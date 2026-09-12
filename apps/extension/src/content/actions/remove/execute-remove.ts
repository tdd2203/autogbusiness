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
import { findMemberRow, findRowMenuButton } from "../member-row";
import { dbLabelsFor, reportLabelMismatch } from "../../../shared/ui-labels";
import { clickTabAndWait } from "../sync";
import { clearMemberFilter, filterOnceAndResolve } from "./member-filter";
import {
  isDataMenuItemText,
  pickRemoveMenuItemIndex,
  sanitizeRemoveLabels,
} from "../menu-guard";
import {
  answerPaidSeatDialog,
  confirmDialogBusy,
  confirmDialogOpen,
  openDialogText,
  paidSeatDialogOpen,
  visibleDialogEl,
  waitForModalLockGone,
} from "../dialog-commit";
import { releaseWindowOpen } from "../paid-seat-guard";
import { ensurePendingInvitesTab } from "../revoke/pending-tab";
import { revokeInvite } from "../revoke/revoke-invite";
import {
  LOAD_BUDGET_MS as PENDING_LOAD_BUDGET_MS,
  readPendingSnapshot,
  waitForPendingListLoaded,
} from "../invite/pending-list-loaded";
import { emailsInListRegion } from "../invite/scan-pending-page";
import { waitForRowGone } from "./wait-row-gone";

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
  // Hộp thoại ĐANG SỐNG, không phải khung ma đầu DOM — xem `dialog-commit.ts`.
  const d = visibleDialogEl();
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

/**
 * Nút xác nhận xoá — chỉ tìm TRONG dialog đang mở khi có dialog.
 *
 * Trước đây danh sách nút gồm cả `button` toàn trang, mà danh sách nhãn có nhãn
 * LỎNG ("Gỡ", "Remove") khớp kiểu `startsWith` → một nút bất kỳ ngoài dialog
 * (sidebar admin, banner "Bật tự động nạp tiền", …) đứng trước dialog trong DOM
 * là bị bấm thay. Dialog xác nhận LUÔN chứa nút cần bấm, nên khi nó đang mở thì
 * quét ngoài nó là thừa và nguy hiểm. Không có dialog mới quét cả trang (giữ
 * nguyên đường lui cũ cho luồng UI không dùng dialog).
 */
function findConfirmRemoveButton(texts: readonly string[]): HTMLElement | null {
  const dialog = visibleDialogEl();
  // Hộp "Gỡ suất trả phí?" (bồi sau khi gỡ xong) cũng có nút đỏ, khớp cả
  // `button[data-variant="destructive"]` lẫn nhãn lỏng "Remove" kiểu `startsWith`
  // → quét ở đây là bấm trúng "Remove paid seat", workspace tụt suất đã mua.
  // Hộp đó do `answerPaidSeatDialog` lo, tuyệt đối không phải việc của hàm này.
  if (dialog && paidSeatDialogOpen()) return null;
  const root: ParentNode = dialog ?? document;
  const sel = querySelectorFirst<HTMLElement>(SELECTORS.confirmRemoveButton, root);
  if (sel) return sel;
  const btns = Array.from(root.querySelectorAll<HTMLElement>("button"));
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
 * Ba kết cục KHÁC HẲN NHAU của cú ghé tab "Lời mời đang chờ xử lý".
 *
 * Trước 6/9/2026 cả ba gộp vào một `null` và caller hiểu là "đã rời workspace
 * thật" ⇒ `absent: true` ⇒ backend mark removed mà chưa click xoá lần nào. Đó
 * đúng là cách một ghế bị nhả oan — xem nhánh `unchecked` trong `executeRemove`
 * và `execute-remove.absent-guard.test.ts`.
 */
type PendingProbe =
  /** Đã xử lý xong ở tab Lời mời (thu hồi được, hoặc thu hồi hỏng) — trả thẳng. */
  | { kind: "handled"; response: ExecuteActionResponse }
  /** ĐÃ TRA và danh sách lời mời CHẮC CHẮN không có email này. */
  | { kind: "absent" }
  /** KHÔNG tra được (không vào nổi tab / danh sách chưa nạp xong) — chưa chứng minh gì. */
  | { kind: "unchecked"; reason: string };

/**
 * FALLBACK khi email KHÔNG có ở tab "Người dùng": sang tab "Lời mời đang chờ xử
 * lý", CHỜ danh sách nạp xong, rồi thu hồi lời mời của email đó.
 *
 * Thứ tự này do user chốt (2026-08-21) cho luồng "Chuyển hạn sử dụng đến": *tìm
 * kiếm trong người dùng — có thì xoá khỏi workspace, không có thì chuyển sang
 * lời mời đang chờ xử lý*. Nó cũng vá một lỗ có sẵn của REMOVE_MEMBER: xoá một
 * email đang là lời mời chờ thì trước đây báo COMPLETED (backend mark removed)
 * trong khi lời mời VẪN sống trên ChatGPT.
 *
 * ⚠️ CỬA CHỜ NẠP XONG (`waitForPendingListLoaded`, 6/9/2026) là phần quan trọng
 * nhất ở đây. `revokeInvite` kết luận `notInPending` bằng ô "Search for invites"
 * (nhiều trang) hoặc quét vị trí (1 trang) — mà một danh sách CHƯA VẼ cũng cho ra
 * đúng hình dạng "không có dòng nào". Không chờ thì "chưa tra được" đội lốt "đã
 * tra và không thấy", và cái lốt đó đi thẳng vào `absent: true`. Vòng chờ này
 * chính là thứ `count-pending-invites.ts` đã dựng cho phép đếm nợ suất, cùng một
 * nguyên tắc: *chỉ chốt khi có BẰNG CHỨNG, không phải khi hết giờ*.
 *
 * `revokeInvite` tự lo phần định vị đúng luật (1 trang → quét vị trí; nhiều
 * trang → ô "Search for invites") và tự CHỜ ChatGPT chốt + quét lại xác nhận.
 */
async function probePendingInvites(
  taskId: string,
  email: string,
): Promise<PendingProbe> {
  console.log(
    `${LOG} ${email}: không có ở tab Người dùng → thử tab "Lời mời đang chờ xử lý"`,
  );
  await reportProgress(
    taskId,
    { phase: "searching", message: `Tìm ${email} ở tab Lời mời đang chờ xử lý...` },
    true,
  );
  // Mốc so: email đang hiện ở tab "Người dùng" NGAY TRƯỚC khi bấm sang. Còn thấy
  // chúng sau khi sang tab nghĩa là React chưa gỡ bảng cũ — đọc lúc đó là đọc
  // nhầm danh sách.
  const baseline = emailsInListRegion();
  if (!(await ensurePendingInvitesTab())) {
    return {
      kind: "unchecked",
      reason: 'không sang được tab "Lời mời đang chờ xử lý"',
    };
  }
  const verdict = await waitForPendingListLoaded(PENDING_LOAD_BUDGET_MS, baseline, {
    read: readPendingSnapshot,
    now: () => Date.now(),
    sleep,
  });
  if (!verdict.loaded) {
    return {
      kind: "unchecked",
      reason: `danh sách lời mời chưa nạp xong sau ${verdict.waitedMs}ms (${verdict.reason})`,
    };
  }

  // DANH SÁCH RỖNG (đã nạp xong) ⇒ email không thể nằm trong đó. Cửa
  // `waitForPendingListLoaded` chính là cửa đang gác phép đếm nợ suất — thứ đi
  // thẳng vào tiền — nên nó cũng đủ chắc để ký "không còn lời mời treo".
  //
  // VÌ SAO PHẢI CHẶN Ở ĐÂY (ca khaialphauni003 10/9/2026): đường cũ luôn đi tiếp
  // vào `revokeInvite` → `lookupPendingRow`, mà chỗ đó chứng minh vắng mặt bằng
  // cách XOÁ Ô TÌM KIẾM RỒI ĐÒI DANH SÁCH ĐẦY LẠI. Danh sách rỗng thì chẳng bao
  // giờ đầy lại được ⇒ luôn ra `pending_search_dead` ⇒ lệnh gỡ báo hỏng, tick
  // sau xếp lại, lại hỏng… tới khi loop-guard kêu "cần gỡ thủ công" — trong khi
  // ChatGPT đã gỡ xong ngay từ lượt đầu. Rỗng cũng là ca ĐẮT NHẤT: nó cuộn hết
  // danh sách ảo rồi mới chịu thua, đủ lâu để backend chốt lệnh treo (cùng ca
  // trên, lượt thứ ba chết vì im lặng 183s).
  if (verdict.emails.length === 0) {
    console.log(
      `${LOG} ${email}: tab Lời mời đã nạp xong và KHÔNG còn dòng nào → không có lời mời treo`,
    );
    return { kind: "absent" };
  }

  // Còn lời mời trong danh sách thì cú tra dưới đây có thể lâu (cuộn danh sách
  // ảo, gõ ô tìm kiếm, chờ danh sách đầy lại). Báo một nhịp trước khi vào, kẻo
  // backend đọc quãng im lặng đó là lệnh treo.
  await reportProgress(
    taskId,
    {
      phase: "searching",
      message: `Tra ${email} trong ${verdict.emails.length} lời mời đang chờ...`,
    },
    true,
  );
  const r = await revokeInvite(email);
  if (r.inconclusive) {
    // Vào được tab, danh sách đã vẽ, NHƯNG cú tra vẫn không chứng minh được gì
    // (không có ô tìm kiếm, hoặc gõ vào mà list không nhúc nhích). Vẫn là "chưa
    // tra được" — xem `revoke/locate-pending-row.ts`.
    return { kind: "unchecked", reason: r.reason ?? "không tra được tab Lời mời" };
  }
  if (r.notInPending) return { kind: "absent" }; // đã tra cả 2 tab ⇒ rời thật.
  if (r.ok) {
    console.log(`${LOG} ${email}: đã THU HỒI lời mời chờ → COMPLETED`);
    return {
      kind: "handled",
      response: { ok: true, data: { email, verified: true, via_revoke: true } },
    };
  }
  // Có lời mời nhưng thu hồi KHÔNG ăn → báo fail để backend giữ member và retry,
  // thà báo chưa-xong còn hơn mark removed trong khi lời mời vẫn sống.
  return {
    kind: "handled",
    response: {
      ok: false,
      error_code: "REMOVE_VERIFY_FAILED",
      error_message:
        `${email} không có ở tab "Người dùng" nhưng ĐANG có lời mời chờ xử lý, và ` +
        `thu hồi lời mời thất bại: ${r.reason ?? "không rõ lý do"}`,
    },
  };
}

/** Tuỳ chọn của một lệnh gỡ. */
export type RemoveOptions = {
  /**
   * Không thấy ở tab "Người dùng" thì sang tab "Lời mời đang chờ xử lý" thu hồi
   * (thứ tự user chốt 2026-08-21). Tắt khi CHÍNH revoke gọi vào đây làm fallback
   * ngược — bật sẽ thành ping-pong 2 tab vô ích. Mặc định bật.
   */
  allowPendingFallback?: boolean;
  /**
   * NGÀY CHỐT CHU KỲ — giờ hoá đơn của mốc (ISO) do backend đính vào lệnh
   * (`payload.release_paid_seat_until`). Hộp "Gỡ suất trả phí?" hiện ra TRƯỚC giờ
   * này thì bấm GỠ SUẤT: gỡ ở đó có hiệu lực ngay hoá đơn kỳ mới, bớt đúng ghế
   * vừa gỡ — cùng lý lẽ với đợt gỡ tại mốc 10h (giờ VN). Thiếu hoặc đã qua ⇒ giữ
   * suất như giữa kỳ. So đồng hồ LÚC HỘP HIỆN RA chứ không phải lúc nhận lệnh: mẻ
   * 5 lệnh chạy tuần tự, lệnh cuối có thể rơi qua giờ hoá đơn.
   */
  releasePaidSeatUntil?: string | null;
};

export async function executeRemove(
  taskId: string,
  email: string,
  opts: RemoveOptions = {},
): Promise<ExecuteActionResponse> {
  const { allowPendingFallback = true, releasePaidSeatUntil = null } = opts;
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
        const probe = await probePendingInvites(taskId, email);
        if (probe.kind === "handled") return probe.response;
        if (probe.kind === "unchecked") {
          // CHƯA TRA ĐƯỢC ≠ ĐÃ TRA VÀ KHÔNG THẤY. Trả `absent` ở đây là ký giấy
          // "email đã rời workspace" dựa trên một tab chưa từng mở ra — backend
          // nhận `absent_confirmed`, mark removed KHÔNG click xoá lần nào, và ghế
          // trên ChatGPT ở lại trong tay email đó. Ca thật GPT1 5/9/2026: gỡ lúc
          // 18:00, email vẫn ăn ghế 16.7 giờ, workspace vượt trần 387/386 khi lần
          // đồng bộ sau chữa lại sự thật. FAILED thì tick auto-remove xếp lại lệnh
          // — chậm vài phút, không mất ghế.
          console.warn(
            `${LOG} ${email}: không tra được tab Lời mời (${probe.reason}) → KHÔNG kết luận đã rời`,
          );
          return {
            ok: false,
            error_code: "MEMBER_NOT_IN_WORKSPACE",
            error_message:
              `Không thấy ${email} ở tab "Người dùng", và KHÔNG tra được tab "Lời mời ` +
              `đang chờ xử lý" (${probe.reason}) → chưa chứng minh được là đã rời hay ` +
              `vẫn còn lời mời treo → GIỮ nguyên (không đánh dấu removed), sẽ thử lại.`,
          };
        }
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

  // ---- XÁC MINH: chờ dòng đó biến mất, rồi tra lại ĐÚNG MỘT LẦN ----
  // LUẬT (user 11/9/2026): *"xoá xong chờ nó biến mất rồi tìm kiếm đúng 1 lần cho
  // chắc chắn. như thế là nó xoá rồi. không cần phải tìm kiếm thêm"*.
  //
  // Hộp thoại KHÔNG phải quan toà: nó có thể nằm lì (khung `role="dialog"` bỏ
  // lại, hộp "Gỡ suất trả phí?" bồi thêm), nên chờ nó tắt trong 30s rồi báo hỏng
  // là sai. Nhưng chờ 3 giây rồi dẹp hộp cũng sai theo chiều ngược lại: ChatGPT
  // còn quay hộp xác nhận chục giây mới gỡ xong, tra ngay lúc đó thì lần nào cũng
  // còn thấy dòng và lệnh gỡ nào cũng phải chạy lượt hai. Thứ cần chờ là DÒNG rời
  // danh sách đang lọc (xem `wait-row-gone.ts`), rồi ô tìm kiếm phân xử.
  await reportProgress(
    taskId,
    { phase: "verifying", message: `Chờ ${email} biến mất khỏi danh sách...` },
    true,
  );
  // Hộp "Gỡ suất trả phí?": GIỮ giữa kỳ, GỠ trong ngày chốt chu kỳ (xem
  // `RemoveOptions.releasePaidSeatUntil`). So đồng hồ đúng lúc hộp hiện ra.
  const releaseNow = (): boolean => {
    const release = releaseWindowOpen(releasePaidSeatUntil);
    if (releasePaidSeatUntil && !release) {
      console.log(
        `${LOG} ${email}: lệnh mang mốc trả suất ${releasePaidSeatUntil} nhưng đã qua giờ → giữ suất`,
      );
    }
    return release;
  };
  const waited = await waitForRowGone({
    read: () => ({
      dialog: confirmDialogOpen(),
      busy: confirmDialogBusy(),
      paidSeat: paidSeatDialogOpen(),
      row: findMemberRow(email) !== null,
    }),
    answerPaidSeat: () => answerPaidSeatDialog(LOG, { release: releaseNow() }),
    beat: (ms) =>
      reportProgress(
        taskId,
        {
          phase: "verifying",
          message: `Chờ ${email} biến mất khỏi danh sách (${Math.round(ms / 1000)}s)...`,
        },
        true,
      ),
    sleep,
  });
  const waitedS = Math.round(waited.waitedMs / 1000);

  let paidSeat = waited.paidSeat;
  const dialogStuck = confirmDialogOpen();
  if (dialogStuck) {
    // Còn hộp thoại thì mọi cú gõ ô lọc rơi vào lớp phủ → dẹp trước khi tra. Hộp
    // suất chưa được trả lời thì trả lời; hộp khác / không nhận ra nút thì ESC
    // (không chọn gì = suất giữ nguyên). Đây KHÔNG phải lý do báo hỏng.
    if (paidSeat === "none") {
      paidSeat = await answerPaidSeatDialog(LOG, { release: releaseNow() });
      if (paidSeat === "none" || paidSeat === "unknown") await escapeDialog();
      await waitForModalLockGone(2000, LOG);
    }
    if (confirmDialogOpen()) {
      // Vẫn còn hộp (ChatGPT hỏi thêm một lượt sau hộp suất?) → ghi nguyên văn để
      // bổ sung nhãn, rồi ESC cho khuất ô lọc. ESC = không chọn gì = suất giữ
      // nguyên, nên có nhầm cũng chỉ mất một lượt trả suất chứ không mất tiền.
      console.warn(
        `${LOG} ${email}: dẹp hộp thoại xong (suất: ${paidSeat}) mà vẫn còn hộp → ESC. ` +
          `Hộp: ${JSON.stringify(openDialogText().slice(0, 200))}`,
      );
      await escapeDialog();
      await waitForModalLockGone(2000, LOG);
    }
  }
  console.log(
    `${LOG} ${email}: sau khi bấm xoá → ` +
      (waited.gone
        ? `dòng đã biến mất sau ~${waitedS}s`
        : `chờ ${waitedS}s dòng vẫn chưa biến mất`) +
      `${dialogStuck ? `, hộp thoại còn nằm lại (đã dẹp, suất: ${paidSeat})` : ""} → tra lại bằng ô lọc`,
  );

  // TRA ĐÚNG MỘT LẦN, rồi thôi. `requireStableList: false`: danh sách vừa bị
  // CHÍNH cú xoá làm đổi nên đòi nó đứng yên trước khi gõ chỉ tổ đốt giờ.
  // `confirmRounds: 1`: đã có cú bấm xác nhận và dòng biến mất làm bằng chứng, ô
  // lọc chỉ còn việc xác nhận.
  const check = await filterOnceAndResolve(email, {
    requireStableList: false,
    confirmRounds: 1,
  });
  // KHÔNG RA DÒNG NÀO ⇒ ĐÃ XOÁ. Ô lọc không tự chứng minh được là nó còn sống
  // (`inconclusive`) thì chỉ tính là xong khi đã thấy dòng biến mất: bấm xác nhận
  // xong mà dòng nằm lì suốt trần chờ, lại tra không được, thì chưa có bằng chứng
  // nào là đã gỡ — báo hỏng để lượt sau tra kỹ lại, còn hơn ký "đã rời" cho người
  // có thể vẫn đang ăn ghế. Khác hẳn nhánh KHÔNG hề bấm xoá phía trên, nơi
  // `absent` là chữ ký nhả ghế và luôn đòi bằng chứng ngặt.
  const gone =
    check.outcome === "absent" || (check.outcome === "inconclusive" && waited.gone);
  console.log(
    `${LOG} ${email}: tra lại sau khi xoá → ${check.outcome}` +
      (check.outcome === "inconclusive" ? ` (${check.reason})` : ""),
  );

  await clearMemberFilter();

  if (!gone) {
    const why =
      check.outcome === "found"
        ? `tra lại VẪN thấy dòng đó ở tab "Người dùng"` +
          (waited.gone
            ? " (dòng đã biến mất rồi hiện lại)"
            : ` (chờ ${waitedS}s dòng không biến mất)`) +
          ` → xoá chưa có hiệu lực, hoặc ChatGPT còn trả về dòng cũ`
        : `chờ ${waitedS}s dòng không biến mất, và ô lọc không tra lại được` +
          (check.outcome === "inconclusive" ? ` (${check.reason})` : "") +
          ` → chưa có bằng chứng đã gỡ`;
    return {
      ok: false,
      error_code: "REMOVE_VERIFY_FAILED",
      error_message:
        `Đã bấm xoá ${email} nhưng ${why}. Giữ nguyên (không đánh dấu removed), sẽ thử lại.`,
    };
  }

  console.log(`${LOG} ${email}: đã BIẾN MẤT khỏi list sau khi xoá → verified → COMPLETED`);
  // Xoá xong là XONG: bằng chứng nằm ở tab "Người dùng" (dòng biến mất + tra lại
  // một lần). KHÔNG ghé tab "Lời mời đang chờ xử lý" quét thêm nữa (user
  // 12/9/2026 rút lại luật 6/9): cú quét ấy không lật được kết quả nào, chỉ tốn
  // thêm một lần chuyển tab và tới 20s gõ ô tìm kiếm; lời mời treo (nếu có) để
  // đồng bộ dọn.
  return {
    ok: true,
    data: {
      email,
      verified: true,
      dialog_stuck: dialogStuck,
      // Có tận mắt thấy dòng rời danh sách trước khi tra lại hay không.
      row_gone: waited.gone,
      // Backend ghi vào audit MEMBER_REMOVED_SYNCED để đếm "kỳ này trả được bao
      // nhiêu suất" mà không phải đoán từ hoá đơn.
      paid_seat: paidSeat,
    },
  };
}
