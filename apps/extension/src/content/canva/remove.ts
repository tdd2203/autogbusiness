/**
 * CANVA_REMOVE — gỡ thành viên (hoặc thu hồi lời mời đang chờ) khỏi team Canva.
 *
 * LỐI CHÍNH = TICK Ô VUÔNG RỒI BẤM THÙNG RÁC (user mô tả kèm ảnh 2026-09-01):
 *
 *   1. Tick ô vuông nhỏ đầu dòng của người cần gỡ.
 *   2. Thanh thao tác hiện ra ở đáy trang: "1 of 4 selected" kèm bốn nút chỉ có hình
 *      — "Change roles", "Resend invite (1)", thêm vào nhóm, và "Remove users".
 *   3. Bấm "Remove users".
 *
 * Lối này chạy cho CẢ thành viên thật lẫn lời mời đang chờ — dòng lời mời không có
 * mục gỡ trong menu vai trò, nên trước đây thu hồi lời mời là bế tắc.
 *
 * Phần chọn dòng + đọc thanh thao tác nằm ở `selection.ts` (dùng chung với đổi vai
 * trò), kể cả chốt chặn "chỉ bấm khi đúng 1 dòng đang được chọn".
 *
 * LỐI DỰ PHÒNG = menu vai trò của dòng ("⌄" → mục "Remove from team"), giữ nguyên vì
 * đã xác nhận chạy được với thành viên thật. Chỉ dùng khi lối chính không dựng được.
 */

import type { CanvaActionRequest, CanvaActionResponse } from "../../shared/messages";
import { humanClick, sleep } from "../human";
import { reportProgress } from "../progress";
import { clickableByAnyText, norm, onPeoplePage, openDialog, visible, waitUntil } from "./dom";
import { bulkBarButton, rowOf, selectRowAlone, untick } from "./selection";
import { scrapePeopleTable } from "./sync";

/** Chữ trên mục menu gỡ thành viên / thu hồi lời mời (lối dự phòng).
 *  "Remove from team" là chữ ĐÃ XÁC NHẬN trên bản tiếng Anh; các chữ còn lại là dự
 *  phòng cho bản tiếng Việt và cho dòng lời mời đang chờ. */
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
const CONFIRM_TEXTS = [
  "Remove users",
  "Remove from team",
  "Xoá",
  "Xóa",
  "Gỡ",
  "Thu hồi",
  "Xác nhận",
  "Remove",
  "Confirm",
];

/** Nhãn nút thùng rác trên thanh thao tác. "Remove users" là chữ đã xác nhận trên
 *  bản tiếng Anh; phần còn lại dự phòng cho bản tiếng Việt. */
const BULK_REMOVE_MARKS = [
  "remove users",
  "remove user",
  "xoa nguoi dung",
  "go nguoi dung",
  "xoa thanh vien",
  "go thanh vien",
];

/** Ba nút CÒN LẠI trên thanh — chặn cứng để không bao giờ bấm nhầm sang chúng. */
const BULK_OTHER_MARKS = [
  "change role",
  "doi vai tro",
  "resend invite",
  "gui lai loi moi",
  "add to group",
  "them vao nhom",
];

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
  const safe = buttons.filter((b) => !NOT_MENU_MARKS.some((m) => norm(b.textContent).includes(m)));
  return safe.length ? safe[safe.length - 1] : null;
}

/** Email đã biến khỏi bảng chưa. */
async function waitGone(email: string): Promise<boolean> {
  const gone = await waitUntil(() => {
    const emails = new Set(scrapePeopleTable().map((m) => m.email));
    return emails.has(email) ? null : true;
  }, 15000);
  return gone === true;
}

/** Lối chính: tick ô vuông → thanh thao tác → "Remove users". */
async function removeViaSelection(
  email: string,
  row: HTMLElement,
): Promise<{ ok: boolean; reason?: string }> {
  const picked = await selectRowAlone(row);
  if (!picked.ok) return { ok: false, reason: picked.reason };

  const del = bulkBarButton(BULK_REMOVE_MARKS, BULK_OTHER_MARKS);
  if (!del) {
    await untick(picked.checkbox);
    return { ok: false, reason: "no_remove_users_button" };
  }
  await humanClick(del);

  const dlg = await waitUntil(() => openDialog(), 4000);
  if (dlg) {
    const confirm = clickableByAnyText(CONFIRM_TEXTS, dlg);
    if (confirm) await humanClick(confirm);
  }

  if (await waitGone(email)) return { ok: true };
  await untick(picked.checkbox);
  return { ok: false, reason: "still_in_team" };
}

/** Lối dự phòng: menu vai trò của dòng → "Remove from team". */
async function removeViaRowMenu(
  email: string,
  row: HTMLElement,
): Promise<{ ok: boolean; reason?: string }> {
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

  return (await waitGone(email)) ? { ok: true } : { ok: false, reason: "still_in_team" };
}

/**
 * "Không thấy dòng" chỉ được coi là ĐÃ GỠ khi bảng thật sự có người.
 *
 * Bảng chưa đổ xong thì `rowOf` cũng trả null, mà đó là lối DUY NHẤT kết luận "đã
 * gỡ" mà không có cú bấm nào — đứt gánh là gỡ-giả: email vẫn ăn suất trên Canva
 * còn dashboard đã xoá khỏi danh sách. Nhánh ChatGPT từng dính đúng lỗi này
 * (4 email, 03→12/8/2026) nên ở đây đòi bằng chứng bảng còn sống trước.
 */
function tableLooksLoaded(): boolean {
  return scrapePeopleTable().length > 0;
}

async function removeOne(email: string): Promise<{ ok: boolean; reason?: string }> {
  const row = rowOf(email);
  if (!row) {
    if (!tableLooksLoaded()) return { ok: false, reason: "table_empty" };
    // Không còn trong đội = kết quả mong muốn. Backend coi như đã gỡ.
    return { ok: true, reason: "not_in_team" };
  }

  const picked = await removeViaSelection(email, row);
  if (picked.ok) return picked;

  // Dòng có thể đã đổi sau lượt thử trên → đọc lại trước khi đi lối dự phòng.
  const again = rowOf(email);
  if (!again) {
    if (!tableLooksLoaded()) return { ok: false, reason: "table_empty" };
    return { ok: true, reason: "not_in_team" };
  }
  const fallback = await removeViaRowMenu(email, again);
  return fallback.ok
    ? fallback
    : { ok: false, reason: `${picked.reason ?? "unknown"}+${fallback.reason ?? "unknown"}` };
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
  // Kết quả TỪNG EMAIL theo đúng hợp đồng chốt lệnh dùng chung với nhánh ChatGPT:
  // backend đọc `data.results[].ok` để chỉ đánh dấu email THẬT SỰ gỡ được, phần còn
  // lại giữ nguyên trạng. Thiếu mảng này là backend không thấy bằng chứng nào ⇒ coi
  // như hỏng cả mẻ (user 2026-09-01: thu hồi xong trên Canva mà nhật ký báo lỗi).
  const results: { email: string; ok: boolean; reason?: string }[] = [];

  for (const email of emails) {
    // Nhịp giữ service worker sống + cho dashboard biết đang tới email nào.
    await reportProgress(
      msg.taskId,
      {
        phase: "removing",
        message: `Đang gỡ ${removed.length + failed.length + 1}/${emails.length}: ${email}`,
      },
      true,
    );
    const r = await removeOne(email);
    results.push({ email, ok: r.ok, reason: r.reason });
    if (r.ok) removed.push(email);
    else failed.push({ email, reason: r.reason ?? "unknown" });
    await sleep(400);
  }

  if (removed.length === 0 && failed.length > 0) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        'Không gỡ được ai trên trang Canva: cả lối tick ô vuông rồi bấm "Remove users" lẫn ' +
        `lối menu vai trò đều không dựng được. Lý do từng email: ${failed
          .map((f) => `${f.email}=${f.reason}`)
          .join(", ")}`,
      data: { failed, results },
    };
  }

  return { ok: true, data: { removed_emails: removed, failed, results } };
}
