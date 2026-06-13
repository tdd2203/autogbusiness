import { sleep } from "../../../human";
import { findUiControlByTexts } from "../../../i18n-ui";
import { TEXT_FALLBACKS } from "../../../selectors";
import { recordIfText, step, type Ctx, type HarvestItem } from "../ctx";
import { navigateSpaVerified } from "../nav";

export async function harvestBillingInvoices(
  ctx: Ctx,
  out: HarvestItem[],
): Promise<void> {
  await step(ctx, "Mở /admin/billing?tab=invoices");
  const ok = await navigateSpaVerified("/admin/billing", "?tab=invoices");
  if (!ok) {
    await step(ctx, "⚠ Bỏ qua /admin/billing?tab=invoices (nav fail)");
    return;
  }
  await sleep(800);
  await step(ctx, "Đọc tab Hoá đơn");
  recordIfText(
    out,
    ctx,
    "tab_billing_invoices",
    findUiControlByTexts(TEXT_FALLBACKS.tabBillingInvoices),
  );
}
