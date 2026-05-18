import type {
  ExecuteActionRequest,
  ExecuteActionResponse,
} from "../shared/messages";
import { loadBundleFromStorage } from "../shared/ui-labels";
import { executeInvite } from "./actions/invite";
import { executeRemove } from "./actions/remove";
import { executeChangeRole } from "./actions/change-role";
import { executeSync } from "./actions/sync";
import { executeSyncBilling } from "./actions/sync-billing";
import { executeRevokeInvites } from "./actions/revoke-invites-batch";
import { executeHarvestLabels } from "./actions/harvest-labels";

console.log("[autogpt-content] injected vào", location.href);

// Load calibrated UI label bundle ngay khi content script khởi động — actions
// dùng sync access (`dbLabelsFor`) nên cache phải sẵn trước khi dispatch task.
void loadBundleFromStorage().then((b) => {
  if (b) {
    console.log(
      `[autogpt-content] loaded ${countLabels(b.labels)} UI labels v${b.version}`,
    );
  } else {
    console.log("[autogpt-content] no UI label bundle yet — fall back text patterns");
  }
});

// Reload cache khi background refresh bundle
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("autogpt.uiLabels" in changes)) return;
  void loadBundleFromStorage();
});

function countLabels(
  labels: Record<string, Record<string, Record<string, unknown>>>,
): number {
  let n = 0;
  for (const byLocale of Object.values(labels)) {
    for (const byPage of Object.values(byLocale)) {
      n += Object.keys(byPage).length;
    }
  }
  return n;
}

chrome.runtime.onMessage.addListener(
  (msg: ExecuteActionRequest, _sender, sendResponse) => {
    (async () => {
      try {
        const result = await dispatch(msg);
        sendResponse(result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendResponse({
          ok: false,
          error_code: "UNKNOWN",
          error_message: message,
        } satisfies ExecuteActionResponse);
      }
    })();
    return true; // async response
  },
);

async function dispatch(
  msg: ExecuteActionRequest,
): Promise<ExecuteActionResponse> {
  switch (msg.kind) {
    case "PING":
      return { ok: true, data: { url: location.href } };
    case "INVITE_MEMBER":
      return executeInvite(msg.taskId, msg.emails, msg.role);
    case "REMOVE_MEMBER":
      return executeRemove(msg.taskId, msg.email);
    case "CHANGE_ROLE":
      return executeChangeRole(msg.taskId, msg.email, msg.new_role);
    case "SYNC_DATA":
      return executeSync(msg.taskId, msg.includePending !== false);
    case "SYNC_BILLING":
      return executeSyncBilling(msg.taskId);
    case "REVOKE_INVITES":
      return executeRevokeInvites(msg.taskId, msg.emails);
    case "HARVEST_LABELS":
      return executeHarvestLabels(msg.taskId, msg.locale);
    default: {
      const exhaustive: never = msg;
      return {
        ok: false,
        error_code: "UNKNOWN",
        error_message: `Unknown message: ${JSON.stringify(exhaustive)}`,
      };
    }
  }
}
