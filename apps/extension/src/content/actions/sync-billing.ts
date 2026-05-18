/**
 * Action SYNC_BILLING: scrape seat_total/seat_used + plan + billing_status từ
 * trang /admin/billing và trả về để background gửi PATCH lên backend.
 */

import type { ExecuteActionResponse } from "../../shared/messages";
import { humanClick, sleep } from "../human";
import { findControlByKey } from "../i18n-ui";
import type { UiLabelPage } from "../../shared/ui-labels";
import { reportProgress } from "../progress";
import { scrapeBillingFromDom } from "../scrapers/billing";
import { TEXT_FALLBACKS } from "../selectors";

const BILLING_PATH = "/admin/billing";

/** Render delay sau khi navigate / click tab trong SPA. */
const POST_NAV_RENDER_MS = 2500;

/**
 * Click 1 trong các tab buttons theo text. Trả true nếu click được, false nếu
 * không tìm thấy.
 */
async function clickBillingTab(
  controlKey: string,
  texts: readonly string[],
): Promise<boolean> {
  const page: UiLabelPage = location.search.includes("tab=invoices")
    ? "/admin/billing?tab=invoices"
    : "/admin/billing";
  const btn = findControlByKey(controlKey, texts, { page });
  if (btn) {
    console.log(
      `[autogpt-sync-billing] click billing tab matched=`,
      (btn.textContent ?? "").trim().slice(0, 60),
      "tag=", btn.tagName,
      "role=", btn.getAttribute("role"),
    );
    await humanClick(btn);
    await sleep(POST_NAV_RENDER_MS);
    return true;
  }
  console.warn(
    `[autogpt-sync-billing] clickBillingTab MISS — texts tried=`,
    texts,
    "all button/tab/anchor texts on page=",
    Array.from(
      document.querySelectorAll<HTMLElement>('button, [role="tab"], a'),
    )
      .map((e) => (e.textContent ?? "").trim().slice(0, 40))
      .filter((s) => s.length > 0 && s.length < 60)
      .slice(0, 30),
  );
  return false;
}

/**
 * Diagnostic dump: log mọi field scrape được + 1 snippet text visible.
 * Gọi khi scrape lần đầu null để biết regex nào miss.
 */
function logBillingDiagnostic(label: string, billing: ReturnType<typeof scrapeBillingFromDom>) {
  const main =
    document.querySelector("main") ??
    document.querySelector("[role='main']") ??
    document.body;
  const text = (main?.textContent ?? "").replace(/\s+/g, " ").trim();
  const hasSeatKeyword =
    /giấy\s*phép|license|seat|ghế|chỗ\s*ngồi|许可证|席位/i.test(text);
  const hasSeatRatio = /\d{1,3}\s*\/\s*\d{1,3}/.test(text);
  const hasPlanKeyword = /business|enterprise|team|gói|企业|商业|团队/i.test(text);
  console.log(
    `[autogpt-sync-billing] ${label} →`,
    JSON.stringify({
      url: location.href,
      seat: `${billing.seat_used}/${billing.seat_total}`,
      plan: billing.plan,
      status: billing.billing_status,
      renewal: billing.renewal_date,
      invoices_count: billing.invoices.length,
      text_length: text.length,
      has_seat_keyword: hasSeatKeyword,
      has_seat_ratio_pattern: hasSeatRatio,
      has_plan_keyword: hasPlanKeyword,
      text_snippet: text.slice(0, 400),
    }),
  );
}

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

  // Navigate vào trang billing (nếu chưa ở đó).
  if (!location.pathname.startsWith(BILLING_PATH)) {
    history.pushState({}, "", BILLING_PATH);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(POST_NAV_RENDER_MS);
  } else {
    await sleep(800);
  }

  // Step 1: click tab "Kế hoạch" → scrape seat + plan + chu kỳ
  // (URL ?tab=invoices có thể sticky nên dùng click button thay vì URL).
  await reportProgress(
    taskId,
    { phase: "scraping", message: "Đang đọc tab Kế hoạch (seat + chu kỳ)..." },
    true,
  );
  const planTabClicked = await clickBillingTab(
    "tab_billing_plan",
    TEXT_FALLBACKS.tabBillingPlan,
  );
  if (!planTabClicked) {
    console.warn(
      "[autogpt-sync-billing] không tìm thấy tab Kế hoạch — có thể đã active sẵn",
    );
  }

  let billing = scrapeBillingFromDom();
  logBillingDiagnostic("plan-tab attempt #0", billing);
  for (let i = 0; i < 6 && billing.seat_total === null; i++) {
    await sleep(700);
    billing = scrapeBillingFromDom();
    if (billing.seat_total === null) {
      logBillingDiagnostic(`plan-tab attempt #${i + 1}`, billing);
    }
  }
  const seatFromPlan = {
    plan: billing.plan,
    seat_total: billing.seat_total,
    seat_used: billing.seat_used,
    billing_status: billing.billing_status,
    renewal_date: billing.renewal_date,
  };

  // Step 2: click tab "Hoá đơn" → scrape list invoices (giá per-slot prorated)
  await reportProgress(
    taskId,
    { phase: "scraping", message: "Đang đọc tab Hoá đơn (lịch sử giá)..." },
    true,
  );
  const invoicesTabClicked = await clickBillingTab(
    "tab_billing_invoices",
    TEXT_FALLBACKS.tabBillingInvoices,
  );
  if (!invoicesTabClicked) {
    console.warn(
      "[autogpt-sync-billing] không tìm thấy tab Hoá đơn — skip invoices",
    );
  } else {
    for (let i = 0; i < 6; i++) {
      const next = scrapeBillingFromDom();
      if (i === 0 || next.invoices.length === 0) {
        logBillingDiagnostic(`invoices-tab attempt #${i}`, next);
      }
      if (next.invoices.length > 0) {
        billing = {
          ...seatFromPlan,
          // Giữ seat/plan/renewal từ step 1 (vì ở tab Hoá đơn không có)
          plan: seatFromPlan.plan ?? next.plan,
          seat_total: seatFromPlan.seat_total ?? next.seat_total,
          seat_used: seatFromPlan.seat_used ?? next.seat_used,
          billing_status:
            seatFromPlan.billing_status ?? next.billing_status,
          renewal_date: seatFromPlan.renewal_date ?? next.renewal_date,
          invoices: next.invoices,
        };
        break;
      }
      await sleep(700);
    }
  }

  // Nới yêu cầu: nếu CẢ seat lẫn invoices đều rỗng → mới fail.
  // Trường hợp chỉ thiếu seat (vd ChatGPT đổi UI Kế hoạch) nhưng vẫn có
  // invoices → push partial data còn hơn fail toàn task.
  if (
    billing.seat_total === null &&
    billing.seat_used === null &&
    billing.invoices.length === 0
  ) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        "Không scrape được gì từ /admin/billing — cả seat ratio lẫn invoices " +
        "list đều trống. Verify: page render xong, URL hiện tại " +
        location.href,
    };
  }

  await reportProgress(
    taskId,
    {
      phase: "uploading",
      message: `Seat ${billing.seat_used ?? "?"}/${billing.seat_total ?? "?"} · ${billing.invoices.length} hoá đơn, đang upload...`,
    },
    true,
  );

  return {
    ok: true,
    data: { billing },
  };
}
