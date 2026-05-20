import { findSingleSwitchRow } from "./single-switch-row";

/**
 * Lấy tất cả "label text" có thể gắn với 1 switch, theo độ đặc trưng giảm dần:
 *   1. aria-labelledby → text của element được tham chiếu (chính xác nhất)
 *   2. aria-label trên chính switch
 *   3. <label for="{switch.id}">
 *   4. closest <label> ancestor
 *   5. text của previous sibling (label thường đứng trước switch)
 *   6. text của single-switch row (fallback rộng nhất, có thể nuốt nhầm)
 *
 * Concat tất cả → lowercase → dùng cho includes() check pattern + exclude.
 */
export function extractSwitchLabel(el: HTMLElement): string {
  const parts: string[] = [];
  const seen = new Set<HTMLElement>();
  const addText = (node: HTMLElement | null) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    const t = (node.textContent ?? "").trim();
    if (t) parts.push(t);
  };

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      const lbl = document.getElementById(id);
      if (lbl) addText(lbl);
    }
  }
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) parts.push(ariaLabel);
  if (el.id) {
    const lblFor = document.querySelector<HTMLElement>(
      `label[for="${CSS.escape(el.id)}"]`,
    );
    addText(lblFor);
  }
  addText(el.closest("label"));
  // Previous siblings (limit 3 — đủ cho structure <h3>label</h3><p>desc</p><switch/>)
  let prev = el.previousElementSibling as HTMLElement | null;
  for (let i = 0; i < 3 && prev; i++, prev = prev.previousElementSibling as HTMLElement | null) {
    addText(prev);
  }
  addText(findSingleSwitchRow(el));

  return parts.join(" | ").toLowerCase().replace(/\s+/g, " ").trim();
}
