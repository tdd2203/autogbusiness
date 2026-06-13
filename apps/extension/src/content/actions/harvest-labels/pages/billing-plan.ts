import { sleep } from "../../../human";
import { findUiControlByTexts } from "../../../i18n-ui";
import { TEXT_FALLBACKS } from "../../../selectors";
import { recordIfText, step, type Ctx, type HarvestItem } from "../ctx";
import { navigateSpaVerified } from "../nav";

export async function harvestBillingPlan(
  ctx: Ctx,
  out: HarvestItem[],
): Promise<void> {
  await step(ctx, "Mở /admin/billing");
  const ok = await navigateSpaVerified("/admin/billing");
  if (!ok) {
    await step(ctx, "⚠ Bỏ qua /admin/billing (nav fail)");
    return;
  }
  await sleep(800);
  await step(ctx, "Đọc 2 tab Billing (Kế hoạch + Hoá đơn)");
  for (const [key, texts] of [
    ["tab_billing_plan", TEXT_FALLBACKS.tabBillingPlan],
    ["tab_billing_invoices", TEXT_FALLBACKS.tabBillingInvoices],
  ] as const) {
    recordIfText(out, ctx, key, findUiControlByTexts(texts));
  }
}
