/**
 * Bật/tắt toggle "Cho phép lời mời ngoài tên miền" như một LỆNH RIÊNG do
 * background gọi — không phải một bước chen giữa lúc background đang chờ kết quả
 * mời.
 *
 * VÌ SAO TÁCH RA (ca 2a5d6450, 31/7/2026 — mất 340.000đ):
 * Trước đây `executeInvite` tắt toggle ngay trong khối `finally` của chính lần
 * mời: mời xong (đã bấm "Gửi lời mời", progress `submit-done` lúc 12:04:39) →
 * `setExternalInvites(false)` điều hướng sang `/admin/identity` → trang đang giữ
 * kênh message bị Chrome đẩy vào back/forward cache → kênh đứt → background
 * KHÔNG BAO GIỜ nhận được kết quả (12:04:44 task FAILED "message channel
 * closed"). Lời mời đã tới hộp thư người nhận thật, nhưng backend hiểu là hỏng:
 * hoàn 340.000đ + xoá bản ghi. Hôm sau chủ hệ thống phải thu lại tay và gán lại
 * chủ (audit `MEMBER_OWNER_CHANGED` 1/8 05:17).
 *
 * Nguyên tắc rút ra: **không để một round-trip nào mà kết quả TIỀN phụ thuộc vào
 * việc sống sót qua một lần điều hướng.** Nay thứ tự là: mời → quét tab Lời mời
 * (chuyển tab bằng click, SPA, không điều hướng thật) → TRẢ KẾT QUẢ VỀ →
 * background gọi lệnh này để tắt toggle. Lệnh này cũng điều hướng và cũng có thể
 * mất kênh, nhưng lúc đó kết quả mời đã nằm an toàn ở backend rồi: mất kênh ở
 * đây chỉ là "không xác nhận được đã tắt", background chỉ cảnh báo.
 *
 * ĐÁNH ĐỔI: toggle nằm ở ON thêm vài giây so với trước (khoảng thời gian quét tab
 * Lời mời + một round-trip). Spec bảo mật của user vẫn giữ nguyên — sau mỗi lần
 * mời là phải về OFF, chỉ muộn hơn một nhịp.
 */

import type { ExecuteActionResponse } from "../../../shared/messages";
import { navigateTo } from "./navigate";
import { setExternalInvites } from "./set-toggle";

const MEMBERS_PATH = "/admin/members";

/**
 * @param enabled trạng thái ĐÍCH của toggle.
 * @returns luôn `ok: true` khi chạy được tới cuối — kể cả không xác nhận được
 *   (`confirmed: false`): lệnh này là việc DỌN sau khi mời, không được phép làm
 *   task mời đổi kết luận. Background đọc `confirmed` để quyết định có cảnh báo.
 */
export async function executeSetExternalInvites(
  enabled: boolean,
): Promise<ExecuteActionResponse> {
  const r = await setExternalInvites(enabled);
  console.log(
    `[autogpt-external-invites] lệnh riêng: đặt toggle = ${enabled} → ` +
      `prev=${r.prev} changed=${r.changed} confirmed=${r.confirmed}`,
  );
  // Về /admin/members để task kế tiếp không phải tự điều hướng từ
  // /admin/identity. Không xong cũng không sao — `ensureAdminTab` của background
  // đưa tab về URL sạch trước mỗi lệnh.
  try {
    await navigateTo(
      MEMBERS_PATH,
      () => location.pathname.includes(MEMBERS_PATH),
      10_000,
    );
  } catch (e) {
    console.warn("[autogpt-external-invites] navigate về /admin/members fail", e);
  }
  return {
    ok: true,
    data: {
      external_invites_enabled: enabled,
      confirmed: r.confirmed,
      prev: r.prev,
      changed: r.changed,
    },
  };
}
