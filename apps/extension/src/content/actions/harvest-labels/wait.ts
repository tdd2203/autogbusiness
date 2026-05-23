import { sleep } from "../../human";

export async function pressEscape(): Promise<void> {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  document.body.click();
  await sleep(400);
}

export async function waitForDialog(timeoutMs = 4000): Promise<HTMLElement | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const d = document.querySelector<HTMLElement>('[role="dialog"]');
    if (d) return d;
    await sleep(150);
  }
  return null;
}

export async function waitForDialogClose(timeoutMs = 2500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!document.querySelector('[role="dialog"]')) return;
    await sleep(150);
  }
}

export async function waitForMenu(timeoutMs = 2500): Promise<HTMLElement | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const m = document.querySelector<HTMLElement>(
      '[role="menu"] [role="menuitem"], [role="menuitem"]',
    );
    if (m) return m;
    await sleep(150);
  }
  return null;
}
