/**
 * CANVA_REMOVE — gỡ thành viên (hoặc thu hồi lời mời đang chờ) khỏi team Canva.
 *
 * MENU THẬT (ảnh user 2026-09-01, giao diện tiếng Anh): bấm dấu "⌄" cạnh vai trò của
 * dòng sẽ mở một menu hai phần —
 *
 *   Roles    → Team admin · Team brand designer · Team member   (đổi vai trò)
 *   Actions  → "Remove from team" — "Remove this member from your team, with the
 *              option to also transfer their designs."
 *
 * Tức mục gỡ nằm CHUNG menu với mục đổi vai trò. Bấm trượt một dòng là ĐỔI VAI TRÒ
 * người ta chứ không phải gỡ, nên `clickableByAnyText` chỉ nhận đúng chữ trong
 * `REMOVE_TEXTS`, không đoán theo vị trí.
 *
 * CHƯA CÓ ẢNH: menu của dòng LỜI MỜI ĐANG CHỜ (nút thu hồi) và hộp xác nhận sau khi
 * bấm "Remove from team" (Canva nói có tuỳ chọn chuyển lại thiết kế). Với hai chỗ đó
 * file này vẫn đi lối AN TOÀN: thử các chữ hay gặp, không thấy thì DỪNG với lỗi rõ
 * ràng chứ không bấm mò — báo "chưa làm được, gỡ tay giúp" rẻ hơn nhiều so với xoá
 * nhầm người hoặc đổi nhầm quyền.
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

/** Chữ trên mục menu gỡ thành viên / thu hồi lời mời.
 *  "Remove from team" là chữ ĐÃ XÁC NHẬN trên bản tiếng Anh; các chữ còn lại là dự
 *  phòng cho bản tiếng Việt và cho dòng lời mời đang chờ (chưa có ảnh). */
const REMOVE_TEXTS = [
  "Remove from team",
  "Xoá khỏi đội",
  "Xóa khỏi đội",
  "Gỡ khỏi đội",
  "Xoá thành viên",
  "Thu hồi lời mời",
  "Huỷ lời mời",
  "Hủy lời mời",
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

/** Chữ trên nút vai trò của dòng (nơi có dấu "⌄" mở menu) — Việt + Anh. */
const ROLE_BUTTON_MARKS = [
  "thanh vien doi",
  "quan tri vien",
  "thiet ke",
  "team member",
  "team admin",
  "team owner",
  "brand designer",
];

/** Nút KHÔNG được bấm nhầm khi tìm menu: chúng làm việc khác hẳn. */
const NOT_MENU_MARKS = [
  "gui lai loi moi",
  "sao chep lien ket",
  "resend invite",
  "copy unique link",
  "copy link",
];

/** Nút mở menu hành động của dòng (dấu "⌄" cạnh vai trò, hoặc nút "…"). */
function rowMenuButton(row: HTMLElement): HTMLElement | null {
  const buttons = [...row.querySelectorAll<HTMLElement>("button, [role='button']")].filter(visible);
  if (buttons.length === 0) return null;
  // Ưu tiên nút VAI TRÒ: đó là chỗ Canva gắn menu gỡ/thu hồi.
  const roleBtn = buttons.find((b) =>
    ROLE_BUTTON_MARKS.some((m) => norm(b.textContent).includes(m)),
  );
  if (roleBtn) return roleBtn;
  // Không có thì tới nút chỉ có icon (nút "…").
  const iconOnly = buttons.find((b) => norm(b.textContent).length === 0);
  if (iconOnly) return iconOnly;
  // Cuối cùng mới đoán, nhưng TUYỆT ĐỐI không đụng "Gửi lại lời mời" / "Sao chép liên
  // kết": bấm nhầm là gửi thư cho khách hoặc ghi đè clipboard của người dùng.
  const safe = buttons.filter(
    (b) => !NOT_MENU_MARKS.some((m) => norm(b.textContent).includes(m)),
  );
  return safe.length ? safe[safe.length - 1] : null;
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
