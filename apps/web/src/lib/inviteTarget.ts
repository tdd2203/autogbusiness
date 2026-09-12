/**
 * ĐÍCH CỦA CẢ MẺ trên trang "Mời thành viên" — một lần mời thì mọi email trong danh
 * sách đang dán đi vào CÙNG MỘT không gian (chốt user 2026-09-12).
 *
 * Trước đây mỗi dòng tự chọn không gian bằng dropdown trong bảng, email mới còn bị
 * bốc ngẫu nhiên — dán 20 email là khách nằm rải ra mấy chỗ, không nơi nào đủ đông.
 * Giờ chọn một lần ở dải suất đầu thẻ mời và áp cho cả mẻ.
 *
 * MẶC ĐỊNH là không gian ĐÔNG THÀNH VIÊN NHẤT trong số còn nhận được email: dồn
 * khách về một chỗ thì mới mua suất theo lô được. Hoà nhau thì giữ thứ tự danh sách
 * đích, để hai lần dựng liên tiếp không nhảy qua nhảy lại.
 *
 * Hàm thuần, không biết React lẫn i18n.
 */
export type BatchWorkspaceInput = {
  /** Không gian người dùng tự chọn ở dải suất. null = chưa đụng tới. */
  picked: string | null;
  /** Toàn bộ không gian đích được cấp (theo thứ tự hiển thị). */
  eligibleIds: string[];
  /** Phần còn NHẬN ĐƯỢC email (đã loại chỗ chạm trần thành viên). */
  invitableIds: string[];
  /** Số người đang chiếm chỗ ở 1 không gian (thành viên + lời mời đang chờ). */
  memberCount: (workspaceId: string) => number;
};

/**
 * Không gian đích của cả mẻ. `undefined` khi tài khoản chưa được cấp chỗ nào.
 *
 * Lựa chọn của người dùng THẮNG, nhưng chỉ khi còn nằm trong danh sách được cấp:
 * đổi nhánh ChatGPT/Canva hay bị admin rút quyền thì lựa chọn cũ phải rụng, không
 * được để nó kéo cả mẻ vào một chỗ không còn mời được.
 */
export function pickBatchWorkspace({
  picked,
  eligibleIds,
  invitableIds,
  memberCount,
}: BatchWorkspaceInput): string | undefined {
  if (picked && eligibleIds.includes(picked)) return picked;
  // Chạm trần HẾT thì quay về danh sách đầy đủ: thà để backend trả đúng câu "tạm
  // ngưng add" còn hơn trả undefined rồi trang không mời được gì.
  const pool = invitableIds.length > 0 ? invitableIds : eligibleIds;
  let best: string | undefined;
  let bestCount = -1;
  for (const id of pool) {
    const n = memberCount(id);
    if (n > bestCount) {
      bestCount = n;
      best = id;
    }
  }
  return best;
}
