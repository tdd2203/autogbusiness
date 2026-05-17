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
import { reportProgress } from "../progress";
import { SELECTORS, TEXT_FALLBACKS } from "../selectors";

function findInviteOpenButton(): HTMLElement | null {
  const bySel = querySelectorFirst<HTMLElement>(SELECTORS.inviteButtonOpen);
  if (bySel) {
    console.log("[autogpt-invite] open button matched via selector");
    return bySel;
  }
  for (const text of TEXT_FALLBACKS.inviteButtonOpen) {
    const el = queryByText("button", text);
    if (el) {
      console.log(`[autogpt-invite] open button matched via text: "${text}"`);
      return el;
    }
  }
  return null;
}

function findInviteEmailInput(): HTMLInputElement | HTMLTextAreaElement | null {
  // Ưu tiên element bên trong [role="dialog"] để tránh bắt nhầm input khác.
  const inDialog = querySelectorFirst<HTMLInputElement | HTMLTextAreaElement>(
    SELECTORS.inviteEmailInput,
  );
  if (inDialog) {
    console.log("[autogpt-invite] email input found:", inDialog.tagName, inDialog.type);
    return inDialog;
  }
  return null;
}

function findInviteSubmitButton(): HTMLElement | null {
  const bySel = querySelectorFirst<HTMLElement>(SELECTORS.inviteSubmitButton);
  if (bySel) {
    console.log("[autogpt-invite] submit button matched via selector");
    return bySel;
  }
  // Text fallback CHỈ tìm trong dialog để tránh click nhầm nút "Mời" mở dialog.
  const dialog = document.querySelector('[role="dialog"]');
  const root: ParentNode = dialog ?? document;
  for (const text of TEXT_FALLBACKS.inviteSubmitButton) {
    const el = queryByText("button", text, root);
    if (el) {
      console.log(`[autogpt-invite] submit matched via text: "${text}"`);
      return el;
    }
  }
  return null;
}

async function setRole(role: ChatGPTRole): Promise<void> {
  const selectEl = querySelectorFirst<HTMLSelectElement>(
    SELECTORS.inviteRoleSelect,
  );
  if (!selectEl) {
    console.log("[autogpt-invite] role select not found — assume default 'member'");
    return;
  }
  if (selectEl.tagName === "SELECT") {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )?.set;
    nativeSetter?.call(selectEl, role);
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
    console.log(`[autogpt-invite] role set to ${role} via native select`);
  } else {
    // Combobox custom (Radix UI) — click rồi tìm option theo text.
    console.log(`[autogpt-invite] role combobox detected, clicking to open...`);
    await humanClick(selectEl);
    await randomDelay(500, 1200);
    // Map role tới text hiển thị tiếng Việt.
    const roleText: Record<ChatGPTRole, string[]> = {
      owner: ["Chủ sở hữu", "Owner"],
      admin: ["Quản trị viên", "Admin"],
      member: ["Thành viên", "Member"],
    };
    let opt: HTMLElement | null = null;
    for (const t of roleText[role]) {
      opt =
        queryByText('[role="option"]', t) ??
        queryByText("li", t) ??
        queryByText("button", t);
      if (opt) break;
    }
    if (opt) {
      await humanClick(opt);
      console.log(`[autogpt-invite] role option clicked: ${role}`);
    } else {
      console.warn(`[autogpt-invite] role option not found for ${role}, leaving default`);
    }
  }
}

export async function executeInvite(
  taskId: string,
  email: string,
  role: ChatGPTRole,
): Promise<ExecuteActionResponse> {
  console.log(`[autogpt-invite] START email=${email} role=${role} pathname=${location.pathname}`);

  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}). Mở chatgpt.com/admin/members trước.`,
    };
  }

  await reportProgress(
    taskId,
    { phase: "opening-dialog", message: "Đang mở dialog Mời thành viên..." },
    true,
  );

  // 1. Đảm bảo đang ở tab "Người dùng" — nếu user mở /admin/members và tab
  //    đang là "Lời mời" hay "Yêu cầu", nút "Mời thành viên" có thể không có.
  for (const text of TEXT_FALLBACKS.tabActiveMembers) {
    const tab = queryByText("button", text);
    if (tab) {
      // Chỉ click nếu tab này chưa active (heuristic: tab inactive có
      // text-token-text-tertiary class). Đơn giản: cứ click — idempotent.
      await humanClick(tab);
      await randomDelay(500, 1200);
      break;
    }
  }

  // 2. Mở dialog Invite
  const openBtn = findInviteOpenButton();
  if (!openBtn) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        "Không tìm thấy nút 'Mời thành viên'. URL hiện tại: " +
        location.pathname +
        ". Kiểm tra (a) đang ở /admin/members, (b) đã click tab Người dùng.",
    };
  }
  await randomDelay();
  await humanClick(openBtn);
  console.log("[autogpt-invite] clicked open button, waiting for dialog...");

  // 3. Đợi dialog mở + input email xuất hiện
  let emailInput: HTMLInputElement | HTMLTextAreaElement;
  try {
    emailInput = await waitFor(() => findInviteEmailInput(), 10_000);
  } catch {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        "Dialog Mời thành viên không mở hoặc input email không tìm thấy sau 10s. " +
        "Kiểm tra DOM trong [role='dialog']. " +
        "Có thể ChatGPT đã đổi dialog → cập nhật SELECTORS.inviteEmailInput.",
    };
  }

  // 4. Nhập email
  await reportProgress(
    taskId,
    { phase: "typing-email", message: `Đang nhập email ${email}...` },
    true,
  );
  await randomDelay();
  await humanType(emailInput, email);
  console.log(`[autogpt-invite] typed email: ${email}`);

  // 5. Set role
  await randomDelay(800, 1800);
  await setRole(role);

  // 6. Click Submit
  await randomDelay();
  const submitBtn = findInviteSubmitButton();
  if (!submitBtn) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        "Không tìm thấy nút Submit invite trong dialog. " +
        "Selectors thử: " +
        SELECTORS.inviteSubmitButton.join(", ") +
        " + text fallback: " +
        TEXT_FALLBACKS.inviteSubmitButton.join(", "),
    };
  }
  await humanClick(submitBtn);
  console.log("[autogpt-invite] submit clicked, verifying...");

  await reportProgress(
    taskId,
    { phase: "verifying", message: "Đợi xác nhận từ ChatGPT..." },
    true,
  );

  // 7. Verify success — chờ toast hoặc dialog đóng
  try {
    await waitFor(() => {
      const toast = querySelectorFirst(SELECTORS.inviteSuccessToast);
      const dialogClosed = !document.querySelector('[role="dialog"]');
      return toast ?? (dialogClosed ? document.body : null);
    }, 15_000);
  } catch {
    // Check xem có error message trong dialog không (vd email đã tồn tại)
    const dialogText = document.querySelector('[role="dialog"]')?.textContent ?? "";
    const errHints = ["đã tồn tại", "already exists", "đã được mời", "invalid", "không hợp lệ"];
    const matchedHint = errHints.find((h) => dialogText.toLowerCase().includes(h.toLowerCase()));
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message: matchedHint
        ? `ChatGPT báo lỗi trong dialog: "${matchedHint}". Có thể email đã được mời/tồn tại.`
        : "Đã submit nhưng không thấy toast thành công và dialog không đóng sau 15s. " +
          `Dialog text: "${dialogText.slice(0, 200)}"`,
    };
  }

  console.log(`[autogpt-invite] SUCCESS: ${email} (${role})`);
  return { ok: true, data: { email, role } };
}
