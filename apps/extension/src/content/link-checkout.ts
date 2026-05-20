/**
 * Content script cho Link checkout popup (https://checkout.link.com/...)
 *
 * Đây là popup window mà Stripe mở khi user click "Link" button trên invoice
 * page. Popup hiển thị:
 *   - Tổng tiền (vd "207.948 đ")
 *   - Email Link account
 *   - Thẻ đã lưu (Mastercard ghi nợ ••5622)
 *   - Button xanh "Thanh toán {amount}" — FINAL CHARGE
 *
 * Action: SANITY CHECK số tiền trong popup phải khớp expectedAmountText. Nếu
 * mismatch → KHÔNG click. Nếu match → click "Thanh toán {amount}". Đây là
 * lệnh FINAL CHARGE — tiền sẽ bị trừ thật trên thẻ Mastercard.
 *
 * Trade-off: tự động hóa hoàn toàn payment chain nhưng yêu cầu sanity check
 * mạnh. Mismatch dù 1 ký tự cũng STOP — admin tự bấm.
 */

import type {
  ExecuteActionRequest,
  ExecuteActionResponse,
} from "../shared/messages";

console.log("[autogpt-link] injected vào", location.href);

const LINK_CHECKOUT_HOSTNAME = "checkout.link.com";

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
  throw new Error(`Link: timeout ${timeoutMs}ms`);
}

/**
 * Normalize số tiền để so sánh. ChatGPT modal hiển thị "Tổng đến hạn hôm
 * nay₫2079.47" (= 207,947₫), Link popup hiển thị "Thanh toán 207.948 đ" (=
 * 207,948₫). Chênh lệch 1 đồng do làm tròn cuối kỳ. Cho phép tolerance ±5đ.
 *
 * Trả về số nguyên VND (vd 207948) hoặc null nếu không parse được.
 */
function parseVndAmount(text: string): number | null {
  if (!text) return null;
  // Tìm cụm số có dấu phân cách thousands (vd "207.948" / "207,948" / "2,079.47")
  const m = text.match(/(\d{1,3}(?:[.,]\d{3}){1,3}(?:[.,]\d{1,2})?)/);
  if (!m) return null;
  let raw = m[1];

  // Xử lý 2 locale:
  // VN: "207.948" (chấm = thousands sep) → 207948
  // VN: "207.948,50" (chấm = thousands, phẩy = decimal) → 207948.5
  // EN: "207,948" (phẩy = thousands) → 207948
  // EN: "207,948.50" (phẩy = thousands, chấm = decimal) → 207948.5
  // ChatGPT mis-display: "2079.47" thực ra là 207947 nhưng đọc "2079.47" → 2079
  //   → cần lookup KHÁC: dùng dấu sep nhất quán + integer.

  const dots = raw.split(".").length - 1;
  const commas = raw.split(",").length - 1;
  // Strategy: cụm chỉ có dấu thousands (no decimal) → strip all → parse int
  // ChatGPT showed "207.948" → 207948 hoặc "₫2079.47" → cần biết locale.
  // Đơn giản: nếu có 6+ ký tự digit hoặc có >=2 thousands sep → là VND integer.
  // Nếu 4-5 digit + 1 sep → có thể là decimal (giá USD/eur).

  // Bỏ tất cả khoảng trắng
  raw = raw.replace(/\s/g, "");

  // VND luôn integer → nếu match dạng "xxx.xxx" hoặc "xxx,xxx" với 3 digit sau
  // sep → đó là thousands separator → strip all separators → parse int.
  if (/^\d{1,3}([.,]\d{3})+$/.test(raw)) {
    return parseInt(raw.replace(/[.,]/g, ""), 10);
  }

  // Nếu có cả . và , (vd "2,079.47") → strip thousands keep decimal
  if (dots >= 1 && commas >= 1) {
    // Last separator là decimal
    const lastDot = raw.lastIndexOf(".");
    const lastComma = raw.lastIndexOf(",");
    if (lastDot > lastComma) {
      // EN format: , = thousands, . = decimal
      const cleaned = raw.replace(/,/g, "");
      const n = Math.round(parseFloat(cleaned));
      return Number.isFinite(n) ? n : null;
    } else {
      // VN/EU format: . = thousands, , = decimal
      const cleaned = raw.replace(/\./g, "").replace(",", ".");
      const n = Math.round(parseFloat(cleaned));
      return Number.isFinite(n) ? n : null;
    }
  }

  // Chỉ 1 dấu (vd "2079.47" hoặc "207.948"):
  //   - Nếu 3 digit sau dấu → thousands sep, parse int
  //   - Nếu < 3 digit sau dấu → decimal, parse float rồi *100? Phức tạp.
  // VND không có cents → để an toàn, NẾU pattern "X.YYY" (Y = 3 digit) coi
  // là thousands. NẾU "X.YY" (Y = 2 digit) coi là decimal — KHẢ NĂNG SAI
  // (ChatGPT mis-display 2079.47 thực ra là 207947).
  // Trả về null nếu không chắc chắn (caller fallback).
  const single = raw.match(/^(\d+)([.,])(\d+)$/);
  if (single) {
    const before = single[1];
    const after = single[3];
    if (after.length === 3) {
      return parseInt(before + after, 10);
    }
    if (after.length === 2 || after.length === 1) {
      // Có thể là 207.94 (= 20794 vnd integer-trimmed) hoặc 207.94 USD decimal
      // → ambiguous, trả null để caller dùng fallback string match.
      return null;
    }
  }

  // Plain integer
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);

  return null;
}

function findLinkPaymentButton(): HTMLElement | null {
  // Strategy 1: button có text "Thanh toán" / "Pay" / "Confirm payment"
  const buttons = Array.from(
    document.querySelectorAll<HTMLElement>("button, [role='button']"),
  );
  for (const b of buttons) {
    const text = (b.textContent ?? "").trim().toLowerCase();
    if (
      /^(thanh\s*toán|thanh\s*toan|pay|confirm\s*and\s*pay|pay\s*now|确认付款|付款)\b.*\d/i.test(
        text,
      )
    ) {
      // Verify visible + enabled
      if (
        b.offsetParent !== null &&
        !b.hasAttribute("disabled") &&
        b.getAttribute("aria-disabled") !== "true"
      ) {
        return b;
      }
    }
  }

  // Strategy 2: button có data-testid liên quan submit/pay
  const testid = document.querySelector<HTMLElement>(
    'button[data-testid*="pay" i], button[data-testid*="submit" i], button[data-testid*="confirm" i]',
  );
  if (testid && testid.offsetParent !== null) return testid;

  // Strategy 3: button type=submit (Link form thường có 1 button submit cuối)
  const submitBtns = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button[type='submit']"),
  ).filter((b) => b.offsetParent !== null && !b.hasAttribute("disabled"));
  if (submitBtns.length === 1) return submitBtns[0];

  // Strategy 4: button cuối có background xanh / class chứa "primary"
  const primaryGreen = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button[class*="primary" i], button[class*="confirm" i]',
    ),
  ).find((b) => b.offsetParent !== null);
  if (primaryGreen) return primaryGreen;

  return null;
}

async function humanClickLink(el: HTMLElement): Promise<void> {
  try {
    el.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  } catch {}
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
    el.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
  } catch {}
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
 * Detect 3D Secure / OTP popup trên Link checkout. Nếu detected → bỏ qua,
 * không click thêm — admin sẽ tự gõ OTP.
 */
function detectOtpStep(): boolean {
  const text = (document.body?.textContent ?? "").toLowerCase();
  return /verify|verification|otp|2fa|3d\s*secure|3ds|xác\s*minh|xác\s*thực|mã.*otp|mã.*xác/i.test(
    text,
  );
}

async function dispatch(msg: ExecuteActionRequest): Promise<ExecuteActionResponse> {
  if (msg.kind === "PING") {
    return { ok: true, data: { url: location.href, host: location.hostname } };
  }
  if (msg.kind !== "LINK_CONFIRM_PAYMENT") {
    return {
      ok: false,
      error_code: "UNKNOWN",
      error_message: `Link content script không xử lý kind=${msg.kind}`,
    };
  }

  if (location.hostname !== LINK_CHECKOUT_HOSTNAME) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Expected ${LINK_CHECKOUT_HOSTNAME}, got ${location.hostname}`,
    };
  }

  // SANITY CHECK: scrape số tiền từ popup, so sánh với expected
  let popupAmountText: string | null = null;
  let popupAmountVnd: number | null = null;
  try {
    await waitFor(() => {
      const text = document.body?.textContent ?? "";
      const m = text.match(/(\d{1,3}(?:[.,]\d{3}){1,3}(?:[.,]\d{1,2})?)\s*[₫đ]/i);
      if (m) {
        popupAmountText = m[0];
        popupAmountVnd = parseVndAmount(m[1]);
        return true;
      }
      return false;
    }, 8000, 300);
  } catch {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: "Không tìm thấy số tiền VND trên Link popup sau 8s.",
    };
  }

  const expectedVnd = parseVndAmount(msg.expectedAmountText);
  console.log(
    `[autogpt-link] amount check: popup=${popupAmountText} (=${popupAmountVnd}vnd), expected="${msg.expectedAmountText}" (=${expectedVnd}vnd)`,
  );

  // Tolerance: ±50 đ cho rounding (kỳ vọng chỉ chênh 1 đồng do làm tròn cuối kỳ
  // hoặc khác locale display). Lớn hơn 50đ = STOP.
  if (
    expectedVnd !== null &&
    popupAmountVnd !== null &&
    Math.abs(popupAmountVnd - expectedVnd) > 50
  ) {
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message:
        `Số tiền Link popup (${popupAmountVnd}đ ~${popupAmountText}) KHÁC expected (${expectedVnd}đ ~${msg.expectedAmountText}). ` +
        "Khác biệt > 50đ → STOP để admin xác minh. Có thể seat/quantity đã đổi.",
    };
  }

  // Detect 3D Secure / OTP — nếu có thì KHÔNG click submit, admin tự xác minh
  if (detectOtpStep()) {
    return {
      ok: true,
      data: {
        action: "LINK_CONFIRM_PAYMENT",
        popup_amount: popupAmountText,
        popup_amount_vnd: popupAmountVnd,
        otp_detected: true,
        clicked: false,
        note: "Link popup yêu cầu OTP/3D Secure. Extension KHÔNG click — admin tự gõ mã.",
      },
    };
  }

  // Tìm + click "Thanh toán {amount}"
  let payBtn: HTMLElement;
  try {
    payBtn = await waitFor(() => findLinkPaymentButton(), 8000, 400);
  } catch {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        "Không tìm thấy button 'Thanh toán' trên Link popup sau 8s. " +
        `Amount visible: ${popupAmountText}. Admin tự click.`,
    };
  }

  console.log(
    `[autogpt-link] CLICKING pay button: "${(payBtn.textContent ?? "").trim().slice(0, 80)}"`,
  );
  await humanClickLink(payBtn);

  // Đợi popup đóng (= payment success) hoặc OTP step xuất hiện
  const deadline = Date.now() + 15_000;
  let outcome: "dismissed" | "otp_after" | "timeout" = "timeout";
  while (Date.now() < deadline) {
    if (!document.body.isConnected) {
      outcome = "dismissed";
      break;
    }
    if (detectOtpStep()) {
      outcome = "otp_after";
      break;
    }
    await sleep(500);
  }

  return {
    ok: true,
    data: {
      action: "LINK_CONFIRM_PAYMENT",
      popup_amount: popupAmountText,
      popup_amount_vnd: popupAmountVnd,
      expected_amount_vnd: expectedVnd,
      clicked: true,
      outcome,
      note:
        outcome === "dismissed"
          ? "Đã click 'Thanh toán' và popup đóng → charge có vẻ thành công. SYNC_BILLING để verify."
          : outcome === "otp_after"
          ? "Đã click 'Thanh toán' nhưng popup hiển thị OTP/3DS step. Admin tự xác minh."
          : `Đã click 'Thanh toán' nhưng sau 15s popup vẫn mở (không OTP). Có thể đang xử lý — admin verify.`,
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
        error_message: `Link content threw: ${message}`,
      } satisfies ExecuteActionResponse);
    }
  })();
  return true;
});
