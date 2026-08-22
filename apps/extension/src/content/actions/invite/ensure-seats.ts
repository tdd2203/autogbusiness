/**
 * BƯỚC ĐẦU TIÊN của luồng mời (quy trình user 2026-08-22): kiểm tra số suất
 * còn trống, thiếu thì MUA BÙ, đủ rồi mới mời.
 *
 * Vì sao phải mua TRƯỚC khi mời: nếu mời khi thiếu suất, ChatGPT bật một modal
 * "Xem lại giao dịch mua" riêng với nút **"Mua suất người dùng và gửi lời mời"**
 * — mua suất VÀ gửi lời mời trong MỘT cú bấm. Extension không kiểm soát được
 * đường đó (không biết trước mua bao nhiêu, hết bao nhiêu tiền), nên ta chủ động
 * làm cho nó KHÔNG BAO GIỜ xuất hiện: đảm bảo đủ suất trước, rồi mới mở dialog
 * mời như bình thường.
 *
 * Workspace CHƯA được ChatGPT bật UI mới (không có nút "Quản lý số suất") →
 * bỏ qua toàn bộ bước này, mời y như trước.
 */

import { sleep } from "../../human";
import { checkSeatAvailability } from "../purchase-seat/check-seat-availability";
import {
  MAX_QUANTITY,
  POST_NAV_RENDER_MS,
  SEAT_SETTLE_AFTER_PURCHASE_MS,
} from "../purchase-seat/constants";
import { executePurchaseSeat } from "../purchase-seat/execute-purchase-seat";
import { navigateTo } from "../external-invites/navigate";

const LOG = "[autogpt-invite-seats]";
const MEMBERS_PATH = "/admin/members";
const BILLING_PATH = "/admin/billing";

export type EnsureSeatsResult = {
  /** false = KHÔNG được mời tiếp. */
  ok: boolean;
  /** true = workspace UI cũ, đã bỏ qua kiểm tra. */
  skipped: boolean;
  error_code?: "NOT_ENOUGH_SEATS" | "SEAT_CHECK_FAILED" | "SEAT_PURCHASE_FAILED";
  error_message?: string;
  /** Số liệu gắn vào result của task mời để dashboard ghi nhận. */
  data: Record<string, unknown>;
};

/** Trang phải ở tab "Người dùng" — hàng nút "Quản lý số suất" nằm trong tab đó. */
function membersListReady(): boolean {
  if (!location.pathname.includes(MEMBERS_PATH)) return false;
  return document.querySelectorAll("button").length > 2;
}

/**
 * Tải lại trang Thành viên để lấy số suất mới nhất.
 *
 * KHÔNG dùng `location.reload()`: content script bị huỷ giữa chừng, lời gọi từ
 * background treo rồi chết với CONTENT_TIMEOUT — trong khi tiền thì đã trừ xong.
 * Thay bằng điều hướng SPA sang trang admin khác rồi quay lại: React unmount/
 * mount lại trang Thành viên và gọi lại API số suất, mà content script vẫn sống
 * nên task chạy tiếp được tới bước mời.
 */
async function softReloadMembersPage(): Promise<void> {
  await navigateTo(
    BILLING_PATH,
    () => location.pathname.includes(BILLING_PATH),
    10_000,
  );
  await sleep(POST_NAV_RENDER_MS);
  await navigateTo(MEMBERS_PATH, membersListReady, 10_000);
  await sleep(POST_NAV_RENDER_MS);
}

/**
 * @param need số suất MỚI mà lần mời này cần (số email sắp mời).
 */
export async function ensureSeatsForInvite(
  taskId: string,
  need: number,
): Promise<EnsureSeatsResult> {
  // Hàng nút "Quản lý số suất" thuộc tab "Người dùng". Tiền tố "Mời lại" trước
  // đó có thể đã chuyển sang tab "Lời mời đang chờ" (?tab=invites) — kiểm tra ở
  // đó sẽ KHÔNG thấy nút rồi kết luận nhầm là "workspace UI cũ" và bỏ qua chốt
  // suất. Ép về URL sạch trước.
  await navigateTo(MEMBERS_PATH, membersListReady, 10_000);
  if (/[?&]tab=(invites|requests)/.test(location.search)) {
    history.pushState({}, "", MEMBERS_PATH);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(1200);
  }

  const check = await checkSeatAvailability();

  // ── Workspace UI cũ → giữ nguyên hành vi trước đây ──────────────────────
  if (!check.supported) {
    return {
      ok: true,
      skipped: true,
      data: { seat_check: "skipped_no_ui", seat_needed: need },
    };
  }

  // ── Modal còn treo → KHÔNG đi tiếp ──────────────────────────────────────
  // Lớp phủ của modal chặn mọi click phía sau: bấm "Quản lý số suất" để mua sẽ
  // trượt, mà mở dialog mời cũng trượt. Dừng sớm với thông báo rõ còn hơn để
  // các bước sau fail lung tung.
  if (!check.modalClosed) {
    return {
      ok: false,
      skipped: false,
      error_code: "SEAT_CHECK_FAILED",
      error_message:
        "Đã đọc suất nhưng KHÔNG đóng được modal 'Quản lý suất' — lớp phủ của nó chặn " +
        "mọi thao tác sau. Đóng modal trên ChatGPT rồi chạy lại task.",
      data: { seat_check: "modal_stuck", seat_needed: need },
    };
  }

  // ── Có UI mới nhưng đọc không ra số → KHÔNG mời ─────────────────────────
  // Mời mù khi không biết còn bao nhiêu suất chính là tình huống làm ChatGPT
  // bật modal "Mua suất người dùng và gửi lời mời". Thà dừng với thông báo rõ.
  if (!check.availability) {
    return {
      ok: false,
      skipped: false,
      error_code: "SEAT_CHECK_FAILED",
      error_message:
        `Không đọc được số suất còn trống: ${check.error ?? "?"} ` +
        "Dừng lại thay vì mời mù (mời khi thiếu suất sẽ kích hoạt luồng mua-kèm-mời của ChatGPT).",
      data: { seat_check: "failed", seat_needed: need },
    };
  }

  const before = check.availability;
  const baseData: Record<string, unknown> = {
    seat_check: "ok",
    seat_total: before.total,
    seat_assigned: before.assigned,
    seat_free: before.free,
    seat_needed: need,
  };
  console.log(
    `${LOG} cần ${need} suất, đang trống ${before.free}/${before.total} (đã gán ${before.assigned})`,
  );

  // ── Đủ suất → mời luôn ──────────────────────────────────────────────────
  if (before.free >= need) {
    return { ok: true, skipped: false, data: { ...baseData, seat_purchased: 0 } };
  }

  // ── Thiếu → mua bù ──────────────────────────────────────────────────────
  const shortfall = need - before.free;

  // Cap 20/task là chốt cứng mirror backend. Mua 20 khi cần 25 thì vẫn không
  // mời đủ — tiền mất mà việc không xong, nên dừng hẳn thay vì mua một phần.
  if (shortfall > MAX_QUANTITY) {
    return {
      ok: false,
      skipped: false,
      error_code: "NOT_ENOUGH_SEATS",
      error_message:
        `Thiếu ${shortfall} suất (cần ${need}, còn trống ${before.free}) — vượt hạn mức ` +
        `${MAX_QUANTITY} suất/lần. KHÔNG mua một phần. Chia nhỏ danh sách mời, hoặc mua suất thủ công trước.`,
      data: { ...baseData, seat_shortfall: shortfall, seat_purchased: 0 },
    };
  }

  console.log(`${LOG} thiếu ${shortfall} suất → mua bù trước khi mời`);
  const purchase = await executePurchaseSeat(taskId, shortfall);

  const purchaseData =
    purchase.ok && "data" in purchase
      ? ((purchase.data ?? {}) as Record<string, unknown>)
      : {};
  const charged = purchaseData.confirm_charge_clicked === true;

  if (!purchase.ok || !charged) {
    return {
      ok: false,
      skipped: false,
      error_code: "SEAT_PURCHASE_FAILED",
      error_message:
        `Cần mua thêm ${shortfall} suất trước khi mời nhưng không mua được: ` +
        (purchase.ok
          ? String(purchaseData.note ?? "luồng mua dừng trước bước xác nhận")
          : purchase.error_message ?? "?") +
        " — KHÔNG mời để tránh kích hoạt luồng mua-kèm-mời của ChatGPT.",
      data: {
        ...baseData,
        seat_shortfall: shortfall,
        seat_purchased: 0,
        seat_purchase: purchaseData,
      },
    };
  }

  // ── Mua xong: ĐỌC LẠI ĐÚNG MỘT LẦN ──────────────────────────────────────
  // Luồng mua báo ok nghĩa là "đã bấm Xác nhận mua và hộp đóng" — chưa chắc
  // ChatGPT đã cộng suất xong, nên vẫn phải xác nhận bằng mắt. Nhưng CHỈ đọc
  // MỘT lần: mở/đóng hộp nhiều lượt vừa chậm vừa thêm cơ hội hộp kẹt.
  await sleep(SEAT_SETTLE_AFTER_PURCHASE_MS);
  let recheck = await checkSeatAvailability();
  let after =
    recheck.availability && recheck.modalClosed ? recheck.availability : null;

  // Vẫn thiếu ở lần đọc đầu → nhiều khả năng trang còn giữ số cũ trong bộ nhớ
  // của React. TẢI LẠI TRANG MỘT LẦN rồi đọc lại. Đủ thì mời tiếp như thường.
  let reloadedOnce = false;
  if (!after || after.free < need) {
    reloadedOnce = true;
    console.log(`${LOG} đọc lần 1 vẫn thiếu → tải lại trang rồi đọc lại`);
    await softReloadMembersPage();
    recheck = await checkSeatAvailability();
    after =
      recheck.availability && recheck.modalClosed ? recheck.availability : null;
  }

  const purchasedData = {
    ...baseData,
    seat_shortfall: shortfall,
    seat_purchased: shortfall,
    seat_purchase: purchaseData,
    seat_total_after: after?.total ?? null,
    seat_assigned_after: after?.assigned ?? null,
    seat_free_after: after?.free ?? null,
    seat_reloaded_once: reloadedOnce,
  };

  if (!after || after.free < need) {
    return {
      ok: false,
      skipped: false,
      error_code: "SEAT_PURCHASE_FAILED",
      error_message:
        `ĐÃ MUA ${shortfall} suất (đã trừ tiền: ${String(purchaseData.charge_amount_text ?? "?")}) ` +
        `nhưng đọc lại (đã tải lại trang) vẫn thấy còn ${after?.free ?? "?"} suất trống, cần ${need}. ` +
        "KHÔNG mời. Kiểm tra ChatGPT rồi chạy lại task — lần sau sẽ thấy suất đã mua và không mua nữa.",
      data: purchasedData,
    };
  }

  console.log(
    `${LOG} mua xong ${shortfall} suất → còn trống ${after.free}/${after.total}, mời tiếp`,
  );
  return { ok: true, skipped: false, data: purchasedData };
}
