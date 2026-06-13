import { humanClick, queryByAnyText, randomDelay } from "../../human";
import { dbLabelsFor, reportLabelMismatch } from "../../../shared/ui-labels";
import { TEXT_FALLBACKS } from "../../selectors";

/**
 * Click nút "Thêm nhiều hơn" trong dialog invite để mở textarea/box độc lập
 * cho multi-email. Trả về true nếu click được, false nếu không tìm thấy
 * (dialog có thể đã ở chế độ multi sẵn).
 */
export async function clickAddMoreIfNeeded(): Promise<boolean> {
  const dialog = document.querySelector('[role="dialog"]');
  const root: ParentNode = dialog ?? document;
  const dbLabels = dbLabelsFor("invite_add_more_button", "/admin/members");
  const merged =
    dbLabels.length > 0
      ? [...dbLabels, ...TEXT_FALLBACKS.inviteAddMoreButton]
      : TEXT_FALLBACKS.inviteAddMoreButton;
  const btn =
    queryByAnyText("button", merged, root) ??
    queryByAnyText("a", merged, root);
  if (!btn && dbLabels.length > 0) {
    reportLabelMismatch("invite_add_more_button", dbLabels[0], "/admin/members");
  }
  if (btn) {
    console.log("[autogpt-invite] click add-more matched via text fallback");
    await humanClick(btn);
    await randomDelay(400, 900);
    return true;
  }
  console.log("[autogpt-invite] không tìm thấy nút 'Thêm nhiều hơn' — single mode");
  return false;
}
