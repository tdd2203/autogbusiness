/**
 * Đưa trang về tab "Người dùng" của /admin/members.
 *
 * Hàng thẻ suất, nút "Quản lý số suất" và nút "Mời thành viên" chỉ có ở tab này;
 * `?tab=invites` / `?tab=requests` cùng nằm trên pathname `/admin/members` nên
 * `navigateTo` KHÔNG nhận ra là phải đổi tab (nó chỉ so pathname) — phải gỡ query
 * bằng tay rồi báo cho React vẽ lại.
 *
 * ⚠️ ĐẮT: một lượt quay về đây là ChatGPT truy vấn lại toàn bộ danh sách thành
 * viên (workspace vài trăm người thì mất vài giây). Chỉ gọi khi THẬT SỰ cần thứ
 * chỉ tab này có — đừng quay về "cho sạch URL".
 */

import { sleep } from "../../human";
import { navigateTo } from "../external-invites/navigate";

const MEMBERS_PATH = "/admin/members";

/** Trang đã ở /admin/members và render đủ để bấm. */
export function membersListReady(): boolean {
  if (!location.pathname.includes(MEMBERS_PATH)) return false;
  return document.querySelectorAll("button").length > 2;
}

/** URL đang đứng ở tab "Lời mời đang chờ" / "Yêu cầu" chứ không phải "Người dùng". */
export function onOtherMembersTab(): boolean {
  return /[?&]tab=(invites|requests)/.test(location.search);
}

export async function goToUsersTab(timeoutMs = 10_000): Promise<void> {
  await navigateTo(MEMBERS_PATH, membersListReady, timeoutMs);
  if (onOtherMembersTab()) {
    history.pushState({}, "", MEMBERS_PATH);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(1200);
  }
}
