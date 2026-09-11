import { normalizeMatchText } from "../human";

/**
 * Hộp thoại thứ HAI sau khi gỡ member: "Gỡ suất trả phí?" — mặc định GIỮ suất.
 *
 * ChatGPT (ảnh user 8/9/2026, bản en) bồi thêm một dialog NGAY SAU khi lệnh gỡ
 * member đã chạy xong:
 *
 *     Remove the paid seat?
 *     <tên> has been removed. Removing 1 Standard seat lowers your monthly bill
 *     by ₫286,550 starting September 11, 2026.
 *     ┌ Current monthly bill        389 Standard seats   ₫111,467,950
 *     └ After removal (monthly)     388 Standard seats   ₫111,181,400
 *     ⓘ The seat stays paid until renewal. You can review or undo this
 *       scheduled removal in Pending requests.
 *     [ Keep paid seat ]  [ Remove paid seat ]
 *
 * Hai lý do phải xử lý ở extension:
 *
 *   1. **Lệnh gỡ báo hỏng oan.** `waitForConfirmDialogClosed` chờ dialog vắng
 *      hẳn; dialog này ở lại → hết 30s → `VERIFY_FAILED` với lý do đoán mò
 *      "ChatGPT yêu cầu OTP/2FA", trong khi member ĐÃ bị gỡ xong.
 *   2. **Nguy cơ bấm nhầm nút đỏ.** `TEXT_FALLBACKS.confirmRemoveButton` có nhãn
 *      lỏng "Remove" và so khớp kiểu `startsWith` → "Remove paid seat" khớp.
 *      Bấm nhầm là workspace tụt suất đã mua, phải mua lại.
 *
 * Chính sách (user chốt 8/9 + 11/9/2026):
 *
 *   · GIỮA KỲ → **"Giữ suất"**. Suất đã trả tiền tới ngày gia hạn nên gỡ giữa kỳ
 *     không hoàn lại đồng nào, mà lại mất chỗ trống để chuyển người sang.
 *   · NGÀY CHỐT CHU KỲ → **"Gỡ suất"**. Gỡ suất ở hộp này có hiệu lực tại lần gia
 *     hạn kế tiếp — tức ngay hoá đơn kỳ mới — nên bớt đúng số người vừa gỡ, cùng
 *     một lý lẽ với đợt gỡ tại mốc 10h (giờ VN) của backend. Backend là nơi biết
 *     "hôm nay có phải ngày chốt": nó đính `release_paid_seat_until` (= giờ hoá
 *     đơn của mốc) vào lệnh gỡ, extension so lại đồng hồ đúng lúc hộp hiện ra
 *     (`releaseWindowOpen`). Không có mốc hoặc đã quá giờ ⇒ giữ như giữa kỳ.
 *
 * Nhãn nút gỡ suất vẫn là DENY-LIST đối với lệnh gỡ member (`confirmRemoveButton`
 * không bao giờ được khớp vào nó); chỉ `decidePaidSeatDialog` với `release: true`
 * mới chỉ vào nút đó, và chỉ khi nhận diện chắc chắn đây là hộp suất trả phí.
 *
 * Module thuần hàm (không đụng DOM) để test được bằng vitest — xem
 * [`paid-seat-guard.test.ts`](./paid-seat-guard.test.ts). Phần đọc/bấm DOM nằm ở
 * [`dialog-commit.ts`](./dialog-commit.ts).
 */

/**
 * Nhãn nút GIỮ suất — nút DUY NHẤT extension được phép bấm trong dialog này.
 * Nhãn đầy đủ xếp TRƯỚC nhãn ngắn (so khớp duyệt theo thứ tự, chấp cả `includes`).
 */
export const KEEP_PAID_SEAT_TEXTS = [
  "Keep paid seat",
  "Keep the paid seat",
  "Keep seat",
  "Giữ suất trả phí",
  "Giữ suất đã thanh toán",
  "Giữ ghế trả phí",
  "Giữ chỗ ngồi trả phí",
  "Giữ lại suất",
  "Giữ suất",
  "Giữ ghế",
  "保留付费席位",
  "保留席位",
] as const;

/**
 * Nhãn nút GỠ suất — DENY-LIST đối với lệnh gỡ member (không được lọt vào
 * `confirmRemoveButton`). Chỉ được bấm qua `decidePaidSeatDialog(..., {release})`
 * trong ngày chốt chu kỳ. Nhãn đầy đủ xếp TRƯỚC nhãn ngắn, như danh sách giữ.
 */
export const REMOVE_PAID_SEAT_TEXTS = [
  "Remove paid seat",
  "Remove the paid seat",
  "Remove seat",
  "Gỡ suất trả phí",
  "Gỡ bỏ suất trả phí",
  "Xoá suất trả phí",
  "Xoá suất đã thanh toán",
  "Gỡ ghế trả phí",
  "Gỡ bỏ suất",
  "Xoá suất",
  "Gỡ suất",
  "移除付费席位",
  "删除付费席位",
  "移除席位",
] as const;

/** Từ chỉ "suất/ghế" trong 3 locale. */
const SEAT_WORDS = ["suất", "ghế", "chỗ ngồi", "seat", "席位"] as const;

/**
 * Từ chỉ tiền/chu kỳ. Dialog gỡ member THƯỜNG (chỉ hỏi có chắc không) không có
 * chữ nào trong nhóm này, nên cặp "suất + tiền" là dấu hiệu phân biệt.
 */
const BILLING_WORDS = [
  "hoá đơn",
  "thanh toán",
  "gia hạn",
  "hàng tháng",
  "hằng tháng",
  "monthly bill",
  "monthly",
  "renewal",
  "renew",
  "billing",
  "账单",
  "续订",
  "续费",
  "每月",
] as const;

function containsAny(hay: string, needles: readonly string[]): boolean {
  return needles.some((n) => {
    const needle = normalizeMatchText(n);
    return needle !== "" && hay.includes(needle);
  });
}

/** Text này là nút "Giữ suất"? */
export function isKeepPaidSeatText(text: string): boolean {
  const hay = normalizeMatchText(text);
  return hay !== "" && containsAny(hay, KEEP_PAID_SEAT_TEXTS);
}

/** Text này là nút "Gỡ suất" (⇒ CẤM bấm)? */
export function isRemovePaidSeatText(text: string): boolean {
  const hay = normalizeMatchText(text);
  return hay !== "" && containsAny(hay, REMOVE_PAID_SEAT_TEXTS);
}

/**
 * Thân dialog nói chuyện suất + tiền? Đòi CẢ HAI nhóm từ để không vơ nhầm dialog
 * gỡ member thường ("Gỡ bỏ <tên> khỏi <workspace>?" — không có chữ nào về tiền).
 */
export function isPaidSeatDialogText(text: string): boolean {
  const hay = normalizeMatchText(text);
  if (!hay) return false;
  return containsAny(hay, SEAT_WORDS) && containsAny(hay, BILLING_WORDS);
}

/**
 * Vị trí nút "Giữ suất" trong danh sách nút của dialog, `-1` nếu không nhận ra.
 * Nút khớp deny-list bị loại TRƯỚC mọi so khớp khác — nhãn "Giữ" mà ChatGPT đặt
 * cho nút đỏ (hoặc label DB harvest nhầm) cũng không lọt qua được.
 */
export function pickKeepPaidSeatIndex(buttonTexts: readonly string[]): number {
  const safe = buttonTexts.map((t) => (isRemovePaidSeatText(t) ? null : t));
  // Khớp CHÍNH XÁC trước, rồi mới tới "chứa chuỗi" — tránh nhãn ngắn vơ nhầm.
  for (const label of KEEP_PAID_SEAT_TEXTS) {
    const needle = normalizeMatchText(label);
    if (!needle) continue;
    for (let i = 0; i < safe.length; i += 1) {
      const t = safe[i];
      if (t !== null && normalizeMatchText(t) === needle) return i;
    }
  }
  for (let i = 0; i < safe.length; i += 1) {
    const t = safe[i];
    if (t !== null && isKeepPaidSeatText(t)) return i;
  }
  return -1;
}

/**
 * Vị trí nút "Gỡ suất" — chỉ dùng khi ĐƯỢC PHÉP trả suất (ngày chốt). Khớp CHÍNH
 * XÁC trước rồi mới "chứa chuỗi", cùng cách với nút giữ.
 */
export function pickRemovePaidSeatIndex(buttonTexts: readonly string[]): number {
  for (const label of REMOVE_PAID_SEAT_TEXTS) {
    const needle = normalizeMatchText(label);
    if (!needle) continue;
    for (let i = 0; i < buttonTexts.length; i += 1) {
      if (normalizeMatchText(buttonTexts[i]) === needle) return i;
    }
  }
  for (let i = 0; i < buttonTexts.length; i += 1) {
    if (isRemovePaidSeatText(buttonTexts[i])) return i;
  }
  return -1;
}

/**
 * Còn trong cửa sổ trả suất không — `until` là giờ hoá đơn backend gửi kèm lệnh
 * (ISO), so với đồng hồ NGAY LÚC hộp hiện ra. Thiếu, hỏng, hoặc đã qua ⇒ false
 * (giữ suất — hướng an toàn).
 */
export function releaseWindowOpen(
  until: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (typeof until !== "string" || until === "") return false;
  const deadline = Date.parse(until);
  return Number.isFinite(deadline) && now < deadline;
}

/** Kết luận cho một dialog đang mở. */
export type PaidSeatDecision =
  /** Không phải hộp thoại suất trả phí — caller cứ chờ như cũ. */
  | { kind: "not_paid_seat" }
  /** Đúng là nó, và đã tìm ra nút giữ suất ở vị trí `index` → bấm nút đó. */
  | { kind: "keep"; index: number }
  /** Đúng là nó, ĐANG NGÀY CHỐT, và đã tìm ra nút gỡ suất ở vị trí `index`. */
  | { kind: "release"; index: number }
  /**
   * Đúng là nó nhưng KHÔNG nhận ra nút giữ suất (ChatGPT đổi nhãn) → TUYỆT ĐỐI
   * không bấm bừa. Caller để lệnh hết giờ và báo nguyên văn dialog ra ngoài, để
   * người dùng bấm tay và bổ sung nhãn.
   */
  | { kind: "unknown_labels"; buttons: string[] };

/**
 * Nhận diện dialog theo thân chữ + danh sách nút.
 *
 * Nhận là "đúng nó" khi thân chữ nói suất + tiền, HOẶC dialog có sẵn nút khớp
 * deny-list (ChatGPT đổi thân chữ nhưng giữ nhãn nút thì vẫn bắt được).
 *
 * `release: true` (ngày chốt chu kỳ) → chỉ vào nút GỠ suất. Không thấy nút gỡ thì
 * rơi về GIỮ chứ không bấm bừa: giữ oan một suất là trả thêm một tháng cho một
 * ghế, còn bấm nhầm nút lạ thì không biết hậu quả.
 */
export function decidePaidSeatDialog(
  dialogText: string,
  buttonTexts: readonly string[],
  opts: { release?: boolean } = {},
): PaidSeatDecision {
  const looks =
    isPaidSeatDialogText(dialogText) || buttonTexts.some(isRemovePaidSeatText);
  if (!looks) return { kind: "not_paid_seat" };
  if (opts.release) {
    const removeIndex = pickRemovePaidSeatIndex(buttonTexts);
    if (removeIndex >= 0) return { kind: "release", index: removeIndex };
  }
  const index = pickKeepPaidSeatIndex(buttonTexts);
  if (index >= 0) return { kind: "keep", index };
  return { kind: "unknown_labels", buttons: [...buttonTexts] };
}
