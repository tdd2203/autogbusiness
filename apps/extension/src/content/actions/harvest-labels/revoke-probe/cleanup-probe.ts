import { humanClick, queryByAnyText, sleep } from "../../../human";
import {
  REVOKE_CONFIRM_TEXTS,
  REVOKE_MENU_ITEM_TEXTS,
  findUiControlByTexts,
} from "../../../i18n-ui";
import { TEXT_FALLBACKS } from "../../../selectors";
import { findRowMenuButton } from "../../member-row";
import { step, type Ctx } from "../ctx";
import { pressEscape, waitForDialog, waitForMenu } from "../wait";
import { findPendingRows } from "./find-pending-rows";

/** Thực sự thu hồi probe invite (không chỉ ESC). */
export async function cleanupProbeInvite(ctx: Ctx, probeEmail: string): Promise<void> {
  await step(ctx, `Cleanup probe invite (${probeEmail.split("@")[0]}@…)`);

  // Đảm bảo đang ở tab Pending
  const pendingTab = findUiControlByTexts(TEXT_FALLBACKS.tabPendingInvites);
  if (pendingTab) {
    await humanClick(pendingTab);
    await sleep(1200);
  }

  // Tìm đúng row chứa probeEmail
  const rows = findPendingRows();
  const probeRow = rows.find((r) =>
    (r.textContent ?? "").toLowerCase().includes(probeEmail.toLowerCase()),
  );
  if (!probeRow) {
    console.warn("[autogpt-harvest] probe row không tìm thấy để cleanup");
    return;
  }
  const menuBtn = findRowMenuButton(probeRow);
  if (!menuBtn) return;
  await humanClick(menuBtn);
  await waitForMenu();
  await sleep(300);
  const revokeItem = queryByAnyText(
    '[role="menuitem"]',
    REVOKE_MENU_ITEM_TEXTS,
  );
  if (!revokeItem) {
    await pressEscape();
    return;
  }
  await humanClick(revokeItem);
  const cDialog = await waitForDialog(2500);
  if (cDialog) {
    // CLICK THẬT (không ESC) — đây là cleanup, cần revoke thật sự
    const cBtn = queryByAnyText("button", REVOKE_CONFIRM_TEXTS, cDialog);
    if (cBtn) {
      await humanClick(cBtn);
      await sleep(1500);
    }
  }
}
