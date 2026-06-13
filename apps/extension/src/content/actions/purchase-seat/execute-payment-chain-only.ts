import type { ExecuteActionResponse } from "../../../shared/messages";
import { sleep, waitFor } from "../../human";
import { reportProgress } from "../../progress";
import { POST_NAV_RENDER_MS } from "./constants";
import { findFirstUnpaidInvoice } from "./invoice/find-first-unpaid";
import type { PaymentChainResultLite } from "./types";

/**
 * Chạy CHỈ Phase 2.5 → 4 (tab Hóa đơn → Stripe → Link), giả định invoice
 * "Đến hạn" đã được tạo từ trước.
 */
export async function executePaymentChainOnly(
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
