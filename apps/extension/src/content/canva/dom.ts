/**
 * Tìm phần tử trên trang Canva THEO CHỮ NGƯỜI DÙNG NHÌN THẤY.
 *
 * Canva sinh class ngẫu nhiên theo mỗi lần build (`_1a2b3c`), nên bám class hay
 * `data-*` là hỏng ngay lần Canva deploy kế tiếp. Chữ hiển thị ("Mời thành viên",
 * "Xác nhận và mời") sống lâu hơn nhiều — cùng cách nhánh ChatGPT đang làm.
 *
 * Mọi phép so sánh đều BỎ DẤU và bỏ hoa/thường: người dùng có thể để giao diện tiếng
 * Việt có dấu, và Canva đôi khi đổi "Mời mọi người" ↔ "Mời thành viên".
 */

import { sleep } from "../human";

/** Bỏ dấu tiếng Việt + hạ chữ thường + gộp khoảng trắng. */
export function norm(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function visible(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hidden) return false;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

const CLICKABLE = 'button, [role="button"], [role="menuitem"], [role="option"], a';

/** Phần tử bấm được có chữ CHỨA `text` (đã chuẩn hoá). Ưu tiên nút nhỏ nhất. */
export function clickableByText(text: string, root: ParentNode = document): HTMLElement | null {
  const want = norm(text);
  const found = [...root.querySelectorAll<HTMLElement>(CLICKABLE)].filter(
    (el) => visible(el) && norm(el.textContent).includes(want),
  );
  if (found.length === 0) return null;
  // Nút nhỏ nhất = nút thật, không phải cả khối cha bọc ngoài.
  return found.sort((a, b) => a.textContent!.length - b.textContent!.length)[0];
}

/** Nút bấm được khớp MỘT TRONG các chữ (thấy cái nào lấy cái đó). */
export function clickableByAnyText(
  texts: string[],
  root: ParentNode = document,
): HTMLElement | null {
  for (const t of texts) {
    const el = clickableByText(t, root);
    if (el) return el;
  }
  return null;
}

/** Phần tử BẤT KỲ đang hiện có chữ chứa `text`. */
export function elementByText(text: string, root: ParentNode = document): HTMLElement | null {
  const want = norm(text);
  const all = [...root.querySelectorAll<HTMLElement>("*")].filter(
    (el) => visible(el) && norm(el.textContent).includes(want),
  );
  if (all.length === 0) return null;
  return all.sort((a, b) => a.textContent!.length - b.textContent!.length)[0];
}

export function hasText(text: string, root: ParentNode = document): boolean {
  return elementByText(text, root) !== null;
}

/** Chờ tới khi `fn` trả giá trị khác null/false, hoặc hết giờ (trả null). */
export async function waitUntil<T>(
  fn: () => T | null | false,
  timeoutMs = 15000,
  pollMs = 200,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

/** Hộp thoại đang mở (nếu có) — giới hạn phạm vi tìm để không bấm nhầm nền sau. */
export function openDialog(): HTMLElement | null {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"], dialog')].filter(
    visible,
  );
  return dialogs.length ? dialogs[dialogs.length - 1] : null;
}

/** Email đầu tiên tìm thấy trong một đoạn chữ. */
export function emailIn(text: string | null | undefined): string | null {
  const m = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(text ?? "");
  return m ? m[0].toLowerCase() : null;
}

/** Số đầu tiên trong đoạn chữ (dùng đọc "Đội của bạn có 2 người"). */
export function numberIn(text: string | null | undefined): number | null {
  const m = /(\d[\d.,]*)/.exec(text ?? "");
  if (!m) return null;
  const n = Number(m[1].replace(/[.,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Đang ở đúng trang quản lý thành viên của Canva chưa. */
export function onPeoplePage(): boolean {
  return /canva\.com\/settings\/(people|members)/i.test(location.href);
}

/** Ô nhập email đang trống trong hộp mời. */
export function emptyEmailInputs(root: ParentNode = document): HTMLInputElement[] {
  return [...root.querySelectorAll<HTMLInputElement>("input")].filter((el) => {
    if (!visible(el)) return false;
    if (el.value.trim() !== "") return false;
    const hint = norm(
      `${el.placeholder} ${el.getAttribute("aria-label") ?? ""} ${el.type}`,
    );
    return hint.includes("email") || el.type === "email";
  });
}
