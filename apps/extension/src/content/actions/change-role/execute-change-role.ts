import type {
  ChatGPTRole,
  ExecuteActionResponse,
} from "../../../shared/messages";
import { humanClick, randomDelay, sleep } from "../../human";
import { findRoleOption } from "../../i18n-ui";
import { reportProgress } from "../../progress";
import { findMemberRow, findRowRoleDropdown } from "../member-row";
import { clearMemberFilter } from "../remove/member-filter";
import { locateMemberRow } from "../remove/locate-member";

/**
 * UI 2026 đổi role qua INLINE dropdown trên row:
 *   1. Tìm row member theo email
 *   2. Click dropdown "Thành viên ▼" (hoặc "Member ▼" / "成员 ▼") trong cột Vai trò
 *   3. Menu hiện 4 option: Thành viên / Trình xem dữ liệu phân tích /
 *      Quản trị viên / Chủ sở hữu
 *   4. Click target role option
 *
 * Trước v0.4.14 code dùng flow CŨ (click "..." menu → "Change role" item) đã bị
 * ChatGPT loại bỏ — flow này khiến CHANGE_ROLE treo IN_PROGRESS vĩnh viễn.
 */
export async function executeChangeRole(
  taskId: string,
  email: string,
  newRole: ChatGPTRole,
  oldRole: ChatGPTRole | null = null,
): Promise<ExecuteActionResponse> {
  await reportProgress(
    taskId,
    { phase: "locating", message: `Tìm row của ${email}...` },
    true,
  );

  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}).`,
    };
  }

  // Định vị row BỀN VỮNG: lọc theo email (fast path) → fallback lật từng trang
  // + scroll-scan. Trước đây dùng `findMemberRow` trần → member ngoài trang đầu
  // / virtualized chưa render bị fail oan (cùng class bug đã fix ở
  // change-license-type v0.7.3). Port `locateMemberRow` sang. Fix 2026-06-17.
  const row = await locateMemberRow(email);
  if (!row) {
    await clearMemberFilter();
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Không tìm thấy ${email} sau khi lọc + lật mọi trang. Chạy SYNC để đối chiếu.`,
    };
  }

  await reportProgress(
    taskId,
    { phase: "opening-dropdown", message: `Mở dropdown vai trò...` },
    true,
  );
  const dropdown = findRowRoleDropdown(row, oldRole);
  if (!dropdown) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        `Không tìm thấy dropdown vai trò trong row của ${email}. ` +
        `UI 2026 có dropdown 'Thành viên ▼' hiển thị inline — kiểm tra DOM cột Vai trò.`,
    };
  }
  await randomDelay();
  await humanClick(dropdown);

  // Wait for menu to open
  await sleep(400);

  await reportProgress(
    taskId,
    { phase: "selecting", message: `Chọn role mới: ${newRole}...` },
    true,
  );
  const roleOption = findRoleOption(newRole);
  if (!roleOption) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        `Menu dropdown role mở nhưng KHÔNG tìm thấy option '${newRole}'. ` +
        `Cần thêm role label vào ROLE_LABELS hoặc DB ui_labels.`,
    };
  }
  await humanClick(roleOption);
  await randomDelay(800, 1500);

  // Verify: dropdown text đổi sang role mới (best-effort)
  // Re-query dropdown vì DOM có thể re-render
  const verifyRow = findMemberRow(email);
  if (verifyRow) {
    const newDropdown = findRowRoleDropdown(verifyRow, newRole);
    if (newDropdown) {
      console.log(
        `[autogpt-change-role] verified: dropdown giờ có role label '${newRole}'`,
      );
    } else {
      console.warn(
        `[autogpt-change-role] không verify được dropdown sau đổi role — UI có thể chưa render`,
      );
    }
  }

  return { ok: true, data: { email, new_role: newRole, old_role: oldRole } };
}
