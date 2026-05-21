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

import type { ExecuteActionResponse } from "../../../shared/messages";
import { humanClick, sleep, waitFor } from "../../human";
import { findControlByKey } from "../../i18n-ui";
import { reportProgress } from "../../progress";
import { TEXT_FALLBACKS } from "../../selectors";
import {
  BILLING_PLAN_PATH,
  BILLING_PLAN_SEARCH,
  CHARGE_MODAL_TIMEOUT_MS,
  MAX_QUANTITY,
  MODAL_OPEN_TIMEOUT_MS,
  POST_NAV_RENDER_MS,
} from "./constants";
import { executePaymentChainOnly } from "./execute-payment-chain-only";
import { findFirstUnpaidInvoiceStripeUrl } from "./invoice/find-first-unpaid";
import { findContinueButton } from "./modal1/find-continue-button";
import { findIncrementButton } from "./modal1/find-increment-button";
import { findUserCountInput } from "./modal1/find-user-count-input";
import { extractChargeAmountFromModal } from "./modal2/extract-charge-amount";
import { extractAdditionalSeatCountFromModal } from "./modal2/extract-seat-count";
import { findAddUserButton } from "./modal2/find-add-user-button";
import { findChargeModal } from "./modal2/find-charge-modal";
import { waitForChargeModalDismiss } from "./modal2/wait-dismiss";
import type { PaymentChainResultLite } from "./types";

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
