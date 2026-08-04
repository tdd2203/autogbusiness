import type { ExecuteActionResponse } from "../../../shared/messages";
import {
  humanClick,
  normalizeMatchText,
  querySelectorFirst,
  randomDelay,
  sleep,
  waitFor,
} from "../../human";
import { reportProgress } from "../../progress";
import { SELECTORS, TEXT_FALLBACKS } from "../../selectors";
import { findRowMenuButton } from "../member-row";
import { dbLabelsFor, reportLabelMismatch } from "../../../shared/ui-labels";
import { clickTabAndWait } from "../sync";
import { clearMemberFilter, filterOnceAndResolve } from "./member-filter";
import {
  isDataMenuItemText,
  pickRemoveMenuItemIndex,
  sanitizeRemoveLabels,
} from "../menu-guard";

const LOG = "[autogpt-remove]";

/**
 * Mọi phần tử "item" trong menu "..." đang mở. ChatGPT (Radix UI) KHÔNG luôn gắn
 * `role="menuitem"` — item xoá có thể là `menuitemradio`/`option`/`button` trong
 * `[role="menu"]`. v0.7.14 chỉ quét `[role="menuitem"]` → bỏ sót "Loại bỏ thành
 * viên" → fail "không có item Remove". Quét rộng như change-license-type.
 */
function openMenuItems(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"], ' +
        '[role="menu"] [role="option"], [role="menu"] button, ' +
        '[role="menuitem"], [role="menuitemradio"], [role="option"]',
    ),
  );
}

/** Text mọi menu item đang mở — đưa vào error_message để debug DOM thật. */
function dumpMenuItems(): string[] {
  return openMenuItems()
    .map((e) => (e.textContent ?? "").trim())
    .filter(Boolean);
}

/**
 * Tìm item menu khớp 1 trong các nhãn — BỎ QUA item "Xuất dữ liệu"/"Xoá dữ liệu"
 * (xem [`menu-guard.ts`](../menu-guard.ts)). Ưu tiên khớp CHÍNH XÁC rồi mới substring.
 */
function findMenuItemByText(texts: readonly string[]): HTMLElement | null {
  const items = openMenuItems();
  const idx = pickRemoveMenuItemIndex(
    items.map((e) => e.textContent ?? ""),
    texts,
  );
  return idx >= 0 ? items[idx] : null;
}

/**
 * Tiêu đề dialog đang mở (heading, fallback dòng text đầu) — dùng để chốt ta đang
 * ở dialog "Loại bỏ thành viên" chứ không phải "Xoá dữ liệu".
 */
function openDialogTitle(): string {
  const d = document.querySelector('[role="alertdialog"], [role="dialog"]');
  if (!d) return "";
  const heading = d.querySelector<HTMLElement>(
    'h1, h2, h3, [role="heading"], [data-testid*="title" i]',
  );
  const raw = heading?.textContent ?? d.textContent ?? "";
  return raw.trim().split("\n")[0]?.trim() ?? "";
}

/** Đóng dialog đang mở (best-effort) khi ta phát hiện mở nhầm dialog. */
async function escapeDialog(): Promise<void> {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await sleep(400);
}

/** Nút xác nhận xoá trong dialog — quét cả `[role="dialog"]`/`[role="alertdialog"]`. */
function findConfirmRemoveButton(texts: readonly string[]): HTMLElement | null {
  const sel = querySelectorFirst<HTMLElement>(SELECTORS.confirmRemoveButton);
  if (sel) return sel;
  const btns = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"] button, [role="alertdialog"] button, button',
    ),
  );
  for (const t of texts) {
    const needle = normalizeMatchText(t);
    if (!needle) continue;
    for (const b of btns) {
      const hay = normalizeMatchText(b.textContent ?? "");
      // So khớp CHÍNH XÁC hoặc bắt đầu bằng nhãn để tránh dính nút "Hủy bỏ".
      if (hay === needle || hay.startsWith(needle)) return b;
    }
  }
  return null;
}

/**
 * Dialog xác nhận xoá còn MỞ không? Sau khi click confirm "Xóa", ChatGPT ĐÓNG dialog
 * ngay khi NHẬN thao tác destructive (gửi DELETE) → dialog biến mất = đã nhận lệnh xoá.
 * Nếu bị chặn (OTP/2FA/lỗi) thì dialog VẪN mở (hoặc bị thay bằng dialog challenge).
 */
function confirmDialogOpen(): boolean {
  return (
    document.querySelector('[role="alertdialog"], [role="dialog"]') !== null
  );
}

/** Text dialog đang mở (để báo lý do khi verify fail: OTP/2FA/lỗi). */
function openDialogText(): string {
  const d = document.querySelector('[role="alertdialog"], [role="dialog"]');
  return (d?.textContent ?? "").trim();
}

export async function executeRemove(
  taskId: string,
  email: string,
): Promise<ExecuteActionResponse> {
  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}).`,
    };
  }

  // Đảm bảo đang ở tab "Người dùng" — REMOVE chỉ làm được trên active member
  // list, không phải tab "Lời mời" / "Yêu cầu". Best-effort, không fail nếu tab
  // button không có (có thể đã ở đúng tab rồi).
  await reportProgress(
    taskId,
    { phase: "navigating", message: "Chuyển tab Người dùng..." },
    true,
  );
  // Render-wait + click nút "Người dùng". `waitForButtonMs=12000`: tab vừa F5/
  // navigate (ensureAdminTab tái dùng tab) → thanh tab có thể CHƯA render → tra 1
  // lần sẽ trượt → kẹt ở tab hiện tại. Cùng cơ chế sync-member/revoke. TRƯỚC đây
  // không truyền waitForButtonMs → nếu tab còn ?tab=invites (action trước để lại)
  // thì không kịp click về Người dùng → lọc nhầm tab Lời mời (bug 2026-06-29).
  await clickTabAndWait(
    "tab_active_members",
    TEXT_FALLBACKS.tabActiveMembers,
    800,
    undefined,
    12_000,
  );

  await reportProgress(
    taskId,
    { phase: "searching", message: `Tìm ${email} bằng ô lọc...` },
    true,
  );
  // Ô LỌC server-side của ChatGPT là NGUỒN SỰ THẬT — gõ TOÀN BỘ email ĐÚNG MỘT LẦN
  // rồi chờ list load xong (`filterOnceAndResolve`). KHÔNG scroll-scan: tab "Người
  // dùng" là list VIRTUALIZED (150+ row, không có thanh phân trang) nên scroll chỉ
  // thấy vài row gần đỉnh → bỏ sót member vẫn hiện diện → xoá oan (bug 2026-07-21).
  // Cũng KHÔNG gõ lại 2-3 lần: gõ thêm không làm kết quả đáng tin hơn, chỉ tốn
  // ngân sách 150s của task (user 2026-07-22). Cái quyết định là list có PHẢN HỒI
  // query hay không — xem `filterOnceAndResolve`.
  const found = await filterOnceAndResolve(email);

  if (found.outcome !== "found") {
    // GUARD chống mark-removed OAN (bug user 2026-06-29): chỉ kết luận "đã rời
    // business" khi CHẮC CHẮN đang ở tab "Người dùng". URL là nguồn sự thật —
    // tab Người dùng KHÔNG có ?tab=invites/requests. Nếu URL còn ?tab=invites
    // (action trước để lại + reload giữ param, hoặc click tab về Người dùng thất
    // bại) thì ô lọc đang lọc danh sách LỜI MỜI → member active không có ở đó là
    // ĐƯƠNG NHIÊN, TUYỆT ĐỐI không được mark removed. Trả UI_ELEMENT_NOT_FOUND
    // (FAILED, member CÒN) → task thử lại thay vì xoá oan khỏi dashboard.
    if (/[?&]tab=(invites|requests)/.test(location.search)) {
      return {
        ok: false,
        error_code: "UI_ELEMENT_NOT_FOUND",
        error_message:
          `Đang ở tab "${location.search}" chứ KHÔNG phải "Người dùng" khi tìm ${email} → ` +
          `bỏ qua để TRÁNH đánh dấu removed oan. Mở chatgpt.com/admin/members (tab Người dùng) rồi thử lại.`,
      };
    }

    // Ô lọc đã LOAD XONG mà không có row → member không còn trong business →
    // THÀNH CÔNG (user 2026-07-22: "chờ nó load thành công mà không thấy là chắc
    // chắn email đó bị xoá rồi"). Trước đây nhánh này trả FAILED vì `null` gộp
    // chung với ca lọc-không-chạy → member đã rời thật kẹt `active`, tick mỗi giờ
    // retry tới MEMBER_REMOVE_STUCK.
    if (found.outcome === "absent") {
      await clearMemberFilter();
      console.log(
        `${LOG} ${email}: ô lọc load xong, KHÔNG có trong tab Người dùng → đã rời workspace → COMPLETED`,
      );
      return {
        ok: true,
        data: { email, verified: true, absent: true, rows_before: found.rows_before },
      };
    }

    // `inconclusive`: list KHÔNG hề phản hồi query (không có ô lọc, hoặc event
    // `input` bị Chrome throttle nuốt nên fetch chưa từng chạy). "Không thấy" ở
    // đây vô nghĩa → giữ member, FAILED để tick sau thử lại. Thà chậm còn hơn
    // xoá-giả.
    return {
      ok: false,
      error_code: "MEMBER_NOT_IN_WORKSPACE",
      error_message:
        `Không tìm thấy ${email} trong tab Người dùng NHƯNG ô lọc không chạy ` +
        `(${found.reason}, list đứng im ở ${found.rows_before} row) → chưa kết luận ` +
        `được là đã rời hay chưa → GIỮ nguyên (không đánh dấu removed), sẽ thử lại.`,
    };
  }
  const row = found.row;

  const menuBtn = findRowMenuButton(row);
  if (!menuBtn) {
    return {
      ok: false,
      error_code: "FAILED_UI_CHANGED",
      error_message: "Không tìm thấy nút menu '...' trong row member.",
    };
  }
  await randomDelay();
  await humanClick(menuBtn);

  // Đợi menu mở rồi tìm item "Loại bỏ thành viên" (vi) / "Remove" (en) / …
  // Label DB cũng phải qua deny-list: nếu HARVEST_LABELS từng ghi nhầm
  // "Xoá dữ liệu" vào `menu_remove_member` thì nó đứng ĐẦU danh sách dò → sẽ xoá
  // sạch dữ liệu member. Chặn + báo mismatch để dashboard thấy label hỏng.
  const dbRemoveRaw = dbLabelsFor("menu_remove_member", "/admin/members");
  const { safe: dbRemove, blocked: dbBlocked } = sanitizeRemoveLabels(dbRemoveRaw);
  if (dbBlocked.length > 0) {
    console.warn(
      `${LOG} label DB menu_remove_member trỏ vào item DỮ LIỆU ${JSON.stringify(dbBlocked)} → BỎ QUA (không click).`,
    );
    reportLabelMismatch("menu_remove_member", dbBlocked[0], "/admin/members");
  }
  const removeTexts =
    dbRemove.length > 0
      ? [...dbRemove, ...TEXT_FALLBACKS.removeMenuItem]
      : TEXT_FALLBACKS.removeMenuItem;
  let removeItem: HTMLElement | null = null;
  try {
    removeItem = await waitFor(() => {
      // Selector CSS cũng phải qua deny-list (phòng ChatGPT đặt
      // data-testid="delete-member-data" — khớp `*="remove" i` là hỏng).
      const bySelector = querySelectorFirst<HTMLElement>(SELECTORS.removeMenuItem);
      if (bySelector && !isDataMenuItemText(bySelector.textContent ?? "")) {
        return bySelector;
      }
      return findMenuItemByText(removeTexts);
    }, 5000);
  } catch {
    if (dbRemove.length > 0) {
      reportLabelMismatch("menu_remove_member", dbRemove[0], "/admin/members");
    }
    // Dump item thật để biết menu rỗng (menu không mở) hay text/role khác.
    const seen = dumpMenuItems();
    console.warn(`${LOG} remove item not found. Menu items:`, JSON.stringify(seen));
    return {
      ok: false,
      error_code: "FAILED_UI_CHANGED",
      error_message:
        seen.length === 0
          ? "Menu '...' không mở (không thấy item nào). ChatGPT có thể đổi nút menu row."
          : `Menu mở nhưng không có item xoá THÀNH VIÊN (item "Xuất/Xoá dữ liệu" bị ` +
            `chặn cố ý — xem menu-guard.ts). Item thấy: ${JSON.stringify(seen)}`,
    };
  }

  await randomDelay();
  await humanClick(removeItem);

  // CHỐT CHẶN CUỐI trước khi bấm nút đỏ: dialog vừa mở phải là "Loại bỏ thành
  // viên", KHÔNG phải "Xoá dữ liệu" (dialog đó cũng có nút đỏ "Xóa" → nhánh
  // confirm bên dưới sẽ bấm nhầm và xoá sạch dữ liệu member, không hoàn tác).
  const dialogTitle = await waitFor(
    () => (confirmDialogOpen() ? openDialogTitle() || " " : null),
    5000,
  ).catch(() => "");
  if (dialogTitle && isDataMenuItemText(dialogTitle)) {
    console.warn(`${LOG} mở NHẦM dialog "${dialogTitle}" → ESC, không bấm xác nhận.`);
    await escapeDialog();
    return {
      ok: false,
      error_code: "FAILED_UI_CHANGED",
      error_message:
        `Click item xoá thành viên nhưng ChatGPT mở dialog "${dialogTitle}" ` +
        `(thao tác trên DỮ LIỆU member, không phải loại bỏ thành viên) → đã huỷ, ` +
        `KHÔNG xác nhận. Nhãn menu ChatGPT đã đổi — cần harvest lại label.`,
    };
  }

  // Đợi confirm dialog → nút đỏ "Xóa" (vi) / "Remove" (en). Bỏ qua "Hủy bỏ".
  const dbConfirm = dbLabelsFor("confirm_remove_button", "/admin/members");
  const confirmTexts =
    dbConfirm.length > 0
      ? [...dbConfirm, ...TEXT_FALLBACKS.confirmRemoveButton]
      : TEXT_FALLBACKS.confirmRemoveButton;
  let confirmBtn: HTMLElement;
  try {
    confirmBtn = await waitFor(() => findConfirmRemoveButton(confirmTexts), 5000);
  } catch {
    if (dbConfirm.length > 0) {
      reportLabelMismatch("confirm_remove_button", dbConfirm[0], "/admin/members");
    }
    const btns = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="dialog"] button, [role="alertdialog"] button',
      ),
    )
      .map((b) => (b.textContent ?? "").trim())
      .filter(Boolean);
    console.warn(`${LOG} confirm button not found. Dialog buttons:`, JSON.stringify(btns));
    return {
      ok: false,
      error_code: "FAILED_UI_CHANGED",
      error_message: `Không tìm thấy nút xác nhận xoá. Nút trong dialog: ${JSON.stringify(btns)}`,
    };
  }

  await reportProgress(taskId, { phase: "confirming", message: "Click confirm Remove..." }, true);
  await randomDelay();
  await humanClick(confirmBtn);

  // ---- Verify: chờ ChatGPT NHẬN lệnh xoá (tín hiệu tại THỜI ĐIỂM thao tác) ----
  // KHÔNG dựa vào "row biến mất khỏi list" nữa: sau DELETE, backend ChatGPT
  // eventual-consistent → list (KỂ CẢ lọc server-side MỚI) VẪN trả member vừa xoá
  // trong vài chục giây → verify cũ (theo dõi list / lọc lại) kết luận "còn" =
  // VERIFY_FAILED OAN dù đã xoá xong (bug user 2026-07-12: lần xoá ĐẦU thành công
  // nhưng báo thất bại, 34s sau retry mới thấy đã removed). Tín hiệu TIN CẬY nằm
  // ngay lúc confirm: dialog xác nhận ĐÓNG = ChatGPT đã nhận thao tác destructive
  // (giống verify của INVITE — toast/dialog đóng). Chỉ VERIFY_FAILED khi dialog
  // VẪN mở sau 15s (OTP/2FA/lỗi thật sự chặn xoá).
  await reportProgress(taskId, { phase: "verifying", message: "Đợi ChatGPT xác nhận đã nhận lệnh xoá..." }, true);
  let verifyOk = false;
  try {
    await waitFor(() => {
      const toast = querySelectorFirst(SELECTORS.inviteSuccessToast);
      return toast ?? (confirmDialogOpen() ? null : document.body);
    }, 15_000, 250);
    verifyOk = true;
  } catch {
    // Dialog xác nhận VẪN mở sau 15s → ChatGPT chặn thao tác (OTP/2FA/lỗi) →
    // xoá THẬT bại (không phải trễ list). Đọc text dialog để báo rõ nguyên nhân.
    verifyOk = false;
  }

  if (!verifyOk) {
    const dialogText = openDialogText();
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message:
        "Dialog xác nhận xoá KHÔNG đóng sau 15s → ChatGPT có thể yêu cầu OTP/2FA " +
        "hoặc báo lỗi cho thao tác xoá. Cần xoá thủ công." +
        (dialogText ? ` Dialog: "${dialogText.slice(0, 200)}"` : ""),
    };
  }

  // ---- XÁC MINH THẬT: member phải BIẾN MẤT khỏi list, không chỉ dialog đóng ----
  // Dialog đóng = ChatGPT NHẬN lệnh, KHÔNG bảo đảm đã xoá server-side (bug user
  // 2026-07-21: dialog đóng → báo COMPLETED → nhưng member VẪN còn → backend mark
  // removed OAN → đồng bộ thấy còn → hồi sinh active → giờ sau xoá lại → VÒNG LẶP
  // xoá-giả vô hạn, không bao giờ xoá thật). Bản 2026-07-12 gỡ verify vì check QUÁ
  // SỚM: ChatGPT eventual-consistent, sau DELETE THẬT list còn hiện member ~34s rồi
  // mới biến mất → verify sớm báo "còn" = fail oan. Cách đúng: POLL tới 45s bằng
  // chính ô lọc server-side (clear+gõ lại mỗi vòng → fetch mới):
  //   - Row biến mất trong 45s → xoá THỰC SỰ có hiệu lực → verified:true.
  //   - Tới 45s vẫn còn → xoá KHÔNG có hiệu lực (ChatGPT chặn/quyền/ghế) →
  //     REMOVE_VERIFY_FAILED (ok:false) → backend GIỮ member active, KHÔNG mark
  //     removed; tick sau retry; loop-guard backend chốt STUCK nếu lặp mãi.
  // Hướng an toàn: thà báo chưa-xoá (giữ member) còn hơn báo đã-xoá GIẢ.
  await reportProgress(
    taskId,
    { phase: "verifying", message: `Xác minh ${email} đã rời workspace...` },
    true,
  );
  let gone = false;
  const verifyDeadlineMs = Date.now() + 45_000;
  while (Date.now() < verifyDeadlineMs) {
    // Mỗi vòng: clear + gõ lại email ĐÚNG MỘT LẦN → ép fetch lọc mới, rồi chờ list
    // load xong. `absent` = ChatGPT không còn trả row nào khớp ⇒ xoá đã có hiệu lực.
    // `inconclusive` (list không phản hồi) KHÔNG được coi là đã xoá — cứ để vòng
    // sau thử lại, hết 45s thì REMOVE_VERIFY_FAILED (giữ member).
    const check = await filterOnceAndResolve(email);
    if (check.outcome === "absent") {
      gone = true;
      break;
    }
    await sleep(3000);
  }

  await clearMemberFilter();

  if (!gone) {
    return {
      ok: false,
      error_code: "REMOVE_VERIFY_FAILED",
      error_message:
        `Đã click xoá ${email} (dialog đóng) nhưng member VẪN còn trong tab ` +
        `"Người dùng" sau 45s → xoá CHƯA có hiệu lực. Giữ nguyên (không mark ` +
        `removed), sẽ thử lại ở lần sau.`,
    };
  }

  console.log(`${LOG} ${email}: đã BIẾN MẤT khỏi list sau khi xoá → verified → COMPLETED`);
  return { ok: true, data: { email, verified: true } };
}
