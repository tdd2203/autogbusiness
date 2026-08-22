import type { ChatGPTRole } from "../../../../shared/messages";
import { dbLabelsFor } from "../../../../shared/ui-labels";
import { ROLE_LABELS } from "../../../i18n-ui";

// Ký tự caret/mũi tên đi kèm dropdown ("Thành viên ▾") — strip trước khi so.
const CARET_RE = /[▼▾▿⌄⇣]/g;

/** Thứ tự so khớp: role "hẹp" trước để nhãn dài không bị nhãn ngắn nuốt. */
const ROLES: ChatGPTRole[] = ["analytics_viewer", "owner", "admin", "member"];

/** Text TRỰC TIẾP của 1 element (chỉ text node con, BỎ text của element con).
 *  Cô lập nhãn 1 cell — tránh nuốt text của các cell khác trong cùng row. */
function directText(el: HTMLElement): string {
  let s = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) s += node.nodeValue ?? "";
  }
  return s;
}

/**
 * Đọc VAI TRÒ đang hiển thị trong 1 row member (tab "Người dùng").
 *
 * Vì sao không dùng `findRowRoleDropdown(row, role)` để verify: hàm đó có
 * Strategy 2 fallback "bất kỳ button nào có aria-haspopup" — hỏi role nào nó
 * cũng trả element, nên dùng để XÁC MINH là luôn PASS (false positive). Ở đây
 * ta đọc NHÃN THẬT rồi map ngược về role, khớp cách `findLicenseTypeInRow` làm.
 *
 * Kỹ thuật giống license-type: duyệt mọi element, lấy DIRECT TEXT (bỏ text con),
 * strip caret, so khớp CHÍNH XÁC với nhãn role (DB ui_labels ưu tiên, rồi
 * `ROLE_LABELS`). So chính xác (không substring) để email/tên không lọt.
 *
 * Trả `null` nếu không đọc được nhãn nào — caller coi là KHÔNG xác minh được.
 */
export function findRoleInRow(row: HTMLElement): ChatGPTRole | null {
  // Gom nhãn → role. DB label (nếu admin đã calibrate) đứng trước fallback tĩnh.
  const labelToRole = new Map<string, ChatGPTRole>();
  for (const role of ROLES) {
    const labels = [
      ...dbLabelsFor(`invite_role_${role}`, "/admin/members"),
      ...ROLE_LABELS[role],
    ];
    for (const lbl of labels) {
      const key = lbl.replace(CARET_RE, "").trim().toLowerCase();
      if (key && !labelToRole.has(key)) labelToRole.set(key, role);
    }
  }

  for (const el of Array.from(row.querySelectorAll<HTMLElement>("*"))) {
    const t = directText(el).replace(CARET_RE, "").trim().toLowerCase();
    if (!t) continue;
    const role = labelToRole.get(t);
    if (role) return role;
  }
  return null;
}
