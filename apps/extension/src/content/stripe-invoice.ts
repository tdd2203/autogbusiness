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
  isDetailToggleText,
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

/**
 * Mở panel "Xem chi tiết hoá đơn" nếu chưa mở (để lộ dòng Số lượng / Mỗi / chu
 * kỳ). Stripe render toggle này là <span>/<div> chứ KHÔNG phải <button>/<a>, nên
 * phải quét mọi phần tử, chọn phần tử NHỎ NHẤT (gần lá) có text khớp rồi click cả
 * nó lẫn ancestor clickable (React gắn handler ở cha). Trả true nếu đã bấm.
 */
/** Tìm phần tử toggle "Xem chi tiết hoá đơn" (nhỏ nhất, đang hiển thị).
 * Nhận diện text qua isDetailToggleText (khớp cả "hoá"/"hóa", loại nút "Đóng"). */
function findDetailToggle(): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>("*"));
  let best: HTMLElement | null = null;
  let bestChildren = Infinity;
  for (const el of all) {
    const text = (el.textContent ?? "").trim();
    if (text.length === 0 || text.length > 40) continue;
    if (!isDetailToggleText(text)) continue;
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
  console.log(
    `[autogpt-stripe] toggle mở panel: "${(toggle.textContent ?? "").trim().slice(0, 40)}"`,
  );
  // CHỈ bấm 1 LẦN đúng vào nút (giống người dùng bấm tay). Nút này là TOGGLE:
  // bấm mở panel, bấm lại đóng. Bản cũ bấm cả ancestor lẫn nút (2 lần) → mở rồi
  // đóng ngay → panel không bao giờ ở trạng thái mở. React bắt sự kiện qua bubbling
  // nên bấm chính span text là đủ (handler ở cha vẫn nhận). Vòng lặp sau thấy nút
  // đổi thành "Đóng chi tiết" (không khớp) → KHÔNG bấm lại → panel giữ mở.
  await humanClickStripe(toggle);
  return true;
}

/**
 * Cuộn MỌI container cuộn được xuống ĐÁY (theo từng bước để kích hoạt lazy render).
 * Panel "chi tiết hoá đơn" của Stripe dài (nhiều dòng proration) + phần TỔNG (Tổng
 * phụ / Số tiền đến hạn / "Mỗi …" / chu kỳ chính 25/7–25/8) nằm ở CUỐI — không cuộn
 * thì các dòng đó chưa vào DOM → parseSubtotal/parseUnitPrice đọc rỗng → no_detail.
 */
async function scrollDetailPanelToBottom(): Promise<void> {
  const doc = (document.scrollingElement ??
    document.documentElement) as HTMLElement;
  const scrollers = [
    doc,
    ...Array.from(document.querySelectorAll<HTMLElement>("*")).filter(
      (el) => el.scrollHeight > el.clientHeight + 40,
    ),
  ].slice(0, 12);
  for (const el of scrollers) {
    try {
      const h = el.scrollHeight;
      const step = Math.max(400, el.clientHeight || 600);
      for (let y = 0; y <= h; y += step) {
        el.scrollTop = y;
        await sleep(80);
      }
      el.scrollTop = el.scrollHeight; // chốt đáy
    } catch {}
  }
  await sleep(150);
}

async function scrapeStripeInvoiceDetail(): Promise<ExecuteActionResponse> {
  // Panel chi tiết cần click "Xem chi tiết hoá đơn" để lộ dòng Số lượng/Mỗi, RỒI
  // cuộn xuống đáy để render toàn bộ (dòng tổng nằm cuối). Poll tới 20s: mỗi vòng
  // click (nếu panel chưa mở) → cuộn đáy → scrape. Panel mở → nút đổi "Đóng chi
  // tiết" (không khớp) → không click lại.
  let detail = scrapeInvoiceDetailFromDom();
  let clicks = 0;
  let toggleSeen = false;
  const deadline = Date.now() + 20_000;
  while (!isDetailUsable(detail) && Date.now() < deadline) {
    const clicked = await openInvoiceDetailPanel();
    if (clicked) {
      clicks++;
      toggleSeen = true;
    }
    await sleep(600);
    await scrollDetailPanelToBottom();
    detail = scrapeInvoiceDetailFromDom();
  }
  console.log(
    `[autogpt-stripe] scrape-detail v0.9.30 url=${location.href} toggleSeen=${toggleSeen} clicks=${clicks} usable=${isDetailUsable(detail)}:`,
    JSON.stringify(detail),
  );
  if (!isDetailUsable(detail)) {
    // Chẩn đoán: liệt kê text các phần tử lá chứa "chi tiết"/"detail" để biết nút
    // thật là gì (và có nằm trong iframe không — content script không vào được).
    const candidates = [
      ...new Set(
        Array.from(document.querySelectorAll<HTMLElement>("*"))
          .filter((el) => el.children.length === 0)
          .map((el) => (el.textContent ?? "").trim())
          .filter((t) => t.length > 0 && t.length < 50 && /chi\s*tiết|detail|明细|详情/i.test(t)),
      ),
    ].slice(0, 10);
    console.log(
      `[autogpt-stripe] DIAG ứng viên 'chi tiết':`,
      JSON.stringify(candidates),
      `| iframes=${document.querySelectorAll("iframe").length}`,
      `| bodyLen=${(document.body?.textContent ?? "").length}`,
    );
  }
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
