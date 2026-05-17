import type {
  ExecuteActionRequest,
  ExecuteActionResponse,
} from "../shared/messages";
import { executeInvite } from "./actions/invite";
import { executeRemove } from "./actions/remove";
import { executeChangeRole } from "./actions/change-role";
import { executeSync } from "./actions/sync";
import { executeSyncBilling } from "./actions/sync-billing";

console.log("[autogpt-content] injected vào", location.href);

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
      return executeInvite(msg.taskId, msg.email, msg.role);
    case "REMOVE_MEMBER":
      return executeRemove(msg.taskId, msg.email);
    case "CHANGE_ROLE":
      return executeChangeRole(msg.taskId, msg.email, msg.new_role);
    case "SYNC_DATA":
      return executeSync(msg.taskId);
    case "SYNC_BILLING":
      return executeSyncBilling(msg.taskId);
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
