/**
 * Batch revoke handler chạy trên /admin/members tab "Lời mời đang chờ xử lý".
 * Wrap quanh revokeInvite — đảm bảo đúng tab + loop emails.
 */

import type { ExecuteActionResponse } from "../../../shared/messages";
import { humanClick, sleep } from "../../human";
import { findControlByKey } from "../../i18n-ui";
import { TEXT_FALLBACKS } from "../../selectors";
import { executeRemove } from "../remove";
import { revokeInvites } from "./revoke-invites-loop";
import type { RevokeResult } from "./revoke-invite";

const PENDING_TAB_LOAD_WAIT_MS = 1500;

export async function executeRevokeInvites(
  taskId: string,
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
  const pendingTab = findControlByKey(
    "tab_pending_invites",
    TEXT_FALLBACKS.tabPendingInvites,
    { page: "/admin/members" },
  );
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

  // Fallback: email KHÔNG có trên tab "Lời mời" (notInPending) thường vì người đó
  // đã CHẤP NHẬN lời mời → trở thành active member, không còn pending invite để
  // thu hồi. Chuyển sang tab "Người dùng" và xoá họ khỏi workspace (executeRemove
  // tự click tab Người dùng + lọc/lật trang + confirm + verify).
  const toRemove = results.filter((r) => r.notInPending).map((r) => r.email);
  let removedViaFallback = 0;
  if (toRemove.length > 0) {
    console.log(
      `[autogpt-revoke] fallback REMOVE cho ${toRemove.length} email không có trên tab Lời mời:`,
      toRemove,
    );
    for (const email of toRemove) {
      const rm = await executeRemove(taskId, email);
      const idx = results.findIndex((r) => r.email === email);
      const merged: RevokeResult = rm.ok
        ? { email, ok: true, viaRemove: true }
        : {
            email,
            ok: false,
            viaRemove: true,
            reason: `Không có trên tab Lời mời; xoá khỏi tab Người dùng cũng thất bại: ${
              rm.error_message ?? rm.error_code ?? "unknown"
            }`,
          };
      if (idx >= 0) results[idx] = merged;
      else results.push(merged);
      if (rm.ok) removedViaFallback += 1;
      // Delay anti-bot giữa các thao tác destructive.
      await sleep(1000 + Math.floor(Math.random() * 2000));
    }
  }

  const revoked = results.filter((r) => r.ok && !r.viaRemove).length;
  const failed = results.filter((r) => !r.ok).length;

  return {
    ok: true,
    data: { revoked, removed: removedViaFallback, failed, results },
  };
}
