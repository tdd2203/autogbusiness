import { sleep } from "../../../human";
import {
  EXTERNAL_INVITE_EXCLUDE_PATTERNS,
  EXTERNAL_INVITE_LABEL_PATTERNS,
} from "../../../i18n-ui";
import { pickAria, step, type Ctx, type HarvestItem } from "../ctx";
import { navigateSpaVerified } from "../nav";

export async function harvestIdentity(
  ctx: Ctx,
  out: HarvestItem[],
): Promise<void> {
  await step(ctx, "Mở /admin/identity");
  const ok = await navigateSpaVerified("/admin/identity");
  if (!ok) {
    await step(ctx, "⚠ Bỏ qua /admin/identity (nav fail)");
    return;
  }
  await sleep(1200);
  await step(ctx, "Đọc toggle 'Allow External Domain Invites'");
  const SWITCH_SEL = 'button[role="switch"], input[type="checkbox"]';
  const switches = Array.from(document.querySelectorAll<HTMLElement>(SWITCH_SEL));

  // Tìm row (ancestor lớn nhất vẫn chỉ chứa 1 switch) để scope text match — tránh
  // nuốt nhầm label của toggle khác (vd "Automatic Account Creation") khi 2 toggle
  // share ancestor.
  type Cand = { el: HTMLElement; row: HTMLElement; raw: string; hit: string; score: number };
  const cands: Cand[] = [];
  for (const el of switches) {
    let p: HTMLElement | null = el.parentElement;
    let row: HTMLElement | null = null;
    for (let depth = 0; depth < 8 && p; depth++, p = p.parentElement) {
      const cnt = p.querySelectorAll(SWITCH_SEL).length;
      if (cnt === 1) row = p;
      else if (cnt > 1) break;
    }
    if (!row) continue;
    const raw = (row.textContent ?? "").trim().replace(/\s+/g, " ");
    const lower = raw.toLowerCase();
    if (EXTERNAL_INVITE_EXCLUDE_PATTERNS.some((p) => lower.includes(p))) continue;
    let bestHit = "";
    let bestLen = 0;
    for (const pat of EXTERNAL_INVITE_LABEL_PATTERNS) {
      if (lower.includes(pat) && pat.length > bestLen) {
        bestLen = pat.length;
        bestHit = pat;
      }
    }
    if (bestLen > 0) cands.push({ el, row, raw, hit: bestHit, score: bestLen });
  }
  if (cands.length === 0) return;
  // Pick longest-pattern-match — most specific row wins.
  cands.sort((a, b) => b.score - a.score);
  const winner = cands[0];
  const sentences = winner.raw.split(/(?<=[.。?!？!])\s+|\s+(?=•|·)/);
  const cand =
    sentences.find((s) => s.toLowerCase().includes(winner.hit)) ?? winner.raw;
  const clipped = cand.length > 180 ? cand.slice(0, 180) : cand;
  out.push({
    control_key: "toggle_external_invites",
    label_text: clipped,
    aria_label: pickAria(winner.el),
  });
  ctx.scanned += 1;
}
