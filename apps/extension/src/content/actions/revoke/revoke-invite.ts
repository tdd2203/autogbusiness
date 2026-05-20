/**
 * Revoke pending invite trên tab "Lời mời đang chờ xử lý" của /admin/members.
 *
 * Use case: sync detect được pending invite trên ChatGPT mà dashboard DB KHÔNG
 * track (= invite không qua dashboard, có thể do member tự mời trực tiếp trong
 * UI ChatGPT) → auto-revoke để dashboard là source of truth.
 *
 * Flow:
 *   1. Đảm bảo đang ở tab "Lời mời đang chờ xử lý" (sync.ts đã click tab này
 *      trong quá trình scrape — revoke chạy NGAY SAU scrape, vẫn còn tab open)
 *   2. Tìm row chứa email
 *   3. Click nút "..." menu trong row
 *   4. Click menu item "Thu hồi lời mời"
 *   5. Verify row biến mất / dialog confirm nếu có
 *
 * Selectors hiện tại heuristic — ChatGPT có thể đổi UI, cần inspect khi fail.
 */

import {
  humanClick,
  queryByText,
  randomDelay,
  sleep,
  waitFor,
} from "../../human";
import {
  REVOKE_CONFIRM_TEXTS,
  REVOKE_MENU_ITEM_TEXTS,
  findMenuItemByKey,
} from "../../i18n-ui";
import { dbLabelsFor, reportLabelMismatch } from "../../../shared/ui-labels";
import { findMemberRow, findRowMenuButton } from "../member-row";

/** Có thể có confirm dialog hoặc không — tuỳ ChatGPT. */
export type RevokeResult = {
  email: string;
  ok: boolean;
  reason?: string;
};

/**
 * Revoke 1 invite. Trả về ok=true nếu thành công, ok=false + reason nếu fail.
 * KHÔNG throw — caller iterate được qua list mà không bị break.
 */
export async function revokeInvite(email: string): Promise<RevokeResult> {
  console.log(`[autogpt-revoke] start email=${email}`);

  const row = findMemberRow(email);
  if (!row) {
    return {
      email,
      ok: false,
      reason: `Row email không tìm thấy trên tab Lời mời (đã scroll hết chưa?)`,
    };
  }

  const menuBtn = findRowMenuButton(row);
  if (!menuBtn) {
    return {
      email,
      ok: false,
      reason: "Không tìm thấy nút '...' trong row",
    };
  }

  await randomDelay(300, 800);
  await humanClick(menuBtn);

  // Đợi menu mở + tìm item "Thu hồi lời mời"
  let revokeItem: HTMLElement | null = null;
  try {
    revokeItem = await waitFor(() => {
      return findMenuItemByKey("menu_revoke_invite", REVOKE_MENU_ITEM_TEXTS, {
        page: "/admin/members",
      });
    }, 4000);
  } catch {
    // Close any opened menu để không kẹt UI
    document.body.click();
    return {
      email,
      ok: false,
      reason: `Menu mở nhưng không có item "Thu hồi lời mời"`,
    };
  }

  await randomDelay(200, 600);
  await humanClick(revokeItem);

  // Có thể có confirm dialog — đợi 1s rồi check
  await sleep(800);
  const dbConfirm = dbLabelsFor("confirm_revoke_button", "/admin/members");
  const confirmTexts =
    dbConfirm.length > 0 ? [...dbConfirm, ...REVOKE_CONFIRM_TEXTS] : REVOKE_CONFIRM_TEXTS;
  let confirmClicked = false;
  for (const text of confirmTexts) {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) break;
    const btn = queryByText("button", text, dialog);
    if (btn) {
      console.log(`[autogpt-revoke] click confirm "${text}"`);
      await randomDelay(200, 500);
      await humanClick(btn);
      confirmClicked = true;
      break;
    }
  }
  if (
    !confirmClicked &&
    dbConfirm.length > 0 &&
    document.querySelector('[role="dialog"]')
  ) {
    reportLabelMismatch("confirm_revoke_button", dbConfirm[0], "/admin/members");
  }

  // Verify row biến mất (tối đa 5s)
  try {
    await waitFor(
      () => (findMemberRow(email) ? null : document.body),
      5000,
    );
    console.log(`[autogpt-revoke] OK email=${email}`);
    return { email, ok: true };
  } catch {
    return {
      email,
      ok: false,
      reason: "Đã click revoke nhưng row vẫn còn sau 5s",
    };
  }
}
