import { scrapeBillingFromDom } from "../../scrapers/billing";

/**
 * Diagnostic dump: log mọi field scrape được + 1 snippet text visible.
 * Gọi khi scrape lần đầu null để biết regex nào miss.
 */
export function logBillingDiagnostic(
  label: string,
  billing: ReturnType<typeof scrapeBillingFromDom>,
): void {
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
