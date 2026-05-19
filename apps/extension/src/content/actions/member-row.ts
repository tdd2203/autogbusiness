import { querySelectorFirst } from "../human";
import { ROLE_LABELS } from "../i18n-ui";
import { SELECTORS } from "../selectors";
import type { ChatGPTRole } from "../../shared/messages";

export function findMemberRow(email: string): HTMLElement | null {
  const lower = email.toLowerCase();
  for (const sel of SELECTORS.memberRow) {
    const rows = document.querySelectorAll<HTMLElement>(sel);
    for (const row of Array.from(rows)) {
      const emailEl = querySelectorFirst<HTMLElement>(
        SELECTORS.memberRowEmail,
        row,
      );
      const emailText = (
        emailEl?.textContent ??
        row.textContent ??
        ""
      ).toLowerCase();
      if (emailText.includes(lower)) return row;
    }
  }
  return null;
}

export function findRowMenuButton(row: HTMLElement): HTMLElement | null {
  return querySelectorFirst<HTMLElement>(SELECTORS.memberRowMenu, row);
}

/**
 * Tìm INLINE role dropdown trong row member — UI 2026 đổi role qua dropdown
 * "Thành viên ▼" / "Member ▼" / "成员 ▼" hiển thị TRỰC TIẾP trong cột Vai trò
 * (KHÔNG còn ẩn trong "..." menu như UI cũ).
 *
 * Heuristic match (giảm dần):
 *   1. button/[role="combobox"]/[role="button"] với text node chỉ chứa role
 *      label (vd "Thành viên") → chính xác nhất, tránh nuốt nhầm seat type
 *      ("ChatGPT") cũng là dropdown trong row.
 *   2. button có aria-haspopup="menu"/"listbox" trong row (fallback rộng hơn,
 *      có thể trúng cả seat dropdown → caller phải kiểm tra).
 *
 * Bỏ qua "..." menu button (`memberRowMenu` selectors) — đó là menu khác.
 */
export function findRowRoleDropdown(
  row: HTMLElement,
  currentRole?: ChatGPTRole | null,
): HTMLElement | null {
  const menuBtn = findRowMenuButton(row);
  const isMenuBtn = (el: Element): boolean => menuBtn === el;

  // Tập role label ưu tiên cho currentRole, fallback hợp tất cả role labels
  const targetLabels = new Set<string>();
  if (currentRole) {
    for (const lbl of ROLE_LABELS[currentRole]) targetLabels.add(lbl.toLowerCase());
  } else {
    for (const role of ["owner", "admin", "member"] as ChatGPTRole[]) {
      for (const lbl of ROLE_LABELS[role]) targetLabels.add(lbl.toLowerCase());
    }
  }

  // Strategy 1: tìm element clickable có text matching role label
  const clickableSel =
    'button, [role="combobox"], [role="button"], [aria-haspopup="menu"], [aria-haspopup="listbox"]';
  const candidates = Array.from(row.querySelectorAll<HTMLElement>(clickableSel));
  for (const el of candidates) {
    if (isMenuBtn(el)) continue;
    const text = (el.textContent ?? "").trim().toLowerCase();
    // Strip caret/arrow chars
    const clean = text.replace(/[▼▾▿⌄⇣]/g, "").trim();
    if (!clean) continue;
    if (targetLabels.has(clean)) return el;
    // Substring match — UI có thể chèn icon text
    for (const lbl of targetLabels) {
      if (clean === lbl || clean.startsWith(lbl) || clean.endsWith(lbl)) {
        return el;
      }
    }
  }

  // Strategy 2: fallback rộng hơn — bất kỳ button có haspopup
  for (const el of candidates) {
    if (isMenuBtn(el)) continue;
    const haspopup = el.getAttribute("aria-haspopup");
    if (haspopup === "menu" || haspopup === "listbox") {
      const text = (el.textContent ?? "").trim().toLowerCase();
      // Loại "ChatGPT" / "Codex" seat dropdown (không phải role)
      if (text.includes("chatgpt") || text.includes("codex")) continue;
      return el;
    }
  }

  return null;
}
