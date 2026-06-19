import type { ExecuteActionResponse } from "../../../shared/messages";
import { reportProgress } from "../../progress";
import { TEXT_FALLBACKS } from "../../selectors";
import { clickTabAndWait } from "../sync";
import { locateMemberRow, scrollScanForRow } from "../remove/locate-member";

const LOG = "[autogpt-sync-member]";

/**
 * "Đồng bộ 1 tài khoản lẻ" — kiểm tra đúng 1 email đã tham gia workspace chưa.
 *
 * Luồng (mô phỏng fallback của REVOKE → REMOVE):
 *   1. Tab "Lời mời đang chờ xử lý" (pending): scroll-scan tìm email. Thấy →
 *      vẫn đang chờ (`found_in:"pending"`).
 *   2. Không thấy → fallback tab "Người dùng" (active): lọc + lật trang tìm email.
 *      Thấy → người này ĐÃ CHẤP NHẬN lời mời → đã tham gia (`found_in:"active"`);
 *      backend completion sẽ set member.status='active'.
 *   3. Không thấy ở cả 2 tab (đã duyệt hết) → `found_in:"none"`; backend báo
 *      "email không tồn tại trong workspace" (KHÔNG mark removed).
 *
 * READ-ONLY: chỉ scroll/lọc/đọc DOM, KHÔNG click thao tác phá huỷ → không cần
 * confirm dialog (khác REMOVE/REVOKE).
 *
 * Trả `ok:true` cho cả 3 outcome (đều là kết quả nghiệp vụ hợp lệ). Chỉ trả
 * `ok:false` khi KHÔNG vào được tab cần thiết để kiểm tra (không đủ căn cứ kết
 * luận "không tồn tại" → để task FAILED rõ ràng, tránh promote/ báo sai).
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

  // ----- Bước 1: tab "Lời mời đang chờ xử lý" -----
  await reportProgress(
    taskId,
    { phase: "searching", message: `Tìm ${target} ở tab Lời mời đang chờ xử lý...` },
    true,
  );
  const onPending = await clickTabAndWait(
    "tab_pending_invites",
    TEXT_FALLBACKS.tabPendingInvites,
    1500,
    "tab=invites",
  );
  if (onPending) {
    const pendingRow = await scrollScanForRow(target);
    if (pendingRow) {
      console.log(`${LOG} thấy ${target} ở tab Lời mời → pending`);
      return { ok: true, data: { email: target, found_in: "pending" } };
    }
  } else {
    console.warn(`${LOG} không vào được tab Lời mời — bỏ qua, thử tab Người dùng`);
  }

  // ----- Bước 2: fallback tab "Người dùng" (active) -----
  await reportProgress(
    taskId,
    { phase: "searching", message: `Không thấy ở Lời mời — tìm ${target} ở tab Người dùng...` },
    true,
  );
  const onActive = await clickTabAndWait(
    "tab_active_members",
    TEXT_FALLBACKS.tabActiveMembers,
    800,
  );
  if (!onActive) {
    // Không vào được tab Người dùng → KHÔNG đủ căn cứ kết luận "không tồn tại".
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        "Không chuyển được sang tab Người dùng để xác minh. Mở chatgpt.com/admin/members và thử lại.",
    };
  }
  const activeRow = await locateMemberRow(target);
  if (activeRow) {
    console.log(`${LOG} thấy ${target} ở tab Người dùng → đã tham gia (active)`);
    return { ok: true, data: { email: target, found_in: "active" } };
  }

  // ----- Bước 3: không thấy ở cả 2 tab -----
  console.log(`${LOG} ${target} KHÔNG có ở cả 2 tab → none`);
  await reportProgress(
    taskId,
    { phase: "verifying", message: `${target} không tồn tại trong workspace.` },
    true,
  );
  return { ok: true, data: { email: target, found_in: "none" } };
}
