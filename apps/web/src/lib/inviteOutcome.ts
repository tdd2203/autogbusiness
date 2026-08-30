/**
 * Kết cục TỪNG EMAIL của một lệnh mời — đọc `task.result.invite_outcome`.
 *
 * Vì sao có (user 29/8/2026): banner kết quả cũ chỉ nói "verify 7/8" rồi cắt danh
 * sách còn 3 email → người dùng biết lệnh đã chạy xong nhưng KHÔNG biết email nào
 * mời được, email nào không. Backend (`queue/completion.py::_stamp_invite_outcome`)
 * đã chia sẵn ba nhóm loại trừ nhau; module này chỉ dịch chúng thành dòng để vẽ.
 *
 * Ba nhóm, đúng nghĩa backend đang dùng:
 *   - `invited`        ✓ lời mời đã có mặt thật trên ChatGPT, chờ người ta bấm nhận.
 *   - `failed`         ✗ đã chốt hỏng, bản ghi bị xoá. Tiền: xem `refunded` /
 *                        `seat_credit` (ca giữ tiền theo phiếu mà nói "đã hoàn phí"
 *                        là sai sổ).
 *   - `pending_verify` … đã bấm gửi nhưng ChatGPT chưa hiện ra để đối chiếu — CHƯA
 *                        phải hỏng, tuyệt đối không nhuộm đỏ.
 *
 * ⚠️ MÀN HÌNH CHỈ CÓ HAI LOẠI (user chốt 30/8/2026): `invited` và `pending_verify`
 * hiện CHUNG một trạng thái "Đã mời — đang chờ người nhận đồng ý". Người dùng hỏi
 * lệnh mời đúng một câu: gửi được hay không. Còn "đã tham gia chưa" là việc của lệnh
 * Đồng bộ, hỏi ở danh sách thành viên. Tách "đã xác minh" với "chờ xác minh" ra hai
 * nhãn là bắt đại lý học một khái niệm nội bộ của extension.
 *
 * Backend VẪN giữ ba nhóm — tiền đi theo chúng: chỉ `failed` mới được hoàn phí.
 *
 * ⚠️ KHÔNG dựng bảng dịch mã lỗi ở file này. Câu giải thích đến từ backend
 * (`services/task_errors.py` — bảng chữ cho đại lý chốt 28/8/2026) qua `reason_text`.
 * Bản đầu của file này có bảng riêng và lệch ngay: `NOT_ENOUGH_SEATS` bị chú thành
 * "workspace hết chỗ trống" (sai — mã đó nghĩa là thiếu quá 20 suất một lúc, hoặc
 * ChatGPT đòi mua-kèm-mời), còn `SEAT_PURCHASE_FAILED` thì thiếu hẳn nên ca mua suất
 * không thành hiện ra thành "ChatGPT không nhận lời mời này".
 *
 * Task cũ (trước bản này) không có `invite_outcome` → trả null, banner tự lùi về
 * dòng chữ tóm tắt như trước.
 */
import type { QueueItem } from "../types";

export type InviteRowKind = "invited" | "failed";

export type InviteOutcomeRow = {
  email: string;
  kind: InviteRowKind;
  /**
   * Key i18n cho dòng phụ dưới email. Nhóm hỏng chỉ mang chuyện TIỀN (mỗi email đi
   * một đường khác nhau); lý do hỏng là của CẢ NHÓM nên nằm ở `failureText` — lặp
   * một câu dài y hệt trên từng dòng vừa rối vừa đá nhau với dòng tiền.
   */
  noteKey?: string;
};

export type InviteOutcomeView = {
  rows: InviteOutcomeRow[];
  /** `sent` gộp cả email đã xác minh lẫn email chờ xác minh — xem ghi chú đầu file. */
  counts: { sent: number; failed: number };
  /** Xanh khi trọn vẹn, đỏ khi hỏng sạch, còn lại vàng. */
  tone: "success" | "warn" | "danger";
  /** Key i18n cho tiêu đề — đi theo kết cục, KHÔNG theo status của task. */
  titleKey: string;
  /** Lý do CHUNG của nhóm hỏng, câu sẵn từ backend. Nói MỘT lần ở đầu thẻ. */
  failureText?: string;
  /** Key i18n thay thế khi lệnh hỏng mà không mang mã lỗi nào. */
  failureKey?: string;
};

type RawOutcome = {
  invited?: unknown;
  failed?: unknown;
  pending_verify?: unknown;
  refunded?: unknown;
  seat_credit?: unknown;
  reason_code?: unknown;
  reason_text?: unknown;
};

function emailList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((e): e is string => typeof e === "string" && e.includes("@"));
}

export function readInviteOutcome(task: QueueItem): InviteOutcomeView | null {
  if (task.type !== "INVITE_MEMBER") return null;
  const raw = (task.result ?? {})["invite_outcome"] as RawOutcome | undefined;
  if (!raw || typeof raw !== "object") return null;

  const invited = emailList(raw.invited);
  const failed = emailList(raw.failed);
  const pending = emailList(raw.pending_verify);
  if (invited.length + failed.length + pending.length === 0) return null;

  const refunded = new Set(emailList(raw.refunded));
  const seatCredit = new Set(emailList(raw.seat_credit));

  const rows: InviteOutcomeRow[] = [
    ...[...invited, ...pending].map((email) => ({
      email,
      kind: "invited" as const,
      noteKey: "inviteOutcome.invited",
    })),
    ...failed.map((email) => ({
      email,
      kind: "failed" as const,
      // Không hoàn mà cũng không giữ phiếu (mời lại miễn phí, task không thu phí)
      // thì im lặng về tiền — bịa ra "đã hoàn phí" là sai sổ.
      noteKey: seatCredit.has(email)
        ? "inviteOutcome.money.seatCredit"
        : refunded.has(email)
          ? "inviteOutcome.money.refunded"
          : undefined,
    })),
  ];

  const counts = {
    sent: invited.length + pending.length,
    failed: failed.length,
  };
  const tone: InviteOutcomeView["tone"] =
    counts.failed === 0 ? "success" : counts.sent === 0 ? "danger" : "warn";
  const titleKey =
    tone === "success"
      ? "inviteOutcome.doneTitle"
      : tone === "danger"
        ? "inviteOutcome.failedTitle"
        : "inviteOutcome.partialTitle";

  const reasonText =
    typeof raw.reason_text === "string" && raw.reason_text.trim()
      ? raw.reason_text
      : undefined;

  return {
    rows,
    counts,
    tone,
    titleKey,
    ...(counts.failed > 0
      ? reasonText
        ? { failureText: reasonText }
        : { failureKey: "inviteOutcome.reason.default" }
      : {}),
  };
}
