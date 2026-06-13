import { queryByAnyText, querySelectorFirst } from "../../../human";
import { dbLabelsFor, reportLabelMismatch } from "../../../../shared/ui-labels";
import { SELECTORS, TEXT_FALLBACKS } from "../../../selectors";

export function findInviteSubmitButton(): HTMLElement | null {
  const bySel = querySelectorFirst<HTMLElement>(SELECTORS.inviteSubmitButton);
  if (bySel) {
    console.log("[autogpt-invite] submit button matched via selector");
    return bySel;
  }
  // Text fallback CHỈ tìm trong dialog để tránh click nhầm nút "Mời" mở dialog.
  const dialog = document.querySelector('[role="dialog"]');
  const root: ParentNode = dialog ?? document;
  const dbLabels = dbLabelsFor("invite_submit_button", "/admin/members");
  const merged =
    dbLabels.length > 0
      ? [...dbLabels, ...TEXT_FALLBACKS.inviteSubmitButton]
      : TEXT_FALLBACKS.inviteSubmitButton;
  const byText = queryByAnyText("button", merged, root);
  if (byText) {
    console.log("[autogpt-invite] submit matched via text/DB fallback");
    return byText;
  }
  if (dbLabels.length > 0) {
    reportLabelMismatch("invite_submit_button", dbLabels[0], "/admin/members");
  }
  return null;
}
