import { SELECTORS } from "../../../selectors";

/** Tìm pending invite rows (helper dùng chung). */
export function findPendingRows(): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const sel of SELECTORS.memberRow) {
    document.querySelectorAll<HTMLElement>(sel).forEach((r) => rows.push(r));
    if (rows.length > 0) break;
  }
  return rows;
}
