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

/**
 * GHIM của từng email đang dán — những email KHÔNG đi theo đích của cả mẻ. Cả hai
 * loại đều là chỗ backend chặn cứng (409 cả nhóm), không phải tuỳ chọn:
 *
 *  - `seat`: email ĐANG GIỮ CHỖ (đã vào đội hoặc đang chờ nhận lời mời) ở một không
 *    gian → chỉ mời lại được vào đúng đó (`_assert_single_workspace`), và mời lại ở
 *    chính chỗ đó không tốn suất mới.
 *  - `home`: email ĐÃ TỪNG DÙNG một không gian → mời lại vào đúng chỗ cũ (chốt user
 *    2026-09-13, ca khách cũ CHATGPT PRO bị dồn vào GPT1). "Chỗ cũ" do backend chọn
 *    (`home_workspace_id`) bằng đúng hàm nó dùng để chặn — web không tự suy thứ tự
 *    ưu tiên, suy lệch một chút là trang ghim một chỗ còn backend đòi chỗ khác.
 *
 * Danh sách member chỉ phủ các không gian ĐÍCH; chỗ ngoài danh sách đích (đại lý
 * không đọc được member ở đó) chỉ lộ ra qua lịch sử email.
 */
export type EmailPinInput = {
  /** Member của các không gian đích, kể cả dòng đã gỡ. */
  members: { email: string; workspace_id: string; status: string }[];
  /** `/auto-invite/email-history` — map email (lowercase) → lịch sử. */
  history:
    | Record<
        string,
        {
          home_workspace_id?: string | null;
          workspaces: { workspace_id: string; holds_seat?: boolean }[];
        }
      >
    | undefined;
};

export type EmailPins = {
  seat: Map<string, string>;
  home: Map<string, string>;
};

export function buildEmailPins({ members, history }: EmailPinInput): EmailPins {
  const seatWs = new Map<string, string>();
  for (const m of members) {
    if (m.status === "removed") continue;
    seatWs.set(m.email.toLowerCase(), m.workspace_id);
  }
  const homeWs = new Map<string, string>();
  for (const [email, h] of Object.entries(history ?? {})) {
    const key = email.toLowerCase();
    const held = h.workspaces.find((w) => w.holds_seat);
    if (held && seatWs.has(key) === false) seatWs.set(key, held.workspace_id);
    if (h.home_workspace_id) homeWs.set(key, h.home_workspace_id);
  }
  return { seat: seatWs, home: homeWs };
}

/** Đích thật của 1 email: chỗ đang giữ > chỗ cũ > đích của cả mẻ. */
export function emailTargetWorkspace(
  email: string,
  pins: EmailPins,
  batchWs: string | undefined,
): string | undefined {
  const key = email.toLowerCase();
  return pins.seat.get(key) ?? pins.home.get(key) ?? batchWs;
}
