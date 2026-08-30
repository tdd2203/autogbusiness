/**
 * Cỡ chữ giao diện do người dùng tự chọn.
 *
 * VÌ SAO PHÓNG CẢ GIAO DIỆN CHỨ KHÔNG RIÊNG CHỮ: dashboard đặt cỡ chữ bằng px
 * cứng ở 672 chỗ inline trong TSX và 119 rule trong index.css, không chỗ nào
 * dùng rem — nên không có một chốt duy nhất để nhân lên. `zoom` trên thẻ gốc
 * phóng đều chữ, ô, khoảng cách, đường viền nên bố cục giữ nguyên tỉ lệ; đổi
 * 791 chỗ px sang rem thì diff cả nghìn dòng và dễ vỡ chỗ chữ dài.
 *
 * Lưu ở máy chứ không đẩy lên server: cỡ chữ là chuyện của từng màn hình, cùng
 * một tài khoản mở trên laptop và màn rời có thể muốn khác nhau.
 */

import { useSyncExternalStore } from "react";

export const UI_SCALES = [0.9, 1, 1.1, 1.25] as const;

export type UiScale = (typeof UI_SCALES)[number];

export const DEFAULT_UI_SCALE: UiScale = 1;

const STORAGE_KEY = "autogpt.uiScale";

// Bản đang áp. Giữ ở biến module để `layoutPx` đọc được mà không phải chạm
// localStorage mỗi lần mở menu.
let current: UiScale = DEFAULT_UI_SCALE;

const listeners = new Set<() => void>();

function parse(raw: string | null): UiScale {
  const n = Number(raw);
  return (UI_SCALES as readonly number[]).includes(n)
    ? (n as UiScale)
    : DEFAULT_UI_SCALE;
}

export function getUiScale(): UiScale {
  return current;
}

/**
 * Ghi thẳng `zoom` lên <html>. Để trống khi 100% để không phải sinh thêm
 * containing block thừa cho phần tử fixed lúc người dùng không đổi gì.
 *
 * Kèm theo `--ui-scale` vì `zoom` KHÔNG chia lại đơn vị viewport: ở cỡ 125%
 * thì `100vh` cao thành 125% màn hình, sidebar và modal tràn khỏi đáy không
 * cuộn tới được. Mọi mốc vh/vw trong app đã bọc `calc(... / var(--ui-scale))`
 * nên biến này phải luôn khớp với hệ số zoom.
 */
function paint(scale: UiScale) {
  document.documentElement.style.zoom = scale === 1 ? "" : String(scale);
  document.documentElement.style.setProperty("--ui-scale", String(scale));
}

/**
 * Gọi MỘT LẦN trước khi React vẽ, nếu không màn hình sẽ nháy một nhịp cỡ 100%
 * rồi mới nhảy sang cỡ đã chọn.
 */
export function initUiScale() {
  try {
    current = parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    current = DEFAULT_UI_SCALE;
  }
  paint(current);

  // Đổi cỡ ở tab này thì tab kia đang mở cũng phải đổi theo, khỏi bắt người
  // dùng F5 từng tab.
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    const next = parse(e.newValue);
    if (next === current) return;
    current = next;
    paint(current);
    listeners.forEach((fn) => fn());
  });
}

export function setUiScale(next: UiScale) {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // Chặn cookie/ẩn danh thì thôi không nhớ, vẫn áp cho phiên đang mở.
  }
  paint(next);
  listeners.forEach((fn) => fn());
}

export function subscribeUiScale(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Đổi px ĐO ĐƯỢC TRÊN MÀN HÌNH sang px trong cây đã zoom.
 *
 * getBoundingClientRect và window.innerHeight trả về px màn hình (đã nhân
 * zoom), nhưng khi gán `top`/`left` cho một phần tử `position: fixed` nằm
 * trong cây đã zoom thì trình duyệt NHÂN THÊM lần nữa. Đo được top 250 mà gán
 * top: 250 ở zoom 1.25 là phần tử rơi xuống 312.5 — menu ⋯ và tooltip mốc giờ
 * lệch hẳn khỏi nút bấm. Chia lại cho scale là hai bên về cùng một hệ.
 */
export function layoutPx(screenPx: number): number {
  return screenPx / current;
}

export function useUiScale(): UiScale {
  return useSyncExternalStore(subscribeUiScale, getUiScale, () => DEFAULT_UI_SCALE);
}
