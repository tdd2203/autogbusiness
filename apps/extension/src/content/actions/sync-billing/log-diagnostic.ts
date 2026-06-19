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
  // Khi renewal null: dump đoạn text quanh từ khoá renew + mọi token giống ngày
  // → đủ để hoàn thiện regex parseRenewalSingleDate mà không cần đoán mò.
  const renewalKwRe =
    /gia\s*hạn|tái\s*tục|tiếp\s*theo|renew|next\s*(?:billing|payment|invoice|charge|bill)|chu\s*kỳ|续订|续期|下次/i;
  const kw = text.match(renewalKwRe);
  const renewalContext =
    billing.renewal_date === null && kw && kw.index !== undefined
      ? text.slice(Math.max(0, kw.index - 30), kw.index + 90)
      : null;
  const dateTokens =
    billing.renewal_date === null
      ? (text.match(
          /\d{1,2}\s*(?:thg|tháng|月)\s*\d{1,2}[^,]{0,8}\d{0,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z.]*\s*\d{1,2},?\s*\d{0,4}|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}/gi,
        ) ?? []).slice(0, 8)
      : null;
  console.log(
    `[autogpt-sync-billing] ${label} →`,
    JSON.stringify({
      url: location.href,
      seat: `${billing.seat_used}/${billing.seat_total}`,
      plan: billing.plan,
      status: billing.billing_status,
      renewal: billing.renewal_date,
      renewal_context: renewalContext,
      date_tokens: dateTokens,
      invoices_count: billing.invoices.length,
      text_length: text.length,
      has_seat_keyword: hasSeatKeyword,
      has_seat_ratio_pattern: hasSeatRatio,
      has_plan_keyword: hasPlanKeyword,
      text_snippet: text.slice(0, 400),
    }),
  );
}
