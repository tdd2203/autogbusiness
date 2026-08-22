/**
 * Đưa trang về tab "Lời mời đang chờ xử lý" của /admin/members.
 *
 * Tách riêng vì có HAI đường vào cần nó:
 *   1. `executeRevokeInvites` — thu hồi lời mời (đường chính).
 *   2. `executeRemove` — FALLBACK khi email KHÔNG có ở tab "Người dùng": theo
 *      thứ tự user chốt 2026-08-21, tìm ở Người dùng trước, không thấy thì sang
 *      Lời mời đang chờ xử lý mà thu hồi.
 */

import { sleep } from "../../human";
import { TEXT_FALLBACKS } from "../../selectors";
import { clickTabAndWait } from "../sync";

export const PENDING_TAB_LOAD_WAIT_MS = 1500;

/**
 * Đảm bảo đang ở /admin/members, tab "Lời mời đang chờ xử lý".
 *
 *   - `waitForButtonMs=12000`: chờ thanh tab RENDER trước khi tìm/click. Từ
 *     v0.8.13 mỗi action mở tab /admin/members MỚI → content chạy ngay khi trang
 *     vừa load, nút tab có thể chưa render → không chờ sẽ fail tức thì.
 *   - `verifyTabParam="tab=invites"`: VERIFY URL đã đổi (retry 3 lần) để không
 *     kẹt ở tab Người dùng khi humanClick không trigger React onClick.
 *
 * Trả `false` nếu không sang được tab (caller tự quyết định báo lỗi thế nào).
 */
export async function ensurePendingInvitesTab(): Promise<boolean> {
  if (!location.pathname.includes("/admin/members")) {
    history.pushState({}, "", "/admin/members");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(PENDING_TAB_LOAD_WAIT_MS);
  }
  return clickTabAndWait(
    "tab_pending_invites",
    TEXT_FALLBACKS.tabPendingInvites,
    PENDING_TAB_LOAD_WAIT_MS,
    "tab=invites",
    12_000,
  );
}
