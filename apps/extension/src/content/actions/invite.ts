import type {
  ExecuteActionResponse,
  ChatGPTRole,
} from "../../shared/messages";
import {
  humanClick,
  humanType,
  queryByText,
  querySelectorFirst,
  randomDelay,
  waitFor,
} from "../human";
import { SELECTORS, TEXT_FALLBACKS } from "../selectors";

function findInviteOpenButton(): HTMLElement | null {
  return (
    querySelectorFirst<HTMLElement>(SELECTORS.inviteButtonOpen) ??
    TEXT_FALLBACKS.inviteButtonOpen
      .map((t) => queryByText("button", t))
      .find((el) => el !== null) ??
    null
  );
}

function findInviteSubmitButton(): HTMLElement | null {
  return (
    querySelectorFirst<HTMLElement>(SELECTORS.inviteSubmitButton) ??
    TEXT_FALLBACKS.inviteSubmitButton
      .map((t) => queryByText("button", t))
      .find((el) => el !== null) ??
    null
  );
}

async function setRole(role: ChatGPTRole): Promise<void> {
  const selectEl = querySelectorFirst<HTMLSelectElement>(
    SELECTORS.inviteRoleSelect,
  );
  if (!selectEl) {
    // Role select không bắt buộc — nếu không tìm thấy, ChatGPT có thể default "member"
    return;
  }
  if (selectEl.tagName === "SELECT") {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )?.set;
    nativeSetter?.call(selectEl, role);
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    // Combobox custom — click rồi tìm option theo text
    await humanClick(selectEl);
    await randomDelay(500, 1200);
    const opt =
      queryByText('[role="option"]', role) ??
      queryByText("li", role) ??
      queryByText("button", role);
    if (opt) await humanClick(opt);
  }
}

export async function executeInvite(
  email: string,
  role: ChatGPTRole,
): Promise<ExecuteActionResponse> {
  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}). Mở chatgpt.com/admin/people trước.`,
    };
  }

  // 1. Mở dialog Invite
  const openBtn = findInviteOpenButton();
  if (!openBtn) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: "Không tìm thấy nút 'Invite members'. Cập nhật selectors.ts.",
    };
  }
  await randomDelay();
  await humanClick(openBtn);

  // 2. Đợi dialog mở + input email xuất hiện
  let emailInput: HTMLInputElement;
  try {
    emailInput = await waitFor(
      () => querySelectorFirst<HTMLInputElement>(SELECTORS.inviteEmailInput),
      8000,
    );
  } catch {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: "Dialog Invite không mở hoặc input email không tìm thấy.",
    };
  }

  // 3. Nhập email
  await randomDelay();
  await humanType(emailInput, email);

  // 4. Set role (nếu UI có)
  await randomDelay(800, 1800);
  await setRole(role);

  // 5. Click Submit
  const submitBtn = findInviteSubmitButton();
  if (!submitBtn) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: "Không tìm thấy nút Submit invite.",
    };
  }
  await randomDelay();
  await humanClick(submitBtn);

  // 6. Verify success — chờ toast hoặc dialog đóng
  try {
    await waitFor(() => {
      const toast = querySelectorFirst(SELECTORS.inviteSuccessToast);
      const dialogClosed = !querySelectorFirst(SELECTORS.inviteEmailInput);
      return toast ?? (dialogClosed ? document.body : null);
    }, 15_000);
  } catch {
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message:
        "Đã submit nhưng không thấy toast thành công và dialog không đóng sau 15s.",
    };
  }

  return { ok: true, data: { email, role } };
}
