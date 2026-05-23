import { reportProgress } from "../../progress";

export type HarvestItem = {
  control_key: string;
  label_text?: string | null;
  aria_label?: string | null;
};

export type HarvestPage = {
  page:
    | "/admin/members"
    | "/admin/billing"
    | "/admin/billing?tab=invoices"
    | "/admin/identity";
  labels: HarvestItem[];
};

export type Ctx = {
  taskId: string;
  startedAt: number;
  scanned: number;
  step: number;
  totalSteps: number;
};

export const PROGRESS_PHASE = "scraping";

export function pickText(el: HTMLElement | null): string | undefined {
  if (!el) return undefined;
  const t = (el.textContent ?? "").trim().replace(/\s+/g, " ");
  return t.length > 0 && t.length <= 120 ? t : undefined;
}

export function pickAria(el: HTMLElement | null): string | undefined {
  if (!el) return undefined;
  const a = (el.getAttribute("aria-label") ?? "").trim();
  return a.length > 0 && a.length <= 120 ? a : undefined;
}

export function elapsedSec(ctx: Ctx): number {
  return Math.round((Date.now() - ctx.startedAt) / 1000);
}

export async function step(ctx: Ctx, message: string): Promise<void> {
  ctx.step += 1;
  await reportProgress(
    ctx.taskId,
    {
      phase: PROGRESS_PHASE,
      message: `[${ctx.step}/${ctx.totalSteps}] ${message}`,
      current: ctx.step,
      total: ctx.totalSteps,
      scanned: ctx.scanned,
      elapsed_sec: elapsedSec(ctx),
    },
    true,
  );
}

export function recordIfText(
  out: HarvestItem[],
  ctx: Ctx,
  key: string,
  el: HTMLElement | null,
  fallback?: { label_text?: string; aria_label?: string },
): boolean {
  const t = pickText(el) ?? fallback?.label_text;
  const a = pickAria(el) ?? fallback?.aria_label;
  if (!t && !a) return false;
  out.push({ control_key: key, label_text: t, aria_label: a });
  ctx.scanned += 1;
  return true;
}
