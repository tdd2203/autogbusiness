import type {
  ExecuteActionRequest,
  ExecuteActionResponse,
} from "../shared/messages";
import { loadBundleFromStorage } from "../shared/ui-labels";
import {
  executeInvite,
  executeVerifyPendingInvite,
  executeCheckActiveAfterInvite,
} from "./actions/invite";
import { executeSetExternalInvites } from "./actions/external-invites/execute-set-toggle";
import { executeRemove } from "./actions/remove";
import { executeMemberData } from "./actions/member-data";
import { executeSyncMember, executeSyncMembersBatch } from "./actions/sync-member";
import { executeChangeRole } from "./actions/change-role";
import { executeChangeLicenseType } from "./actions/change-license-type";
import { executeSetUsageLimit } from "./actions/set-usage-limit";
import { executeSync } from "./actions/sync";
import { executeSyncBilling } from "./actions/sync-billing";
import { executeRevokeInvites } from "./actions/revoke";
import { executeHarvestLabels } from "./actions/harvest-labels";
import { executePurchaseSeat } from "./actions/purchase-seat";

console.log("[autogpt-content] injected vào", location.href);

/**
 * ID của LẦN NẠP NÀY của content script, trả kèm mọi `PING`.
 *
 * Runner dùng nó để biết message tiếp theo sẽ tới trang MỚI hay trang cũ đang bị
 * Chrome đóng băng trong back/forward cache — trang trong bfcache vẫn trả lời
 * PING bằng `loadId` CŨ, gửi lệnh vào đó là mất kênh giữa chừng (4 ca thật, xem
 * `background/content-ready.ts`). Sinh mới mỗi lần script khởi tạo: mỗi lần nạp
 * trang là một instance khác, và inject lại bằng `executeScript` cũng vậy.
 */
const CONTENT_LOAD_ID =
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

// Lưu ý: KHÔNG hiện toast kết quả trên trang chatgpt.com nữa. Thông báo kết quả
// lệnh chỉ hiển thị ở web app (dashboard) để người thực thi theo dõi — tránh
// nhân đôi thông báo (xem yêu cầu user 2026-06-21). Content script chỉ trả
// ExecuteActionResponse về background; web app tự báo qua recent-tasks.

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
        const errResult: ExecuteActionResponse = {
          ok: false,
          error_code: "UNKNOWN",
          error_message: message,
        };
        sendResponse(errResult);
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
      return { ok: true, data: { url: location.href, loadId: CONTENT_LOAD_ID } };
    case "INVITE_MEMBER":
      return executeInvite(
        msg.taskId,
        msg.emails,
        msg.role,
        msg.verifiedDomain ?? null,
        msg.externalReady ?? false,
        msg.reinvite ?? false,
        msg.newSeatCount,
        msg.seatHint,
      );
    case "SET_EXTERNAL_INVITES":
      return executeSetExternalInvites(msg.enabled);
    case "VERIFY_PENDING_INVITE":
      return executeVerifyPendingInvite(msg.taskId, msg.emails, msg.role);
    case "CHECK_ACTIVE_AFTER_INVITE":
      return executeCheckActiveAfterInvite(msg.taskId, msg.emails);
    case "REMOVE_MEMBER":
      return executeRemove(msg.taskId, msg.email);
    case "EXPORT_MEMBER_DATA":
      return executeMemberData(msg.taskId, msg.email, "export");
    case "DELETE_MEMBER_DATA":
      return executeMemberData(msg.taskId, msg.email, "delete");
    case "SET_USAGE_LIMIT":
      return executeSetUsageLimit(
        msg.taskId,
        msg.email,
        msg.limit_credits,
        msg.old_limit_credits ?? null,
      );
    case "SYNC_MEMBER":
      return executeSyncMember(msg.taskId, msg.email);
    case "SYNC_MEMBERS_BATCH":
      return executeSyncMembersBatch(msg.taskId, msg.emails);
    case "CHANGE_ROLE":
      return executeChangeRole(msg.taskId, msg.email, msg.new_role, msg.old_role ?? null);
    case "CHANGE_LICENSE_TYPE":
      return executeChangeLicenseType(
        msg.taskId,
        msg.email,
        msg.new_license_type,
        msg.old_license_type ?? null,
      );
    case "SYNC_DATA": {
      const scope =
        msg.scope ?? (msg.includePending === false ? "members" : "both");
      return executeSync(msg.taskId, scope, msg.expectedLocale ?? null);
    }
    case "SYNC_BILLING":
      return executeSyncBilling(msg.taskId);
    case "REVOKE_INVITES":
      return executeRevokeInvites(msg.taskId, msg.emails);
    case "HARVEST_LABELS":
      return executeHarvestLabels(msg.taskId, msg.locale);
    case "PURCHASE_SEAT":
      return executePurchaseSeat(msg.taskId, msg.quantity, msg.skipToPayment === true);
    case "STRIPE_CLICK_LINK":
    case "STRIPE_SCRAPE_INVOICE_DETAIL":
    case "LINK_CONFIRM_PAYMENT":
      // Các message này dành cho content/stripe-invoice.ts + content/link-checkout.ts
      // (matches invoice.stripe.com / checkout.link.com). Nếu gửi nhầm vào
      // chatgpt.com content script → trả error rõ ràng.
      return {
        ok: false,
        error_code: "PAGE_NOT_ADMIN",
        error_message: `Message ${msg.kind} dành cho Stripe/Link content script, không phải chatgpt.com.`,
      };
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
