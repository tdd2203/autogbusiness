import { sleep } from "../../../human";
import { CHARGE_DISMISS_TIMEOUT_MS } from "../constants";

/** Đợi modal review #2 đóng (dismissed) hoặc timeout. */
export async function waitForChargeModalDismiss(modal: HTMLElement): Promise<boolean> {
  const deadline = Date.now() + CHARGE_DISMISS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // Modal đã bị remove khỏi DOM, hoặc display=none, hoặc data-state=closed
    if (!document.body.contains(modal)) return true;
    const state = modal.getAttribute("data-state");
    if (state === "closed") return true;
    const style = window.getComputedStyle(modal);
    if (style.display === "none" || style.visibility === "hidden") return true;
    await sleep(300);
  }
  return false;
}
