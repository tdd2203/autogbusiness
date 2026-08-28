import type { ExecuteActionResponse } from "../../../shared/messages";
import { reportProgress } from "../../progress";
import { TEXT_FALLBACKS } from "../../selectors";
import { clickTabAndWait, DEFAULT_TAB_VERIFY } from "../sync";
import { locateMemberRow } from "../remove/locate-member";

const LOG = "[autogpt-sync-member]";

/**
 * "Đồng bộ 1 tài khoản lẻ" — kiểm tra đúng 1 email đã tham gia workspace chưa.
 *
 * Logic MỚI (user 2026-07-15), ĐƠN GIẢN — KHÔNG quét tab "Lời mời đang chờ xử lý"
 * nữa. Lời mời đã xác minh thành công lúc mời, nên 1 email pending chỉ có 2 khả
 * năng: ĐÃ tham gia (có ở tab "Người dùng" → active) hoặc CHƯA (không có → pending).
 *
 * Luồng: vào tab "Người dùng" → `locateMemberRow` (ô search là nguồn sự thật).
 * Thấy → found_in="active" (đã tham gia; backend set status='active'). Không thấy
 * → found_in="pending" (chưa tham gia; giữ nguyên).
 *
 * READ-ONLY: chỉ lọc/đọc DOM. `ok:false` (UI_ELEMENT_NOT_FOUND) chỉ khi KHÔNG vào
 * được tab "Người dùng" để xác minh (không đủ căn cứ → để task FAILED rõ ràng).
 */
export async function executeSyncMember(
  taskId: string,
  email: string,
): Promise<ExecuteActionResponse> {
  const target = email.trim().toLowerCase();
  console.log(`${LOG} START email=${target} path=${location.pathname}`);

  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}). Mở chatgpt.com/admin/members trước.`,
    };
  }

  await reportProgress(
    taskId,
    { phase: "searching", message: `Tìm ${target} ở tab Người dùng...` },
    true,
  );
  // Kiểm chứng URL thay vì tin cú click (xem `DEFAULT_TAB_VERIFY`): còn kẹt ở
  // ?tab=invites thì ô lọc tìm thấy chính lời mời đang chờ và bị hiểu là "đã
  // tham gia".
  const onActive = await clickTabAndWait(
    "tab_active_members",
    TEXT_FALLBACKS.tabActiveMembers,
    800,
    DEFAULT_TAB_VERIFY,
    12_000,
  );
  if (!onActive) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        `Không vào được tab Người dùng để xác minh (URL hiện tại '${location.search || "(rỗng)"}'). ` +
        "Mở chatgpt.com/admin/members và thử lại.",
    };
  }

  const row = await locateMemberRow(target, {
    pageThrough: false,
    preferFilter: true,
  });
  if (row) {
    console.log(`${LOG} thấy ${target} ở tab Người dùng → đã tham gia (active)`);
    await reportProgress(
      taskId,
      { phase: "verifying", message: `${target} đã tham gia workspace.` },
      true,
    );
    return { ok: true, data: { email: target, found_in: "active" } };
  }

  console.log(`${LOG} ${target} KHÔNG có ở tab Người dùng → chưa tham gia (pending)`);
  await reportProgress(
    taskId,
    { phase: "verifying", message: `${target} chưa tham gia (vẫn đang chờ).` },
    true,
  );
  return { ok: true, data: { email: target, found_in: "pending" } };
}
