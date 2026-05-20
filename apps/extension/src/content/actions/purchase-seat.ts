/**
 * Action PURCHASE_SEAT: tăng số seat trên ChatGPT Business +`quantity`.
 *
 * Flow (tham chiếu user 2026-05-20):
 *   1. Navigate /admin/billing?tab=plan (nếu chưa ở)
 *   2. Click link "Quản lý giấy phép" → mở modal review #1 ("Xem xét")
 *   3. Đọc input "Người dùng" giá trị hiện tại N (vd 13)
 *   4. Click nút "+" `quantity` lần (target = N + quantity)
 *      Sau mỗi click, verify input đã tăng — nếu kẹt → fail.
 *   5. Click "Tiếp tục" → ChatGPT mở modal review #2 ("Quản lý chỗ ngồi")
 *      hiển thị tổng tiền + breakdown.
 *   6. Verify modal #2 nói đúng "<quantity> suất ... bổ sung" (sanity check).
 *   7. Click "Thêm người dùng" → ⚠️ CHARGE TIỀN THẬT qua payment method
 *      đã lưu trên ChatGPT (Stripe).
 *   8. DỪNG sau click. Nếu ChatGPT mở 3D Secure / OTP popup → để admin xử lý.
 *
 * ⚠️ TRADE-OFF: trước v0.5.1 extension DỪNG sau "Tiếp tục" để admin tự confirm.
 * Sau v0.5.1 extension click luôn tới "Thêm người dùng" → flow automation hơn
 * nhưng RỦI RO TIỀN nếu task tạo nhầm. Mitigation: hard cap quantity=20/task,
 * dedup, audit log, sanity check quantity-match-modal-text trước khi click.
 *
 * Trả về:
 *   data: {
 *     initial_seat, target_seat, quantity, modal_advanced: true,
 *     confirm_charge_clicked: boolean,
 *     charge_modal_dismissed: boolean,  // true nếu modal #2 đóng sau click
 *     charge_amount_text: string | null,  // vd "đ2080.24" scrape từ modal
 *     note: string,
 *   }
 */

import type { ExecuteActionResponse } from "../../shared/messages";
import { humanClick, queryByAnyText, sleep, waitFor } from "../human";
import { findControlByKey } from "../i18n-ui";
import { reportProgress } from "../progress";
import { TEXT_FALLBACKS } from "../selectors";

const BILLING_PLAN_PATH = "/admin/billing";
const BILLING_PLAN_SEARCH = "?tab=plan";

/** Render delay sau khi navigate / click trong SPA. */
const POST_NAV_RENDER_MS = 2500;

/** Hard cap đợi modal "Xem xét" mở. */
const MODAL_OPEN_TIMEOUT_MS = 15_000;

/** Hard cap đợi modal review #2 ("Quản lý chỗ ngồi") mở sau Tiếp tục. */
const CHARGE_MODAL_TIMEOUT_MS = 12_000;

/** Đợi modal #2 đóng (= ChatGPT đã accept charge) sau Thêm người dùng. */
const CHARGE_DISMISS_TIMEOUT_MS = 10_000;

/** Hard cap quantity per task (mirror backend `PURCHASE_SEAT_MAX_PER_TASK`). */
const MAX_QUANTITY = 20;

/**
 * Tìm input "Người dùng" trong modal review. ChatGPT dùng number-like text
 * input không có aria-label rõ ràng — fallback: tìm trong [role="dialog"] /
 * [aria-modal="true"] input chứa giá trị numeric.
 */
function findUserCountInput(): HTMLInputElement | null {
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-state="open"]',
    ),
  );
  for (const dialog of dialogs) {
    const inputs = Array.from(dialog.querySelectorAll<HTMLInputElement>("input"));
    for (const inp of inputs) {
      const value = inp.value?.trim() ?? "";
      // Chấp nhận input chứa số nguyên (1-999), bỏ qua input email/text dài.
      if (/^\d{1,3}$/.test(value)) return inp;
    }
  }
  // Fallback page-wide: bất kỳ input numeric nào trên trang (last resort).
  const all = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
  for (const inp of all) {
    const value = inp.value?.trim() ?? "";
    if (/^\d{1,3}$/.test(value) && inp.offsetParent !== null) return inp;
  }
  return null;
}

/**
 * Tìm nút "+" trong modal review. ChatGPT dùng icon-only button kế bên input
 * số người dùng. Strategy: tìm 2 button anh em của user-count input, button
 * thứ 2 (sau số) thường là "+", button đầu là "-".
 */
function findIncrementButton(input: HTMLInputElement): HTMLButtonElement | null {
  // Strategy 1: aria-label / text
  const dialog = input.closest<HTMLElement>(
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-state="open"]',
  );
  if (dialog) {
    const ariaMatch = dialog.querySelector<HTMLButtonElement>(
      'button[aria-label*="Increase" i], button[aria-label*="Increment" i], button[aria-label*="Tăng" i], button[aria-label*="Thêm" i], button[aria-label*="增加" i]',
    );
    if (ariaMatch) return ariaMatch;
  }

  // Strategy 2: tìm trong cùng row/container của input — button "+" thường
  // nằm bên phải input (sibling). Walk up tối đa 3 cấp tìm container.
  let row: HTMLElement | null = input.parentElement;
  for (let i = 0; i < 4 && row; i++) {
    const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>("button"));
    if (buttons.length >= 2) {
      // Có 2+ button trong cùng container → cái thứ 2 (DOM order: - đứng trước, + đứng sau)
      // hoặc cái mang ký tự "+" trong textContent / svg.
      const plusByText = buttons.find((b) => (b.textContent ?? "").trim() === "+");
      if (plusByText) return plusByText;
      // SVG-only: pick button bên phải input (lớn hơn input.getBoundingClientRect().right)
      const inputRect = input.getBoundingClientRect();
      const rightmost = buttons
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return r.left > inputRect.right - 5;
        })
        .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
      if (rightmost[0]) return rightmost[0];
      // Fallback: button cuối trong container (thường là +)
      return buttons[buttons.length - 1] ?? null;
    }
    row = row.parentElement;
  }
  return null;
}

/**
 * Tìm nút "Tiếp tục" trong modal review. Có thể là <button> hoặc role=button.
 * Ưu tiên trong modal scope; fallback page-wide.
 */
function findContinueButton(): HTMLElement | null {
  const dialog = document.querySelector<HTMLElement>(
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-state="open"]',
  );
  if (dialog) {
    const inDialog = queryByAnyText(
      "button",
      TEXT_FALLBACKS.billingContinueButton,
      dialog,
    );
    if (inDialog) return inDialog;
  }
  return findControlByKey(
    "billing_continue_button",
    TEXT_FALLBACKS.billingContinueButton,
    { page: "/admin/billing" },
  );
}

export async function executePurchaseSeat(
  taskId: string,
  quantity: number,
  skipToPayment = false,
): Promise<ExecuteActionResponse> {
  if (!location.pathname.startsWith("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}). Mở chatgpt.com/admin/billing trước.`,
    };
  }

  const qty = Math.max(1, Math.min(MAX_QUANTITY, Math.floor(quantity || 1)));
  if (qty !== quantity) {
    console.warn(
      `[autogpt-purchase-seat] quantity ${quantity} clamp về ${qty} (cap=${MAX_QUANTITY})`,
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // skipToPayment branch: invoice "Đến hạn" đã tồn tại (vd task trước tạo
  // invoice nhưng phase 2.5+payment chain fail) → skip Phase 1+2 (modal), nhảy
  // thẳng tới tab Hóa đơn + payment chain.
  // ────────────────────────────────────────────────────────────────────────
  if (skipToPayment) {
    return executePaymentChainOnly(taskId, qty);
  }

  await reportProgress(
    taskId,
    {
      phase: "navigate",
      message: `Đang mở /admin/billing?tab=plan để mua thêm ${qty} seat...`,
      current: 0,
      total: qty + 2,
    },
    true,
  );

  // Step 1: navigate vào tab Kế hoạch
  if (
    !location.pathname.startsWith(BILLING_PLAN_PATH) ||
    !location.search.includes("tab=plan")
  ) {
    history.pushState({}, "", BILLING_PLAN_PATH + BILLING_PLAN_SEARCH);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(POST_NAV_RENDER_MS);
  } else {
    await sleep(800);
  }

  // Step 2: click "Quản lý giấy phép"
  await reportProgress(
    taskId,
    {
      phase: "open_modal",
      message: "Đang click 'Quản lý giấy phép'...",
      current: 1,
      total: qty + 2,
    },
    true,
  );
  const manageLink = findControlByKey(
    "billing_manage_licenses",
    TEXT_FALLBACKS.billingManageLicenses,
    { page: "/admin/billing" },
  );
  if (!manageLink) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        "Không tìm thấy link 'Quản lý giấy phép' trên /admin/billing?tab=plan. " +
        "Có thể ChatGPT đổi UI hoặc page chưa render xong. " +
        `URL hiện tại: ${location.href}`,
    };
  }
  await humanClick(manageLink);

  // Step 3: đợi modal "Xem xét" mở + input number xuất hiện
  let userInput: HTMLInputElement;
  try {
    userInput = await waitFor(
      () => findUserCountInput(),
      MODAL_OPEN_TIMEOUT_MS,
      300,
    );
  } catch {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        `Đã click 'Quản lý giấy phép' nhưng modal review không xuất hiện ` +
        `input số người dùng sau ${MODAL_OPEN_TIMEOUT_MS / 1000}s. ` +
        "Có thể ChatGPT đổi UI dialog hoặc bị chặn bởi popup khác.",
    };
  }

  const initialSeat = parseInt(userInput.value, 10);
  if (!Number.isFinite(initialSeat) || initialSeat < 1) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Input người dùng có giá trị không hợp lệ: '${userInput.value}'`,
    };
  }
  const targetSeat = initialSeat + qty;
  console.log(
    `[autogpt-purchase-seat] initial=${initialSeat}, target=${targetSeat} (+${qty})`,
  );

  // Step 4: click "+" qty lần. Verify input value tăng sau mỗi click.
  const incrementBtn = findIncrementButton(userInput);
  if (!incrementBtn) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        `Không tìm thấy nút '+' bên cạnh input người dùng (hiện ${initialSeat}). ` +
        "ChatGPT có thể đã đổi UI modal review.",
    };
  }

  for (let i = 0; i < qty; i++) {
    const before = parseInt(userInput.value, 10);
    await reportProgress(
      taskId,
      {
        phase: "increment",
        message: `Đang tăng seat: ${before} → ${before + 1} (${i + 1}/${qty})`,
        current: 2 + i,
        total: qty + 2,
      },
      true,
    );
    await humanClick(incrementBtn);
    await sleep(400);
    const after = parseInt(userInput.value, 10);
    if (after !== before + 1) {
      // Chờ thêm 1 nhịp — React state update có thể chậm
      await sleep(600);
      const retry = parseInt(userInput.value, 10);
      if (retry !== before + 1) {
        return {
          ok: false,
          error_code: "UI_ELEMENT_NOT_FOUND",
          error_message:
            `Click '+' không tăng seat (trước=${before}, sau=${retry}, kỳ vọng=${before + 1}). ` +
            "Có thể ChatGPT chặn vì đã đạt cap, hoặc nút '+' tìm sai element.",
        };
      }
    }
  }

  const finalSeat = parseInt(userInput.value, 10);
  if (finalSeat !== targetSeat) {
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message: `Sau ${qty} click '+', seat = ${finalSeat} thay vì ${targetSeat}.`,
    };
  }

  // Step 5: click "Tiếp tục"
  await reportProgress(
    taskId,
    {
      phase: "continue",
      message: `Seat đã tăng ${initialSeat} → ${finalSeat}. Click 'Tiếp tục' để chuyển sang trang xác nhận thanh toán...`,
      current: qty + 2,
      total: qty + 2,
    },
    true,
  );
  const continueBtn = findContinueButton();
  if (!continueBtn) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        `Đã tăng seat thành công ${initialSeat} → ${finalSeat} nhưng KHÔNG tìm thấy ` +
        "nút 'Tiếp tục' trong modal. Admin phải bấm thủ công trên ChatGPT.",
    };
  }
  // Verify button enabled (ChatGPT disable khi disabled — vd thiếu payment method)
  const isDisabled =
    continueBtn.hasAttribute("disabled") ||
    continueBtn.getAttribute("aria-disabled") === "true";
  if (isDisabled) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        `Nút 'Tiếp tục' bị disabled — ChatGPT chặn (có thể chưa có payment method, ` +
        `hoặc tài khoản ${initialSeat} → ${finalSeat} vượt cap). Admin kiểm tra ChatGPT thủ công.`,
    };
  }
  await humanClick(continueBtn);
  await sleep(1500);

  // Step 6: đợi modal review #2 ("Quản lý chỗ ngồi") mở. Modal này KHÁC modal #1
  // — không còn input numeric, mà hiển thị tổng tiền + breakdown + nút "Thêm
  // người dùng".
  await reportProgress(
    taskId,
    {
      phase: "charge_modal",
      message: "Đợi modal 'Quản lý chỗ ngồi' (review charge)...",
      current: qty + 2,
      total: qty + 4,
    },
    true,
  );

  let chargeModal: HTMLElement;
  try {
    chargeModal = await waitFor(
      () => findChargeModal(qty),
      CHARGE_MODAL_TIMEOUT_MS,
      300,
    );
  } catch {
    // Modal #2 không mở — có thể ChatGPT đã đổi flow (1 modal duy nhất) hoặc
    // bị chặn. Trả partial success (modal #1 đã advance) + note.
    return {
      ok: true,
      data: {
        initial_seat: initialSeat,
        target_seat: targetSeat,
        quantity: qty,
        modal_advanced: true,
        confirm_charge_clicked: false,
        charge_modal_dismissed: false,
        charge_amount_text: null,
        note:
          `Đã click 'Tiếp tục' nhưng modal review #2 không xuất hiện sau ` +
          `${CHARGE_MODAL_TIMEOUT_MS / 1000}s. Admin phải kiểm tra ChatGPT thủ công.`,
      },
    };
  }

  // SANITY CHECK #1: modal phải nói đúng "<qty> suất" / "<qty> seat(s)" để
  // chắc chắn ChatGPT charge đúng quantity. Nếu mismatch → STOP, KHÔNG click.
  const modalText = (chargeModal.textContent ?? "").replace(/\s+/g, " ").trim();
  const qtyInModal = extractAdditionalSeatCountFromModal(modalText);
  if (qtyInModal !== null && qtyInModal !== qty) {
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message:
        `Modal charge nói '${qtyInModal} suất bổ sung' nhưng task yêu cầu ${qty}. ` +
        `Có thể seat trên ChatGPT đã đổi (vd có task khác đang chạy) — DỪNG để tránh charge sai.`,
    };
  }

  // SCRAPE charge amount để audit log
  const chargeAmount = extractChargeAmountFromModal(modalText);
  console.log(
    `[autogpt-purchase-seat] modal#2 sẵn sàng: qty_in_modal=${qtyInModal}, amount=${chargeAmount}`,
  );

  // Step 7: click "Thêm người dùng" — ⚠️ FINAL CHARGE
  await reportProgress(
    taskId,
    {
      phase: "confirm_charge",
      message: `Click 'Thêm người dùng' để charge ${chargeAmount ?? "?"} cho ${qty} seat...`,
      current: qty + 3,
      total: qty + 4,
    },
    true,
  );

  const addUserBtn = findAddUserButton(chargeModal);
  if (!addUserBtn) {
    return {
      ok: true,
      data: {
        initial_seat: initialSeat,
        target_seat: targetSeat,
        quantity: qty,
        modal_advanced: true,
        confirm_charge_clicked: false,
        charge_modal_dismissed: false,
        charge_amount_text: chargeAmount,
        note:
          "Modal review #2 mở nhưng KHÔNG tìm thấy nút 'Thêm người dùng'. " +
          "Admin phải bấm thủ công trên ChatGPT.",
      },
    };
  }

  const isAddUserDisabled =
    addUserBtn.hasAttribute("disabled") ||
    addUserBtn.getAttribute("aria-disabled") === "true";
  if (isAddUserDisabled) {
    return {
      ok: true,
      data: {
        initial_seat: initialSeat,
        target_seat: targetSeat,
        quantity: qty,
        modal_advanced: true,
        confirm_charge_clicked: false,
        charge_modal_dismissed: false,
        charge_amount_text: chargeAmount,
        note:
          "Nút 'Thêm người dùng' bị disabled (thiếu payment method?). " +
          "Admin phải kiểm tra trên ChatGPT.",
      },
    };
  }

  await humanClick(addUserBtn);

  // Step 8: đợi modal đóng (= ChatGPT accept) hoặc 3D Secure popup xuất hiện
  await reportProgress(
    taskId,
    {
      phase: "confirm_charge",
      message: "Đang đợi ChatGPT xử lý charge...",
      current: qty + 4,
      total: qty + 4,
    },
    true,
  );

  const dismissed = await waitForChargeModalDismiss(chargeModal);

  // ────────────────────────────────────────────────────────────────────────
  // Phase 2 (v0.6.0+): navigate /admin/billing?tab=invoices, tìm row "Đến hạn"
  // mới tạo, extract Stripe invoice URL → gửi background mở Stripe tab → chain
  // qua Link popup → click "Thanh toán {amount}". Tiền THẬT bị trừ ở Phase 3.
  // ────────────────────────────────────────────────────────────────────────
  if (!chargeAmount) {
    // KHÔNG có amount expected → không an toàn để chain auto-payment, dừng.
    return {
      ok: true,
      data: {
        initial_seat: initialSeat,
        target_seat: targetSeat,
        quantity: qty,
        modal_advanced: true,
        confirm_charge_clicked: true,
        charge_modal_dismissed: dismissed,
        charge_amount_text: null,
        payment_chain_started: false,
        note: "ChatGPT chấp nhận tạo invoice nhưng KHÔNG scrape được amount → không chain payment (admin tự thanh toán tab Hóa đơn).",
      },
    };
  }

  await reportProgress(
    taskId,
    { phase: "find_invoice", message: "Đang tìm invoice 'Đến hạn' trên tab Hóa đơn...", current: qty + 4, total: qty + 6 },
    true,
  );

  // Navigate sang tab Hóa đơn
  if (!location.search.includes("tab=invoices")) {
    history.pushState({}, "", "/admin/billing?tab=invoices");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(POST_NAV_RENDER_MS);
  } else {
    await sleep(1500);
  }

  // Đợi list invoice render + tìm row "Đến hạn" đầu tiên
  let stripeUrl: string | null = null;
  try {
    stripeUrl = await waitFor(
      () => findFirstUnpaidInvoiceStripeUrl(),
      12_000,
      400,
    );
  } catch {
    return {
      ok: true,
      data: {
        initial_seat: initialSeat,
        target_seat: targetSeat,
        quantity: qty,
        modal_advanced: true,
        confirm_charge_clicked: true,
        charge_modal_dismissed: dismissed,
        charge_amount_text: chargeAmount,
        payment_chain_started: false,
        note:
          "Không tìm thấy invoice 'Đến hạn' trên tab Hóa đơn sau 12s. " +
          "ChatGPT có thể chưa kịp tạo invoice — admin retry sau 30s hoặc tự thanh toán thủ công.",
      },
    };
  }

  await reportProgress(
    taskId,
    { phase: "payment_chain", message: `Đang mở Stripe invoice + chain qua Link checkout...`, current: qty + 5, total: qty + 6 },
    true,
  );

  // Gửi background mở Stripe tab + chain Link popup
  let chainResult: PaymentChainResultLite;
  try {
    chainResult = await chrome.runtime.sendMessage({
      type: "run-payment-chain",
      options: {
        taskId,
        stripeInvoiceUrl: stripeUrl,
        expectedAmountText: chargeAmount,
      },
    });
  } catch (e) {
    return {
      ok: true,
      data: {
        initial_seat: initialSeat,
        target_seat: targetSeat,
        quantity: qty,
        modal_advanced: true,
        confirm_charge_clicked: true,
        charge_modal_dismissed: dismissed,
        charge_amount_text: chargeAmount,
        stripe_invoice_url: stripeUrl,
        payment_chain_started: false,
        payment_chain_error: e instanceof Error ? e.message : String(e),
        note: "Lỗi gửi message run-payment-chain tới background. Admin thanh toán thủ công.",
      },
    };
  }

  return {
    ok: true,
    data: {
      initial_seat: initialSeat,
      target_seat: targetSeat,
      quantity: qty,
      modal_advanced: true,
      confirm_charge_clicked: true,
      charge_modal_dismissed: dismissed,
      charge_amount_text: chargeAmount,
      stripe_invoice_url: stripeUrl,
      payment_chain_started: true,
      payment_chain_stage: chainResult?.stage,
      payment_chain_ok: chainResult?.ok ?? false,
      payment_chain_error_code: chainResult?.error_code ?? null,
      payment_chain_error_message: chainResult?.error_message ?? null,
      payment_chain_stripe: chainResult?.stripe_result?.data ?? null,
      payment_chain_link: chainResult?.link_result?.data ?? null,
      note: chainResult?.ok
        ? `✓ Payment chain hoàn tất stage=${chainResult.stage}. ${chainResult.link_result?.data?.note ?? ""}`
        : `✗ Payment chain dừng ở stage=${chainResult?.stage}: ${chainResult?.error_message ?? "?"}`,
    },
  };
}

/** Subset của PaymentChainResult — content script không import được type từ background. */
type PaymentChainResultLite = {
  ok: boolean;
  stage: string;
  error_code?: string;
  error_message?: string;
  stripe_result?: { ok: boolean; data?: { note?: string } & Record<string, unknown> };
  link_result?: { ok: boolean; data?: { note?: string } & Record<string, unknown> };
};

/**
 * Tìm row đầu tiên có trạng thái "Đến hạn" / "Due" / "Unpaid" trong bảng
 * /admin/billing?tab=invoices và extract:
 *   - URL Stripe từ anchor "Xem"
 *   - Số tiền (text + integer VND) từ cột "Số lượng" cùng row
 *
 * Bảng có cấu trúc 4 cột: Ngày, Số lượng, Trạng thái, Xem(link). "Đến hạn"
 * thường là row mới nhất (top). Trả null nếu không tìm thấy.
 */
function findFirstUnpaidInvoice(): { url: string; amountText: string | null } | null {
  const anchors = Array.from(
    document.querySelectorAll<HTMLAnchorElement>(
      'a[href*="invoice.stripe.com"]',
    ),
  );
  for (const a of anchors) {
    let row: HTMLElement | null = a;
    for (let i = 0; i < 6 && row; i++) {
      const rowText = (row.textContent ?? "").toLowerCase();
      if (
        /đến\s*hạn|đến\s*ngày|due|unpaid|past\s*due|chưa\s*thanh\s*toán|未\s*付款|未支付|逾期/i.test(
          rowText,
        ) &&
        !/đã\s*thanh\s*toán|paid|已\s*付款|已支付/i.test(rowText)
      ) {
        // Tìm cụm tiền trong row: "207.948 đ" / "207,948 đ" / "$25.00"
        const amountMatch = (row.textContent ?? "").match(
          /(\d{1,3}(?:[.,]\d{3}){1,3}(?:[.,]\d{1,2})?)\s*[₫đ]/i,
        );
        return {
          url: a.href,
          amountText: amountMatch ? amountMatch[0].trim() : null,
        };
      }
      row = row.parentElement;
    }
  }
  if (anchors.length > 0) {
    console.warn(
      "[autogpt-purchase-seat] không match được 'Đến hạn' — fallback anchor đầu tiên",
    );
    return { url: anchors[0].href, amountText: null };
  }
  return null;
}

/** Backward-compat alias để chain-handler cũ vẫn dùng được. */
function findFirstUnpaidInvoiceStripeUrl(): string | null {
  return findFirstUnpaidInvoice()?.url ?? null;
}

/**
 * Chạy CHỈ Phase 2.5 → 4 (tab Hóa đơn → Stripe → Link), giả định invoice
 * "Đến hạn" đã được tạo từ trước.
 */
async function executePaymentChainOnly(
  taskId: string,
  qty: number,
): Promise<ExecuteActionResponse> {
  await reportProgress(
    taskId,
    {
      phase: "find_invoice",
      message: "Skip modal (đã mua slot trước đó) → đang mở tab Hóa đơn để thanh toán...",
      current: 1,
      total: 3,
    },
    true,
  );

  if (!location.search.includes("tab=invoices")) {
    history.pushState({}, "", "/admin/billing?tab=invoices");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(POST_NAV_RENDER_MS);
  } else {
    await sleep(1500);
  }

  let invoice: { url: string; amountText: string | null };
  try {
    invoice = await waitFor(
      () => findFirstUnpaidInvoice(),
      15_000,
      400,
    );
  } catch {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        "Không tìm thấy invoice 'Đến hạn' trên /admin/billing?tab=invoices sau 15s. " +
        "Có thể invoice đã được thanh toán hoặc ChatGPT đổi UI.",
    };
  }

  if (!invoice.amountText) {
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message:
        `Tìm thấy invoice (${invoice.url}) nhưng không scrape được số tiền trong row. ` +
        "KHÔNG chain payment để tránh charge sai amount.",
    };
  }

  await reportProgress(
    taskId,
    {
      phase: "payment_chain",
      message: `Mở Stripe + chain Link checkout cho invoice ${invoice.amountText}...`,
      current: 2,
      total: 3,
    },
    true,
  );

  let chainResult: PaymentChainResultLite;
  try {
    chainResult = await chrome.runtime.sendMessage({
      type: "run-payment-chain",
      options: {
        taskId,
        stripeInvoiceUrl: invoice.url,
        expectedAmountText: invoice.amountText,
      },
    });
  } catch (e) {
    return {
      ok: false,
      error_code: "UNKNOWN",
      error_message: `Gửi run-payment-chain fail: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return {
    ok: true,
    data: {
      mode: "skip_to_payment",
      quantity: qty,
      stripe_invoice_url: invoice.url,
      charge_amount_text: invoice.amountText,
      payment_chain_started: true,
      payment_chain_stage: chainResult?.stage,
      payment_chain_ok: chainResult?.ok ?? false,
      payment_chain_error_code: chainResult?.error_code ?? null,
      payment_chain_error_message: chainResult?.error_message ?? null,
      payment_chain_stripe: chainResult?.stripe_result?.data ?? null,
      payment_chain_link: chainResult?.link_result?.data ?? null,
      note: chainResult?.ok
        ? `✓ Payment chain hoàn tất stage=${chainResult.stage}. ${chainResult.link_result?.data?.note ?? ""}`
        : `✗ Payment chain dừng ở stage=${chainResult?.stage}: ${chainResult?.error_message ?? "?"}`,
    },
  };
}

/**
 * Tìm modal review #2 ("Quản lý chỗ ngồi"). Khác modal #1: KHÔNG có input
 * numeric (đã ẩn), CÓ button "Thêm người dùng" + KHÔNG có nút "+/-".
 *
 * Heuristic: scan dialogs đang mở, pick dialog nào chứa text "suất" / "seat" /
 * currency amount + button matching `billingAddUserButton` patterns.
 */
function findChargeModal(_quantity: number): HTMLElement | null {
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-state="open"]',
    ),
  );
  for (const dialog of dialogs) {
    // Modal #2 luôn có: "suất ... bổ sung" / "additional seat" / "tổng" / "total"
    const hasSeatPhrase =
      /suất.{0,20}bổ\s*sung|additional\s+seat|additional\s+user|bổ\s*sung|额外|附加/i.test(
        dialog.textContent ?? "",
      );
    // KHÔNG có input numeric đang visible
    const numericInputs = Array.from(
      dialog.querySelectorAll<HTMLInputElement>("input"),
    ).filter((i) => /^\d{1,3}$/.test((i.value ?? "").trim()));
    // CÓ button "Thêm người dùng" hoặc tương tự
    const hasConfirmButton = !!queryByAnyText(
      "button",
      TEXT_FALLBACKS.billingAddUserButton,
      dialog,
    );
    if (hasSeatPhrase && numericInputs.length === 0 && hasConfirmButton) {
      return dialog;
    }
    // Fallback: dialog có currency amount + confirm button
    const hasCurrency = /[₫đ]\s*\d|\$\s*\d|¥\s*\d/i.test(dialog.textContent ?? "");
    if (hasCurrency && hasConfirmButton && numericInputs.length === 0) {
      return dialog;
    }
  }
  return null;
}

/**
 * Đọc số "X suất ... bổ sung" / "X additional seats" từ modal text. Trả null
 * nếu không match (caller skip sanity check).
 */
function extractAdditionalSeatCountFromModal(text: string): number | null {
  const patterns: RegExp[] = [
    /(\d{1,3})\s*suất.{0,30}bổ\s*sung/i,
    /(\d{1,3})\s*additional\s*(?:seat|user|license)/i,
    /add\s*(\d{1,3})\s*(?:seat|user|license)/i,
    /添加?\s*(\d{1,3})\s*(?:个\s*)?(?:用户|席位|许可)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 0 && n <= 999) return n;
    }
  }
  return null;
}

/**
 * Scrape tổng tiền "Tổng đến hạn hôm nay" / "Total due today" từ modal.
 * Best-effort cho audit log — không bắt buộc.
 */
function extractChargeAmountFromModal(text: string): string | null {
  const patterns: RegExp[] = [
    /tổng\s*đến\s*hạn\s*hôm\s*nay\s*([₫đ]\s*[\d.,]+|\$\s*[\d.,]+)/i,
    /total\s*due\s*(?:today)?\s*([₫đ]\s*[\d.,]+|\$\s*[\d.,]+)/i,
    /(?:[₫đ]|\$)\s*([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

/**
 * Tìm nút "Thêm người dùng" trong modal review #2. Scope strictly trong modal
 * để tránh match nhầm "Thêm" ở chỗ khác.
 */
function findAddUserButton(modal: HTMLElement): HTMLElement | null {
  // Ưu tiên button primary (variant=primary / class chứa "primary" hoặc bg-black)
  // sau đó fallback text match.
  const inModal = queryByAnyText(
    "button",
    TEXT_FALLBACKS.billingAddUserButton,
    modal,
  );
  if (inModal) return inModal;
  // Fallback: button cuối trong modal (thường là primary CTA bên phải)
  const buttons = Array.from(modal.querySelectorAll<HTMLButtonElement>("button"));
  const visible = buttons.filter(
    (b) =>
      !b.hasAttribute("disabled") &&
      b.getAttribute("aria-label")?.toLowerCase() !== "close" &&
      !/close|đóng|关闭/i.test(b.getAttribute("aria-label") ?? "") &&
      b.offsetParent !== null,
  );
  // Loại bỏ nút "Hủy bỏ" / "Cancel"
  const noCancel = visible.filter(
    (b) => !/hủy|huỷ|cancel|取消/i.test((b.textContent ?? "").trim()),
  );
  return noCancel[noCancel.length - 1] ?? null;
}

/** Đợi modal review #2 đóng (dismissed) hoặc timeout. */
async function waitForChargeModalDismiss(modal: HTMLElement): Promise<boolean> {
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
