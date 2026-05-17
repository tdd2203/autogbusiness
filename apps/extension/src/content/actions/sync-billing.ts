/**
 * Action SYNC_BILLING: scrape seat_total/seat_used + plan + billing_status từ
 * trang /admin/billing và trả về để background gửi PATCH lên backend.
 */

import type { ExecuteActionResponse } from "../../shared/messages";
import { sleep } from "../human";
import { reportProgress } from "../progress";
import { scrapeBillingFromDom } from "../scrapers/billing";

const BILLING_PATH = "/admin/billing";

/** Render delay sau khi navigate trong cùng SPA tab. */
const POST_NAV_RENDER_MS = 2500;

export async function executeSyncBilling(
  taskId: string,
): Promise<ExecuteActionResponse> {
  // Người dùng phải đang ở /admin/* (manifest content script chỉ match path đó).
  if (!location.pathname.startsWith("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}). Mở chatgpt.com/admin/billing trước.`,
    };
  }

  await reportProgress(
    taskId,
    { phase: "navigate", message: "Đang mở /admin/billing..." },
    true,
  );

  // Nếu đang ở trang khác trong /admin, dùng history.pushState để chuyển nội bộ
  // Next.js sẽ tự render component billing. KHÔNG full reload (tránh mất context).
  if (location.pathname !== BILLING_PATH) {
    history.pushState({}, "", BILLING_PATH);
    // Kích next.js intercept popstate
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(POST_NAV_RENDER_MS);
  } else {
    // Đang ở billing rồi, vẫn cần chờ render ổn định (mở popup → tab vừa load).
    await sleep(800);
  }

  await reportProgress(
    taskId,
    { phase: "scraping", message: "Đang đọc thông tin billing..." },
    true,
  );

  // Re-poll vài lần vì SPA có thể chưa render xong text
  let billing = scrapeBillingFromDom();
  for (let i = 0; i < 6 && billing.seat_total === null; i++) {
    await sleep(700);
    billing = scrapeBillingFromDom();
  }

  if (billing.seat_total === null && billing.seat_used === null) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        "Không tìm thấy '<số> / <số> giấy phép' trên trang /admin/billing. " +
        "ChatGPT có thể đã đổi UI — cập nhật scrapers/billing.ts.",
    };
  }

  await reportProgress(
    taskId,
    {
      phase: "uploading",
      message: `Đã đọc seat ${billing.seat_used ?? "?"}/${billing.seat_total ?? "?"}, đang upload...`,
    },
    true,
  );

  return {
    ok: true,
    data: { billing },
  };
}
