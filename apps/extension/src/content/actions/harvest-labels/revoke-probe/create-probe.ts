import {
  humanClick,
  humanType,
  queryByAnyText,
  sleep,
} from "../../../human";
import { findUiControlByTexts } from "../../../i18n-ui";
import { TEXT_FALLBACKS } from "../../../selectors";
import { step, type Ctx } from "../ctx";
import { pressEscape, waitForDialog, waitForDialogClose } from "../wait";

/**
 * Tạo invite probe (email fake) để có ít nhất 1 pending row → harvest revoke
 * labels được. Trả về email probe nếu tạo thành công, null nếu fail.
 *
 * Email format: `autogpt-probe-{timestamp}@example.com` — example.com là
 * domain reserved, ChatGPT accept format nhưng email không deliver.
 */
export async function createProbeInvite(
  ctx: Ctx,
): Promise<string | null> {
  await step(ctx, "Tạo probe invite tạm để harvest revoke labels");

  // Switch về tab active để mở dialog invite
  const activeTab = findUiControlByTexts(TEXT_FALLBACKS.tabActiveMembers);
  if (activeTab) {
    await humanClick(activeTab);
    await sleep(1000);
  }

  const inviteOpen = findUiControlByTexts(TEXT_FALLBACKS.inviteButtonOpen);
  if (!inviteOpen) return null;
  await humanClick(inviteOpen);
  const dialog = await waitForDialog(4000);
  if (!dialog) return null;

  // Tìm input email trong dialog
  const input =
    dialog.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'input[type="email"], textarea, input[type="text"]',
    );
  if (!input) {
    await pressEscape();
    return null;
  }

  const probeEmail = `autogpt-probe-${Date.now()}@example.com`;
  await humanType(input, probeEmail);
  await sleep(600);

  const submit = queryByAnyText(
    "button",
    TEXT_FALLBACKS.inviteSubmitButton,
    dialog,
  );
  if (!submit) {
    await pressEscape();
    return null;
  }
  await humanClick(submit);
  await sleep(2500); // chờ ChatGPT register invite + đóng dialog

  // Đảm bảo dialog đóng
  if (document.querySelector('[role="dialog"]')) {
    await pressEscape();
    await waitForDialogClose();
  }
  return probeEmail;
}
