/**
 * CANVA_REMOVE — gỡ thành viên (hoặc thu hồi lời mời đang chờ) khỏi team Canva.
 *
 * ⚠️ CHƯA KHẢO SÁT ĐƯỢC TRANG THẬT: ảnh user gửi 2026-09-01 mới có luồng MỜI. Menu
 * gỡ nằm sau dấu "⌄" cạnh vai trò, và chưa rõ Canva hỏi xác nhận thế nào.
 *
 * Vì vậy file này đi theo lối AN TOÀN: thử đúng những chữ Canva hay dùng, và nếu
 * không thấy thì DỪNG với lỗi rõ ràng chứ không bấm mò. Bấm nhầm trong menu quản trị
 * có thể đổi vai trò người khác hoặc xoá nhầm người — hỏng cái đó đắt hơn nhiều so
 * với việc báo "chưa làm được, gỡ tay giúp".
 *
 * Khi có ảnh menu thật thì chỉ cần bổ sung chữ vào các hằng dưới đây.
 */

import type { CanvaActionRequest, CanvaActionResponse } from "../../shared/messages";
import { humanClick, sleep } from "../human";
import {
  clickableByAnyText,
  emailIn,
  norm,
  onPeoplePage,
  openDialog,
  visible,
  waitUntil,
} from "./dom";
import { scrapePeopleTable } from "./sync";

/** Chữ trên mục menu gỡ thành viên / thu hồi lời mời. */
const REMOVE_TEXTS = [
  "Xoá khỏi đội",
  "Xóa khỏi đội",
  "Gỡ khỏi đội",
  "Xoá thành viên",
  "Thu hồi lời mời",
  "Huỷ lời mời",
  "Hủy lời mời",
  "Remove from team",
  "Remove member",
  "Cancel invite",
  "Revoke invite",
];

/** Chữ trên nút xác nhận trong hộp thoại hỏi lại. */
const CONFIRM_TEXTS = ["Xoá", "Xóa", "Gỡ", "Thu hồi", "Xác nhận", "Remove", "Confirm"];

/** Dòng của email trong bảng thành viên. */
function rowOf(email: string): HTMLElement | null {
  const want = email.toLowerCase();
  const rows = [...document.querySelectorAll<HTMLElement>("tr, li, [role='row']")].filter(
    (r) => visible(r) && emailIn(r.textContent) === want,
  );
  if (rows.length === 0) return null;
  // Dòng NHỎ NHẤT chứa email (tránh chọn cả bảng khi bảng dựng bằng div).
  return rows.sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0))[0];
}

/** Nút mở menu hành động của dòng (dấu "⌄" cạnh vai trò, hoặc nút "…"). */
function rowMenuButton(row: HTMLElement): HTMLElement | null {
  const buttons = [...row.querySelectorAll<HTMLElement>("button, [role='button']")].filter(visible);
  if (buttons.length === 0) return null;
  // Nút menu thường không có chữ (chỉ icon) hoặc mang chữ vai trò + mũi tên.
  const iconOnly = buttons.find((b) => norm(b.textContent).length === 0);
  if (iconOnly) return iconOnly;
  const roleBtn = buttons.find((b) => {
    const t = norm(b.textContent);
    return t.includes("thanh vien doi") || t.includes("quan tri vien") || t.includes("thiet ke");
  });
  return roleBtn ?? buttons[buttons.length - 1];
}

async function removeOne(email: string): Promise<{ ok: boolean; reason?: string }> {
  const row = rowOf(email);
  if (!row) {
    // Không còn trong đội = kết quả mong muốn. Backend coi như đã gỡ.
    return { ok: true, reason: "not_in_team" };
  }
  const menuBtn = rowMenuButton(row);
  if (!menuBtn) return { ok: false, reason: "no_menu_button" };
  await humanClick(menuBtn);

  const item = await waitUntil(() => clickableByAnyText(REMOVE_TEXTS), 6000);
  if (!item) {
    // Đóng menu lại cho sạch trạng thái trang rồi mới báo lỗi.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return { ok: false, reason: "no_remove_item" };
  }
  await humanClick(item);

  // Có thể có hộp xác nhận — có thì bấm, không có thì thôi.
  const dlg = await waitUntil(() => openDialog(), 3000);
  if (dlg) {
    const confirm = clickableByAnyText(CONFIRM_TEXTS, dlg);
    if (confirm) await humanClick(confirm);
  }

  // Xác minh: email biến khỏi bảng.
  const gone = await waitUntil(() => {
    const emails = new Set(scrapePeopleTable().map((m) => m.email));
    return emails.has(email.toLowerCase()) ? null : true;
  }, 15000);
  return gone ? { ok: true } : { ok: false, reason: "still_in_team" };
}

export async function executeCanvaRemove(
  msg: Extract<CanvaActionRequest, { kind: "CANVA_REMOVE" }>,
): Promise<CanvaActionResponse> {
  if (!onPeoplePage()) {
    return {
      ok: false,
      error_code: "PAGE_NOT_PEOPLE",
      error_message: `Không ở trang thành viên Canva (đang ở ${location.href}).`,
    };
  }
  const emails = msg.emails.map((e) => e.toLowerCase()).filter(Boolean);
  const removed: string[] = [];
  const failed: { email: string; reason: string }[] = [];

  for (const email of emails) {
    const r = await removeOne(email);
    if (r.ok) removed.push(email);
    else failed.push({ email, reason: r.reason ?? "unknown" });
    await sleep(400);
  }

  if (removed.length === 0 && failed.length > 0) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        "Không tìm thấy mục gỡ thành viên trong menu Canva — cần chụp lại màn hình menu để cập nhật kịch bản.",
      data: { failed },
    };
  }

  return { ok: true, data: { removed_emails: removed, failed } };
}
