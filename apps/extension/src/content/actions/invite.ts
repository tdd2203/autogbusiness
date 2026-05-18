import type {
  ExecuteActionResponse,
  ChatGPTRole,
} from "../../shared/messages";
import {
  humanClick,
  humanType,
  queryByAnyText,
  querySelectorFirst,
  randomDelay,
  waitFor,
} from "../human";
import {
  INVITE_ERROR_HINTS,
  findControlByKey,
  findRoleOption,
} from "../i18n-ui";
import { dbLabelsFor, reportLabelMismatch } from "../../shared/ui-labels";
import { reportProgress } from "../progress";
import { SELECTORS, TEXT_FALLBACKS } from "../selectors";
import { withExternalInvitesEnabled } from "./external-invites";

function findInviteOpenButton(): HTMLElement | null {
  const bySel = querySelectorFirst<HTMLElement>(SELECTORS.inviteButtonOpen);
  if (bySel) {
    console.log("[autogpt-invite] open button matched via selector");
    return bySel;
  }
  const byText = findControlByKey(
    "invite_button_open",
    TEXT_FALLBACKS.inviteButtonOpen,
    { page: "/admin/members" },
  );
  if (byText) {
    console.log("[autogpt-invite] open button matched via text/DB fallback");
    return byText;
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
  const dbLabels = dbLabelsFor("invite_submit_button", "/admin/members");
  const merged =
    dbLabels.length > 0
      ? [...dbLabels, ...TEXT_FALLBACKS.inviteSubmitButton]
      : TEXT_FALLBACKS.inviteSubmitButton;
  const byText = queryByAnyText("button", merged, root);
  if (byText) {
    console.log("[autogpt-invite] submit matched via text/DB fallback");
    return byText;
  }
  if (dbLabels.length > 0) {
    reportLabelMismatch("invite_submit_button", dbLabels[0], "/admin/members");
  }
  return null;
}

async function setRole(role: ChatGPTRole): Promise<void> {
  // ChatGPT mặc định role = 'member' trong dialog Mời thành viên.
  // Nếu cần role = 'member' thì không cần click — vừa nhanh hơn vừa giảm
  // pattern bot (mỗi click thêm là một interaction có thể bị detect).
  if (role === "member") {
    console.log("[autogpt-invite] role='member' = default, không click role select");
    return;
  }
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
    const opt = findRoleOption(role);
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
  emails: string[],
  role: ChatGPTRole,
): Promise<ExecuteActionResponse> {
  console.log(
    `[autogpt-invite] START ${emails.length} email(s) role=${role} pathname=${location.pathname}`,
  );

  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}). Mở chatgpt.com/admin/members trước.`,
    };
  }
  if (emails.length === 0) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: "Danh sách emails rỗng",
    };
  }

  // Wrap: bật toggle "Cho phép lời mời từ miền bên ngoài" trên /admin/identity
  // trước khi invite (cho phép email ngoài domain) → restore lại trạng thái cũ
  // ngay sau khi invite xong, kể cả khi fail. ChatGPT giữ toggle này nhanh chóng
  // OFF lại sau invite để tránh rủi ro bảo mật.
  return await withExternalInvitesEnabled(() =>
    executeInviteInner(taskId, emails, role),
  );
}

/**
 * Click nút "Thêm nhiều hơn" trong dialog invite để mở textarea/box độc lập
 * cho multi-email. Trả về true nếu click được, false nếu không tìm thấy
 * (dialog có thể đã ở chế độ multi sẵn).
 */
async function clickAddMoreIfNeeded(): Promise<boolean> {
  const dialog = document.querySelector('[role="dialog"]');
  const root: ParentNode = dialog ?? document;
  const dbLabels = dbLabelsFor("invite_add_more_button", "/admin/members");
  const merged =
    dbLabels.length > 0
      ? [...dbLabels, ...TEXT_FALLBACKS.inviteAddMoreButton]
      : TEXT_FALLBACKS.inviteAddMoreButton;
  const btn =
    queryByAnyText("button", merged, root) ??
    queryByAnyText("a", merged, root);
  if (!btn && dbLabels.length > 0) {
    reportLabelMismatch("invite_add_more_button", dbLabels[0], "/admin/members");
  }
  if (btn) {
    console.log("[autogpt-invite] click add-more matched via text fallback");
    await humanClick(btn);
    await randomDelay(400, 900);
    return true;
  }
  console.log("[autogpt-invite] không tìm thấy nút 'Thêm nhiều hơn' — single mode");
  return false;
}

async function executeInviteInner(
  taskId: string,
  emails: string[],
  role: ChatGPTRole,
): Promise<ExecuteActionResponse> {

  await reportProgress(
    taskId,
    { phase: "opening-dialog", message: "Đang mở dialog Mời thành viên..." },
    true,
  );

  // 1. Đảm bảo đang ở tab "Người dùng" — nếu user mở /admin/members và tab
  //    đang là "Lời mời" hay "Yêu cầu", nút "Mời thành viên" có thể không có.
  const activeTab = findControlByKey(
    "tab_active_members",
    TEXT_FALLBACKS.tabActiveMembers,
    { page: "/admin/members" },
  );
  if (activeTab) {
    await humanClick(activeTab);
    await randomDelay(500, 1200);
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

  // 4. Nếu nhiều email → click "Thêm nhiều hơn" để mở multi-email textarea.
  //    Nếu chỉ 1 email → input mặc định OK.
  if (emails.length > 1) {
    await randomDelay(300, 700);
    await clickAddMoreIfNeeded();
    // Re-find input (textarea/contenteditable mới xuất hiện sau click)
    try {
      emailInput = await waitFor(() => findInviteEmailInput(), 5_000);
    } catch {
      // Vẫn dùng input cũ (single-mode) nếu không tìm được multi-textarea
      console.warn(
        "[autogpt-invite] sau click 'Thêm nhiều hơn' không tìm được textarea mới — dùng input mặc định + newline join",
      );
    }
  }

  await reportProgress(
    taskId,
    {
      phase: "typing-email",
      message:
        emails.length === 1
          ? `Đang nhập email ${emails[0]}...`
          : `Đang nhập ${emails.length} email...`,
    },
    true,
  );
  await randomDelay();
  // Multi-email: join bằng newline (ChatGPT auto-tokenize). Single: type trực tiếp.
  const inputText = emails.join("\n");
  await humanType(emailInput, inputText);
  console.log(
    `[autogpt-invite] typed ${emails.length} email(s): ${emails.slice(0, 3).join(", ")}${emails.length > 3 ? "..." : ""}`,
  );

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
    const errHints = INVITE_ERROR_HINTS;
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

  console.log(
    `[autogpt-invite] SUCCESS: ${emails.length} email(s) role=${role}`,
  );
  return { ok: true, data: { emails, count: emails.length, role } };
}
