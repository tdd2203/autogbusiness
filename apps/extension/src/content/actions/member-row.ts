import { querySelectorFirst } from "../human";
import { SELECTORS } from "../selectors";

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
