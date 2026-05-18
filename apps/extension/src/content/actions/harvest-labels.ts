/**
 * HARVEST_LABELS — extension tự crawl DOM ChatGPT /admin/* để đọc text label
 * cho 18 control_key × 1 locale. Admin chọn locale (vi/en/zh) trên dashboard,
 * đặt ChatGPT sang ngôn ngữ tương ứng, rồi bấm "Tự động harvest".
 *
 * Mỗi bước:
 *   - Verify navigate thành công trước khi đọc (nếu Next.js router không
 *     bắt popstate, ta skip page đó thay vì hang).
 *   - Report progress real-time (step + scanned count) để dashboard hiện
 *     thanh tiến trình.
 *   - Timeout từng step ngắn — fail-fast để không kẹt.
 */

import type { ExecuteActionResponse } from "../../shared/messages";
import {
  humanClick,
  humanType,
  queryByAnyText,
  querySelectorFirst,
  randomDelay,
  sleep,
} from "../human";
import {
  EXTERNAL_INVITE_LABEL_PATTERNS,
  findUiControlByTexts,
  REVOKE_CONFIRM_TEXTS,
  REVOKE_MENU_ITEM_TEXTS,
  ROLE_LABELS,
} from "../i18n-ui";
import { reportProgress } from "../progress";
import { SELECTORS, TEXT_FALLBACKS } from "../selectors";
import { findRowMenuButton } from "./member-row";

type HarvestItem = {
  control_key: string;
  label_text?: string | null;
  aria_label?: string | null;
};

type HarvestPage = {
  page:
    | "/admin/members"
    | "/admin/billing"
    | "/admin/billing?tab=invoices"
    | "/admin/identity";
  labels: HarvestItem[];
};

type Ctx = {
  taskId: string;
  startedAt: number;
  scanned: number;
  step: number;
  totalSteps: number;
};

const PROGRESS_PHASE = "scraping";

function pickText(el: HTMLElement | null): string | undefined {
  if (!el) return undefined;
  const t = (el.textContent ?? "").trim().replace(/\s+/g, " ");
  return t.length > 0 && t.length <= 120 ? t : undefined;
}

function pickAria(el: HTMLElement | null): string | undefined {
  if (!el) return undefined;
  const a = (el.getAttribute("aria-label") ?? "").trim();
  return a.length > 0 && a.length <= 120 ? a : undefined;
}

function elapsedSec(ctx: Ctx): number {
  return Math.round((Date.now() - ctx.startedAt) / 1000);
}

async function step(ctx: Ctx, message: string): Promise<void> {
  ctx.step += 1;
  await reportProgress(
    ctx.taskId,
    {
      phase: PROGRESS_PHASE,
      message: `[${ctx.step}/${ctx.totalSteps}] ${message}`,
      current: ctx.step,
      total: ctx.totalSteps,
      scanned: ctx.scanned,
      elapsed_sec: elapsedSec(ctx),
    },
    true,
  );
}

function recordIfText(
  out: HarvestItem[],
  ctx: Ctx,
  key: string,
  el: HTMLElement | null,
  fallback?: { label_text?: string; aria_label?: string },
): boolean {
  const t = pickText(el) ?? fallback?.label_text;
  const a = pickAria(el) ?? fallback?.aria_label;
  if (!t && !a) return false;
  out.push({ control_key: key, label_text: t, aria_label: a });
  ctx.scanned += 1;
  return true;
}

async function pressEscape(): Promise<void> {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  document.body.click();
  await sleep(400);
}

async function waitForDialog(timeoutMs = 4000): Promise<HTMLElement | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const d = document.querySelector<HTMLElement>('[role="dialog"]');
    if (d) return d;
    await sleep(150);
  }
  return null;
}

async function waitForDialogClose(timeoutMs = 2500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!document.querySelector('[role="dialog"]')) return;
    await sleep(150);
  }
}

async function waitForMenu(timeoutMs = 2500): Promise<HTMLElement | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const m = document.querySelector<HTMLElement>(
      '[role="menu"] [role="menuitem"], [role="menuitem"]',
    );
    if (m) return m;
    await sleep(150);
  }
  return null;
}

/**
 * Navigate SPA + verify pathname thực sự thay đổi.
 * Trả false nếu sau 6s vẫn chưa nav được → caller skip page đó.
 */
async function navigateSpaVerified(
  pathname: string,
  search = "",
  timeoutMs = 6000,
): Promise<boolean> {
  const targetPath = pathname;
  const targetSearch = search;

  if (
    location.pathname === targetPath &&
    (location.search === targetSearch ||
      (targetSearch === "" && location.search === ""))
  ) {
    return true;
  }

  // Ưu tiên click link <a> trong sidebar nếu có (Next.js router handle đúng)
  const link = document.querySelector<HTMLAnchorElement>(
    `a[href="${targetPath}${targetSearch}"], a[href="${targetPath}"]`,
  );
  if (link) {
    link.click();
  } else {
    history.pushState({}, "", `${targetPath}${targetSearch}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(250);
    if (location.pathname === targetPath) {
      // Chờ thêm 1.2s cho React render xong
      await sleep(1200);
      return true;
    }
  }
  console.warn(
    `[autogpt-harvest] nav failed to ${targetPath}${targetSearch} (still ${location.pathname}${location.search})`,
  );
  return false;
}

async function harvestMembers(
  ctx: Ctx,
  out: HarvestItem[],
): Promise<void> {
  await step(ctx, "Mở /admin/members");
  const ok = await navigateSpaVerified("/admin/members");
  if (!ok) {
    await step(ctx, "⚠ Bỏ qua /admin/members (nav fail)");
    return;
  }

  // 3 tabs
  await step(ctx, "Đọc 3 tab Members");
  for (const [key, texts] of [
    ["tab_active_members", TEXT_FALLBACKS.tabActiveMembers],
    ["tab_pending_invites", TEXT_FALLBACKS.tabPendingInvites],
    ["tab_pending_requests", TEXT_FALLBACKS.tabPendingRequests],
  ] as const) {
    recordIfText(out, ctx, key, findUiControlByTexts(texts));
  }

  // Mở invite dialog
  await step(ctx, "Mở dialog Mời thành viên");
  const inviteOpen = findUiControlByTexts(TEXT_FALLBACKS.inviteButtonOpen);
  if (inviteOpen) {
    recordIfText(out, ctx, "invite_button_open", inviteOpen);
    await humanClick(inviteOpen);
    const dialog = await waitForDialog(4000);
    if (dialog) {
      await step(ctx, "Đọc nút Submit + Add-more");
      const submit = queryByAnyText(
        "button",
        TEXT_FALLBACKS.inviteSubmitButton,
        dialog,
      );
      recordIfText(out, ctx, "invite_submit_button", submit);

      const addMore =
        queryByAnyText("button", TEXT_FALLBACKS.inviteAddMoreButton, dialog) ??
        queryByAnyText("a", TEXT_FALLBACKS.inviteAddMoreButton, dialog);
      recordIfText(out, ctx, "invite_add_more_button", addMore);

      await step(ctx, "Mở dropdown Role → đọc 3 option");
      const roleSelect = querySelectorFirst<HTMLElement>(
        SELECTORS.inviteRoleSelect,
        dialog,
      );
      if (roleSelect && roleSelect.tagName !== "SELECT") {
        await humanClick(roleSelect);
        await sleep(700);
        for (const role of ["owner", "admin", "member"] as const) {
          const opt =
            queryByAnyText('[role="menuitem"]', ROLE_LABELS[role]) ??
            queryByAnyText('[role="option"]', ROLE_LABELS[role]) ??
            queryByAnyText('[role="menuitemradio"]', ROLE_LABELS[role]) ??
            queryByAnyText("li", ROLE_LABELS[role]);
          recordIfText(out, ctx, `invite_role_${role}`, opt);
        }
        await pressEscape();
      } else if (roleSelect && roleSelect.tagName === "SELECT") {
        const sel = roleSelect as HTMLSelectElement;
        for (const role of ["owner", "admin", "member"] as const) {
          const opt = Array.from(sel.options).find(
            (o) =>
              o.value === role ||
              (o.textContent ?? "").trim().toLowerCase().includes(role),
          );
          const t = (opt?.textContent ?? "").trim();
          if (t) {
            out.push({ control_key: `invite_role_${role}`, label_text: t });
            ctx.scanned += 1;
          }
        }
      }

      await pressEscape();
      await waitForDialogClose();
    } else {
      await step(ctx, "⚠ Dialog Invite không mở (skip)");
    }
  }

  // Row menu
  await step(ctx, "Tìm row member để mở menu ...");
  const rows: HTMLElement[] = [];
  for (const sel of SELECTORS.memberRow) {
    document.querySelectorAll<HTMLElement>(sel).forEach((r) => rows.push(r));
    if (rows.length > 0) break;
  }
  const targetRow = rows[rows.length - 1] ?? null;
  if (targetRow) {
    const menuBtn = findRowMenuButton(targetRow);
    if (menuBtn) {
      recordIfText(out, ctx, "member_row_menu_button", menuBtn);
      await humanClick(menuBtn);
      await waitForMenu();
      await sleep(300);

      await step(ctx, "Đọc menu items Remove / Change role");
      const removeItem = queryByAnyText(
        '[role="menuitem"]',
        TEXT_FALLBACKS.removeMenuItem,
      );
      recordIfText(out, ctx, "menu_remove_member", removeItem);

      const changeItem = queryByAnyText(
        '[role="menuitem"]',
        TEXT_FALLBACKS.changeRoleMenuItem,
      );
      recordIfText(out, ctx, "menu_change_role", changeItem);

      if (removeItem) {
        await step(ctx, "Mở confirm Remove (sẽ ESC để hủy)");
        await randomDelay(250, 500);
        await humanClick(removeItem);
        const confirmDialog = await waitForDialog(3000);
        if (confirmDialog) {
          const confirmBtn = queryByAnyText(
            "button",
            TEXT_FALLBACKS.confirmRemoveButton,
            confirmDialog,
          );
          recordIfText(out, ctx, "confirm_remove_button", confirmBtn);
          await pressEscape();
          await waitForDialogClose();
        } else {
          await pressEscape();
        }
      } else {
        await pressEscape();
      }
    } else {
      await step(ctx, "⚠ Row không có nút ... (skip)");
    }
  } else {
    await step(ctx, "⚠ Workspace chưa có member nào (skip row menu)");
  }

  // Pending tab → revoke menu (auto-tạo probe invite nếu trống)
  await harvestRevokeFlow(ctx, out);
}

/** Tìm pending invite rows (helper dùng chung). */
function findPendingRows(): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const sel of SELECTORS.memberRow) {
    document.querySelectorAll<HTMLElement>(sel).forEach((r) => rows.push(r));
    if (rows.length > 0) break;
  }
  return rows;
}

/**
 * Tạo invite probe (email fake) để có ít nhất 1 pending row → harvest revoke
 * labels được. Trả về email probe nếu tạo thành công, null nếu fail.
 *
 * Email format: `autogpt-probe-{timestamp}@example.com` — example.com là
 * domain reserved, ChatGPT accept format nhưng email không deliver.
 */
async function createProbeInvite(
  ctx: Ctx,
): Promise<string | null> {
  await step(ctx, "Tạo probe invite tạm để harvest revoke labels");

  // Switch về tab active để mở dialog invite
  const activeTab = findUiControlByTexts(TEXT_FALLBACKS.tabActiveMembers);
  if (activeTab) {
    await humanClick(activeTab);
    await sleep(1000);
  }

  const inviteOpen = findUiControlByTexts(TEXT_FALLBACKS.inviteButtonOpen);
  if (!inviteOpen) return null;
  await humanClick(inviteOpen);
  const dialog = await waitForDialog(4000);
  if (!dialog) return null;

  // Tìm input email trong dialog
  const input =
    dialog.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'input[type="email"], textarea, input[type="text"]',
    );
  if (!input) {
    await pressEscape();
    return null;
  }

  const probeEmail = `autogpt-probe-${Date.now()}@example.com`;
  await humanType(input, probeEmail);
  await sleep(600);

  const submit = queryByAnyText(
    "button",
    TEXT_FALLBACKS.inviteSubmitButton,
    dialog,
  );
  if (!submit) {
    await pressEscape();
    return null;
  }
  await humanClick(submit);
  await sleep(2500); // chờ ChatGPT register invite + đóng dialog

  // Đảm bảo dialog đóng
  if (document.querySelector('[role="dialog"]')) {
    await pressEscape();
    await waitForDialogClose();
  }
  return probeEmail;
}

/** Thực sự thu hồi probe invite (không chỉ ESC). */
async function cleanupProbeInvite(ctx: Ctx, probeEmail: string): Promise<void> {
  await step(ctx, `Cleanup probe invite (${probeEmail.split("@")[0]}@…)`);

  // Đảm bảo đang ở tab Pending
  const pendingTab = findUiControlByTexts(TEXT_FALLBACKS.tabPendingInvites);
  if (pendingTab) {
    await humanClick(pendingTab);
    await sleep(1200);
  }

  // Tìm đúng row chứa probeEmail
  const rows = findPendingRows();
  const probeRow = rows.find((r) =>
    (r.textContent ?? "").toLowerCase().includes(probeEmail.toLowerCase()),
  );
  if (!probeRow) {
    console.warn("[autogpt-harvest] probe row không tìm thấy để cleanup");
    return;
  }
  const menuBtn = findRowMenuButton(probeRow);
  if (!menuBtn) return;
  await humanClick(menuBtn);
  await waitForMenu();
  await sleep(300);
  const revokeItem = queryByAnyText(
    '[role="menuitem"]',
    REVOKE_MENU_ITEM_TEXTS,
  );
  if (!revokeItem) {
    await pressEscape();
    return;
  }
  await humanClick(revokeItem);
  const cDialog = await waitForDialog(2500);
  if (cDialog) {
    // CLICK THẬT (không ESC) — đây là cleanup, cần revoke thật sự
    const cBtn = queryByAnyText("button", REVOKE_CONFIRM_TEXTS, cDialog);
    if (cBtn) {
      await humanClick(cBtn);
      await sleep(1500);
    }
  }
}

async function harvestRevokeFlow(ctx: Ctx, out: HarvestItem[]): Promise<void> {
  await step(ctx, "Switch tab Pending → đọc menu Revoke");
  const pendingTab = findUiControlByTexts(TEXT_FALLBACKS.tabPendingInvites);
  if (!pendingTab) return;
  await humanClick(pendingTab);
  await sleep(1500);

  let pendingRows = findPendingRows();
  let probeEmail: string | null = null;

  if (pendingRows.length === 0) {
    // Auto-tạo probe invite để có row mà harvest
    probeEmail = await createProbeInvite(ctx);
    if (!probeEmail) {
      await step(ctx, "⚠ Không tạo được probe invite (skip revoke labels)");
      return;
    }

    // Switch lại tab Pending
    const pendingTab2 = findUiControlByTexts(TEXT_FALLBACKS.tabPendingInvites);
    if (pendingTab2) {
      await humanClick(pendingTab2);
      await sleep(1800);
    }
    pendingRows = findPendingRows();
  }

  const pendingRow =
    (probeEmail
      ? pendingRows.find((r) =>
          (r.textContent ?? "").toLowerCase().includes(probeEmail.toLowerCase()),
        )
      : pendingRows[0]) ?? pendingRows[0] ?? null;

  if (!pendingRow) {
    await step(ctx, "⚠ Probe đã tạo nhưng row chưa xuất hiện (skip)");
    if (probeEmail) await cleanupProbeInvite(ctx, probeEmail);
    return;
  }

  const pMenuBtn = findRowMenuButton(pendingRow);
  if (!pMenuBtn) {
    if (probeEmail) await cleanupProbeInvite(ctx, probeEmail);
    return;
  }
  await humanClick(pMenuBtn);
  await waitForMenu();
  await sleep(300);

  const revokeItem = queryByAnyText('[role="menuitem"]', REVOKE_MENU_ITEM_TEXTS);
  recordIfText(out, ctx, "menu_revoke_invite", revokeItem);

  if (revokeItem) {
    await randomDelay(250, 500);
    await humanClick(revokeItem);
    const cDialog = await waitForDialog(2500);
    if (cDialog) {
      const cBtn = queryByAnyText("button", REVOKE_CONFIRM_TEXTS, cDialog);
      recordIfText(out, ctx, "confirm_revoke_button", cBtn);
      // Nếu là probe → click thật để cleanup. Nếu invite thật → ESC để không xóa.
      if (probeEmail && cBtn) {
        await step(ctx, "Cleanup: thu hồi probe (click confirm thật)");
        await humanClick(cBtn);
        await sleep(1500);
      } else {
        await pressEscape();
        await waitForDialogClose();
      }
    } else {
      await pressEscape();
    }
  } else {
    await pressEscape();
    // Vẫn cần cleanup probe nếu tạo
    if (probeEmail) await cleanupProbeInvite(ctx, probeEmail);
  }
}

async function harvestBillingPlan(
  ctx: Ctx,
  out: HarvestItem[],
): Promise<void> {
  await step(ctx, "Mở /admin/billing");
  const ok = await navigateSpaVerified("/admin/billing");
  if (!ok) {
    await step(ctx, "⚠ Bỏ qua /admin/billing (nav fail)");
    return;
  }
  await sleep(800);
  await step(ctx, "Đọc 2 tab Billing (Kế hoạch + Hoá đơn)");
  for (const [key, texts] of [
    ["tab_billing_plan", TEXT_FALLBACKS.tabBillingPlan],
    ["tab_billing_invoices", TEXT_FALLBACKS.tabBillingInvoices],
  ] as const) {
    recordIfText(out, ctx, key, findUiControlByTexts(texts));
  }
}

async function harvestBillingInvoices(
  ctx: Ctx,
  out: HarvestItem[],
): Promise<void> {
  await step(ctx, "Mở /admin/billing?tab=invoices");
  const ok = await navigateSpaVerified("/admin/billing", "?tab=invoices");
  if (!ok) {
    await step(ctx, "⚠ Bỏ qua /admin/billing?tab=invoices (nav fail)");
    return;
  }
  await sleep(800);
  await step(ctx, "Đọc tab Hoá đơn");
  recordIfText(
    out,
    ctx,
    "tab_billing_invoices",
    findUiControlByTexts(TEXT_FALLBACKS.tabBillingInvoices),
  );
}

async function harvestIdentity(
  ctx: Ctx,
  out: HarvestItem[],
): Promise<void> {
  await step(ctx, "Mở /admin/identity");
  const ok = await navigateSpaVerified("/admin/identity");
  if (!ok) {
    await step(ctx, "⚠ Bỏ qua /admin/identity (nav fail)");
    return;
  }
  await sleep(1200);
  await step(ctx, "Đọc toggle 'External invites'");
  const switches = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button[role="switch"], input[type="checkbox"]',
    ),
  );
  for (const el of switches) {
    let p: HTMLElement | null = el;
    for (let depth = 0; depth < 6 && p; depth++, p = p.parentElement) {
      const raw = (p.textContent ?? "").trim().replace(/\s+/g, " ");
      const lower = raw.toLowerCase();
      const hit = EXTERNAL_INVITE_LABEL_PATTERNS.find((pat) =>
        lower.includes(pat),
      );
      if (hit) {
        const sentences = raw.split(/(?<=[.。?!？!])\s+|\s+(?=•|·)/);
        const cand =
          sentences.find((s) => s.toLowerCase().includes(hit)) ?? raw;
        const clipped = cand.length > 180 ? cand.slice(0, 180) : cand;
        out.push({
          control_key: "toggle_external_invites",
          label_text: clipped,
          aria_label: pickAria(el),
        });
        ctx.scanned += 1;
        return;
      }
    }
  }
}

const MAX_HARVEST_MS = 180_000; // 3 phút hard timeout

export async function executeHarvestLabels(
  taskId: string,
  locale: "vi" | "en" | "zh",
): Promise<ExecuteActionResponse> {
  console.log(`[autogpt-harvest] START locale=${locale}`);

  // Phát signal đầu tiên ngay khi content script bắt đầu — KHÔNG đợi bước 1.
  // Mục đích: progress bar hiện 0/18 và status đổi từ "đợi" → "đang chạy"
  // trong < 1s sau khi background gọi sendMessage tới content script.
  await reportProgress(
    taskId,
    {
      phase: "starting",
      message: `Bắt đầu harvest locale ${locale.toUpperCase()} — kiểm tra trang ChatGPT...`,
      current: 0,
      total: 18,
      scanned: 0,
      elapsed_sec: 0,
    },
    true,
  );

  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}). Mở chatgpt.com/admin/members trước.`,
    };
  }

  const detectedLocale = (document.documentElement.lang ?? "").toLowerCase();
  if (
    (locale === "vi" && !detectedLocale.startsWith("vi")) ||
    (locale === "en" && !(detectedLocale.startsWith("en") || detectedLocale === "")) ||
    (locale === "zh" && !detectedLocale.startsWith("zh"))
  ) {
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message: `Locale ChatGPT đang là '${detectedLocale || "unknown"}' nhưng admin yêu cầu '${locale}'. Đổi ngôn ngữ ChatGPT sang ${locale} (Settings → Personalization) rồi F5 trước khi harvest.`,
    };
  }

  const pages: HarvestPage[] = [
    { page: "/admin/members", labels: [] },
    { page: "/admin/billing", labels: [] },
    { page: "/admin/billing?tab=invoices", labels: [] },
    { page: "/admin/identity", labels: [] },
  ];

  const ctx: Ctx = {
    taskId,
    startedAt: Date.now(),
    scanned: 0,
    step: 0,
    totalSteps: 18,
  };

  let timedOut = false;
  const guard = setTimeout(() => {
    timedOut = true;
    console.warn("[autogpt-harvest] global timeout 3 phút");
  }, MAX_HARVEST_MS);

  const runStep = async (
    fn: () => Promise<void>,
    label: string,
  ): Promise<void> => {
    if (timedOut) return;
    try {
      await fn();
    } catch (e) {
      console.warn(`[autogpt-harvest] ${label} step error`, e);
      await step(ctx, `⚠ ${label} bị lỗi nội bộ, tiếp tục`);
    }
  };

  await runStep(() => harvestMembers(ctx, pages[0].labels), "members");
  await runStep(() => harvestBillingPlan(ctx, pages[1].labels), "billing-plan");
  await runStep(
    () => harvestBillingInvoices(ctx, pages[2].labels),
    "billing-invoices",
  );
  await runStep(() => harvestIdentity(ctx, pages[3].labels), "identity");

  clearTimeout(guard);

  await step(ctx, `Quay về /admin/members (đã quét ${ctx.scanned} label)`);
  await navigateSpaVerified("/admin/members");

  const total = pages.reduce((s, p) => s + p.labels.length, 0);
  console.log(
    `[autogpt-harvest] DONE — scraped ${total} labels in ${elapsedSec(ctx)}s, timedOut=${timedOut}`,
  );

  if (total === 0) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Quét xong nhưng không lấy được label nào (${elapsedSec(ctx)}s). Kiểm tra: (1) đang ở chatgpt.com/admin, (2) workspace có member, (3) ChatGPT chưa đổi UI hoàn toàn.`,
    };
  }

  return {
    ok: true,
    data: {
      harvest: { locale, pages },
      total,
      elapsed_sec: elapsedSec(ctx),
      timed_out: timedOut,
    },
  };
}
