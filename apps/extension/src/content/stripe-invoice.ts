/**
 * Content script cho Stripe invoice page (https://invoice.stripe.com/i/...)
 *
 * Đây là page mà ChatGPT chuyển admin tới sau khi click "Xem" trên invoice
 * "Đến hạn" tại /admin/billing?tab=invoices. Page hiển thị:
 *   - Số tiền + thông tin invoice
 *   - 2 phương thức thanh toán:
 *     (a) Button "Link" (xanh green, có icon Link + last4 số thẻ) — 1-click
 *         pay qua Link Stripe (popup window mới checkout.link.com)
 *     (b) Form nhập thẻ thủ công
 *
 * Action: click button "Link" để mở popup checkout.link.com. Popup đó sẽ được
 * inject content/link-checkout.ts riêng.
 */

import type {
  ExecuteActionRequest,
  ExecuteActionResponse,
} from "../shared/messages";
import {
  isDetailUsable,
  scrapeInvoiceDetailFromDom,
} from "./scrapers/invoice-detail";

console.log("[autogpt-stripe] injected vào", location.href);

const STRIPE_INVOICE_HOSTNAME = "invoice.stripe.com";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(
  fn: () => T | null | undefined,
  timeoutMs = 15_000,
  pollMs = 300,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(pollMs);
  }
  throw new Error(`Stripe: timeout ${timeoutMs}ms`);
}

/**
 * Tìm button "Link" trên Stripe invoice page. Heuristic (Stripe đổi UI thường):
 *   1. Button có data-testid="link-button" hoặc class chứa "link-button"
 *   2. Button chứa text "Link" + last4 digits (vd "Link  5622" / "Link Pay")
 *   3. Button có background xanh green (#00d66f / rgb(0, 214, 111))
 *   4. <a href> đến checkout.link.com (open in popup)
 */
function findStripeLinkButton(): HTMLElement | null {
  // Strategy 1: data-testid
  const testid = document.querySelector<HTMLElement>(
    'button[data-testid*="link" i], a[data-testid*="link" i]',
  );
  if (testid) {
    const t = (testid.textContent ?? "").toLowerCase();
    if (t.includes("link") || /\d{4}/.test(t)) return testid;
  }

  // Strategy 2: text match "Link" + last4 (vd "5622")
  const buttons = Array.from(
    document.querySelectorAll<HTMLElement>("button, a, [role='button']"),
  );
  for (const b of buttons) {
    const text = (b.textContent ?? "").trim();
    // Stripe Link button thường có format "Link  ••••5622" hoặc "Link 5622"
    if (/^link\s*[\s•]*\d{4}/i.test(text)) return b;
    if (/link\s*pay/i.test(text)) return b;
  }

  // Strategy 3: aria-label
  const ariaMatch = document.querySelector<HTMLElement>(
    'button[aria-label*="Link" i], button[aria-label*="link pay" i]',
  );
  if (ariaMatch) return ariaMatch;

  // Strategy 4: button có class chứa "link" + visible
  const classMatch = Array.from(
    document.querySelectorAll<HTMLElement>('button[class*="link" i]'),
  ).find((b) => b.offsetParent !== null);
  if (classMatch) {
    const t = (classMatch.textContent ?? "").toLowerCase();
    // Loại bỏ false-match "manage payment link" etc
    if (!t.includes("manage") && !t.includes("settings")) {
      return classMatch;
    }
  }

  // Strategy 5: link với href tới checkout.link.com
  const linkAnchor = document.querySelector<HTMLAnchorElement>(
    'a[href*="checkout.link.com"], a[href*="link.com/pay"]',
  );
  if (linkAnchor) return linkAnchor;

  return null;
}

async function humanClickStripe(el: HTMLElement): Promise<void> {
  try {
    el.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  } catch {
    el.scrollIntoView();
  }
  await sleep(150);
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const opts: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    button: 0,
    composed: true,
  };
  const pointerOpts = { ...opts, pointerType: "mouse", isPrimary: true };
  try {
    el.dispatchEvent(new PointerEvent("pointerover", pointerOpts));
    el.dispatchEvent(new PointerEvent("pointerenter", pointerOpts));
    el.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
  } catch {}
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  el.dispatchEvent(new MouseEvent("mouseenter", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  await sleep(80);
  try {
    el.dispatchEvent(new PointerEvent("pointerup", pointerOpts));
  } catch {}
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
  if (typeof el.click === "function") {
    try {
      el.click();
    } catch {}
  }
}

const DETAIL_TOGGLE_RE =
  /^(xem\s*chi\s*tiết(\s*ho[áà]\s*đơn)?|view\s*invoice\s*details?|view\s*details?|查看发票明细|发票明细|查看明细|查看详情)\s*[>›»]?$/i;

/**
 * Mở panel "Xem chi tiết hoá đơn" nếu chưa mở (để lộ dòng Số lượng / Mỗi / chu
 * kỳ). Stripe render toggle này là <span>/<div> chứ KHÔNG phải <button>/<a>, nên
 * phải quét mọi phần tử, chọn phần tử NHỎ NHẤT (gần lá) có text khớp rồi click cả
 * nó lẫn ancestor clickable (React gắn handler ở cha). Trả true nếu đã bấm.
 */
/** Tìm phần tử toggle "Xem chi tiết hoá đơn" (nhỏ nhất, đang hiển thị). */
function findDetailToggle(): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>("*"));
  let best: HTMLElement | null = null;
  let bestChildren = Infinity;
  for (const el of all) {
    const text = (el.textContent ?? "").trim();
    if (text.length === 0 || text.length > 40) continue;
    if (!DETAIL_TOGGLE_RE.test(text)) continue;
    if (el.offsetParent === null) continue; // bỏ phần tử ẩn
    const childCount = el.querySelectorAll("*").length;
    if (childCount < bestChildren) {
      best = el;
      bestChildren = childCount;
    }
  }
  return best;
}

/**
 * Mở panel "Xem chi tiết hoá đơn". Toggle là <span>/<div> (không phải button),
 * React gắn handler ở đâu đó trong cây → click bằng chuỗi sự kiện chuột THẬT
 * (humanClickStripe) trên chính nó + ancestor clickable. Trả true nếu tìm thấy
 * toggle (tức panel chưa mở). false = không thấy toggle (panel đã mở hoặc UI khác).
 */
async function openInvoiceDetailPanel(): Promise<boolean> {
  const toggle = findDetailToggle();
  if (!toggle) return false;
  const clickable =
    (toggle.closest(
      "a, button, [role='button'], [class*='button' i], [class*='link' i], [class*='Link' i]",
    ) as HTMLElement | null) ?? toggle;
  await humanClickStripe(clickable);
  if (clickable !== toggle) await humanClickStripe(toggle);
  return true;
}

async function scrapeStripeInvoiceDetail(): Promise<ExecuteActionResponse> {
  // Panel chi tiết cần click "Xem chi tiết hoá đơn" để lộ dòng Số lượng/Mỗi.
  // Poll tới 14s: mỗi vòng, nếu toggle còn đó (panel chưa mở) thì click; rồi
  // scrape. Panel mở → text đổi thành "Đóng chi tiết" → không click lại nữa.
  let detail = scrapeInvoiceDetailFromDom();
  let clicks = 0;
  let toggleSeen = false;
  const deadline = Date.now() + 14_000;
  while (!isDetailUsable(detail) && Date.now() < deadline) {
    const clicked = await openInvoiceDetailPanel();
    if (clicked) {
      clicks++;
      toggleSeen = true;
    }
    await sleep(600);
    detail = scrapeInvoiceDetailFromDom();
  }
  console.log(
    `[autogpt-stripe] scrape-detail v0.9.8 url=${location.href} toggleSeen=${toggleSeen} clicks=${clicks} usable=${isDetailUsable(detail)}:`,
    JSON.stringify(detail),
  );
  if (!isDetailUsable(detail)) {
    return {
      ok: false,
      error_code: "FAILED_UI_CHANGED",
      error_message:
        `Không đọc được số lượng/đơn giá trên trang chi tiết hoá đơn Stripe ` +
        `(toggle 'Xem chi tiết' ${toggleSeen ? "đã click nhưng panel không cho ra số liệu" : "KHÔNG tìm thấy"}). ` +
        `URL: ${location.href}`,
    };
  }
  return { ok: true, data: { invoice_detail: detail } };
}

async function dispatch(msg: ExecuteActionRequest): Promise<ExecuteActionResponse> {
  if (msg.kind === "PING") {
    return { ok: true, data: { url: location.href, host: location.hostname } };
  }
  if (msg.kind === "STRIPE_SCRAPE_INVOICE_DETAIL") {
    if (location.hostname !== STRIPE_INVOICE_HOSTNAME) {
      return {
        ok: false,
        error_code: "PAGE_NOT_ADMIN",
        error_message: `Expected ${STRIPE_INVOICE_HOSTNAME}, got ${location.hostname}`,
      };
    }
    return scrapeStripeInvoiceDetail();
  }
  if (msg.kind !== "STRIPE_CLICK_LINK") {
    return {
      ok: false,
      error_code: "UNKNOWN",
      error_message: `Stripe content script không xử lý kind=${msg.kind}`,
    };
  }

  if (location.hostname !== STRIPE_INVOICE_HOSTNAME) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Expected ${STRIPE_INVOICE_HOSTNAME}, got ${location.hostname}`,
    };
  }

  // Scrape amount displayed cho audit
  const pageText = document.body?.textContent ?? "";
  const amountMatch = pageText.match(
    /([\d]{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?)\s*[₫đ]|([₫đ]|\$)\s*([\d]{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?)/,
  );
  const amount_visible = amountMatch?.[0]?.trim() ?? null;
  console.log(
    `[autogpt-stripe] page amount visible: ${amount_visible}, expected: ${msg.expectedAmountText}`,
  );

  let linkBtn: HTMLElement;
  try {
    linkBtn = await waitFor(() => findStripeLinkButton(), 12_000, 400);
  } catch {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        "Không tìm thấy button 'Link' trên Stripe invoice page sau 12s. " +
        `URL: ${location.href}. Có thể Stripe đổi UI hoặc user chưa setup Link account.`,
    };
  }

  await humanClickStripe(linkBtn);
  return {
    ok: true,
    data: {
      action: "STRIPE_CLICK_LINK",
      amount_visible,
      link_button_text: (linkBtn.textContent ?? "").trim().slice(0, 60),
      note: "Đã click 'Link' button. Popup checkout.link.com sẽ mở.",
    },
  };
}

chrome.runtime.onMessage.addListener((msg: ExecuteActionRequest, _sender, sendResponse) => {
  (async () => {
    try {
      const result = await dispatch(msg);
      sendResponse(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      sendResponse({
        ok: false,
        error_code: "UNKNOWN",
        error_message: `Stripe content threw: ${message}`,
      } satisfies ExecuteActionResponse);
    }
  })();
  return true;
});
