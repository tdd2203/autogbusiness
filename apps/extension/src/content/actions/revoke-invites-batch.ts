/**
 * Batch revoke handler chạy trên /admin/members tab "Lời mời đang chờ xử lý".
 * Wrap quanh revokeInvite — đảm bảo đúng tab + loop emails.
 */

import type { ExecuteActionResponse } from "../../shared/messages";
import { humanClick, queryByText, sleep } from "../human";
import { TEXT_FALLBACKS } from "../selectors";
import { revokeInvites } from "./revoke-invite";

const PENDING_TAB_LOAD_WAIT_MS = 1500;

export async function executeRevokeInvites(
  _taskId: string,
  emails: string[],
): Promise<ExecuteActionResponse> {
  if (emails.length === 0) {
    return { ok: true, data: { revoked: 0, failed: 0, results: [] } };
  }
  console.log(`[autogpt-revoke] batch: ${emails.length} emails`);

  // Đảm bảo đang ở /admin/members
  if (!location.pathname.includes("/admin/members")) {
    history.pushState({}, "", "/admin/members");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(PENDING_TAB_LOAD_WAIT_MS);
  }

  // Click tab "Lời mời đang chờ xử lý"
  let pendingTab: HTMLElement | null = null;
  for (const text of TEXT_FALLBACKS.tabPendingInvites) {
    const btn = queryByText("button", text);
    if (btn) {
      pendingTab = btn;
      break;
    }
  }
  if (!pendingTab) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        "Không tìm thấy tab 'Lời mời đang chờ xử lý' để revoke. URL hiện: " +
        location.pathname,
    };
  }
  await humanClick(pendingTab);
  await sleep(PENDING_TAB_LOAD_WAIT_MS);

  const results = await revokeInvites(emails);
  const revoked = results.filter((r) => r.ok).length;
  const failed = results.length - revoked;

  return {
    ok: true,
    data: { revoked, failed, results },
  };
}
