import type {
  ChatGPTRole,
  ExecuteActionResponse,
} from "../../../shared/messages";
import {
  humanClick,
  humanType,
  randomDelay,
  sleep,
  waitFor,
} from "../../human";
import { INVITE_ERROR_HINTS, findControlByKey } from "../../i18n-ui";
import { reportProgress } from "../../progress";
import { SELECTORS, TEXT_FALLBACKS } from "../../selectors";
import { querySelectorFirst } from "../../human";
import { clickAddMoreIfNeeded } from "./click-add-more";
import {
  countDialogEmailInputs,
  findInviteEmailInput,
  findLastEmptyEmailInput,
} from "./finders/find-email-input";
import { findInviteOpenButton } from "./finders/find-invite-open-button";
import { findInviteSubmitButton } from "./finders/find-submit-button";
import { setRole } from "./set-role";

export async function executeInviteInner(
  taskId: string,
  emails: string[],
  role: ChatGPTRole,
): Promise<ExecuteActionResponse> {

  await reportProgress(
    taskId,
    {
      phase: "opening-dialog",
      message: `Đang mở dialog Mời thành viên (${emails.length} email)...`,
      current: 0,
      total: emails.length,
    },
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

  // 2. Mở dialog Invite. Poll-wait button render — wrap external-invites điều
  //    hướng từ /admin/identity → /admin/members chỉ đợi URL đổi (5s), nhưng
  //    SPA render content sau navigation cần thêm vài trăm ms tới vài giây.
  //    Nếu invite button chưa render thì retry tới 8s.
  let openBtn: HTMLElement | null = null;
  try {
    openBtn = await waitFor(() => findInviteOpenButton(), 8_000);
  } catch {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        "Không tìm thấy nút 'Mời thành viên' sau 8s. URL hiện tại: " +
        location.pathname +
        ". Kiểm tra (a) đang ở /admin/members, (b) đã click tab Người dùng, " +
        "(c) sidebar có hiển thị tab '+Mời thành viên' ở góc phải.",
    };
  }
  await randomDelay();
  // Log button info trước click để debug — confirm extension click đúng button
  console.log("[autogpt-invite] sẽ click open button:", {
    tagName: openBtn.tagName,
    text: (openBtn.textContent ?? "").trim().slice(0, 80),
    ariaLabel: openBtn.getAttribute("aria-label"),
    testId: openBtn.getAttribute("data-testid"),
    className: openBtn.className.slice(0, 100),
    boundingRect: openBtn.getBoundingClientRect(),
  });
  await humanClick(openBtn);
  console.log("[autogpt-invite] clicked open button (1st), waiting...");

  // Sau 800ms, nếu chưa thấy modal nào → retry click. ChatGPT Radix DialogTrigger
  // đôi khi miss event đầu, click lần 2 thường mở được.
  await sleep(800);
  const dialogAfter1 = document.querySelector(
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-state="open"]',
  );
  if (!dialogAfter1) {
    console.log("[autogpt-invite] chưa thấy dialog sau 800ms — retry click");
    await humanClick(openBtn);
  }

  // 3. Đợi dialog mở + input email xuất hiện. Tăng từ 10s → 20s vì sau v0.4.17
  //    auto-reload tab, SPA cần thời gian rehydrate + dialog animate open.
  let emailInput: HTMLInputElement | HTMLTextAreaElement;
  try {
    emailInput = await waitFor(() => findInviteEmailInput(), 20_000);
  } catch {
    // DIAGNOSTIC: dump dialog state để chẩn đoán next time
    const dialog = document.querySelector('[role="dialog"]');
    let diagnostic = "";
    if (dialog) {
      const allInputs = dialog.querySelectorAll("input, textarea");
      const inputInfo = Array.from(allInputs)
        .slice(0, 10)
        .map((el) => {
          const tag = el.tagName;
          const type = (el as HTMLInputElement).type ?? "";
          const placeholder = el.getAttribute("placeholder") ?? "";
          const name = el.getAttribute("name") ?? "";
          return `${tag}[type=${type},name=${name},ph=${placeholder.slice(0, 30)}]`;
        })
        .join(", ");
      diagnostic =
        `Dialog tồn tại. Inputs trong dialog: ${allInputs.length} (${inputInfo}). ` +
        `Dialog text 100 char đầu: "${(dialog.textContent ?? "").slice(0, 100)}".`;
      console.warn("[autogpt-invite] DIAGNOSTIC dialog HTML:", dialog.innerHTML.slice(0, 2000));
    } else {
      diagnostic = "KHÔNG có element [role='dialog'] trên page sau click button. Dialog không mở được, hoặc dùng role khác.";
      // Dump tất cả modal-like elements
      const modals = document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal, dialog');
      console.warn(
        `[autogpt-invite] DIAGNOSTIC: ${modals.length} modal candidates trên page`,
        Array.from(modals).slice(0, 5).map((m) => m.tagName + "[" + (m.getAttribute("role") ?? "") + "]"),
      );
    }
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        "Dialog Mời thành viên không mở hoặc input email không tìm thấy sau 20s. " +
        diagnostic +
        " (Mở DevTools Console của tab ChatGPT để xem chi tiết DOM dump '[autogpt-invite] DIAGNOSTIC'.)",
    };
  }

  // 4. Multi-email: ChatGPT 2026 layout = mỗi email 1 ROW riêng với input riêng.
  //    Flow: type email 1 vào input đầu → click "Add more" → type email 2 vào
  //    input mới → repeat. KHÔNG còn textarea join newline như UI cũ.
  await reportProgress(
    taskId,
    {
      phase: "typing-email",
      message:
        emails.length === 1
          ? `Đang nhập email ${emails[0]}...`
          : `Đang nhập email 1/${emails.length}: ${emails[0]}...`,
      current: 1,
      total: emails.length,
    },
    true,
  );
  await randomDelay();
  // Email đầu tiên: dùng input mặc định
  await humanType(emailInput, emails[0]);
  console.log(`[autogpt-invite] typed email 1/${emails.length}: ${emails[0]}`);

  // Email 2..N: click "Add more" → tìm input MỚI (input chưa có giá trị) → type
  for (let i = 1; i < emails.length; i++) {
    await reportProgress(
      taskId,
      {
        phase: "add-row",
        message: `Click 'Add more' để thêm row email ${i + 1}/${emails.length}...`,
        current: i,
        total: emails.length,
      },
      true,
    );
    await randomDelay(400, 900);
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
    if (!dialog) {
      console.warn(`[autogpt-invite] dialog không còn mở trước khi nhập email ${i + 1}`);
      break;
    }
    const inputsBefore = countDialogEmailInputs(dialog);
    const clicked = await clickAddMoreIfNeeded();
    if (!clicked) {
      console.warn(
        `[autogpt-invite] không click được 'Add more' cho email ${i + 1}/${emails.length} — fallback: dồn các email còn lại vào input cuối, separator=newline`,
      );
      // Fallback: join các email còn lại vào input hiện tại (cho trường hợp UI
      // khác chấp nhận multi-line trong 1 input).
      const remaining = emails.slice(i).join("\n");
      const lastInput = findLastEmptyEmailInput(dialog) ?? emailInput;
      await humanType(lastInput, remaining);
      console.log(`[autogpt-invite] fallback typed ${emails.length - i} email vào 1 input`);
      break;
    }
    // Đợi DOM render row mới (input count tăng)
    let newInput: HTMLInputElement | HTMLTextAreaElement | null = null;
    try {
      newInput = await waitFor(() => {
        const cur = countDialogEmailInputs(dialog);
        if (cur <= inputsBefore) return null;
        return findLastEmptyEmailInput(dialog);
      }, 4_000);
    } catch {
      console.warn(`[autogpt-invite] không phát hiện row mới sau click Add more lần ${i}`);
    }
    if (!newInput) {
      // Last-resort: scan toàn bộ input rỗng trong dialog
      newInput = findLastEmptyEmailInput(dialog);
    }
    if (!newInput) {
      console.warn(`[autogpt-invite] vẫn không tìm được input trống cho email ${i + 1} — bỏ qua phần còn lại`);
      break;
    }
    await reportProgress(
      taskId,
      {
        phase: "typing-email",
        message: `Đang nhập email ${i + 1}/${emails.length}: ${emails[i]}...`,
        current: i + 1,
        total: emails.length,
      },
      true,
    );
    await humanType(newInput, emails[i]);
    console.log(`[autogpt-invite] typed email ${i + 1}/${emails.length}: ${emails[i]}`);
  }

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
    `[autogpt-invite] SUBMIT SUCCESS: ${emails.length} email(s) role=${role}`,
  );

  // executeInviteInner CHỈ chịu trách nhiệm submit invite. Bước "chuyển tab
  // Lời mời" được làm ở scope ngoài (executeInvite) SAU khi
  // withExternalInvitesEnabled finally restore xong toggle — đảm bảo URL không
  // bị mất ?tab=invites do navigation /admin/identity → /admin/members của
  // wrapper. (v0.6.4 từng đặt click tab ở đây là SAI thứ tự — fixed ở v0.6.5.)
  await reportProgress(
    taskId,
    {
      phase: "submit-done",
      message: `Submit ${emails.length} email OK — chờ restore toggle + chuyển tab Lời mời...`,
      current: emails.length,
      total: emails.length,
    },
    true,
  );

  return {
    ok: true,
    data: {
      emails,
      count: emails.length,
      role,
      awaiting_reload_verify: true,
    },
  };
}
