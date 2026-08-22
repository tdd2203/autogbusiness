/**
 * Chức năng: MỜI LẠI HÀNG LOẠT (re-invite) cho các dòng đã tick ở tab "Chờ tham gia".
 *
 * Gọi POST /workspaces/{wsId}/members/re-invite-batch { member_ids } → backend gom
 * theo vai trò rồi enqueue task INVITE_MEMBER (payload.reinvite) — extension thu hồi
 * lời mời cũ rồi mời lại.
 *
 * Chỉ email CÒN HẠN được mời lại (MIỄN PHÍ). Email HẾT HẠN bị backend bỏ qua và trả
 * `skipped_expired` — lệnh hàng loạt KHÔNG bao giờ trừ ví / bật modal QR giữa chừng
 * (chốt user 2026-08-22). Muốn mời lại email hết hạn → dùng menu ⋯ từng dòng.
 *
 * `skipped_active` = email đang là thành viên thật (đồng bộ vẫn thấy) → không cần mời
 * lại. Nếu đồng bộ KHÔNG thấy (`sync_missing_at`) thì backend vẫn cho mời lại.
 */
import { api } from "../lib/api";

export type ReinviteBatchResult = {
  queue_item_ids: string[];
  count: number;
  /** Bị bỏ qua vì HẾT HẠN (mời lại sẽ tính phí → phải làm từng dòng). */
  skipped_expired: number;
  /** Bị bỏ qua vì đang là thành viên thật (đồng bộ vẫn thấy trong workspace). */
  skipped_active: number;
  /** id không thuộc workspace hoặc ngoài phạm vi nhìn thấy của tài khoản. */
  skipped_missing: number;
};

export function reinviteBatch(
  workspaceId: string,
  memberIds: string[],
): Promise<ReinviteBatchResult> {
  return api<ReinviteBatchResult>(
    `/api/v1/workspaces/${workspaceId}/members/re-invite-batch`,
    { method: "POST", body: JSON.stringify({ member_ids: memberIds }) },
  );
}

/** Gộp kết quả nhiều workspace (trang "Email đã thêm" chọn xuyên không gian). */
export function mergeReinviteBatch(
  results: ReinviteBatchResult[],
): ReinviteBatchResult {
  return results.reduce<ReinviteBatchResult>(
    (acc, r) => ({
      queue_item_ids: [...acc.queue_item_ids, ...r.queue_item_ids],
      count: acc.count + r.count,
      skipped_expired: acc.skipped_expired + r.skipped_expired,
      skipped_active: acc.skipped_active + r.skipped_active,
      skipped_missing: acc.skipped_missing + r.skipped_missing,
    }),
    {
      queue_item_ids: [],
      count: 0,
      skipped_expired: 0,
      skipped_active: 0,
      skipped_missing: 0,
    },
  );
}
