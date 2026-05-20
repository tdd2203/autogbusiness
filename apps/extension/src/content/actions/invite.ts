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
  sleep,
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
import { scrapePendingInvitesAfterInvite } from "./sync";

/**
 * Filter: loại trừ button là switch/toggle/tab/menu — chỉ giữ button "action"
 * thực sự (vd "Mời thành viên"). Toggle có role="switch", tab có role="tab",
 * menu item có role="menuitem", v.v.
 */
function isToggleOrSwitchOrTab(el: HTMLElement): boolean {
  const role = (el.getAttribute("role") ?? "").toLowerCase();
  if (role === "switch" || role === "tab" || role === "menuitem" || role === "menuitemcheckbox") {
    return true;
  }
  // Radix UI Switch dùng data-state checked/unchecked
  const ds = el.getAttribute("data-state");
  if (ds === "checked" || ds === "unchecked") return true;
  return false;
}

function findInviteOpenButton(): HTMLElement | null {
  // Chỉ scan trong main content / không scan sidebar (sidebar links có thể
  // match aria-label / text). Ưu tiên main[role="main"] hoặc <main>.
  const root = document.querySelector('main, [role="main"]') ?? document;

  // Try CSS selectors first
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>(SELECTORS.inviteButtonOpen.join(", ")),
  );
  for (const el of candidates) {
    if (isToggleOrSwitchOrTab(el)) continue;
    console.log("[autogpt-invite] open button matched via CSS selector");
    return el;
  }

  // Fallback text search — queryByAnyText("button", texts) + filter
  const dbLabels = dbLabelsFor("invite_button_open", "/admin/members");
  const merged =
    dbLabels.length > 0
      ? [...dbLabels, ...TEXT_FALLBACKS.inviteButtonOpen]
      : TEXT_FALLBACKS.inviteButtonOpen;
  for (const text of merged) {
    const buttons = Array.from(root.querySelectorAll<HTMLElement>("button"));
    for (const btn of buttons) {
      if (isToggleOrSwitchOrTab(btn)) continue;
      const btnText = (btn.textContent ?? "").trim();
      if (btnText.includes(text)) {
        console.log(
          `[autogpt-invite] open button matched via text "${text}" → btn text="${btnText.slice(0, 60)}"`,
        );
        return btn;
      }
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

/** Đếm số input "email-like" trong dialog (multi-row UI 2026). */
function countDialogEmailInputs(dialog: HTMLElement): number {
  return dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input[type="email"], input[type="text"], textarea',
  ).length;
}

/** Trả input cuối cùng đang trống trong dialog — dùng cho row mới sau Add more. */
function findLastEmptyEmailInput(
  dialog: HTMLElement,
): HTMLInputElement | HTMLTextAreaElement | null {
  const inputs = Array.from(
    dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input[type="email"], input[type="text"], textarea',
    ),
  );
  // Duyệt ngược: chọn input rỗng cuối cùng (row mới nhất luôn ở dưới)
  for (let i = inputs.length - 1; i >= 0; i--) {
    const el = inputs[i];
    if (!el.value) return el;
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

  // Phase 1 (submit) HOÀN TẤT. Verify pending list được tách thành Phase 2 —
  // background sẽ chrome.tabs.reload (F5 thật) tab admin để ChatGPT BUỘC PHẢI
  // load lại pending list từ server (KHÔNG dùng React Query cache stale), rồi
  // gửi message VERIFY_PENDING_INVITE cho content script mới → scrape.
  //
  // Trả `awaiting_reload_verify: true` để runner biết cần F5 + verify riêng.
  await reportProgress(
    taskId,
    {
      phase: "submit-done",
      message: `Submit ${emails.length} email OK — chờ background F5 trang để verify pending list...`,
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

/**
 * Phase 2 của INVITE_MEMBER — chạy SAU khi background đã F5 tab admin.
 * Page hiện tại đã fresh (không cache React Query), pending list chắc chắn
 * load từ server. Chỉ cần navigate tới /admin/members?tab=invites + scrape.
 *
 * Retry tới 3 lần với forceReload (bounce tab) để cover trường hợp ChatGPT
 * backend chưa kịp index invite vừa POST (1-5s).
 */
export async function executeVerifyPendingInvite(
  taskId: string,
  emails: string[],
  role: ChatGPTRole,
): Promise<ExecuteActionResponse> {
  console.log(
    `[autogpt-invite-verify] START: ${emails.length} email(s) role=${role} pathname=${location.pathname}`,
  );

  // Page có thể vừa load xong sau F5 — đợi DOM ready + sidebar render.
  await sleep(1500);

  // Nếu sau F5 không ở /admin/members thì navigate qua sidebar / pushState.
  if (!location.pathname.includes("/admin/members")) {
    console.log(
      `[autogpt-invite-verify] sau F5 đang ở ${location.pathname}, navigate /admin/members`,
    );
    const sidebarLink = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ).find((a) => {
      const href = a.getAttribute("href") ?? "";
      return (
        href === "/admin/members" ||
        href === "/admin/members/" ||
        a.pathname === "/admin/members" ||
        a.pathname === "/admin/members/"
      );
    });
    if (sidebarLink) {
      sidebarLink.click();
    } else {
      history.pushState({}, "", "/admin/members");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
    await sleep(2000);
  }

  await reportProgress(
    taskId,
    {
      phase: "mapping",
      message: `Page đã F5 — đang scrape pending list để verify ${emails.length} email...`,
      current: 0,
      total: emails.length,
    },
    true,
  );

  type ScrapedPending = Awaited<ReturnType<typeof scrapePendingInvitesAfterInvite>>;
  const invitedLower = emails.map((e) => e.toLowerCase());
  let scrapedPending: ScrapedPending = [];
  let scrapeFailed = false;
  let verifiedEmails: string[] = [];
  let unverifiedEmails: string[] = invitedLower.slice();
  let scrapedEmailSet = new Set<string>();

  // Sau F5, attempt 1 chỉ cần delay nhỏ vì cache đã sạch. Retry với delay dài
  // dần phòng case ChatGPT backend index chậm.
  const RETRY_DELAYS_MS = [0, 3000, 5000];
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt] > 0) {
      await reportProgress(
        taskId,
        {
          phase: "mapping",
          message: `Pending list chưa có ${unverifiedEmails.length} email — đợi ChatGPT index (retry ${attempt + 1}/${RETRY_DELAYS_MS.length})...`,
          current: verifiedEmails.length,
          total: emails.length,
        },
        true,
      );
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
    try {
      scrapedPending = await scrapePendingInvitesAfterInvite(taskId, attempt > 0);
      scrapeFailed = false;
      console.log(
        `[autogpt-invite-verify] attempt ${attempt + 1}: scraped ${scrapedPending.length} pending invite(s)`,
      );
    } catch (e) {
      scrapeFailed = true;
      console.warn(
        `[autogpt-invite-verify] attempt ${attempt + 1} scrape FAILED:`,
        e,
      );
      continue;
    }
    scrapedEmailSet = new Set(
      scrapedPending.map((m) => m.email.toLowerCase()),
    );
    verifiedEmails = invitedLower.filter((e) => scrapedEmailSet.has(e));
    unverifiedEmails = invitedLower.filter((e) => !scrapedEmailSet.has(e));
    if (unverifiedEmails.length === 0) {
      console.log(
        `[autogpt-invite-verify] tất cả ${verifiedEmails.length} email đã xuất hiện trong pending tab (attempt ${attempt + 1})`,
      );
      break;
    }
  }

  const pendingMembersForUpsert = scrapedPending.filter((m) =>
    invitedLower.includes(m.email.toLowerCase()),
  );

  console.log(
    `[autogpt-invite-verify] RESULT: ${verifiedEmails.length}/${emails.length} email confirmed in pending tab`,
    { verified: verifiedEmails, unverified: unverifiedEmails, scrapeFailed },
  );

  await reportProgress(
    taskId,
    {
      phase: "mapping",
      message: scrapeFailed
        ? `Verify FAILED (không scrape được tab Lời mời). Đã invite ${emails.length} email.`
        : `Verified ${verifiedEmails.length}/${emails.length} email trong tab Lời mời.`,
      current: verifiedEmails.length,
      total: emails.length,
    },
    true,
  );

  if (!scrapeFailed && verifiedEmails.length === 0 && emails.length > 0) {
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message:
        `Đã submit ${emails.length} email lên ChatGPT (toast success) + F5 verify nhưng KHÔNG email nào ` +
        `xuất hiện trong tab 'Lời mời đang chờ xử lý'. Có thể: (a) email đã active sẵn, ` +
        `(b) domain không verify, (c) ChatGPT từ chối silently. Unverified: ` +
        unverifiedEmails.slice(0, 5).join(", ") +
        (unverifiedEmails.length > 5 ? ` +${unverifiedEmails.length - 5}` : ""),
    };
  }

  return {
    ok: true,
    data: {
      emails,
      count: emails.length,
      role,
      pending_members: pendingMembersForUpsert,
      verified_emails: verifiedEmails,
      unverified_emails: unverifiedEmails,
      verify_scrape_failed: scrapeFailed,
    },
  };
}
