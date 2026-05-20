/**
 * Background orchestrator cho PURCHASE_SEAT payment chain.
 *
 * Sau khi content script chatgpt.com (purchase-seat.ts) hoàn tất Phase 1
 * (modal #1 + modal #2 → tạo invoice "Đến hạn") + Phase 2 (tab=invoices →
 * extract Stripe URL "Xem"), nó gọi `runPaymentChain` qua chrome.runtime
 * sendMessage. Background:
 *
 *   1. Mở tab MỚI với Stripe invoice URL.
 *   2. Đợi tab load + content stripe-invoice.ts inject (auto qua manifest).
 *   3. sendMessage `STRIPE_CLICK_LINK` → Stripe content click button "Link"
 *      → popup checkout.link.com mở (window mới).
 *   4. Đợi tab/window có hostname `checkout.link.com` xuất hiện.
 *   5. sendMessage `LINK_CONFIRM_PAYMENT` với expectedAmountText → Link
 *      content verify amount + click "Thanh toán {amount}".
 *   6. Trả kết quả ghép (stripe + link) về caller.
 *
 * Tất cả wait có timeout — chain hỏng (Stripe đổi UI, popup blocked, etc) →
 * return error chi tiết để purchase-seat.ts surface lên task result.
 */

import type {
  ExecuteActionRequest,
  ExecuteActionResponse,
} from "../shared/messages";

const STRIPE_HOST = "invoice.stripe.com";
const LINK_HOST = "checkout.link.com";

const STRIPE_TAB_OPEN_TIMEOUT_MS = 15_000;
const STRIPE_CONTENT_READY_TIMEOUT_MS = 12_000;
const LINK_TAB_OPEN_TIMEOUT_MS = 12_000;
const LINK_CONTENT_READY_TIMEOUT_MS = 12_000;

export type PaymentChainOptions = {
  taskId: string;
  stripeInvoiceUrl: string;
  expectedAmountText: string;
};

export type PaymentChainResult = {
  ok: boolean;
  stage: "stripe_open" | "stripe_click_link" | "link_open" | "link_confirm" | "done";
  stripe_result?: ExecuteActionResponse;
  link_result?: ExecuteActionResponse;
  error_code?: string;
  error_message?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForTabUrl(
  predicate: (tab: chrome.tabs.Tab) => boolean,
  timeoutMs: number,
): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const cleanup = (): void => {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onCreated.removeListener(onCreated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
    const onCreated = (tab: chrome.tabs.Tab): void => {
      if (predicate(tab)) {
        cleanup();
        resolve(tab);
      }
    };
    const onUpdated = (
      _id: number,
      _info: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ): void => {
      if (predicate(tab)) {
        cleanup();
        resolve(tab);
      }
    };
    chrome.tabs.onCreated.addListener(onCreated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    // Cũng scan existing tabs ngay
    chrome.tabs.query({}).then((tabs) => {
      for (const t of tabs) {
        if (predicate(t)) {
          cleanup();
          resolve(t);
          return;
        }
      }
    });
    setTimeout(() => {
      if (resolved) return;
      cleanup();
      resolve(null);
    }, timeoutMs);
  });
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const cleanup = (): void => {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onUpdated.removeListener(listener);
    };
    const listener = (
      id: number,
      info: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ): void => {
      if (id !== tabId) return;
      if (info.status !== "complete") return;
      cleanup();
      resolve(tab);
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Check ngay nếu tab đã complete
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        cleanup();
        resolve(tab);
      }
    });
    setTimeout(() => {
      if (resolved) return;
      cleanup();
      chrome.tabs.get(tabId).then(resolve).catch(() => resolve(null));
    }, timeoutMs);
  });
}

async function pingContent(tabId: number): Promise<boolean> {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { kind: "PING" });
    return Boolean(r?.ok);
  } catch {
    return false;
  }
}

async function waitForContentReady(
  tabId: number,
  timeoutMs: number,
  injectFiles?: string[],
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingContent(tabId)) return true;
    await sleep(400);
  }
  // Fallback: inject content script manually
  if (injectFiles && injectFiles.length > 0) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: injectFiles });
    } catch (e) {
      console.warn("[autogpt-payment] inject fallback failed:", e);
    }
    for (let i = 0; i < 5; i++) {
      await sleep(500);
      if (await pingContent(tabId)) return true;
    }
  }
  return false;
}

function findContentScriptFiles(matchHostname: string): string[] {
  const manifest = chrome.runtime.getManifest();
  const scripts = (manifest.content_scripts ?? []) as Array<{
    matches?: string[];
    js?: string[];
  }>;
  const entry = scripts.find((cs) =>
    (cs.matches ?? []).some((m) => m.includes(matchHostname)),
  );
  return entry?.js ?? [];
}

export async function runPaymentChain(
  opts: PaymentChainOptions,
): Promise<PaymentChainResult> {
  console.log(
    `[autogpt-payment] runPaymentChain start: url=${opts.stripeInvoiceUrl}, expected=${opts.expectedAmountText}`,
  );

  // Stage 1: mở Stripe tab
  let stripeTab: chrome.tabs.Tab;
  try {
    stripeTab = await chrome.tabs.create({
      url: opts.stripeInvoiceUrl,
      active: true,
    });
  } catch (e) {
    return {
      ok: false,
      stage: "stripe_open",
      error_code: "UNKNOWN",
      error_message: `Không mở được Stripe tab: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (stripeTab.id === undefined) {
    return {
      ok: false,
      stage: "stripe_open",
      error_code: "UNKNOWN",
      error_message: "chrome.tabs.create trả tab không có id",
    };
  }
  const stripeTabId = stripeTab.id;

  // Đợi load
  const loaded = await waitForTabComplete(stripeTabId, STRIPE_TAB_OPEN_TIMEOUT_MS);
  if (!loaded || !loaded.url?.includes(STRIPE_HOST)) {
    return {
      ok: false,
      stage: "stripe_open",
      error_code: "TIMEOUT",
      error_message: `Stripe tab không load tới ${STRIPE_HOST} sau ${STRIPE_TAB_OPEN_TIMEOUT_MS / 1000}s. URL: ${loaded?.url}`,
    };
  }

  // Đợi content script ready
  const stripeReady = await waitForContentReady(
    stripeTabId,
    STRIPE_CONTENT_READY_TIMEOUT_MS,
    findContentScriptFiles(STRIPE_HOST),
  );
  if (!stripeReady) {
    return {
      ok: false,
      stage: "stripe_open",
      error_code: "CONTENT_NOT_INJECTED",
      error_message: `Stripe content script không ready sau ${STRIPE_CONTENT_READY_TIMEOUT_MS / 1000}s.`,
    };
  }

  // Stage 2: click Link button trên Stripe
  let stripeResult: ExecuteActionResponse;
  try {
    stripeResult = await chrome.tabs.sendMessage(stripeTabId, {
      kind: "STRIPE_CLICK_LINK",
      taskId: opts.taskId,
      expectedAmountText: opts.expectedAmountText,
    } satisfies ExecuteActionRequest);
  } catch (e) {
    return {
      ok: false,
      stage: "stripe_click_link",
      error_code: "UNKNOWN",
      error_message: `Lỗi gửi STRIPE_CLICK_LINK: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!stripeResult.ok) {
    return {
      ok: false,
      stage: "stripe_click_link",
      stripe_result: stripeResult,
      error_code: stripeResult.error_code,
      error_message: stripeResult.error_message,
    };
  }

  // Stage 3: đợi Link popup mở
  const linkTab = await waitForTabUrl(
    (t) => (t.url ?? t.pendingUrl ?? "").includes(LINK_HOST),
    LINK_TAB_OPEN_TIMEOUT_MS,
  );
  if (!linkTab || linkTab.id === undefined) {
    return {
      ok: false,
      stage: "link_open",
      stripe_result: stripeResult,
      error_code: "TIMEOUT",
      error_message: `Link popup không xuất hiện sau ${LINK_TAB_OPEN_TIMEOUT_MS / 1000}s sau click Link button. Có thể bị popup blocker hoặc Link chưa setup.`,
    };
  }
  const linkTabId = linkTab.id;

  // Đợi load
  const linkLoaded = await waitForTabComplete(linkTabId, STRIPE_TAB_OPEN_TIMEOUT_MS);
  if (!linkLoaded || !(linkLoaded.url ?? "").includes(LINK_HOST)) {
    return {
      ok: false,
      stage: "link_open",
      stripe_result: stripeResult,
      error_code: "TIMEOUT",
      error_message: `Link tab không load tới ${LINK_HOST}. URL: ${linkLoaded?.url}`,
    };
  }

  // Đợi content link ready
  const linkReady = await waitForContentReady(
    linkTabId,
    LINK_CONTENT_READY_TIMEOUT_MS,
    findContentScriptFiles(LINK_HOST),
  );
  if (!linkReady) {
    return {
      ok: false,
      stage: "link_open",
      stripe_result: stripeResult,
      error_code: "CONTENT_NOT_INJECTED",
      error_message: `Link content script không ready sau ${LINK_CONTENT_READY_TIMEOUT_MS / 1000}s.`,
    };
  }

  // Stage 4: verify amount + click "Thanh toán"
  let linkResult: ExecuteActionResponse;
  try {
    linkResult = await chrome.tabs.sendMessage(linkTabId, {
      kind: "LINK_CONFIRM_PAYMENT",
      taskId: opts.taskId,
      expectedAmountText: opts.expectedAmountText,
    } satisfies ExecuteActionRequest);
  } catch (e) {
    return {
      ok: false,
      stage: "link_confirm",
      stripe_result: stripeResult,
      error_code: "UNKNOWN",
      error_message: `Lỗi gửi LINK_CONFIRM_PAYMENT: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!linkResult.ok) {
    return {
      ok: false,
      stage: "link_confirm",
      stripe_result: stripeResult,
      link_result: linkResult,
      error_code: linkResult.error_code,
      error_message: linkResult.error_message,
    };
  }

  return {
    ok: true,
    stage: "done",
    stripe_result: stripeResult,
    link_result: linkResult,
  };
}
