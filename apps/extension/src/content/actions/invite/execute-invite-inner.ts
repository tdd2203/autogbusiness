import type {
  ChatGPTRole,
  ExecuteActionResponse,
} from "../../../shared/messages";
import { SESSION_RECOVERY_HINT } from "../../../shared/messages";
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
import { normalizeForMatch } from "../purchase-seat/modal2/money";
import { clickAddMoreIfNeeded } from "./click-add-more";
import {
  findVerifiedDomainWarning,
  hasVerifiedDomainWarning,
  waitForDomainWarningCleared,
} from "./finders/find-domain-warning";
import {
  countDialogEmailInputs,
  findInviteEmailInput,
  findLastEmptyEmailInput,
} from "./finders/find-email-input";
import { findInviteOpenButton } from "./finders/find-invite-open-button";
import { findInviteSubmitButton } from "./finders/find-submit-button";
import {
  findInviteSuccessToastText,
  isInviteDialogOpen,
} from "./invite-success-toast";
import { setRole } from "./set-role";
import { VERIFY_TOAST_GRACE_MS, inviteVerifyTimeoutMs } from "./verify-wait";

/**
 * Nhãn nút "MUA suất và gửi lời mời" — nút CUỐI của hộp "Xem lại giao dịch mua"
 * mà ChatGPT bật lên khi mời trong lúc THIẾU suất: mua ghế VÀ gửi lời mời trong
 * MỘT cú bấm, trừ tiền thẻ ngay, không hỏi lại.
 *
 * Nhãn đó CHỨA "gửi lời mời" nên khớp luôn `TEXT_FALLBACKS.inviteSubmitButton`,
 * và cũng khớp `[role="dialog"] button.btn-primary` — tức `findInviteSubmitButton`
 * trả về đúng nó mà không hay biết.
 *
 * `ensure-seats.ts` giữ nguyên tắc "làm cho hộp đó KHÔNG BAO GIỜ xuất hiện"
 * (đếm/mua đủ suất trước khi mời). Đây là lớp chặn CUỐI cho ca nguyên tắc đó
 * hụt: số suất dashboard gửi kèm (`seatHint`) cao hơn thực tế nên luồng mời đi
 * đường tắt, bỏ qua bước đếm tận nơi. Thà task chết còn hơn tiêu tiền workspace
 * bằng một cú bấm không ai duyệt.
 */
const BUY_AND_INVITE_RE = /mua\s*suat|purchase\s*seat|buy\s*seat|购买席位/i;

/** Tách khỏi phần DOM để test được bằng chuỗi thuần. */
export function isBuyAndInviteLabel(text: string): boolean {
  return BUY_AND_INVITE_RE.test(normalizeForMatch(text));
}

function isBuyAndInviteButton(el: HTMLElement): boolean {
  return isBuyAndInviteLabel(el.textContent ?? "");
}

/**
 * Nút bị VÔ HIỆU HOÁ? ChatGPT disable "Gửi lời mời" khi còn banner "ngoài miền"
 * (hoặc email chưa hợp lệ). Click nút disabled = no-op → chờ hết trần verify → VERIFY_FAILED.
 * Kiểm 3 tín hiệu: thuộc tính `disabled`, `aria-disabled`, `data-disabled` (Radix).
 */
function isControlDisabled(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled === true) return true;
  if (el.getAttribute("aria-disabled") === "true") return true;
  if (el.getAttribute("data-disabled") !== null) return true;
  return false;
}

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
  //
  //    TỐI ƯU TỐC ĐỘ (2026-06-18): nếu nút "Mời thành viên" ĐÃ hiện sẵn thì
  //    đang ở đúng tab rồi → KHÔNG click lại tab "Người dùng". Click thừa khiến
  //    ChatGPT re-fetch + re-render cả danh sách member (vài giây) ngay trước khi
  //    mở dialog → là một trong các nguyên nhân chính "mở dialog tốn nhiều thời
  //    gian". Chỉ click tab khi thật sự chưa thấy nút Mời (đang ở tab khác).
  if (!findInviteOpenButton()) {
    const activeTab = findControlByKey(
      "tab_active_members",
      TEXT_FALLBACKS.tabActiveMembers,
      { page: "/admin/members" },
    );
    if (activeTab) {
      await humanClick(activeTab);
      await randomDelay(500, 1200);
    }
  }

  // 2. Mở dialog Invite. Poll-wait button render — wrap external-invites điều
  //    hướng từ /admin/identity → /admin/members chỉ đợi URL đổi (5s), nhưng
  //    SPA render content sau navigation cần thêm vài trăm ms tới vài giây.
  //    Nếu invite button chưa render thì retry tới 20s (FIX B 2026-07-15: tăng
  //    từ 8s — tab tái dùng vừa F5, ChatGPT React rehydrate + fetch org-config
  //    có khi >8s → "Không tìm thấy nút Mời" oan; 20s khớp poll ô email bên dưới).
  let openBtn: HTMLElement | null = null;
  try {
    openBtn = await waitFor(() => findInviteOpenButton(), 20_000);
  } catch {
    return {
      ok: false,
      error_code: "FAILED_UI_CHANGED",
      error_message:
        "Không tìm thấy nút 'Mời thành viên' sau 20s. URL hiện tại: " +
        location.pathname +
        ". Kiểm tra (a) đang ở /admin/members, (b) đã click tab Người dùng, " +
        "(c) sidebar có hiển thị tab '+Mời thành viên' ở góc phải. " +
        SESSION_RECOVERY_HINT,
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

  // POLL dialog mở (thay sleep 800ms CỐ ĐỊNH — 2026-06-18). Dialog Radix thường
  // mở trong ~150-400ms; chờ cứng 800ms phí ~400-650ms mỗi lần. Poll 150ms/lần,
  // tối đa 1000ms, mở sớm thì đi tiếp NGAY. Hết 1000ms vẫn chưa thấy → retry click
  // (Radix DialogTrigger đôi khi miss event đầu, click lần 2 thường mở được).
  const dialogSel =
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-state="open"]';
  let dialogOpened = false;
  for (let waited = 0; waited < 1000; waited += 150) {
    await sleep(150);
    if (document.querySelector(dialogSel)) {
      dialogOpened = true;
      break;
    }
  }
  if (!dialogOpened) {
    console.log("[autogpt-invite] chưa thấy dialog sau ~1s — retry click");
    await humanClick(openBtn);
  }

  // 3. Đợi dialog mở + input email xuất hiện. Tăng từ 10s → 20s vì sau v0.4.17
  //    auto-reload tab, SPA cần thời gian rehydrate + dialog animate open.
  //    Tách phase "waiting-dialog" để PhaseBreakdown trên dashboard tách bạch
  //    "thời gian tìm+click nút mở" (phase opening-dialog) với "thời gian dialog
  //    + ô email render" (phase này) → chẩn đoán đúng bước nào chậm.
  await reportProgress(
    taskId,
    {
      phase: "waiting-dialog",
      message: "Dialog đang mở — đợi ô nhập email render...",
      current: 0,
      total: emails.length,
    },
    true,
  );
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
      error_code: "FAILED_UI_CHANGED",
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

  // 5.5 KIỂM TRA LẠI banner "email ngoài miền đã xác minh" (v0.8.12 + "làm chậm
  //   mà chắc" 2026-07-15).
  //   ChatGPT validate email LIVE, BẤT ĐỒNG BỘ sau khi gõ. Nếu có email NGOÀI
  //   domain mà setting "Allow External Domain Invites" CHƯA có hiệu lực, dialog
  //   hiện banner đỏ "...not a part of your organization's verified domains..." +
  //   DISABLE nút Send invites. `execute-invite.ts` đã xác nhận toggle ON + để
  //   server chốt (settleServerCommit) + background HARD-RELOAD refetch config,
  //   nhưng banner vẫn có thể tới TRỄ vài trăm ms–vài giây.
  //   ⚠️ Bài học 2026-07-15 (VERIFY_FAILED): check banner NGAY sau setRole có thể
  //   thấy "không banner" oan (banner chưa render) → submit mù → ChatGPT từ chối
  //   silently. → ĐỢI 1 nhịp cho validation kịp render TRƯỚC khi kết luận, rồi mới
  //   check + poll banner biến mất (tối đa 15s), còn → huỷ rõ ràng.
  await sleep(1_500);
  const dialogNow = document.querySelector('[role="dialog"]') as HTMLElement | null;
  if (hasVerifiedDomainWarning(dialogNow)) {
    console.log(
      "[autogpt-invite] phát hiện banner 'email ngoài miền đã xác minh' — đợi setting external-invites propagate (poll tối đa 15s)...",
    );
    await reportProgress(
      taskId,
      {
        phase: "verifying",
        message:
          "Email ngoài miền đã xác minh — đợi setting 'mời ngoài domain' có hiệu lực...",
        current: emails.length,
        total: emails.length,
      },
      true,
    );
    const cleared = await waitForDomainWarningCleared(dialogNow, 15_000);
    if (!cleared) {
      const warnText = findVerifiedDomainWarning(dialogNow) ?? "(banner)";
      console.warn(
        "[autogpt-invite] banner 'email ngoài miền đã xác minh' VẪN còn sau 15s — huỷ invite (toggle external-invites chưa có hiệu lực).",
      );
      return {
        ok: false,
        error_code: "EXTERNAL_TOGGLE_FAILED",
        error_message:
          `Dialog vẫn cảnh báo email ngoài miền đã xác minh sau khi bật 'Cho phép lời mời ngoài tên miền' (khớp: "${warnText}"). ` +
          "Setting có thể chưa kịp có hiệu lực — thử lại sau vài giây. Đã huỷ submit để tránh tạo lời mời ảo.",
      };
    }
    console.log(
      "[autogpt-invite] banner đã biến mất — setting external-invites đã có hiệu lực, chờ nút Send enable rồi submit.",
    );
    // Banner vừa ẩn → React cập nhật nút Send từ disabled→enabled TRỄ 1 nhịp.
    await sleep(1_000);
  }

  // 6. Click Submit — CHỜ nút Send THỰC SỰ enable trước khi click.
  //   Banner-text không phải tín hiệu duy nhất: có lúc banner đã ẩn nhưng nút Send
  //   còn disabled 1 nhịp (React trễ), hoặc setting chưa hiệu lực làm Send disabled
  //   dù không có banner text. Click nút disabled = no-op → chờ hết trần verify →
  //   VERIFY_FAILED. → poll tới 6s cho nút enable; còn disabled → EXTERNAL_TOGGLE_FAILED
  //   (huỷ rõ ràng thay vì click chết → tạo lời mời ảo).
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
  const enabledBtn = await waitFor(() => {
    const b = findInviteSubmitButton();
    return b && !isControlDisabled(b) ? b : null;
  }, 6_000).catch(() => null);
  if (!enabledBtn) {
    const warnText =
      findVerifiedDomainWarning(document.querySelector('[role="dialog"]')) ??
      "(nút Gửi lời mời vẫn bị mờ)";
    console.warn(
      "[autogpt-invite] nút 'Gửi lời mời' VẪN disabled sau 6s — huỷ invite (setting external chưa hiệu lực).",
    );
    return {
      ok: false,
      error_code: "EXTERNAL_TOGGLE_FAILED",
      error_message:
        `Nút "Gửi lời mời" vẫn bị vô hiệu hoá sau khi chờ (dấu hiệu: "${warnText}") — ` +
        "setting 'mời ngoài tên miền' chưa có hiệu lực server-side. Đã huỷ submit để tránh lời mời ảo.",
    };
  }
  // ⚠️ CHẶN CUỐI: nút này có phải "Mua suất người dùng và gửi lời mời" không?
  // Nếu đúng thì workspace đang THIẾU suất và cú bấm sẽ mua ghế bằng tiền thật
  // (số suất + số tiền do ChatGPT tự quyết). Dừng hẳn — xem `isBuyAndInviteButton`.
  if (isBuyAndInviteButton(enabledBtn)) {
    const label = (enabledBtn.textContent ?? "").trim().slice(0, 80);
    console.warn(
      `[autogpt-invite] HUỶ submit: nút là "${label}" — mua suất kèm gửi lời mời.`,
    );
    return {
      ok: false,
      // Đúng nghĩa của `NOT_ENOUGH_SEATS`: workspace thiếu suất và extension
      // KHÔNG mua bù — ở đây là không mua theo đường ChatGPT tự quyết số tiền.
      error_code: "NOT_ENOUGH_SEATS",
      error_message:
        `Đã dừng TRƯỚC khi bấm: nút gửi của ChatGPT là "${label}" — bấm vào là MUA ` +
        "suất bằng tiền thật rồi mới gửi lời mời. Nghĩa là workspace đang thiếu suất " +
        "(số suất dashboard đang hiển thị cao hơn thực tế). Mua suất trên ChatGPT " +
        "hoặc chạy Đồng bộ để cập nhật số suất, rồi chạy lại lệnh mời.",
      data: { seat_check: "buy_and_invite_button", submit_clicked: false },
    };
  }

  await humanClick(enabledBtn);
  // Trần chờ CO GIÃN theo số email — 15s cố định là nguyên nhân ca 26/8/2026 báo
  // hỏng oan cả một mẻ 5 email đã gửi được. Xem `verify-wait.ts`.
  const verifyTimeoutMs = inviteVerifyTimeoutMs(emails.length);
  console.log(
    `[autogpt-invite] submit clicked, verifying (chờ tối đa ${Math.round(verifyTimeoutMs / 1000)}s cho ${emails.length} email)...`,
  );

  await reportProgress(
    taskId,
    {
      phase: "verifying",
      message: `Đợi ChatGPT xác nhận ${emails.length} lời mời (tối đa ${Math.round(verifyTimeoutMs / 1000)}s)...`,
    },
    true,
  );

  // 7. Verify success — chờ hộp thoại ĐÓNG HẲN, rồi mới lấy toast xác nhận.
  //
  // Chốt user 28/8/2026: "phải chờ cái tab này tắt hoàn toàn, có thông báo đã mời
  // thành công thì mới check ở Lời mời đang chờ xử lý". Bản cũ dừng chờ khi thấy
  // MỘT TRONG HAI (toast HOẶC dialog đóng) — nút "Đang gửi lời mời..." còn quay mà
  // đã bỏ đi quét tab, hoặc dialog vừa đóng trước khi toast kịp vẽ nên bằng chứng
  // tụt xuống mức YẾU rồi báo hỏng oan. Giờ điều kiện là ĐÓNG HẲN, đóng rồi vẫn
  // nán `VERIFY_TOAST_GRACE_MS` cho toast kịp hiện.
  //
  // Phân biệt HAI mức bằng chứng (user 2026-08-04) thay vì gộp làm một:
  //   - "toast": ChatGPT NÓI RÕ đã gửi lời mời (khớp INVITE_SUCCESS_TOAST_PATTERNS)
  //     → bằng chứng MẠNH, background dựa vào đây để KHÔNG kết luận hỏng chỉ vì tab
  //     "Lời mời đang chờ xử lý" chưa kịp index (xem runner.ts::decideInviteOutcome).
  //   - "dialog_closed": dialog đóng nhưng không đọc được chữ xác nhận → bằng chứng
  //     YẾU (dialog cũng có thể đóng vì lý do khác).
  let submitEvidence: "toast" | "dialog_closed" = "dialog_closed";
  let toastText: string | null = null;
  let dialogClosedAt = 0;
  try {
    await waitFor(() => {
      // Toast là thứ CHỚP TẮT — đọc được lần nào thì giữ luôn, đừng đọc lại ở
      // vòng poll sau rồi kết luận "không có".
      if (!toastText) toastText = findInviteSuccessToastText();
      if (isInviteDialogOpen()) return null; // hộp còn mở = ChatGPT còn đang gửi
      if (!dialogClosedAt) dialogClosedAt = Date.now();
      if (!toastText && Date.now() - dialogClosedAt < VERIFY_TOAST_GRACE_MS) {
        return null; // đóng rồi nhưng nán thêm để lấy bằng chứng MẠNH
      }
      return document.body;
    }, verifyTimeoutMs + VERIFY_TOAST_GRACE_MS);
    submitEvidence = toastText ? "toast" : "dialog_closed";
  } catch {
    // Hộp chưa đóng nhưng ChatGPT ĐÃ nói "đã mời" → lời mời đi rồi, hộp chỉ chậm
    // đóng. Báo hỏng ở đây là dựng lại đúng ca 26/8/2026 (suýt hoàn 1.650.000đ oan).
    if (toastText) {
      console.log(
        `[autogpt-invite] hộp chưa đóng sau ${Math.round(verifyTimeoutMs / 1000)}s ` +
          `nhưng đã đọc được toast xác nhận: "${toastText}" → coi như đã gửi.`,
      );
      await reportProgress(
        taskId,
        {
          phase: "submit-done",
          message: `ChatGPT xác nhận đã mời (${emails.length} email) — hộp thoại chậm đóng.`,
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
          submit_evidence: "toast",
          dialog_still_open: true,
        },
      };
    }
    // Check xem có error message trong dialog không (vd email đã tồn tại)
    const dialogText = document.querySelector('[role="dialog"]')?.textContent ?? "";
    const errHints = INVITE_ERROR_HINTS;
    const matchedHint = errHints.find((h) => dialogText.toLowerCase().includes(h.toLowerCase()));
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message: matchedHint
        ? `ChatGPT báo lỗi trong dialog: "${matchedHint}". Có thể email đã được mời/tồn tại.`
        : `Đã submit nhưng hộp thoại không đóng và không đọc được thông báo mời thành công sau ${Math.round((verifyTimeoutMs + VERIFY_TOAST_GRACE_MS) / 1000)}s (${emails.length} email). ` +
          `Dialog text: "${dialogText.slice(0, 200)}"`,
      data: {
        // ⚠️ Cú click "Gửi lời mời" ĐÃ XẢY RA (ở trên) trước khi vào vòng chờ xác
        // nhận này → hết trần chờ mà không đọc được toast/dialog-đóng KHÔNG chứng minh lời
        // mời chưa đi, chỉ chứng minh ta KHÔNG BIẾT. Background phải F5 + soi tab
        // Lời mời/Người dùng để phân xử (invite-salvage.ts), tuyệt đối không để
        // backend hiểu là "mời hỏng" → hoàn phí + void kỳ (CA 1 ngày 12/8/2026:
        // mời tới ĐƯỢC nhưng vẫn bị hoàn 330k + xoá hạn → dùng miễn phí vô hạn).
        submit_clicked: true,
        // Trừ khi CHÍNH ChatGPT báo lỗi trong dialog (email trùng / không hợp lệ /
        // hết ghế) — đó là bằng chứng DƯƠNG rằng lời mời không đi → giữ nguyên kết
        // luận hỏng, KHÔNG phân xử lại.
        chatgpt_error_hint: matchedHint ?? null,
      },
    };
  }

  console.log(
    `[autogpt-invite] SUBMIT SUCCESS: ${emails.length} email(s) role=${role}`,
  );

  // executeInviteInner CHỈ chịu trách nhiệm submit invite. Bước "chuyển tab
  // Lời mời" được làm ở scope ngoài (executeInvite) SAU khi finally đã
  // setExternalInvites(false) restore xong toggle — đảm bảo URL không bị mất
  // ?tab=invites do navigation /admin/identity → /admin/members khi tắt toggle.
  // (v0.6.4 từng đặt click tab ở đây là SAI thứ tự — fixed ở v0.6.5.)
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
      // "toast" = ChatGPT xác nhận đã gửi → tab Lời mời chưa hiện KHÔNG có nghĩa là hỏng.
      submit_evidence: submitEvidence,
    },
  };
}
