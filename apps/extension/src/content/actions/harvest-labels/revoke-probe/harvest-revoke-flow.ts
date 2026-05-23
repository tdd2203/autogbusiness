import { humanClick, queryByAnyText, randomDelay, sleep } from "../../../human";
import {
  REVOKE_CONFIRM_TEXTS,
  REVOKE_MENU_ITEM_TEXTS,
  findUiControlByTexts,
} from "../../../i18n-ui";
import { TEXT_FALLBACKS } from "../../../selectors";
import { findRowMenuButton } from "../../member-row";
import { recordIfText, step, type Ctx, type HarvestItem } from "../ctx";
import { pressEscape, waitForDialog, waitForDialogClose, waitForMenu } from "../wait";
import { cleanupProbeInvite } from "./cleanup-probe";
import { createProbeInvite } from "./create-probe";
import { findPendingRows } from "./find-pending-rows";

export async function harvestRevokeFlow(ctx: Ctx, out: HarvestItem[]): Promise<void> {
  await step(ctx, "Switch tab Pending → đọc menu Revoke");
  const pendingTab = findUiControlByTexts(TEXT_FALLBACKS.tabPendingInvites);
  if (!pendingTab) return;
  await humanClick(pendingTab);
  await sleep(1500);

  let pendingRows = findPendingRows();
  let probeEmail: string | null = null;

  if (pendingRows.length === 0) {
    // Auto-tạo probe invite để có row mà harvest
    probeEmail = await createProbeInvite(ctx);
    if (!probeEmail) {
      await step(ctx, "⚠ Không tạo được probe invite (skip revoke labels)");
      return;
    }

    // Switch lại tab Pending
    const pendingTab2 = findUiControlByTexts(TEXT_FALLBACKS.tabPendingInvites);
    if (pendingTab2) {
      await humanClick(pendingTab2);
      await sleep(1800);
    }
    pendingRows = findPendingRows();
  }

  const pendingRow =
    (probeEmail
      ? pendingRows.find((r) =>
          (r.textContent ?? "").toLowerCase().includes(probeEmail.toLowerCase()),
        )
      : pendingRows[0]) ?? pendingRows[0] ?? null;

  if (!pendingRow) {
    await step(ctx, "⚠ Probe đã tạo nhưng row chưa xuất hiện (skip)");
    if (probeEmail) await cleanupProbeInvite(ctx, probeEmail);
    return;
  }

  const pMenuBtn = findRowMenuButton(pendingRow);
  if (!pMenuBtn) {
    if (probeEmail) await cleanupProbeInvite(ctx, probeEmail);
    return;
  }
  await humanClick(pMenuBtn);
  await waitForMenu();
  await sleep(300);

  const revokeItem = queryByAnyText('[role="menuitem"]', REVOKE_MENU_ITEM_TEXTS);
  recordIfText(out, ctx, "menu_revoke_invite", revokeItem);

  if (revokeItem) {
    await randomDelay(250, 500);
    await humanClick(revokeItem);
    const cDialog = await waitForDialog(2500);
    if (cDialog) {
      const cBtn = queryByAnyText("button", REVOKE_CONFIRM_TEXTS, cDialog);
      recordIfText(out, ctx, "confirm_revoke_button", cBtn);
      // Nếu là probe → click thật để cleanup. Nếu invite thật → ESC để không xóa.
      if (probeEmail && cBtn) {
        await step(ctx, "Cleanup: thu hồi probe (click confirm thật)");
        await humanClick(cBtn);
        await sleep(1500);
      } else {
        await pressEscape();
        await waitForDialogClose();
      }
    } else {
      await pressEscape();
    }
  } else {
    await pressEscape();
    // Vẫn cần cleanup probe nếu tạo
    if (probeEmail) await cleanupProbeInvite(ctx, probeEmail);
  }
}
