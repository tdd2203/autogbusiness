/**
 * CANVA_RESEND_INVITE — gửi lại lời mời cho người CHƯA bấm nhận.
 *
 * Trên Canva đây là thao tác có sẵn, không phải "thu hồi rồi mời lại": dòng lời mời
 * đang chờ có nút "Resend invite" ngay trong dòng, và thanh thao tác ở đáy trang cũng
 * có nút phong bì "Resend invite (1)" sau khi tick ô vuông.
 *
 * VÌ SAO KHÔNG DÙNG LẠI KỊCH BẢN MỜI: nhánh ChatGPT làm "mời lại" bằng cách thu hồi
 * lời mời cũ rồi mời mới (`payload.reinvite`), vì bên đó không có nút gửi lại. Đem
 * đúng lối ấy sang Canva là hộp mời báo email đã được mời rồi và lệnh chết — mà thu
 * hồi thì đã thu hồi mất rồi, khách đang giữ link cũ tự dưng hỏng link.
 *
 * Ưu tiên nút TRONG DÒNG: nó chỉ tác động đúng một người, không phải dựng trạng thái
 * chọn nào cả. Không thấy thì mới tick ô vuông rồi bấm phong bì trên thanh thao tác,
 * và lối đó vẫn qua chốt "đúng 1 dòng đang chọn" của `selection.ts`.
 *
 * Email KHÔNG có trong bảng ⇒ chưa từng mời (hoặc lời mời đã hết hạn và rơi khỏi
 * danh sách): trả `fallback_invite` để runner chạy lệnh mời thường, đừng báo lỗi.
 */

import type { CanvaActionRequest, CanvaActionResponse } from "../../shared/messages";
import { humanClick } from "../human";
import { reportProgress } from "../progress";
import { onPeoplePage, visible, waitUntil } from "./dom";
import { bulkBarButton, labelOf, rowOf, selectRowAlone, untick } from "./selection";
import { scrapePeopleTable } from "./sync";

/** Chữ trên nút gửi lại trong dòng, và trên nút phong bì của thanh thao tác. */
const RESEND_MARKS = ["resend invite", "gui lai loi moi", "resend"];

/** Nút khác trên thanh — chặn cứng, nhất là thùng rác. */
const BULK_OTHER_MARKS = [
  "remove user",
  "xoa nguoi dung",
  "go nguoi dung",
  "change role",
  "doi vai tro",
  "add to group",
  "them vao nhom",
];

/** Nút "Resend invite" nằm ngay trong dòng đó. */
function rowResendButton(row: HTMLElement): HTMLElement | null {
  const found = [...row.querySelectorAll<HTMLElement>("button, [role='button']")].find(
    (b) => visible(b) && RESEND_MARKS.some((m) => labelOf(b).includes(m)),
  );
  return found ?? null;
}

/** Trạng thái của email trong bảng, đọc từ chính bảng đã quét. */
function statusOf(email: string): "active" | "pending" | null {
  return scrapePeopleTable().find((m) => m.email === email)?.status ?? null;
}

export async function executeCanvaResendInvite(
  msg: Extract<CanvaActionRequest, { kind: "CANVA_RESEND_INVITE" }>,
): Promise<CanvaActionResponse> {
  if (!onPeoplePage()) {
    return {
      ok: false,
      error_code: "PAGE_NOT_PEOPLE",
      error_message: `Không ở trang thành viên Canva (đang ở ${location.href}).`,
    };
  }
  const email = msg.email.toLowerCase();
  await reportProgress(
    msg.taskId,
    { phase: "resending", message: `Đang gửi lại lời mời cho ${email}` },
    true,
  );

  // Chờ bảng vẽ xong rồi mới kết luận "không có trong danh sách".
  await waitUntil(() => scrapePeopleTable().length > 0, 15000);

  const status = statusOf(email);
  if (status === null) {
    // Chưa từng mời / lời mời đã rơi khỏi bảng → để runner mời như bình thường.
    return { ok: true, data: { email, fallback_invite: true } };
  }
  if (status === "active") {
    // Đã vào đội rồi thì không còn lời mời nào để gửi lại — và mời lại một thành viên
    // thật là vô nghĩa. Coi như xong, đừng trừ thêm gì của đại lý.
    return { ok: true, data: { email, already_active: true } };
  }

  const row = rowOf(email);
  if (!row) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Bảng có ${email} nhưng không khoanh được đúng dòng của họ.`,
    };
  }

  // Lối chính: nút ngay trong dòng.
  const inRow = rowResendButton(row);
  if (inRow) {
    await humanClick(inRow);
    return { ok: true, data: { email, resent: true, via: "row_button" } };
  }

  // Lối dự phòng: tick ô vuông → nút phong bì trên thanh thao tác.
  const picked = await selectRowAlone(row);
  if (!picked.ok) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Không thấy nút "Resend invite" trong dòng của ${email}, mà cũng không chọn được đúng một dòng (${picked.reason}).`,
    };
  }
  const bulk = bulkBarButton(RESEND_MARKS, BULK_OTHER_MARKS);
  if (!bulk) {
    await untick(picked.checkbox);
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Không thấy nút gửi lại lời mời cho ${email}, cả trong dòng lẫn trên thanh thao tác.`,
    };
  }
  await humanClick(bulk);
  await untick(picked.checkbox);
  return { ok: true, data: { email, resent: true, via: "bulk_bar" } };
}
