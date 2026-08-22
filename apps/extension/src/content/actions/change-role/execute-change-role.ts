import type {
  ChatGPTRole,
  ExecuteActionResponse,
} from "../../../shared/messages";
import { humanClick, randomDelay, sleep } from "../../human";
import { findRoleOption, TEXT_FALLBACKS } from "../../i18n-ui";
import { reportProgress } from "../../progress";
import { findRowRoleDropdown } from "../member-row";
import { clickTabAndWait } from "../sync";
import { clearMemberFilter } from "../remove/member-filter";
import { locateMemberRow } from "../remove/locate-member";
import { waitForChatGptCommit } from "../dialog-commit";
import { findRoleInRow } from "../sync/row-extractors/role";

const LOG = "[autogpt-change-role]";

/** Hạn chờ dialog (nếu ChatGPT dựng) tắt hẳn — cùng nhịp với REMOVE. */
const COMMIT_TIMEOUT_MS = 30_000;
/** Để ChatGPT commit + list refetch 1 nhịp trước khi lọc lại xác minh. */
const VERIFY_SETTLE_MS = 1500;
/** Số lần lọc lại row + khoảng cách giữa 2 lần. */
const VERIFY_ATTEMPTS = 3;
const VERIFY_GAP_MS = 2500;

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

  // Đảm bảo đang ở tab "Người dùng" trước khi định vị row (đổi vai trò chỉ làm
  // trên active list). TRƯỚC ĐÂY CHANGE_ROLE KHÔNG chuyển tab — nếu tab còn
  // ?tab=invites do action trước để lại (ensureAdminTab tái dùng tab + reload giữ
  // param) thì locateMemberRow lọc nhầm danh sách Lời mời → UI_ELEMENT_NOT_FOUND
  // oan dù member đang active (bug 2026-06-29). Render-wait thanh tab
  // (waitForButtonMs=12000) rồi click, cùng cơ chế REMOVE/CHANGE_LICENSE_TYPE.
  await clickTabAndWait(
    "tab_active_members",
    TEXT_FALLBACKS.tabActiveMembers,
    800,
    undefined,
    12_000,
  );

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
      error_code: "FAILED_UI_CHANGED",
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
      error_code: "FAILED_UI_CHANGED",
      error_message:
        `Menu dropdown role mở nhưng KHÔNG tìm thấy option '${newRole}'. ` +
        `Cần thêm role label vào ROLE_LABELS hoặc DB ui_labels.`,
    };
  }
  await humanClick(roleOption);

  // ---- (1) CHỜ CHATGPT XỬ LÝ XONG ----------------------------------------
  // Đổi vai trò thường KHÔNG có dialog xác nhận, nhưng ChatGPT vẫn gửi PATCH và
  // có thể dựng dialog cảnh báo (hạ quyền owner / ghế Codex). `waitForChatGptCommit`
  // phủ cả 2: có dialog thì chờ tắt hẳn, không có thì trả về sau ~1.2s.
  await reportProgress(
    taskId,
    { phase: "verifying", message: "Đợi ChatGPT chốt vai trò..." },
    true,
  );
  const commit = await waitForChatGptCommit(LOG, COMMIT_TIMEOUT_MS);
  if (!commit.settled) {
    await clearMemberFilter();
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message:
        `Dialog KHÔNG đóng sau ${COMMIT_TIMEOUT_MS / 1000}s sau khi chọn vai trò ` +
        `'${newRole}' (${commit.busy ? "vẫn đang quay" : "đứng im"}) → ChatGPT có ` +
        "thể hỏi OTP/2FA hoặc từ chối." +
        (commit.dialogText ? ` Dialog: "${commit.dialogText.slice(0, 200)}"` : ""),
    };
  }

  // ---- (2) QUÉT LẠI XÁC NHẬN ----------------------------------------------
  // Trước v0.11.7 chỗ này chỉ ngủ 800-1500ms rồi "verify best-effort": không
  // khớp vẫn `ok:true`. Mà backend lấy ok:true ghi thẳng `Member.chatgpt_role`
  // (completion.py) ⇒ ChatGPT từ chối im lặng là DB lệch vĩnh viễn tới lần sync
  // sau. Nay LỌC LẠI row (fetch mới, không đọc DOM cũ) rồi đọc NHÃN THẬT; sai
  // hoặc không đọc được ⇒ VERIFY_FAILED, thà báo chưa-xong còn hơn xong GIẢ.
  await sleep(VERIFY_SETTLE_MS);
  let seen: ChatGPTRole | null = null;
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
    // `pageThrough: false`: XÁC MINH thì ô lọc là nguồn sự thật (giống REMOVE).
    // Cho lật trang ở đây thì 3 lần tra × N trang dễ nuốt trọn 150s của task →
    // TIMEOUT (không rõ nguyên nhân) thay vì VERIFY_FAILED (rõ, backend retry).
    const verifyRow = await locateMemberRow(email, { pageThrough: false });
    seen = verifyRow ? findRoleInRow(verifyRow) : null;
    if (seen === newRole) {
      await clearMemberFilter();
      console.log(`${LOG} verified: row hiện vai trò '${newRole}'`);
      return { ok: true, data: { email, new_role: newRole, old_role: oldRole } };
    }
    console.log(
      `${LOG} xác minh lần ${attempt}/${VERIFY_ATTEMPTS}: row đang là '${seen ?? "không đọc được"}', chờ '${newRole}'`,
    );
    if (attempt < VERIFY_ATTEMPTS) await sleep(VERIFY_GAP_MS);
  }

  await clearMemberFilter();
  return {
    ok: false,
    error_code: "VERIFY_FAILED",
    error_message:
      `Đã chọn vai trò '${newRole}' cho ${email} nhưng sau ${VERIFY_ATTEMPTS} lần ` +
      `lọc lại row vẫn hiện '${seen ?? "không đọc được nhãn vai trò"}' → đổi vai trò ` +
      "CHƯA có hiệu lực trên ChatGPT (bị từ chối, hoặc nhãn vai trò đổi — chạy " +
      "HARVEST_LABELS để cập nhật ui_labels).",
  };
}
