import {
  EXTERNAL_INVITE_EXCLUDE_PATTERNS,
  EXTERNAL_INVITE_LABEL_PATTERNS,
} from "../../../i18n-ui";
import { dbLabelsFor, reportLabelMismatch } from "../../../../shared/ui-labels";
import { extractSwitchLabel } from "./extract-switch-label";
import { SWITCH_SEL } from "./single-switch-row";

/**
 * Tìm toggle "Allow External Domain Invites" bằng multi-strategy:
 *   1. Lấy tất cả switch/checkbox trên trang
 *   2. Với mỗi switch, extract label text từ aria-labelledby / aria-label /
 *      label[for] / closest label / prev siblings / single-switch row
 *   3. Loại các switch có label chứa EXCLUDE pattern (vd "Automatic Account Creation")
 *   4. Cho điểm = length của longest matching pattern → chọn switch điểm cao nhất
 *
 * Log diagnostic chi tiết để user debug khi DOM ChatGPT đổi.
 */
export function findExternalInvitesToggle(): HTMLElement | null {
  const dbLabels = dbLabelsFor("toggle_external_invites", "/admin/identity").map(
    (s) => s.toLowerCase(),
  );
  const patterns =
    dbLabels.length > 0
      ? [...dbLabels, ...EXTERNAL_INVITE_LABEL_PATTERNS]
      : EXTERNAL_INVITE_LABEL_PATTERNS;

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(SWITCH_SEL),
  );

  console.log(
    `[autogpt-external-invites] scan ${candidates.length} switch(es) on ${location.pathname}`,
  );

  let bestEl: HTMLElement | null = null;
  let bestScore = 0;
  let bestPattern = "";
  const diagnostic: Array<{ idx: number; label: string; matched: string | null; excluded: string | null }> = [];

  candidates.forEach((el, idx) => {
    const label = extractSwitchLabel(el);
    const excluded =
      EXTERNAL_INVITE_EXCLUDE_PATTERNS.find((p) => label.includes(p)) ?? null;
    if (excluded) {
      diagnostic.push({ idx, label: label.slice(0, 100), matched: null, excluded });
      return;
    }
    let longest = 0;
    let matchedPat: string | null = null;
    for (const p of patterns) {
      if (label.includes(p) && p.length > longest) {
        longest = p.length;
        matchedPat = p;
      }
    }
    diagnostic.push({ idx, label: label.slice(0, 100), matched: matchedPat, excluded: null });
    if (longest > bestScore) {
      bestScore = longest;
      bestEl = el;
      bestPattern = matchedPat ?? "";
    }
  });

  console.table(diagnostic);

  if (bestEl) {
    console.log(
      `[autogpt-external-invites] toggle matched via "${bestPattern}" (score=${bestScore})`,
    );
    return bestEl;
  }

  if (dbLabels.length > 0) {
    reportLabelMismatch("toggle_external_invites", dbLabels[0], "/admin/identity");
  }
  console.warn(
    "[autogpt-external-invites] không tìm thấy toggle — DOM ChatGPT có thể đã đổi. Patterns kỳ vọng:",
    patterns,
    "Exclude patterns:",
    EXTERNAL_INVITE_EXCLUDE_PATTERNS,
  );
  return null;
}
