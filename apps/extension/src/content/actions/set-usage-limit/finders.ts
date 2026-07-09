import { normalizeMatchText } from "../../human";
import { TEXT_FALLBACKS } from "../../i18n-ui";

/**
 * DOM finder cho trang /admin/billing/manage_member_usage_limit ("Ghi đè mỗi
 * người dùng"). Trang này KHÁC /admin/members → không dùng member-row.ts được:
 * mỗi row là 1 thành viên + cột "Hành động" có nút "Thêm" (chưa đặt) hoặc "Chỉnh
 * sửa" (đã đặt). Click nút mở dialog "Đặt giới hạn sử dụng tùy chỉnh" (số + Lưu +
 * Gỡ bỏ + ×).
 */

/** Có phải element đang hiển thị (không display:none / 0 kích thước)? */
function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** Button trong scope khớp 1 trong các nhãn (exact hoặc startsWith sau normalize). */
function findButtonByTexts(
  scope: ParentNode,
  texts: readonly string[],
): HTMLElement | null {
  const btns = Array.from(
    scope.querySelectorAll<HTMLElement>('button, [role="button"], a'),
  );
  for (const t of texts) {
    const needle = normalizeMatchText(t);
    if (!needle) continue;
    for (const b of btns) {
      if (!isVisible(b)) continue;
      const hay = normalizeMatchText(b.textContent ?? "");
      if (hay === needle || hay.startsWith(needle)) return b;
    }
  }
  return null;
}

/**
 * Tìm row của member theo email rồi trả về NÚT hành động ("Thêm"/"Chỉnh sửa") trên
 * row đó. Cách làm: tìm element nhỏ nhất chứa đúng text email → leo lên ancestor
 * cho tới khi gặp container có nút Thêm/Chỉnh sửa → đó là row.
 *
 * Trả về `{ button, isEdit }` hoặc null nếu không thấy.
 */
export function findUsageRowButton(
  email: string,
): { button: HTMLElement; isEdit: boolean } | null {
  const needle = email.toLowerCase();

  // 1) Cell chứa email — element "lá" (ít con) để tránh bắt nhằm cả bảng.
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>("td, div, span, p, a"),
  );
  let cell: HTMLElement | null = null;
  for (const el of candidates) {
    const txt = (el.textContent ?? "").toLowerCase();
    if (txt.includes(needle) && el.querySelectorAll("*").length <= 4) {
      if (isVisible(el)) {
        cell = el;
        break;
      }
    }
  }
  if (!cell) return null;

  // 2) Leo lên tìm ancestor có nút Thêm / Chỉnh sửa.
  const addTexts = TEXT_FALLBACKS.usageLimitAddButton;
  const editTexts = TEXT_FALLBACKS.usageLimitEditButton;
  let node: HTMLElement | null = cell;
  for (let i = 0; i < 8 && node; i++) {
    const edit = findButtonByTexts(node, editTexts);
    if (edit) return { button: edit, isEdit: true };
    const add = findButtonByTexts(node, addTexts);
    if (add) return { button: add, isEdit: false };
    node = node.parentElement;
  }
  return null;
}

/** Dialog "Đặt giới hạn sử dụng tùy chỉnh" đang mở (nếu có). */
export function findLimitDialog(): HTMLElement | null {
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'),
  );
  for (const d of dialogs) {
    if (isVisible(d)) return d;
  }
  return null;
}

/** Ô nhập số tín dụng trong dialog. */
export function findLimitInput(dialog: ParentNode): HTMLInputElement | null {
  const inputs = Array.from(
    dialog.querySelectorAll<HTMLInputElement>(
      'input[type="number"], input[type="text"], input:not([type])',
    ),
  );
  for (const inp of inputs) {
    if (isVisible(inp)) return inp;
  }
  return inputs[0] ?? null;
}

/**
 * Nút LƯU trong dialog. Match nhãn save; loại trừ nút "Gỡ bỏ" (xoá override) để
 * KHÔNG bao giờ click nhầm — yêu cầu user: chỉ ĐẶT số, không gỡ.
 */
export function findSaveButton(dialog: ParentNode): HTMLElement | null {
  const removeNeedles = TEXT_FALLBACKS.usageLimitRemoveButton.map((t) =>
    normalizeMatchText(t),
  );
  const isRemove = (el: HTMLElement): boolean => {
    const hay = normalizeMatchText(el.textContent ?? "");
    return removeNeedles.some((n) => n && (hay === n || hay.startsWith(n)));
  };
  const btns = Array.from(
    dialog.querySelectorAll<HTMLElement>('button, [role="button"]'),
  );
  for (const t of TEXT_FALLBACKS.usageLimitSaveButton) {
    const needle = normalizeMatchText(t);
    if (!needle) continue;
    for (const b of btns) {
      if (!isVisible(b) || isRemove(b)) continue;
      const hay = normalizeMatchText(b.textContent ?? "");
      if (hay === needle || hay.startsWith(needle)) return b;
    }
  }
  return null;
}

/** Text mọi button trong dialog — đưa vào error_message để debug DOM thật. */
export function dumpDialogButtons(dialog: ParentNode): string[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>("button, [role=button]"))
    .map((b) => (b.textContent ?? "").trim())
    .filter(Boolean);
}
