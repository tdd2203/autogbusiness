/**
 * Dịch tiến trình lệnh từ ngôn ngữ kỹ thuật sang câu người dùng đọc được.
 *
 * Vì sao có (user 2026-08-30): extension báo tiến trình bằng đúng thứ nó đang
 * làm với DOM ChatGPT — "Đợi ChatGPT xác nhận 1 lời mời (tối đa 25s)...",
 * "Lọc theo tên: ...", "Click confirm Remove...". Người bấm lệnh không cần biết
 * extension đang gõ vào ô nào, họ chỉ cần biết lệnh đi tới đâu: kiểm tra suất →
 * đủ suất → đang mời → đã mời chờ xác nhận.
 *
 * Cách làm: BỎ HẲN `progress.message` do extension gửi, chỉ đọc `progress.phase`
 * rồi quy về một nhóm bước ngắn gọn. Phase lạ (extension mới hơn dashboard) rơi
 * về "Đang xử lý" — thà nói chung chung còn hơn xì chi tiết kỹ thuật ra.
 */
import type { QueueItem } from "../types";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** phase extension gửi → nhóm bước hiển thị (khoá i18n `step.<slug>`). */
const STEP_BY_PHASE: Record<string, string> = {
  // Chờ tới lượt chạy
  queued: "queued",
  rate_limit: "queued",
  // Mở/tải trang ChatGPT
  opening_tab: "opening",
  navigate: "opening",
  navigating: "opening",
  starting: "opening",
  "external-reload": "opening",
  // Suất
  "seat-check": "seatCheck",
  "seat-reload": "seatCheck",
  "seat-reload-verify": "seatCheck",
  "seat-repurchase": "seatBuying",
  charge_modal: "seatBuying",
  confirm_charge: "seatBuying",
  "seat-purchased": "seatReady",
  verify_seats: "seatReady",
  find_invoice: "invoice",
  payment_chain: "paying",
  // Tìm đúng người trong danh sách
  searching: "finding",
  locating: "finding",
  mapping: "finding",
  // Mời
  "opening-dialog": "inviting",
  "waiting-dialog": "inviting",
  "typing-email": "inviting",
  "add-row": "inviting",
  "submit-done": "invited",
  "f5-verify": "invited",
  "scan-pending": "invited",
  "external-restore": "invited",
  // ChatGPT im sau cú bấm Gửi → extension đi soi tab "Lời mời đang chờ xử lý"
  // rồi tab "Người dùng"; không thấy thì mời lại đúng một lần.
  "no-reply-check": "inviteRecheck",
  "re-invite": "inviteRetry",
  // Sửa thông tin thành viên (vai trò, giấy phép, giới hạn tín dụng...)
  opening: "updating",
  "opening-menu": "updating",
  "opening-dropdown": "updating",
  selecting: "updating",
  typing: "updating",
  saving: "updating",
  confirming: "updating",
  "batch-remove": "removing",
  // Quét danh sách rồi gửi về server
  discover: "reading",
  scraping: "reading",
  uploading: "saving",
  // Chốt kết quả
  verifying: "checking",
};

/**
 * Cùng một phase nhưng khác loại lệnh thì ý nghĩa khác hẳn: `verifying` của lệnh
 * mời là "đã mời xong, chờ ChatGPT xác nhận", còn của lệnh xoá là "kiểm tra đã
 * gỡ chưa". Bảng này đè lên bảng chung.
 */
const STEP_BY_TYPE_PHASE: Record<string, string> = {
  "INVITE_MEMBER:verifying": "invited",
  "INVITE_MEMBER:mapping": "invited",
  "REMOVE_MEMBER:navigating": "finding",
  "REMOVE_MEMBER:confirming": "removing",
  "SYNC_BILLING:scraping": "invoice",
  "PURCHASE_SEAT:navigate": "seatBuying",
};

/**
 * Số đếm `current/total`: chỉ có nghĩa khi nó đếm ĐẦU VIỆC (email, dòng danh
 * sách). Lệnh mua suất đếm bước thao tác nội bộ (qty + 4) nên đưa ra ngoài chỉ
 * làm người xem hoang mang.
 */
const NO_COUNTER_TYPES = new Set(["PURCHASE_SEAT"]);

/** Nhóm bước của một phase, hoặc null nếu phase lạ. */
export function progressStep(taskType: string, phase?: string | null): string | null {
  if (!phase) return null;
  return STEP_BY_TYPE_PHASE[`${taskType}:${phase}`] ?? STEP_BY_PHASE[phase] ?? null;
}

/**
 * Một dòng tiến trình gọn cho người dùng, ví dụ "Đã mời, chờ xác nhận" hay
 * "Đang gửi lời mời (2/5)". Trả null khi lệnh chưa thật sự chạy.
 */
export function progressLine(t: Translate, task: QueueItem): string | null {
  // Lệnh chưa được nhận: nhãn trạng thái cạnh đó đã nói "Chờ xử lý" rồi, thêm
  // một dòng nữa cùng nghĩa chỉ tổ rối.
  if (task.status !== "IN_PROGRESS") return null;

  const pr = task.progress;
  const step = progressStep(task.type, pr?.phase);
  const label = step ? t(`step.${step}`) : t("progress.IN_PROGRESS");

  const cur = typeof pr?.current === "number" ? pr.current : null;
  const total = typeof pr?.total === "number" ? pr.total : null;
  const showCounter =
    !NO_COUNTER_TYPES.has(task.type) && cur != null && total != null && total > 1;

  return showCounter ? `${label} (${cur}/${total})` : label;
}

/** Nhãn cho một mốc phase trong bảng phân rã thời lượng. */
export function phaseLabel(t: Translate, taskType: string, phase: string): string {
  const step = progressStep(taskType, phase);
  return step ? t(`step.${step}`) : phase;
}
