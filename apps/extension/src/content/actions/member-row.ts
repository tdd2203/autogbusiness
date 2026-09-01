import { querySelectorFirst } from "../human";
import { ROLE_LABELS } from "../i18n-ui";
import { SELECTORS } from "../selectors";
import type { ChatGPTRole } from "../../shared/messages";

/**
 * Chữ trên dropdown CỘT LOẠI SUẤT của một row member — dùng để LOẠI TRỪ khi đi
 * tìm dropdown VAI TRÒ (hai dropdown nằm cạnh nhau trong cùng row).
 *
 * Cột này đổi tên hai lần: cũ in loại giấy phép ("ChatGPT"/"Codex"), UI
 * 2026-09-01 in loại suất ("Tiêu chuẩn"/"Cao cấp" · "Standard"/"Premium" ·
 * "标准"/"高级"). Giữ CẢ HAI thế hệ chữ vì workspace chưa được bật UI mới vẫn
 * hiện chữ cũ. Đã lowercase sẵn để so bằng `includes`.
 */
const SEAT_TYPE_DROPDOWN_TEXTS = [
  "chatgpt",
  "codex",
  "tiêu chuẩn",
  "cao cấp",
  "standard",
  "premium",
  "标准",
  "高级",
];

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

/**
 * Nút "..." (kebab) của row member — cửa vào MỌI action trên row: xoá thành
 * viên, thu hồi lời mời, đổi loại ghế, xuất/xoá dữ liệu, harvest label.
 *
 * ChatGPT 18/8/2026 GỠ `data-testid="member-menu-button"` lẫn `aria-label` khỏi
 * nút này. Nút vẫn hiện y nguyên trên UI nhưng thuộc tính chỉ còn
 * `aria-haspopup="menu"` — trùng KHÍT với dropdown vai trò ("Thành viên ⌄" /
 * "Member ⌄") cũng nằm trong row và đứng TRƯỚC "..." theo DOM order. Selector cũ
 * có fallback `button[aria-haspopup="menu"]` nên `querySelector` trả về cái ĐẦU
 * = dropdown vai trò → mọi action mở nhầm menu vai trò (chỉ có Member/Analytics
 * Viewer/Admin/Owner, không có "Loại bỏ thành viên") → FAILED_UI_CHANGED hàng
 * loạt: 15 task xoá trượt, 5 member hết hạn kẹt `MEMBER_REMOVE_STUCK` trong một
 * buổi sáng.
 *
 * Phân biệt bằng HÌNH DẠNG, không bằng attribute: kebab là nút CHỈ CÓ ICON (text
 * rỗng), còn mọi dropdown trong row đều mang nhãn chữ (vai trò, loại ghế). Dấu
 * hiệu này bền hơn `data-testid` — ChatGPT đổi/gỡ attribute liên tục, nhưng nút
 * icon không tự nhiên mọc chữ.
 */
export function findRowMenuButton(row: HTMLElement): HTMLElement | null {
  // 1) Selector ĐỊNH DANH — dùng lại ngay nếu ChatGPT trả testid/aria-label về.
  const exact = querySelectorFirst<HTMLElement>(SELECTORS.memberRowMenu, row);
  if (exact) return exact;

  // 2) Dò theo hình dạng: button mở popup menu và KHÔNG có chữ.
  const popups = Array.from(
    row.querySelectorAll<HTMLElement>(
      'button[aria-haspopup="menu"], [role="button"][aria-haspopup="menu"]',
    ),
  );
  const iconOnly = popups.filter((b) => !(b.textContent ?? "").trim());
  // Lấy cái CUỐI: kebab nằm ở cột phải ngoài cùng, nên nếu ChatGPT chèn thêm nút
  // icon nào đó vào giữa row thì "..." vẫn là cái sau chót.
  if (iconOnly.length > 0) return iconOnly[iconOnly.length - 1];

  // 3) Row chỉ có ĐÚNG 1 button popup → không có dropdown vai trò để nhầm (tài
  //    khoản không đủ quyền đổi role, hoặc tab "Lời mời") ⇒ nó chính là kebab.
  //    Nhiều hơn 1 mà cái nào cũng có chữ thì KHÔNG đoán bừa — trả null để action
  //    fail rõ ràng, thà vậy còn hơn bấm nhầm dropdown rồi báo lỗi lạc đề.
  return popups.length === 1 ? popups[0] : null;
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
      // Loại dropdown CỘT LOẠI SUẤT (không phải vai trò). Cột này từng in
      // "ChatGPT"/"Codex"; UI 2026-09-01 (ảnh user) đổi sang "Tiêu chuẩn" /
      // "Standard" / "标准" — chỉ chặn 2 chữ cũ là dropdown loại suất lọt vào
      // đây và lệnh đổi vai trò đi mở nhầm menu.
      if (SEAT_TYPE_DROPDOWN_TEXTS.some((t) => text.includes(t))) continue;
      return el;
    }
  }

  return null;
}
