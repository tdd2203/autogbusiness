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
import { waitForModalLockGone } from "../dialog-commit";

const LOG = "[autogpt-usage-limit]";

/** Để ChatGPT commit + list refetch 1 nhịp trước khi lọc lại xác minh. */
const VERIFY_SETTLE_MS = 1500;
/** Số lần lọc lại row + khoảng cách giữa 2 lần. */
const VERIFY_ATTEMPTS = 3;
const VERIFY_GAP_MS = 2500;
const PAGE = "manage_member_usage_limit";

/** Ô "Lọc theo tên" trên trang usage-limit (dùng chung selector với /admin/members). */
function findFilterInput(): HTMLInputElement | null {
  return querySelectorFirst<HTMLInputElement>(SELECTORS.memberFilterInput);
}

/**
 * Lọc theo email rồi định vị nút hành động ("Thêm"/"Chỉnh sửa") của member.
 * Trang có phân trang (1/5…) → KHÔNG scroll/lật trang, dùng ô lọc làm nguồn sự
 * thật (giống REMOVE). Gõ chính xác email đầy đủ 1 lần.
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

  // Gõ CHÍNH XÁC email đầy đủ 1 LẦN (user 2026-07-13: không gõ nửa rồi full = 2 lần).
  await humanType(input, email);
  await sleep(700); // chờ React Query / debounce filter
  try {
    const found = await waitFor(() => findUsageRowButton(email), 4000, 200);
    if (found) {
      console.log(`${LOG} ✓ thấy row sau khi lọc "${email}"`);
      return found;
    }
  } catch {
    console.warn(`${LOG} lọc "${email}" không ra row`);
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

  if (!closed) {
    await clearMemberFilter();
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message: "Dialog vẫn mở sau khi click Lưu — có thể giá trị không hợp lệ.",
    };
  }

  // Dialog đã rời DOM nhưng lớp phủ Radix còn khoá trang thêm 1 nhịp — gõ ô lọc
  // lúc đó thì event `input` rơi vào lớp phủ, query lọc không bao giờ chạy.
  await waitForModalLockGone(5000, LOG);

  // ---- 6) QUÉT LẠI XÁC NHẬN (v0.11.7) ------------------------------------
  // Trước đây dừng ở "dialog đóng" rồi báo ok. Dialog đóng chỉ nghĩa ChatGPT
  // NHẬN lệnh; backend lại lấy ok:true ghi thẳng `Member.usage_limit_credits`
  // (completion.py) nên lệnh bị từ chối là DB lệch im lặng. Nay lọc lại row:
  // nút hành động phải chuyển sang "Chỉnh sửa" (= member ĐANG có ghi đè giới
  // hạn). Trang này không hiện số credits trên row nên không xác minh được ĐÚNG
  // con số — đây là mức xác nhận tối đa mà DOM cho phép; SYNC vẫn là chốt cuối.
  await reportProgress(
    taskId,
    { phase: "verifying", message: "Lọc lại để xác nhận đã đặt giới hạn..." },
    true,
  );
  await sleep(VERIFY_SETTLE_MS);
  let hasOverride = false;
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
    const again = await filterAndFindRowButton(email);
    if (again?.isEdit) {
      hasOverride = true;
      break;
    }
    console.log(
      `${LOG} xác minh lần ${attempt}/${VERIFY_ATTEMPTS}: ` +
        (again ? "nút vẫn là 'Thêm' (chưa có ghi đè)" : "không thấy row sau khi lọc"),
    );
    if (attempt < VERIFY_ATTEMPTS) await sleep(VERIFY_GAP_MS);
  }
  await clearMemberFilter();

  if (!hasOverride) {
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message:
        `Đã click Lưu giới hạn ${limitCredits} cho ${email} (dialog đã đóng) nhưng ` +
        `lọc lại ${VERIFY_ATTEMPTS} lần vẫn không thấy row ở trạng thái "Chỉnh sửa" ` +
        "→ giới hạn CHƯA được ghi nhận trên ChatGPT.",
    };
  }

  console.log(`${LOG} DONE email=${email} → ${limitCredits} (đã xác minh)`);
  return {
    ok: true,
    data: {
      email,
      limit_credits: limitCredits,
      old_limit_credits: oldLimitCredits,
    },
  };
}
