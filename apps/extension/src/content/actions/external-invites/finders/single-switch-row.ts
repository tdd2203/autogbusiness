/**
 * CSS selector cho switch/checkbox trên trang /admin/identity. Dùng chung bởi
 * finders trong folder này (`single-switch-row`, `find-toggle`, ...).
 */
export const SWITCH_SEL = 'button[role="switch"], input[type="checkbox"]';

/**
 * Trả về ancestor LỚN NHẤT của `el` mà vẫn chỉ chứa đúng 1 switch — tức là
 * "row" bao quanh đúng 1 toggle. Dùng để scope text match cho 1 toggle duy
 * nhất, tránh nuốt nhầm label của toggle khác trên cùng trang.
 *
 * Trả về CHÍNH `el` nếu parent đã có nhiều switch — đảm bảo luôn có 1 element
 * để check label (dù chỉ là text của bản thân switch / sibling gần).
 */
export function findSingleSwitchRow(el: HTMLElement): HTMLElement {
  let p: HTMLElement | null = el.parentElement;
  let row: HTMLElement | null = null;
  for (let depth = 0; depth < 8 && p; depth++, p = p.parentElement) {
    const switchCount = p.querySelectorAll(SWITCH_SEL).length;
    if (switchCount === 1) {
      row = p;
    } else if (switchCount > 1) {
      break;
    }
  }
  return row ?? el;
}
