/**
 * Quyết định của bước "mua suất xong → tải lại trang → mời trong LƯỢT MỚI".
 *
 * Vì sao tách khỏi `runner.ts`: đây là chỗ đứng giữa TIỀN ĐÃ TRỪ và cú bấm mời
 * tiếp theo, mà `runner.ts` thì không test được (nó cần cả `chrome.tabs`, tab
 * thật, content script thật). Ba mệnh đề dưới đây phải luôn đúng, nên chúng nằm
 * ở đây dưới dạng hàm thuần và được khoá bằng test (`seat-reload-plan.test.ts`):
 *
 *   1. Lượt gọi lại KHÔNG BAO GIỜ được phép mua lần hai — hoặc bỏ hẳn bước suất
 *      (`seatsReady`), hoặc chỉ đọc kiểm (`seatsPurchasedAlready`), không bao
 *      giờ là một lượt mua mới.
 *   2. Số `seat_*` của lượt MUA phải sang được kết quả cuối. Lượt sau bỏ qua
 *      bước suất nên không tự sinh lại chúng; mất là dashboard tưởng lệnh này
 *      mua 0 suất trong khi thẻ đã bị trừ tiền (ca GPT1 26/8: ChatGPT lên 152,
 *      dashboard đứng 151).
 *   3. Tải lại trang mà không chốt được thì DỪNG TRƯỚC KHI MỜI, và câu báo lỗi
 *      phải nói rõ "đã mua N suất" — chưa ai được mời nên backend hoàn phí,
 *      còn suất đã mua vẫn nằm trong workspace cho lần chạy sau.
 *
 * Bối cảnh sinh ra cả cơ chế này: ba lệnh mời 26/8/2026 (fdeeadc5, cd03d5ff,
 * 3bc11c7b) chạy 4–5 phút trong MỘT lượt gọi content → service worker MV3 bị
 * Chrome khai tử giữa chừng, mang theo cả kênh chờ trả lời lẫn đồng hồ
 * `CONTENT_TIMEOUT` → không còn ai báo lỗi, task im tới lúc backend dọn ở 8'.
 */

import type { ExecuteActionRequest, ExecuteActionResponse } from "../shared/messages";
import { pickSeatFields } from "./invite-seat-fields";

/** Lệnh MỜI — nhánh duy nhất của union đi qua bước suất. */
type InviteRequest = Extract<ExecuteActionRequest, { kind: "INVITE_MEMBER" }>;

export type SeatReloadPlan =
  | { kind: "none" }
  | {
      kind: "reload";
      /** Số suất lượt trước đã mua (tiền đã trừ). */
      purchased: number;
      /** true = bộ đếm không chốt được tổng mới ⇒ lượt sau chỉ ĐỌC KIỂM. */
      recheck: boolean;
      /** `seat_*` của lượt mua, phải gắp sang kết quả cuối. */
      seatFields: Record<string, unknown>;
    };

/**
 * Content vừa mua suất xong và xin background tải lại trang chưa?
 *
 * Chỉ nhận đúng lệnh MỜI: `awaiting_seat_reload` là cờ của luồng mời. Task khác
 * (kể cả PURCHASE_SEAT, vốn có đường F5-kiểm-chứng riêng) không đi cửa này.
 */
export function planSeatReloadAfterPurchase(
  taskType: string,
  requestKind: string,
  response: ExecuteActionResponse,
): SeatReloadPlan {
  if (!response.ok) return { kind: "none" };
  if (taskType !== "INVITE_MEMBER" || requestKind !== "INVITE_MEMBER") {
    return { kind: "none" };
  }
  const data = (response as { data?: Record<string, unknown> }).data;
  if ((data as { awaiting_seat_reload?: boolean } | undefined)?.awaiting_seat_reload !== true) {
    return { kind: "none" };
  }
  const seatFields = pickSeatFields(data);
  const purchasedRaw = seatFields.seat_purchased;
  return {
    kind: "reload",
    purchased: typeof purchasedRaw === "number" && Number.isFinite(purchasedRaw)
      ? purchasedRaw
      : 0,
    recheck:
      (data as { seat_recheck_needed?: boolean } | undefined)?.seat_recheck_needed === true,
    seatFields,
  };
}

/**
 * Lệnh gửi lại sau khi background đã tải lại trang.
 *
 * ⚠️ Đây là chốt chặn "không mua lần hai". Hai đường, cả hai đều bịt đường mua:
 *   - `seatsReady`            → content BỎ HẲN bước suất (tổng mới đã chốt bằng
 *                               bộ đếm hộp mua ở lượt trước) và mời ngay;
 *   - `seatsPurchasedAlready` → content ĐỌC KIỂM lại số suất; thiếu thì dừng chứ
 *                               không mua bù (xem chốt `alreadyPurchased` trong
 *                               `ensure-seats.ts`).
 * Không bao giờ đặt cả hai: `seatsReady` bỏ qua bước suất nên sẽ nuốt luôn cờ
 * đọc kiểm, biến ca "chưa chốt được số" thành mời liều.
 *
 * `noSeatPurchase` (khoá suất của lệnh chạy song song) được giữ nguyên từ lệnh
 * gốc: tới được đây thì nó đã là `false` — lệnh nào còn giữ lease CHIA SẺ đã
 * dừng ở `SEAT_LOCK_REQUIRED` từ trước khi mua.
 */
export function seatReloadRetryRequest(
  request: InviteRequest,
  plan: Extract<SeatReloadPlan, { kind: "reload" }>,
): InviteRequest {
  return plan.recheck
    ? { ...request, seatsPurchasedAlready: plan.purchased }
    : { ...request, seatsReady: true };
}

/** Vì sao không mời được sau khi đã trừ tiền. */
export type SeatReloadFailure =
  /** Tải lại xong nhưng tab không còn ở /admin — nhiều khả năng đã logout. */
  | { reason: "off_admin"; url: string | null }
  /** Trang MỚI chưa chắc đã tiếp quản kênh — gửi lệnh mời vào đây là mời trong
   *  lúc mất kênh, đúng chuỗi tai nạn 31/7 (hoàn 340k oan). */
  | { reason: "stale_content" };

/**
 * Câu báo lỗi cho ca "đã trừ tiền mà chưa mời được".
 *
 * Bắt buộc mở đầu bằng số suất đã mua: task hỏng kiểu này thì thứ admin cần
 * biết đầu tiên là tiền đã đi bao nhiêu, và rằng KHÔNG phải mua lại lần sau.
 * `SEAT_RELOAD_FAILED` không kèm `submit_clicked` nên backend đi đường
 * `reconcile_failed_invite` = hoàn phí + dọn bản ghi chờ (completion.py).
 */
export function seatReloadFailureResponse(
  purchased: number,
  failure: SeatReloadFailure,
): ExecuteActionResponse {
  const bought = `ĐÃ MUA ${purchased} suất (tiền đã trừ trên ChatGPT)`;
  return {
    ok: false,
    error_code: "SEAT_RELOAD_FAILED",
    error_message:
      failure.reason === "off_admin"
        ? `${bought} nhưng khi tải lại /admin/members thì tab bị redirect khỏi /admin ` +
          `(url=${failure.url ?? "?"}) — có thể đã logout ChatGPT. CHƯA mời ai; ` +
          "suất đã mua vẫn còn đó, chạy lại lệnh mời."
        : `${bought}. Sau khi tải lại trang admin, extension không xác nhận được trang MỚI ` +
          "đã tiếp quản (trang cũ vẫn giữ kênh liên lạc). Đã dừng TRƯỚC khi mời — chưa " +
          "email nào được mời. Chạy lại lệnh mời; suất đã mua vẫn còn.",
  };
}
