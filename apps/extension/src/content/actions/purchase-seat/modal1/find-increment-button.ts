/**
 * Tìm nút "+" trong modal review. ChatGPT dùng icon-only button kế bên input
 * số người dùng. Strategy: tìm 2 button anh em của user-count input, button
 * thứ 2 (sau số) thường là "+", button đầu là "-".
 */
export function findIncrementButton(input: HTMLInputElement): HTMLButtonElement | null {
  // Strategy 1: aria-label / text
  const dialog = input.closest<HTMLElement>(
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-state="open"]',
  );
  if (dialog) {
    const ariaMatch = dialog.querySelector<HTMLButtonElement>(
      'button[aria-label*="Increase" i], button[aria-label*="Increment" i], button[aria-label*="Tăng" i], button[aria-label*="Thêm" i], button[aria-label*="增加" i]',
    );
    if (ariaMatch) return ariaMatch;
  }

  // Strategy 2: tìm trong cùng row/container của input — button "+" thường
  // nằm bên phải input (sibling). Walk up tối đa 3 cấp tìm container.
  let row: HTMLElement | null = input.parentElement;
  for (let i = 0; i < 4 && row; i++) {
    const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>("button"));
    if (buttons.length >= 2) {
      // Có 2+ button trong cùng container → cái thứ 2 (DOM order: - đứng trước, + đứng sau)
      // hoặc cái mang ký tự "+" trong textContent / svg.
      const plusByText = buttons.find((b) => (b.textContent ?? "").trim() === "+");
      if (plusByText) return plusByText;
      // SVG-only: pick button bên phải input (lớn hơn input.getBoundingClientRect().right)
      const inputRect = input.getBoundingClientRect();
      const rightmost = buttons
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return r.left > inputRect.right - 5;
        })
        .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
      if (rightmost[0]) return rightmost[0];
      // Fallback: button cuối trong container (thường là +)
      return buttons[buttons.length - 1] ?? null;
    }
    row = row.parentElement;
  }
  return null;
}
