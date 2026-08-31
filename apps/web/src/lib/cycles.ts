/** Chu kỳ thanh toán — tách ĐỢT THAM GIA từ danh sách kỳ của một email.
 *
 * Email hết hạn thì bị job gỡ khỏi team; mời lại sau đó là một ĐỢT tham gia mới.
 * Backend GIỮ kỳ của các đợt cũ (từ 31/8/2026) để khớp hoá đơn đã thu trong ví, nên
 * `member.cycles` có thể trải nhiều đợt cách nhau bởi khoảng hết hạn. Ranh giới đợt
 * KHÔNG nằm trong dữ liệu: nó lộ ra ở chỗ kỳ sau không nối liền kỳ trước.
 */
import type { SubscriptionCycle } from "../types";

/** Sai số cho phép khi coi hai mốc là "nối liền" (mốc chỉnh tay lệch vài giây). */
const JOIN_TOLERANCE_MS = 60_000;

/** Kỳ đã sắp theo số thứ tự (bản sao, không sửa mảng gốc). */
export function sortCycles(cycles: SubscriptionCycle[]): SubscriptionCycle[] {
  return [...cycles].sort((a, b) => a.cycle_number - b.cycle_number);
}

/** Kỳ này có MỞ ĐẦU một đợt tham gia mới không (so với hạn của kỳ ngay trước)?
 *
 *  Chỉ tính lệch MỘT CHIỀU — bắt đầu SAU hạn kỳ trước mới là khoảng ngừng. Kỳ chồng
 *  lấn (mốc chỉnh tay lùi lại) vẫn thuộc cùng đợt. Khớp `_starts_new_stint` backend. */
export function startsNewStint(
  prevEnd: string | null | undefined,
  start: string | null | undefined,
): boolean {
  if (!prevEnd || !start) return false;
  return (
    new Date(start).getTime() - new Date(prevEnd).getTime() > JOIN_TOLERANCE_MS
  );
}

/** Các kỳ thuộc ĐỢT HIỆN TẠI = chuỗi kỳ liền mạch cuối cùng. Trạng thái/tiến độ của
 *  GHẾ ĐANG DÙNG chỉ được tính trên đây — nợ của một đợt đã đóng không sống lại trên
 *  ghế mới (khớp `current_stint_cycles` phía backend). */
export function currentStintCycles(
  cycles: SubscriptionCycle[],
): SubscriptionCycle[] {
  const ordered = sortCycles(cycles);
  let start = 0;
  for (let i = 1; i < ordered.length; i++) {
    if (startsNewStint(ordered[i - 1].end_at, ordered[i].start_at)) start = i;
  }
  return ordered.slice(start);
}
