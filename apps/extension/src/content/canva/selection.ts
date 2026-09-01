/**
 * Chọn dòng bằng ô vuông + thanh thao tác ở đáy trang `canva.com/settings/people`.
 *
 * Dùng chung cho gỡ thành viên (`remove.ts`) và đổi vai trò (`role.ts`): cả hai đều
 * đi qua đúng một lối mà user mô tả kèm ảnh (2026-09-01) —
 *
 *   tick ô vuông đầu dòng → thanh đáy hiện "1 of 4 selected" kèm bốn nút chỉ có hình
 *   ("Change roles", "Resend invite (1)", thêm vào nhóm, "Remove users")
 *
 * BÁM THEO NHÃN, KHÔNG ĐẾM VỊ TRÍ: bốn nút đó `textContent` rỗng, chỉ phân biệt được
 * bằng `aria-label`/`title` đúng bằng chữ trong tooltip. Đếm "nút thứ tư" thì Canva
 * chèn thêm một nút là bấm nhầm sang việc khác.
 *
 * CHỐT SỐ DÒNG ĐANG CHỌN: mọi nút trên thanh này tác động lên TẤT CẢ dòng đang tick.
 * `selectRowAlone` chỉ trả về thành công khi thanh đọc ra đúng 1 dòng — đọc không ra
 * số thì coi như thất bại. Hiểu sai trạng thái một lần là gỡ nhầm cả đội, không có
 * nút hoàn tác.
 */

import { humanClick } from "../human";
import { emailIn, norm, visible, waitUntil } from "./dom";

/** Nhãn người dùng nhìn thấy của một nút, gồm cả tooltip (`aria-label`/`title`). */
export function labelOf(el: HTMLElement): string {
  return norm(
    `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""} ${el.textContent ?? ""}`,
  );
}

/** Dòng của email trong bảng thành viên (kể cả dòng lời mời đang chờ). */
export function rowOf(email: string): HTMLElement | null {
  const want = email.toLowerCase();
  const rows = [...document.querySelectorAll<HTMLElement>("tr, li, [role='row']")].filter(
    (r) => visible(r) && emailIn(r.textContent) === want,
  );
  if (rows.length === 0) return null;
  // Dòng NHỎ NHẤT chứa email (tránh chọn cả bảng khi bảng dựng bằng div).
  return rows.sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0))[0];
}

/** Ô tick đầu dòng + cách đọc nó đang bật hay tắt. */
export type RowCheckbox = { el: HTMLElement; checked: () => boolean };

export function rowCheckbox(row: HTMLElement): RowCheckbox | null {
  const painted = [...row.querySelectorAll<HTMLElement>('[role="checkbox"]')].find(visible);
  if (painted) {
    return { el: painted, checked: () => painted.getAttribute("aria-checked") === "true" };
  }
  const input = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!input) return null;
  // Canva vẽ ô vuông riêng và giấu input thật phía sau: bấm vào input vô hình không
  // ăn, phải bấm đúng thứ người dùng nhìn thấy.
  let target: HTMLElement = input;
  if (!visible(input)) {
    const shown = (input.closest("label") ?? input.parentElement) as HTMLElement | null;
    if (shown && visible(shown)) target = shown;
  }
  return { el: target, checked: () => input.checked };
}

/** Bỏ tick — không bỏ lại dòng đang chọn dở trên trang của người dùng. */
export async function untick(cb: RowCheckbox): Promise<void> {
  if (!cb.checked()) return;
  await humanClick(cb.el);
  await waitUntil(() => !cb.checked(), 2000);
}

/** Số dòng đang được tick, đọc từ thanh thao tác ("1 of 4 selected" / "Đã chọn 1…").
 *  Trả null khi không đọc được — và không đọc được thì không được bấm gì trên thanh. */
export function selectedCount(): number | null {
  for (const el of document.querySelectorAll<HTMLElement>("*")) {
    const raw = el.textContent ?? "";
    if (raw.length === 0 || raw.length > 60) continue; // nhãn ngắn, không phải cả trang
    const t = norm(raw);
    const m = /^(\d+) of \d+ selected$/.exec(t) ?? /^da chon (\d+)(\s|\/|$)/.exec(t);
    // `visible` bắt trình duyệt tính lại bố cục nên chỉ gọi cho vài phần tử đã khớp
    // chữ, không gọi cho cả cây DOM — hàm này chạy trong vòng chờ lặp 200ms.
    if (m && visible(el)) return Number(m[1]);
  }
  return null;
}

/**
 * Nút trên thanh thao tác khớp `wantMarks` và chắc chắn KHÔNG phải `avoidMarks`.
 * Tìm cả trang vì thanh nằm ngoài bảng.
 */
export function bulkBarButton(wantMarks: string[], avoidMarks: string[]): HTMLElement | null {
  const found = [...document.querySelectorAll<HTMLElement>("button, [role='button']")].find((b) => {
    if (!visible(b)) return false;
    const l = labelOf(b);
    if (avoidMarks.some((m) => l.includes(m))) return false;
    return wantMarks.some((m) => l.includes(m));
  });
  return found ?? null;
}

/** Kết quả của một lượt chọn dòng: hoặc chọn được đúng nó, hoặc lý do vì sao không. */
export type Selection =
  | { ok: true; checkbox: RowCheckbox }
  | { ok: false; reason: string };

/**
 * Tick đúng MỘT dòng rồi xác nhận thanh thao tác đang nói "1 dòng được chọn".
 * Thất bại thì tự bỏ tick, trả trang về đúng trạng thái ban đầu.
 */
export async function selectRowAlone(row: HTMLElement): Promise<Selection> {
  const cb = rowCheckbox(row);
  if (!cb) return { ok: false, reason: "no_checkbox" };

  if (!cb.checked()) {
    await humanClick(cb.el);
    await waitUntil(() => cb.checked(), 3000);
  }
  if (!cb.checked()) return { ok: false, reason: "checkbox_not_ticked" };

  const count = await waitUntil(selectedCount, 5000);
  if (count === null) {
    await untick(cb);
    return { ok: false, reason: "no_selection_bar" };
  }
  if (count !== 1) {
    // Còn dòng khác đang tick sẵn từ trước: nút trên thanh sẽ đụng cả họ.
    await untick(cb);
    return { ok: false, reason: `selected_${count}` };
  }
  return { ok: true, checkbox: cb };
}
