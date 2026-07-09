import type { ExecuteActionResponse } from "../../../shared/messages";
import {
  humanClick,
  humanType,
  querySelectorFirst,
  randomDelay,
  sleep,
  waitFor,
} from "../../human";
import { reportProgress } from "../../progress";
import { SELECTORS } from "../../selectors";
import { clearMemberFilter } from "../remove/member-filter";
import {
  dumpDialogButtons,
  findLimitDialog,
  findLimitInput,
  findSaveButton,
  findUsageRowButton,
} from "./finders";

const LOG = "[autogpt-usage-limit]";
const PAGE = "manage_member_usage_limit";

/** Ô "Lọc theo tên" trên trang usage-limit (dùng chung selector với /admin/members). */
function findFilterInput(): HTMLInputElement | null {
  return querySelectorFirst<HTMLInputElement>(SELECTORS.memberFilterInput);
}

/**
 * Lọc theo email rồi định vị nút hành động ("Thêm"/"Chỉnh sửa") của member.
 * Trang có phân trang (1/5…) → KHÔNG scroll/lật trang, dùng ô lọc làm nguồn sự
 * thật (giống REMOVE). Thử local-part rồi full email.
 */
async function filterAndFindRowButton(
  email: string,
): Promise<{ button: HTMLElement; isEdit: boolean } | null> {
  let input = findFilterInput();
  if (!input) {
    try {
      input = await waitFor(() => findFilterInput(), 8000, 250);
    } catch {
      input = null;
    }
  }
  if (!input) {
    console.warn(`${LOG} không thấy ô lọc — thử tìm trực tiếp trên DOM`);
    return findUsageRowButton(email);
  }

  const local = email.includes("@") ? email.split("@")[0] : email;
  const needles = local === email ? [local] : [local, email];
  for (const needle of needles) {
    await humanType(input, needle);
    await sleep(700); // chờ React Query / debounce filter
    try {
      const found = await waitFor(() => findUsageRowButton(email), 4000, 200);
      if (found) {
        console.log(`${LOG} ✓ thấy row sau khi lọc "${needle}"`);
        return found;
      }
    } catch {
      console.warn(`${LOG} lọc "${needle}" chưa ra row`);
    }
  }
  return null;
}

/**
 * Đặt giới hạn tín dụng/tháng cho 1 member trên trang
 * /admin/billing/manage_member_usage_limit ("Ghi đè mỗi người dùng").
 *
 * Flow (theo đúng thao tác user mô tả):
 *   1. Đảm bảo đang trang usage-limit (background đã điều hướng tới đây).
 *   2. LỌC THEO TÊN bằng email → định vị nút "Thêm" (chưa đặt) / "Chỉnh sửa" (đã đặt).
 *   3. Click nút → dialog "Đặt giới hạn sử dụng tùy chỉnh".
 *   4. Gõ SỐ tín dụng vào ô input → click "Lưu" (TUYỆT ĐỐI không click "Gỡ bỏ").
 *   5. Đợi dialog đóng → clear filter.
 */
export async function executeSetUsageLimit(
  taskId: string,
  email: string,
  limitCredits: number,
  oldLimitCredits: number | null = null,
): Promise<ExecuteActionResponse> {
  console.log(
    `${LOG} START email=${email} limit=${limitCredits} old=${oldLimitCredits}`,
  );

  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}).`,
    };
  }
  if (!location.pathname.includes(PAGE)) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message:
        `Không ở trang Ghi đè giới hạn (${location.pathname}). ` +
        `Cần /admin/billing/${PAGE}.`,
    };
  }

  // 1) Lọc theo email → nút hành động.
  await reportProgress(
    taskId,
    { phase: "searching", message: `Lọc theo tên: ${email}...` },
    true,
  );
  const found = await filterAndFindRowButton(email);
  if (!found) {
    await clearMemberFilter();
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Không tìm thấy ${email} (hoặc nút Thêm/Chỉnh sửa) sau khi lọc. Chạy SYNC để đối chiếu.`,
    };
  }
  console.log(`${LOG} row button found (isEdit=${found.isEdit})`);

  // 2) Mở dialog.
  await reportProgress(
    taskId,
    { phase: "opening", message: "Mở dialog đặt giới hạn..." },
    true,
  );
  await randomDelay();
  await humanClick(found.button);

  let dialog: HTMLElement;
  try {
    dialog = await waitFor(() => findLimitDialog(), 5000, 200);
  } catch {
    await clearMemberFilter();
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: "Click nút Thêm/Chỉnh sửa nhưng dialog 'Đặt giới hạn' không mở.",
    };
  }

  // 3) Tìm ô nhập số → gõ giá trị.
  const input = findLimitInput(dialog);
  if (!input) {
    const btns = dumpDialogButtons(dialog);
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Dialog mở nhưng không thấy ô nhập số. Nút trong dialog: ${JSON.stringify(btns)}`,
    };
  }
  await reportProgress(
    taskId,
    { phase: "typing", message: `Nhập ${limitCredits} tín dụng/tháng...` },
    true,
  );
  await humanType(input, String(limitCredits));
  await sleep(300);

  // 4) Click LƯU (loại trừ nút "Gỡ bỏ").
  const saveBtn = findSaveButton(dialog);
  if (!saveBtn) {
    const btns = dumpDialogButtons(dialog);
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Không tìm thấy nút Lưu trong dialog. Nút thấy: ${JSON.stringify(btns)}`,
    };
  }
  await reportProgress(taskId, { phase: "saving", message: "Click Lưu..." }, true);
  await randomDelay();
  await humanClick(saveBtn);

  // 5) Đợi dialog đóng (best-effort) → clear filter.
  await reportProgress(
    taskId,
    { phase: "verifying", message: "Đợi dialog đóng..." },
    true,
  );
  let closed = false;
  try {
    await waitFor(() => (findLimitDialog() ? null : document.body), 8000, 250);
    closed = true;
  } catch {
    /* fall through */
  }
  await clearMemberFilter();

  if (!closed) {
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message: "Dialog vẫn mở sau khi click Lưu — có thể giá trị không hợp lệ.",
    };
  }

  console.log(`${LOG} DONE email=${email} → ${limitCredits}`);
  return {
    ok: true,
    data: {
      email,
      limit_credits: limitCredits,
      old_limit_credits: oldLimitCredits,
    },
  };
}
