import { normalizeMatchText } from "../human";

/**
 * Hàng rào chặn REMOVE_MEMBER click nhầm item "Xuất dữ liệu" / "Xoá dữ liệu".
 *
 * ChatGPT (user report 2026-08-04, kèm ảnh UI vi + en) thêm 2 item vào menu "..."
 * của member **đã tham gia** (tab "Người dùng"):
 *
 *     Xuất dữ liệu       / Export data
 *     Xoá dữ liệu        / Delete data        ← XOÁ SẠCH dữ liệu member, KHÔNG HOÀN TÁC
 *     Loại bỏ thành viên / Remove member      ← item ta cần
 *
 * `TEXT_FALLBACKS.removeMenuItem` chứa nhãn LỎNG ("Xoá", "Xóa", "Delete", "删除")
 * xếp SAU nhãn đúng, nên hôm nay vẫn khớp đúng. Nhưng chỉ cần ChatGPT đổi chữ
 * "Loại bỏ thành viên" (đã đổi 2 lần: v0.4.4, v0.7.14) là nhãn lỏng rơi trúng
 * "Xoá dữ liệu" → extension mở dialog xoá dữ liệu, mà dialog đó cũng có nút đỏ
 * "Xóa" nên `confirmRemoveButton` bấm luôn ⇒ mất sạch dữ liệu member trong im lặng.
 * Nguy hiểm y hệt nếu label DB `menu_remove_member` bị HARVEST_LABELS ghi nhầm.
 *
 * Module này thuần hàm (không đụng DOM) để test được bằng vitest — xem
 * [`menu-guard.test.ts`](./menu-guard.test.ts).
 */

/** Nhãn mục "Xuất dữ liệu" (vi / en / zh-CN). */
export const EXPORT_DATA_MENU_TEXTS = [
  "Xuất dữ liệu thành viên",
  "Xuất dữ liệu",
  "Tải dữ liệu",
  "Export member data",
  "Export data",
  "Download data",
  "导出数据",
  "下载数据",
] as const;

/** Nhãn mục "Xoá dữ liệu" (vi / en / zh-CN). */
export const DELETE_DATA_MENU_TEXTS = [
  "Xoá dữ liệu thành viên",
  "Xóa dữ liệu thành viên",
  "Xoá dữ liệu",
  "Xóa dữ liệu",
  "Delete member data",
  "Delete data",
  "删除数据",
] as const;

/**
 * Nhãn của MỌI item menu thao tác trên DỮ LIỆU member. Đây là DENY-LIST cứng cho
 * REMOVE_MEMBER: item khớp 1 trong các chuỗi này KHÔNG BAO GIỜ được coi là item
 * "Loại bỏ thành viên", dù nhãn DB hay fallback có khớp text đến đâu.
 */
export const DATA_MENU_ITEM_TEXTS = [
  ...EXPORT_DATA_MENU_TEXTS,
  ...DELETE_DATA_MENU_TEXTS,
] as const;

/** Text này là item "Xuất/Xoá dữ liệu" (⇒ CẤM click khi đang xoá member)? */
export function isDataMenuItemText(text: string): boolean {
  const hay = normalizeMatchText(text);
  if (!hay) return false;
  return DATA_MENU_ITEM_TEXTS.some((t) => {
    const needle = normalizeMatchText(t);
    return needle !== "" && hay.includes(needle);
  });
}

/**
 * Lọc nhãn (thường từ DB `menu_remove_member`) trước khi đem đi dò menu.
 * Nhãn trỏ vào item dữ liệu bị loại và trả riêng ở `blocked` để báo mismatch —
 * dashboard sẽ thấy label stale thay vì extension âm thầm xoá dữ liệu.
 */
export function sanitizeRemoveLabels(labels: readonly string[]): {
  safe: string[];
  blocked: string[];
} {
  const safe: string[] = [];
  const blocked: string[] = [];
  for (const l of labels) {
    (isDataMenuItemText(l) ? blocked : safe).push(l);
  }
  return { safe, blocked };
}

/**
 * Chọn item "Loại bỏ thành viên" trong menu đang mở.
 *
 * @param itemTexts text của MỌI item trong menu, theo đúng thứ tự DOM.
 * @param labels    nhãn ứng viên theo thứ tự ưu tiên (DB trước, fallback sau).
 * @returns index trong `itemTexts`, hoặc `-1` nếu không có item AN TOÀN nào khớp.
 *
 * 2 vòng: khớp CHÍNH XÁC trước (theo thứ tự ưu tiên nhãn), rồi mới substring.
 * Nếu chỉ dò substring như trước, nhãn ngắn đứng trước ("Remove") có thể vơ phải
 * item dài hơn của thao tác khác. Item dữ liệu bị loại ở cả 2 vòng.
 */
export function pickRemoveMenuItemIndex(
  itemTexts: readonly string[],
  labels: readonly string[],
): number {
  const candidates = itemTexts
    .map((t, i) => ({ i, hay: normalizeMatchText(t) }))
    .filter((c) => c.hay !== "" && !isDataMenuItemText(c.hay));
  const needles = labels.map((l) => normalizeMatchText(l)).filter(Boolean);

  for (const n of needles) {
    const hit = candidates.find((c) => c.hay === n);
    if (hit) return hit.i;
  }
  for (const n of needles) {
    const hit = candidates.find((c) => c.hay.includes(n));
    if (hit) return hit.i;
  }
  return -1;
}

/** Loại thao tác trên dữ liệu member (2 mục menu mới của ChatGPT). */
export type DataMenuKind = "export" | "delete";

function matchesAny(hay: string, labels: readonly string[]): boolean {
  return labels.some((l) => {
    const n = normalizeMatchText(l);
    return n !== "" && hay.includes(n);
  });
}

/**
 * Chọn item "Xuất dữ liệu" HOẶC "Xoá dữ liệu" trong menu đang mở — chiều NGƯỢC
 * lại của `pickRemoveMenuItemIndex`, dùng cho 2 action EXPORT/DELETE_MEMBER_DATA.
 *
 * Loại trừ CHÉO: item phải khớp nhãn của ĐÚNG `kind` và KHÔNG khớp nhãn của kind
 * kia. Không thoả → `-1` (action FAILED) chứ không đoán bừa — click nhầm ở đây là
 * xoá dữ liệu người dùng, không hoàn tác.
 */
export function pickDataMenuItemIndex(
  itemTexts: readonly string[],
  kind: DataMenuKind,
): number {
  const wanted =
    kind === "export" ? EXPORT_DATA_MENU_TEXTS : DELETE_DATA_MENU_TEXTS;
  const other =
    kind === "export" ? DELETE_DATA_MENU_TEXTS : EXPORT_DATA_MENU_TEXTS;
  const candidates = itemTexts
    .map((t, i) => ({ i, hay: normalizeMatchText(t) }))
    .filter((c) => c.hay !== "" && !matchesAny(c.hay, other));

  for (const l of wanted) {
    const n = normalizeMatchText(l);
    if (!n) continue;
    const exact = candidates.find((c) => c.hay === n);
    if (exact) return exact.i;
  }
  for (const l of wanted) {
    const n = normalizeMatchText(l);
    if (!n) continue;
    const hit = candidates.find((c) => c.hay.includes(n));
    if (hit) return hit.i;
  }
  return -1;
}

/** Text (tiêu đề dialog / nhãn item) thuộc đúng `kind`, không phải kind kia? */
export function isDataTextOfKind(text: string, kind: DataMenuKind): boolean {
  const hay = normalizeMatchText(text);
  if (!hay) return false;
  const wanted =
    kind === "export" ? EXPORT_DATA_MENU_TEXTS : DELETE_DATA_MENU_TEXTS;
  const other =
    kind === "export" ? DELETE_DATA_MENU_TEXTS : EXPORT_DATA_MENU_TEXTS;
  return matchesAny(hay, wanted) && !matchesAny(hay, other);
}
