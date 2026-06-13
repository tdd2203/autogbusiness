/**
 * HARVEST_LABELS — extension tự crawl DOM ChatGPT /admin/* để đọc text label
 * cho 18 control_key × 1 locale. Admin chọn locale (vi/en/zh) trên dashboard,
 * đặt ChatGPT sang ngôn ngữ tương ứng, rồi bấm "Tự động harvest".
 *
 * Mỗi bước:
 *   - Verify navigate thành công trước khi đọc (nếu Next.js router không
 *     bắt popstate, ta skip page đó thay vì hang).
 *   - Report progress real-time (step + scanned count) để dashboard hiện
 *     thanh tiến trình.
 *   - Timeout từng step ngắn — fail-fast để không kẹt.
 */

import type { ExecuteActionResponse } from "../../../shared/messages";
import { reportProgress } from "../../progress";
import { elapsedSec, step, type Ctx, type HarvestPage } from "./ctx";
import { navigateSpaVerified } from "./nav";
import { harvestBillingInvoices } from "./pages/billing-invoices";
import { harvestBillingPlan } from "./pages/billing-plan";
import { harvestIdentity } from "./pages/identity";
import { harvestMembers } from "./pages/members";

const MAX_HARVEST_MS = 180_000; // 3 phút hard timeout

export async function executeHarvestLabels(
  taskId: string,
  locale: "vi" | "en" | "zh",
): Promise<ExecuteActionResponse> {
  console.log(`[autogpt-harvest] START locale=${locale}`);

  // Phát signal đầu tiên ngay khi content script bắt đầu — KHÔNG đợi bước 1.
  // Mục đích: progress bar hiện 0/18 và status đổi từ "đợi" → "đang chạy"
  // trong < 1s sau khi background gọi sendMessage tới content script.
  await reportProgress(
    taskId,
    {
      phase: "starting",
      message: `Bắt đầu harvest locale ${locale.toUpperCase()} — kiểm tra trang ChatGPT...`,
      current: 0,
      total: 18,
      scanned: 0,
      elapsed_sec: 0,
    },
    true,
  );

  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}). Mở chatgpt.com/admin/members trước.`,
    };
  }

  const detectedLocale = (document.documentElement.lang ?? "").toLowerCase();
  if (
    (locale === "vi" && !detectedLocale.startsWith("vi")) ||
    (locale === "en" && !(detectedLocale.startsWith("en") || detectedLocale === "")) ||
    (locale === "zh" && !detectedLocale.startsWith("zh"))
  ) {
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message: `Locale ChatGPT đang là '${detectedLocale || "unknown"}' nhưng admin yêu cầu '${locale}'. Đổi ngôn ngữ ChatGPT sang ${locale} (Settings → Personalization) rồi F5 trước khi harvest.`,
    };
  }

  const pages: HarvestPage[] = [
    { page: "/admin/members", labels: [] },
    { page: "/admin/billing", labels: [] },
    { page: "/admin/billing?tab=invoices", labels: [] },
    { page: "/admin/identity", labels: [] },
  ];

  const ctx: Ctx = {
    taskId,
    startedAt: Date.now(),
    scanned: 0,
    step: 0,
    totalSteps: 18,
  };

  let timedOut = false;
  const guard = setTimeout(() => {
    timedOut = true;
    console.warn("[autogpt-harvest] global timeout 3 phút");
  }, MAX_HARVEST_MS);

  const runStep = async (
    fn: () => Promise<void>,
    label: string,
  ): Promise<void> => {
    if (timedOut) return;
    try {
      await fn();
    } catch (e) {
      console.warn(`[autogpt-harvest] ${label} step error`, e);
      await step(ctx, `⚠ ${label} bị lỗi nội bộ, tiếp tục`);
    }
  };

  await runStep(() => harvestMembers(ctx, pages[0].labels), "members");
  await runStep(() => harvestBillingPlan(ctx, pages[1].labels), "billing-plan");
  await runStep(
    () => harvestBillingInvoices(ctx, pages[2].labels),
    "billing-invoices",
  );
  await runStep(() => harvestIdentity(ctx, pages[3].labels), "identity");

  clearTimeout(guard);

  await step(ctx, `Quay về /admin/members (đã quét ${ctx.scanned} label)`);
  await navigateSpaVerified("/admin/members");

  const total = pages.reduce((s, p) => s + p.labels.length, 0);
  console.log(
    `[autogpt-harvest] DONE — scraped ${total} labels in ${elapsedSec(ctx)}s, timedOut=${timedOut}`,
  );

  if (total === 0) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Quét xong nhưng không lấy được label nào (${elapsedSec(ctx)}s). Kiểm tra: (1) đang ở chatgpt.com/admin, (2) workspace có member, (3) ChatGPT chưa đổi UI hoàn toàn.`,
    };
  }

  return {
    ok: true,
    data: {
      harvest: { locale, pages },
      total,
      elapsed_sec: elapsedSec(ctx),
      timed_out: timedOut,
    },
  };
}
