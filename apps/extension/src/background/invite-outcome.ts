/**
 * Quyết định KẾT CỤC của lệnh mời sau khi đã F5 + quét tab "Lời mời đang chờ xử lý".
 *
 * Tách khỏi `runner.ts` để test được bằng dữ liệu thuần — đây là chỗ từng gây mất
 * tiền nên phải khoá bằng test, không để lẫn trong hàm 200 dòng.
 *
 * ⚠️ BÀI HỌC (user 2026-08-04, ca stockbox.m):
 * Trước đây quét xong mà KHÔNG thấy email nào thì kết luận luôn FAILED. Backend
 * hiểu FAILED = mời hỏng → hoàn phí + xoá bản ghi. Nhưng tab "Lời mời" của ChatGPT
 * index TRỄ vài giây là chuyện thường, trong khi lời mời THẬT SỰ đã gửi (người nhận
 * vẫn vào được team) → email dùng miễn phí, sổ sách sai. "Không thấy" ≠ "không gửi".
 *
 * Nguyên tắc mới: chỉ kết luận hỏng khi CÓ BẰNG CHỨNG hỏng.
 *   - ChatGPT đã báo "đã gửi lời mời" (`submitEvidence === "toast"`) → dù chưa thấy
 *     email trong danh sách vẫn KHÔNG báo hỏng: trả COMPLETED + để email ở diện
 *     "chưa xác minh". Backend hoãn 10 phút rồi để đồng bộ phân xử; quá 20 phút vẫn
 *     không ai thấy email trong team thì resolver mới chốt hỏng + hoàn phí — lúc đó
 *     là quyết định có bằng chứng.
 *   - Không đọc được chữ xác nhận (chỉ thấy dialog đóng) → giữ hành vi cũ: quét sạch
 *     mà trắng tay thì báo hỏng ngay.
 * Cùng lý do: có bằng chứng toast thì KHÔNG dọn phantom (`shouldReconcile=false`) —
 * dọn = mark member 'removed', xoá mất bản ghi của một lời mời đang bay.
 */

export type SubmitEvidence = "toast" | "dialog_closed" | "unknown";

export type InviteOutcomeInput = {
  /** Bằng chứng ChatGPT đã nhận lệnh gửi (content trả về sau khi bấm Gửi). */
  submitEvidence: SubmitEvidence;
  /** Email THẤY trong tab "Lời mời đang chờ xử lý" (hoặc tab Người dùng). */
  verifiedEmails: string[];
  /** Email đã mời nhưng chưa thấy ở đâu cả. */
  unverifiedEmails: string[];
  /** Không quét được danh sách (không có dữ liệu để kết luận). */
  verifyScrapeFailed: boolean;
};

export type InviteOutcome = {
  status: "COMPLETED" | "FAILED";
  /** Có gọi reconcile-after-invite để mark phantom 'removed' hay không. */
  shouldReconcile: boolean;
  /** Vì sao — ghi vào log/result để truy vết sau này. */
  reason:
    | "verified"
    | "scrape-failed"
    | "trusted-toast"
    | "total-miss"
    | "nothing-to-do";
};

export function decideInviteOutcome(input: InviteOutcomeInput): InviteOutcome {
  const { submitEvidence, verifiedEmails, unverifiedEmails, verifyScrapeFailed } =
    input;

  // Không quét được → không có bằng chứng gì để kết luận: giữ nguyên mọi thứ,
  // SYNC_DATA sau sẽ đối soát (hành vi cũ, benefit-of-doubt).
  if (verifyScrapeFailed) {
    return { status: "COMPLETED", shouldReconcile: false, reason: "scrape-failed" };
  }
  if (unverifiedEmails.length === 0) {
    return {
      status: "COMPLETED",
      shouldReconcile: false,
      reason: verifiedEmails.length > 0 ? "verified" : "nothing-to-do",
    };
  }
  // ChatGPT đã xác nhận gửi → chưa thấy chỉ là index trễ, KHÔNG kết luận hỏng và
  // KHÔNG xoá bản ghi. Để backend/đồng bộ phân xử bằng thời gian.
  if (submitEvidence === "toast") {
    return { status: "COMPLETED", shouldReconcile: false, reason: "trusted-toast" };
  }
  // Thiếu MỘT PHẦN: phần thấy được là bằng chứng lệnh đã chạy → COMPLETED, phần
  // thiếu dọn phantom như cũ.
  if (verifiedEmails.length > 0) {
    return { status: "COMPLETED", shouldReconcile: true, reason: "verified" };
  }
  // Quét sạch, không thấy email nào, cũng không có xác nhận từ ChatGPT → hỏng thật.
  return { status: "FAILED", shouldReconcile: true, reason: "total-miss" };
}
