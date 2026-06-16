import type { Query } from "@tanstack/react-query";
import type { QueueItem } from "../types";

/**
 * Poll thông minh cho các query danh sách /queue.
 *
 * Bối cảnh: trước đây các query này `refetchInterval` cứng 2s/5s, chạy KHÔNG
 * NGỪNG kể cả khi chẳng có task nào — 40 tab idle vẫn nã backend ~28 req/s vô
 * ích. Helper này cho interval phụ thuộc trạng thái: poll nhanh khi còn task
 * đang chạy, giãn/dừng khi tất cả đã xong.
 *
 * Task "đang chạy" = PENDING (chờ extension nhận qua SSE) hoặc IN_PROGRESS
 * (extension đang thực thi). COMPLETED/FAILED là trạng thái cuối → ngừng.
 *
 * React Query gọi lại callback này sau mỗi lần fetch, nên khi mutation tạo task
 * invalidate query → refetch → data có task PENDING → poll tự bật lại ngay.
 */
export function hasActiveTask(items: QueueItem[] | undefined): boolean {
  return !!items?.some(
    (it) => it.status === "PENDING" || it.status === "IN_PROGRESS",
  );
}

/**
 * Trả về callback `refetchInterval` cho useQuery.
 *
 * @param activeMs  Nhịp poll khi còn task đang chạy (giữ nguyên giá trị cũ).
 * @param idleMs    Khi không còn task chạy:
 *                  - `false` (mặc định): DỪNG hẳn. Dùng cho query banner tiến
 *                    trình (recent-tasks) vì task luôn được tạo trong cùng tab
 *                    → mutation invalidate sẽ bật lại tức thì, idle = 0 request.
 *                  - một số ms (vd 15000): nhịp tim chậm. Dùng cho trang theo
 *                    dõi queue để vẫn bắt được task do người/tab khác tạo,
 *                    nhưng không còn nã nhanh lúc rảnh.
 */
export function queuePollInterval(activeMs: number, idleMs: number | false = false) {
  return (query: Query<QueueItem[], Error, QueueItem[]>) =>
    hasActiveTask(query.state.data) ? activeMs : idleMs;
}
