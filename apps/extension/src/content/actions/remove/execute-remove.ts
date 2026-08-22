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
import {
  confirmDialogBusy,
  confirmDialogOpen,
  openDialogText,
  waitForConfirmDialogClosed,
  waitForModalLockGone,
} from "../dialog-commit";
import { ensurePendingInvitesTab } from "../revoke/pending-tab";
import { revokeInvite } from "../revoke/revoke-invite";

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
 * Chờ ChatGPT chốt thao tác (dialog tắt hẳn + lớp phủ gỡ) — dùng CHUNG với
 * revoke / change-role / change-license-type / set-usage-limit. Cơ chế + lý do
 * xem `../dialog-commit.ts`; REMOVE là action đầu tiên làm đúng nhịp này
 * (v0.11.5) nên helper được tách ra từ đây, hành vi giữ nguyên 100%.
 */


/**
 * FALLBACK khi email KHÔNG có ở tab "Người dùng": sang tab "Lời mời đang chờ xử
 * lý" và thu hồi lời mời của email đó.
 *
 * Thứ tự này do user chốt (2026-08-21) cho luồng "Chuyển hạn sử dụng đến": *tìm
 * kiếm trong người dùng — có thì xoá khỏi workspace, không có thì chuyển sang
 * lời mời đang chờ xử lý*. Nó cũng vá một lỗ có sẵn của REMOVE_MEMBER: xoá một
 * email đang là lời mời chờ thì trước đây báo COMPLETED (backend mark removed)
 * trong khi lời mời VẪN sống trên ChatGPT.
 *
 * `revokeInvite` tự lo phần định vị đúng luật (1 trang → quét vị trí; nhiều
 * trang → ô "Search for invites") và tự CHỜ ChatGPT chốt + quét lại xác nhận.
 *
 * Trả `null` = email KHÔNG có ở tab Lời mời (caller kết luận đã rời workspace
 * thật). Trả response = đã xử lý xong (ok hoặc fail, caller trả thẳng ra).
 */
async function tryRevokePendingFallback(
  taskId: string,
  email: string,
): Promise<ExecuteActionResponse | null> {
  console.log(
    `${LOG} ${email}: không có ở tab Người dùng → thử tab "Lời mời đang chờ xử lý"`,
  );
  await reportProgress(
    taskId,
    { phase: "searching", message: `Tìm ${email} ở tab Lời mời đang chờ xử lý...` },
    true,
  );
  if (!(await ensurePendingInvitesTab())) {
    console.warn(
      `${LOG} ${email}: không sang được tab Lời mời → bỏ fallback, giữ kết luận theo tab Người dùng`,
    );
    return null;
  }
  const r = await revokeInvite(email);
  if (r.notInPending) return null; // không có ở cả 2 tab ⇒ đã rời thật.
  if (r.ok) {
    console.log(`${LOG} ${email}: đã THU HỒI lời mời chờ → COMPLETED`);
    return { ok: true, data: { email, verified: true, via_revoke: true } };
  }
  // Có lời mời nhưng thu hồi KHÔNG ăn → báo fail để backend giữ member và retry,
  // thà báo chưa-xong còn hơn mark removed trong khi lời mời vẫn sống.
  return {
    ok: false,
    error_code: "REMOVE_VERIFY_FAILED",
    error_message:
      `${email} không có ở tab "Người dùng" nhưng ĐANG có lời mời chờ xử lý, và ` +
      `thu hồi lời mời thất bại: ${r.reason ?? "không rõ lý do"}`,
  };
}

export async function executeRemove(
  taskId: string,
  email: string,
  opts: { allowPendingFallback?: boolean } = {},
): Promise<ExecuteActionResponse> {
  // `allowPendingFallback`: không thấy ở tab "Người dùng" thì sang tab "Lời mời
  // đang chờ xử lý" thu hồi (thứ tự user chốt 2026-08-21). Tắt khi CHÍNH revoke
  // gọi vào đây làm fallback ngược — bật sẽ thành ping-pong 2 tab vô ích.
  const { allowPendingFallback = true } = opts;
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
  // Ô LỌC server-side của ChatGPT là NGUỒN SỰ THẬT — gõ TOÀN BỘ email rồi chờ list
  // load xong (`filterOnceAndResolve`). KHÔNG scroll-scan: tab "Người dùng" là list
  // VIRTUALIZED (150+ row, không có thanh phân trang) nên scroll chỉ thấy vài row
  // gần đỉnh → bỏ sót member vẫn hiện diện → xoá oan (bug 2026-07-21). Cái quyết
  // định là list có THỰC SỰ chạy query hay không — xem `filterOnceAndResolve`.
  //
  // Đây là lần tra NGUY HIỂM NHẤT: `absent` ở đây khiến backend mark removed mà
  // KHÔNG click xoá lần nào. Nên để nguyên mặc định NGHIÊM NGẶT (chờ list đứng
  // yên + 2 vòng lọc độc lập + positive control) — xem sự cố xoá-giả 03→12/8/2026.
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

      // KHÔNG có ở tab "Người dùng" ⇒ CHƯA đủ để kết luận "đã rời workspace":
      // email có thể đang là LỜI MỜI CHỜ XỬ LÝ (mời rồi nhưng chưa bấm nhận).
      // Kết luận vội thì backend mark removed trong khi lời mời VẪN sống trên
      // ChatGPT → ghế vẫn bị giữ, người đó vẫn vào được. Nên: sang tab "Lời mời
      // đang chờ xử lý" thu hồi (đúng thứ tự user chốt 2026-08-21 cho luồng
      // "Chuyển hạn sử dụng đến"); không có ở đó nữa thì mới là đã rời thật.
      if (allowPendingFallback) {
        const viaRevoke = await tryRevokePendingFallback(taskId, email);
        if (viaRevoke) return viaRevoke;
      }

      console.log(
        `${LOG} ${email}: ô lọc load xong, KHÔNG có trong tab Người dùng (và không có lời mời chờ) → đã rời workspace → COMPLETED`,
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
  // ngay lúc confirm: dialog xác nhận ĐÓNG = ChatGPT đã nhận thao tác destructive.
  //
  // ChatGPT bản 2026-08 đổi hành vi (user 13/8/2026, ảnh chụp dialog "Remove
  // member" với nút "Delete" đang QUAY): dialog KHÔNG đóng ngay khi bấm nữa mà
  // giữ spinner tới khi server trả lời. Nên:
  //   · KHÔNG còn nhận toast làm tín hiệu — toast có thể hiện KHI DIALOG CÒN MỞ
  //     → nhánh cũ `toast ?? …` chạy tiếp trong lúc modal vẫn phủ trang.
  //   · Đòi dialog VẮNG MẶT 4 nhịp liên tiếp (~1.2s) mới coi là "tắt hẳn", rồi
  //     chờ nốt lớp phủ Radix — có lớp phủ thì mọi cú gõ ô lọc đều rơi vào hư
  //     không, lọc không chạy, và vòng xác minh chỉ tổ gõ lại liên tục.
  //   · Hạn chờ 15s → 30s cho vừa nhịp spinner mới.
  await reportProgress(taskId, { phase: "verifying", message: "Đợi dialog xoá đóng hẳn..." }, true);
  const dialogClosed = await waitForConfirmDialogClosed(30_000, LOG);

  if (!dialogClosed) {
    // Dialog xác nhận VẪN mở sau 30s → ChatGPT chặn thao tác (OTP/2FA/lỗi) →
    // xoá THẬT bại (không phải trễ list). Đọc text dialog để báo rõ nguyên nhân.
    const dialogText = openDialogText();
    const busy = confirmDialogBusy();
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message:
        `Dialog xác nhận xoá KHÔNG đóng sau 30s (${busy ? "nút xác nhận vẫn đang quay" : "dialog đứng im"}) → ` +
        "ChatGPT có thể yêu cầu OTP/2FA hoặc báo lỗi cho thao tác xoá. Cần xoá thủ công." +
        (dialogText ? ` Dialog: "${dialogText.slice(0, 200)}"` : ""),
    };
  }
  // Dialog đã rời DOM — chờ nốt lớp phủ/scroll-lock trước khi đụng vào ô lọc.
  await waitForModalLockGone(5000, LOG);
  console.log(`${LOG} ${email}: dialog xoá đã tắt hẳn → bắt đầu xác minh bằng ô lọc`);

  // ---- XÁC MINH THẬT: member phải BIẾN MẤT khỏi list, không chỉ dialog đóng ----
  // Dialog đóng = ChatGPT NHẬN lệnh, KHÔNG bảo đảm đã xoá server-side (bug user
  // 2026-07-21: dialog đóng → báo COMPLETED → nhưng member VẪN còn → backend mark
  // removed OAN → đồng bộ thấy còn → hồi sinh active → giờ sau xoá lại → VÒNG LẶP
  // xoá-giả vô hạn, không bao giờ xoá thật). Bản 2026-07-12 gỡ verify vì check QUÁ
  // SỚM: ChatGPT eventual-consistent, sau DELETE THẬT list còn hiện member ~34s rồi
  // mới biến mất → verify sớm báo "còn" = fail oan. Cách đúng: tra tối đa 3 lần
  // (cách nhau 3s, trần 60s) bằng chính ô lọc server-side (clear+gõ lại mỗi lần →
  // fetch mới):
  //   - Row biến mất trong hạn → xoá THỰC SỰ có hiệu lực → verified:true.
  //   - Hết 3 lần vẫn còn → xoá KHÔNG có hiệu lực (ChatGPT chặn/quyền/ghế) →
  //     REMOVE_VERIFY_FAILED (ok:false) → backend GIỮ member active, KHÔNG mark
  //     removed; tick sau retry; loop-guard backend chốt STUCK nếu lặp mãi.
  // Hướng an toàn: thà báo chưa-xoá (giữ member) còn hơn báo đã-xoá GIẢ.
  await reportProgress(
    taskId,
    { phase: "verifying", message: `Xác minh ${email} đã rời workspace...` },
    true,
  );
  // Dialog vừa tắt thì ChatGPT còn refetch list — để nó thở 1 nhịp rồi mới gõ,
  // chứ gõ ngay lúc list đang thay chính là kiểu "tìm kiếm liên tục" vô ích.
  await sleep(2000);

  let gone = false;
  // Tra TỐI ĐA 3 lần, mỗi lần cách nhau 3s (không còn bám sát 1.5s/vòng): một
  // lần `filterOnceAndResolve` đã tự gõ 2 vòng lọc độc lập + positive control
  // (~15-25s), gõ dồn thêm chỉ làm ChatGPT nuốt event chứ không sớm ra kết quả.
  // Trần 60s giữ nguyên để không phá ngân sách 150s của task.
  const VERIFY_ATTEMPTS = 3;
  const VERIFY_GAP_MS = 3000;
  const verifyDeadlineMs = Date.now() + 60_000;
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
    // Mỗi lần tra: clear + gõ lại email → ép fetch lọc mới, chờ list load xong.
    // `absent` = ChatGPT không còn trả row nào khớp ⇒ xoá đã có hiệu lực.
    // `inconclusive` (list không phản hồi) KHÔNG được coi là đã xoá — cứ để lần
    // sau thử lại, hết lượt/hết giờ thì REMOVE_VERIFY_FAILED (giữ member).
    //
    // `requireStableList: false`: list vừa bị CHÍNH cú click xoá làm đổi (row rơi
    // ra, ChatGPT eventual-consistent) nên đòi nó "đứng yên" trước khi gõ chỉ đốt
    // ngân sách. Vẫn giữ 2 vòng lọc độc lập — false-absent ở đây cũng là xoá-giả.
    const check = await filterOnceAndResolve(email, { requireStableList: false });
    if (check.outcome === "absent") {
      gone = true;
      break;
    }
    console.log(
      `${LOG} ${email}: xác minh lần ${attempt}/${VERIFY_ATTEMPTS} → ${check.outcome}` +
        (check.outcome === "inconclusive" ? ` (${check.reason})` : ""),
    );
    if (attempt >= VERIFY_ATTEMPTS || Date.now() + VERIFY_GAP_MS >= verifyDeadlineMs) break;
    await sleep(VERIFY_GAP_MS);
  }

  await clearMemberFilter();

  if (!gone) {
    return {
      ok: false,
      error_code: "REMOVE_VERIFY_FAILED",
      error_message:
        `Đã click xoá ${email} (dialog đã tắt hẳn) nhưng member VẪN còn trong tab ` +
        `"Người dùng" sau ${VERIFY_ATTEMPTS} lần tra (trần 60s) → xoá CHƯA có hiệu ` +
        `lực. Giữ nguyên (không mark removed), sẽ thử lại ở lần sau.`,
    };
  }

  console.log(`${LOG} ${email}: đã BIẾN MẤT khỏi list sau khi xoá → verified → COMPLETED`);
  return { ok: true, data: { email, verified: true } };
}
