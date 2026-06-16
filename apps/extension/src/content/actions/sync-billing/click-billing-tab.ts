import { humanClick, sleep } from "../../human";
import { findControlByKey } from "../../i18n-ui";
import type { UiLabelPage } from "../../../shared/ui-labels";

/** Render delay sau khi navigate / click tab trong SPA. GIỮ NGUYÊN: phụ thuộc
 * tốc độ render trang (network/máy), không giảm. */
export const POST_NAV_RENDER_MS = 2500;

/**
 * Click 1 trong các tab buttons theo text. Trả true nếu click được, false nếu
 * không tìm thấy.
 */
export async function clickBillingTab(
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
