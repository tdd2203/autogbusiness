/**
 * Revoke pending invite trên tab "Lời mời đang chờ xử lý" của /admin/members.
 *
 * Use case: sync detect được pending invite trên ChatGPT mà dashboard DB KHÔNG
 * track (= invite không qua dashboard, có thể do member tự mời trực tiếp trong
 * UI ChatGPT) → auto-revoke để dashboard là source of truth.
 *
 * Flow:
 *   1. Đảm bảo đang ở tab "Lời mời đang chờ xử lý" (sync.ts đã click tab này
 *      trong quá trình scrape — revoke chạy NGAY SAU scrape, vẫn còn tab open)
 *   2. Tìm row chứa email
 *   3. Click nút "..." menu trong row
 *   4. Click menu item "Thu hồi lời mời"
 *   5. CHỜ ChatGPT chốt (dialog tắt hẳn + lớp phủ gỡ) rồi QUÉT LẠI tab Lời mời
 *      để xác nhận invite đã biến mất — không quét lại thì không được báo ok.
 *
 * Selectors hiện tại heuristic — ChatGPT có thể đổi UI, cần inspect khi fail.
 */

import {
  humanClick,
  normalizeMatchText,
  queryByText,
  randomDelay,
  sleep,
  waitFor,
} from "../../human";
import {
  DIALOG_DISMISS_TEXTS,
  REVOKE_CONFIRM_TEXTS,
  REVOKE_MENU_ITEM_TEXTS,
  findMenuItemByKey,
} from "../../i18n-ui";
import { dbLabelsFor, reportLabelMismatch } from "../../../shared/ui-labels";
import { findRowMenuButton } from "../member-row";
import { waitForChatGptCommit } from "../dialog-commit";
import { locatePendingRow } from "./locate-pending-row";
import { verifyInviteGone } from "./verify-invite-gone";

const LOG = "[autogpt-revoke]";

/**
 * Hạn chờ HỘP THOẠI XÁC NHẬN hiện ra. Trước đây là `sleep(800)` cứng rồi soi DOM
 * đúng 1 lần: dialog render chậm hơn 800ms (máy/mạng chậm) là coi như "luồng này
 * không có dialog" → BỎ QUA bước bấm xác nhận → lời mời không hề bị thu hồi, mà
 * `waitForChatGptCommit` thấy không có dialog nào lại chốt "đã xong" → xuống quét
 * lại thấy row còn nguyên → báo hỏng lạc đề.
 */
const CONFIRM_DIALOG_WAIT_MS = 3_000;

/** Hạn chờ dialog thu hồi tắt hẳn — cùng nhịp spinner với REMOVE (v0.11.5). */
const COMMIT_TIMEOUT_MS = 30_000;
/** Để ChatGPT refetch list 1 nhịp sau khi dialog đóng rồi mới tra lại. */
const VERIFY_SETTLE_MS = 2000;
/**
 * Ngân sách xác minh mặc định khi caller không cấp (thu hồi lẻ 1 email).
 *
 * 25s → 60s (ca ickj886@gmail.com 27/8/2026): ChatGPT còn trả về dòng đã thu hồi
 * thêm ~34 giây mới chịu bỏ (cùng độ trễ mà lệnh gỡ đã đo được từ 12/7/2026, nên
 * gỡ để trần 60s). Cửa sổ 25s cũ — thực tế chỉ dùng hết 12-17s vì mỗi lần tra
 * quá nhanh — đóng sổ ngay giữa khoảng ChatGPT chưa cập nhật ⇒ thu hồi trót lọt
 * bị chốt là hỏng. Xem `verify-invite-gone.ts`.
 */
const VERIFY_DEFAULT_BUDGET_MS = 60_000;

/** Có thể có confirm dialog hoặc không — tuỳ ChatGPT. */
export type RevokeResult = {
  email: string;
  ok: boolean;
  reason?: string;
  /**
   * Email KHÔNG có trên tab "Lời mời đang chờ xử lý" (đã scroll-scan hết list).
   * Thường vì người đó đã CHẤP NHẬN lời mời → thành active member, không còn là
   * pending invite. Caller (`executeRevokeInvites`) dùng cờ này để fallback sang
   * tab "Người dùng" và xoá khỏi workspace.
   */
  notInPending?: boolean;
  /**
   * Có row mang email này trên tab "Lời mời" nhưng menu "..." của nó KHÔNG có mục
   * "Thu hồi lời mời" — dấu hiệu row đó KHÔNG PHẢI một lời mời đang chờ (người ta đã
   * bấm nhận, hoặc ô tìm kiếm trả về dòng của tab "Người dùng").
   *
   * Trước 4/9/2026 ca này chỉ trả `ok:false` trơ trọi: không có `notInPending` nên
   * `executeRevokeInvites` KHÔNG lùi sang tab "Người dùng", lệnh gỡ hỏng hẳn và email
   * cũ ở lại ăn ghế tới lần đồng bộ sau (4/7 lệnh thu hồi hỏng trên production đúng
   * kiểu này). Caller dùng cờ này để lùi sang xoá, nhưng KHÔNG được coi "không thấy ở
   * tab Người dùng" là đã xoá xong — xem `execute-revoke-batch.ts`.
   */
  menuWithoutRevoke?: boolean;
  /** Email được xử lý qua fallback REMOVE (xoá khỏi tab Người dùng) thay vì revoke. */
  viaRemove?: boolean;
};

/** Nút đóng/huỷ của hộp thoại — KHÔNG BAO GIỜ được bấm khi tìm nút xác nhận. */
function isDismissButton(el: Element): boolean {
  const txt = normalizeMatchText(el.textContent ?? "");
  return DIALOG_DISMISS_TEXTS.some((t) => normalizeMatchText(t) === txt);
}

/**
 * Nút XÁC NHẬN trong hộp thoại thu hồi.
 *
 *   1. Khớp chữ (`REVOKE_CONFIRM_TEXTS` + label từ DB), bỏ qua nút huỷ/đóng.
 *   2. Không chữ nào khớp (ChatGPT đổi nhãn) → lấy nút CUỐI có chữ mà không phải
 *      huỷ/đóng: hộp thoại luôn đặt nút hành động ở cuối. Thà bấm đúng nút hành
 *      động còn hơn đứng im rồi để lời mời còn nguyên.
 *
 * Vì sao cần lọc huỷ/đóng: vòng lặp cũ duyệt `REVOKE_CONFIRM_TEXTS` theo thứ tự
 * và khớp kiểu CHỨA CHUỖI, mà danh sách đó từng có sẵn "Hủy"/"Cancel"/"取消" —
 * chỉ cần ChatGPT đổi chữ nút xác nhận là mấy chữ đầu trượt hết rồi rơi đúng vào
 * nút HUỶ của hộp thoại (ca vaominh11@gmail.com 21/8/2026).
 */
function findConfirmButton(
  dialog: Element,
  texts: readonly string[],
): HTMLElement | null {
  for (const text of texts) {
    const btn = queryByText("button", text, dialog);
    if (btn && !isDismissButton(btn)) return btn;
  }
  const buttons = Array.from(
    dialog.querySelectorAll<HTMLElement>("button"),
  ).filter((b) => (b.textContent ?? "").trim());
  for (let i = buttons.length - 1; i >= 0; i--) {
    if (!isDismissButton(buttons[i])) {
      console.warn(
        `${LOG} không chữ nào khớp nút xác nhận → dùng nút cuối "${(buttons[i].textContent ?? "").trim()}"`,
      );
      return buttons[i];
    }
  }
  return null;
}

/**
 * Revoke 1 invite. Trả về ok=true nếu thành công, ok=false + reason nếu fail.
 * KHÔNG throw — caller iterate được qua list mà không bị break.
 */
export async function revokeInvite(
  email: string,
  verifyBudgetMs = VERIFY_DEFAULT_BUDGET_MS,
): Promise<RevokeResult> {
  console.log(`${LOG} start email=${email} (ngân sách xác minh ${verifyBudgetMs}ms)`);

  // v0.8.8: định vị row qua ô "Search for invites" (FAST + chính xác) thay vì
  // scroll-scan list virtualized vốn dễ MISS → kết luận nhầm notInPending →
  // fallback nhầm sang tab "Người dùng". Fallback scroll-scan nằm trong
  // locatePendingRow khi UI không có ô search.
  const row = await locatePendingRow(email);
  if (!row) {
    return {
      email,
      ok: false,
      notInPending: true,
      reason: `Row email không tìm thấy trên tab Lời mời (đã search + scroll-scan).`,
    };
  }

  const menuBtn = findRowMenuButton(row);
  if (!menuBtn) {
    return {
      email,
      ok: false,
      reason: "Không tìm thấy nút '...' trong row",
    };
  }

  await randomDelay(300, 800);
  await humanClick(menuBtn);

  // Đợi menu mở + tìm item "Thu hồi lời mời"
  let revokeItem: HTMLElement | null = null;
  try {
    revokeItem = await waitFor(() => {
      return findMenuItemByKey("menu_revoke_invite", REVOKE_MENU_ITEM_TEXTS, {
        page: "/admin/members",
      });
    }, 4000);
  } catch {
    // Close any opened menu để không kẹt UI
    document.body.click();
    return {
      email,
      ok: false,
      menuWithoutRevoke: true,
      reason: `Menu mở nhưng không có item "Thu hồi lời mời"`,
    };
  }

  await randomDelay(200, 600);
  await humanClick(revokeItem);

  // Hộp thoại xác nhận CÓ THỂ không xuất hiện (tuỳ phiên bản UI) → CHỜ RENDER
  // thay vì sleep cứng; hết giờ mà vẫn không có thì đi thẳng xuống bước chốt.
  const dbConfirm = dbLabelsFor("confirm_revoke_button", "/admin/members");
  const confirmTexts =
    dbConfirm.length > 0 ? [...dbConfirm, ...REVOKE_CONFIRM_TEXTS] : REVOKE_CONFIRM_TEXTS;
  let dialog: Element | null = null;
  try {
    dialog = await waitFor(
      () => document.querySelector('[role="dialog"]'),
      CONFIRM_DIALOG_WAIT_MS,
    );
  } catch {
    console.log(`${LOG} không có hộp thoại xác nhận → chốt thẳng`);
  }
  if (dialog) {
    const btn = findConfirmButton(dialog, confirmTexts);
    if (btn) {
      console.log(`${LOG} click confirm "${(btn.textContent ?? "").trim()}"`);
      await randomDelay(200, 500);
      await humanClick(btn);
    } else if (dbConfirm.length > 0) {
      reportLabelMismatch("confirm_revoke_button", dbConfirm[0], "/admin/members");
    }
  }

  // ---- (1) CHỜ CHATGPT XỬ LÝ XONG ----------------------------------------
  // Trước v0.11.7 chỗ này chỉ `waitFor(row biến mất, 5s)`: bấm xong là đo DOM
  // ngay trong lúc dialog CÒN QUAY. ChatGPT 2026-08 giữ dialog tới khi server
  // trả lời (xem remove/README v0.11.5) nên 5s đó đo đúng cái list CHƯA đổi →
  // vừa fail oan khi mạng chậm, vừa báo ok GIẢ nếu row rơi khỏi DOM vì re-render.
  // Nay đòi dialog TẮT HẲN (vắng 4 nhịp liên tiếp) + lớp phủ Radix gỡ xong rồi
  // mới đụng vào ô search.
  const commit = await waitForChatGptCommit(LOG, COMMIT_TIMEOUT_MS);
  if (!commit.settled) {
    return {
      email,
      ok: false,
      reason:
        `Dialog thu hồi KHÔNG đóng sau ${COMMIT_TIMEOUT_MS / 1000}s ` +
        `(${commit.busy ? "nút xác nhận vẫn đang quay" : "dialog đứng im"}) → ` +
        "ChatGPT có thể hỏi OTP/2FA hoặc báo lỗi." +
        (commit.dialogText ? ` Dialog: "${commit.dialogText.slice(0, 200)}"` : ""),
    };
  }

  // ---- (2) HỎI LẠI CHATGPT ĐỂ XÁC NHẬN ------------------------------------
  // Dialog đóng = ChatGPT NHẬN lệnh, KHÔNG bảo đảm đã thu hồi server-side (đúng
  // bài học của REMOVE: dialog đóng → báo COMPLETED → invite VẪN còn → DB lệch).
  //
  // Mỗi vòng tra phải là một lần HỎI MỚI (xoá ô tìm kiếm → chờ danh sách đầy lại
  // → gõ lại email), và phải đủ HAI vòng độc lập cùng không thấy mới dám kết
  // luận. Bản trước tra 3 lần bằng `locatePendingRow`, mà đường đó quét thẳng
  // DOM đang hiển thị khi danh sách gọn một trang — ba lần tra là đọc lại cùng
  // một dữ liệu cũ, ChatGPT chưa hề bị hỏi lại. Chi tiết + ca thật:
  // `verify-invite-gone.ts`.
  await sleep(VERIFY_SETTLE_MS); // để ChatGPT refetch list 1 nhịp trước khi tra
  const deadline = Date.now() + Math.max(10_000, verifyBudgetMs);
  const absence = await verifyInviteGone(email, deadline);
  if (absence.outcome === "gone") {
    console.log(`${LOG} OK email=${email} (đã biến mất khỏi tab Lời mời)`);
    return { email, ok: true };
  }
  if (absence.outcome === "still_there") {
    return {
      email,
      ok: false,
      reason:
        `Đã click thu hồi ${email} (dialog đã tắt hẳn) nhưng hỏi lại ChatGPT vẫn ` +
        `thấy lời mời trên tab "Lời mời đang chờ xử lý" → thu hồi CHƯA có hiệu ` +
        "lực (ChatGPT chặn/lỗi quyền). Cần thu hồi thủ công hoặc chờ retry.",
    };
  }
  return {
    email,
    ok: false,
    reason:
      `Đã click thu hồi ${email} (dialog đã tắt hẳn) nhưng KHÔNG kiểm chứng được ` +
      `lời mời đã biến mất chưa (${absence.reason}) → giữ nguyên trạng thái, sẽ ` +
      "thử lại ở lần sau thay vì đánh dấu đã thu hồi khi chưa chắc.",
  };
}
