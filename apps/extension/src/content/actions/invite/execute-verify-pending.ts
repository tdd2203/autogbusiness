import type {
  ExecuteActionResponse,
  ChatGPTRole,
} from "../../../shared/messages";
import { sleep } from "../../human";
import { reportProgress } from "../../progress";
import { scrapePendingInvitesAfterInvite } from "../sync";
import { verifyPendingViaFilter } from "./verify-pending-via-filter";
import { waitForPendingListStable } from "./wait-for-pending-list-stable";

/**
 * Phase 2 của INVITE_MEMBER — chạy SAU khi background đã F5 tab admin.
 * Page hiện tại đã fresh (không cache React Query), pending list chắc chắn
 * load từ server. Chỉ cần navigate tới /admin/members?tab=invites + scrape.
 *
 * v0.7.15 (2026-06-17): mục tiêu user "giảm thời gian chờ F5 verify còn ~10s".
 * Bỏ `sleep(2500)` cố định + vòng retry delay nội bộ `[0,3000,6000]`. Thay bằng:
 *   1. poll DOM tới khi list render xong / thấy đủ email (return NGAY khi thấy).
 *   2. scrape MỘT lần.
 *   3. nếu còn email chưa thấy (scrape OK) → trả `needs_reload_retry: true`.
 * Background (runner) tự F5 THẬT lại + gọi lại Phase 2 trong ngân sách 10s —
 * ép ChatGPT re-fetch từ server (mạnh hơn bounce tab vốn dễ serve cache stale).
 */
export async function executeVerifyPendingInvite(
  taskId: string,
  emails: string[],
  role: ChatGPTRole,
): Promise<ExecuteActionResponse> {
  console.log(
    `[autogpt-invite-verify] START: ${emails.length} email(s) role=${role} pathname=${location.pathname}${location.search}`,
  );

  // Defensive: nếu vì lý do gì đó (Step 3 NUCLEAR recreate tab) URL không
  // ở /admin/members → navigate qua sidebar / pushState.
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
    await sleep(1500);
  }

  // v0.7.15: thay sleep(2500) cố định bằng poll render-aware. Trả về NGAY khi
  // đủ email vừa mời đã hiện trong DOM (fast path ~sub-second), hoặc tối đa 4s
  // khi list đã render xong (stable) mà chưa thấy đủ. Không treo budget 10s.
  await waitForPendingListStable(emails, 4000);

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

  const invitedLower = emails.map((e) => e.toLowerCase());
  let scrapeFailed = false;
  let scrapedPending: Awaited<
    ReturnType<typeof scrapePendingInvitesAfterInvite>
  > = [];
  try {
    // FAST PATH (v0.8.6): dùng ô "Lọc theo tên" để gõ thẳng từng email vừa mời
    // → list rút còn 0-1 row → đọc ngay. KHÔNG đọc toàn bộ email / KHÔNG lật
    // trang. Nhanh hơn nhiều lần khi pending list dài.
    const viaFilter = await verifyPendingViaFilter(emails);
    if (viaFilter !== null) {
      scrapedPending = viaFilter;
      console.log(
        `[autogpt-invite-verify] filter fast-path: ${scrapedPending.length}/${emails.length} email thấy`,
      );
    } else {
      // Ô lọc không khả dụng (UI đổi / chưa render) → fallback scrape full.
      // forceReload=false: page vừa F5 từ background → DOM đã fresh, KHÔNG bounce
      // tab (bounce serve React Query cache stale). Re-fetch thật = F5 vòng sau.
      console.warn(
        "[autogpt-invite-verify] ô lọc không dùng được → fallback scrape full",
      );
      scrapedPending = await scrapePendingInvitesAfterInvite(taskId, false);
      console.log(
        `[autogpt-invite-verify] scraped ${scrapedPending.length} pending invite(s)`,
      );
    }
  } catch (e) {
    scrapeFailed = true;
    console.warn(`[autogpt-invite-verify] scrape FAILED:`, e);
  }

  const scrapedEmailSet = new Set(
    scrapedPending.map((m) => m.email.toLowerCase()),
  );
  const verifiedEmails = invitedLower.filter((e) => scrapedEmailSet.has(e));
  const unverifiedEmails = invitedLower.filter((e) => !scrapedEmailSet.has(e));
  const pendingMembersForUpsert = scrapedPending.filter((m) =>
    invitedLower.includes(m.email.toLowerCase()),
  );

  // Còn email chưa thấy mà scrape OK → đề nghị background F5 reload lần nữa (ép
  // ChatGPT re-fetch từ server, phòng backend index pending list chậm 1-5s).
  // scrapeFailed → KHÔNG retry (reload nữa cũng không scrape được, fallback giữ data).
  const needsReloadRetry = !scrapeFailed && unverifiedEmails.length > 0;

  console.log(
    `[autogpt-invite-verify] RESULT: ${verifiedEmails.length}/${emails.length} email confirmed in pending tab`,
    { verified: verifiedEmails, unverified: unverifiedEmails, scrapeFailed, needsReloadRetry },
  );

  await reportProgress(
    taskId,
    {
      phase: "mapping",
      message: scrapeFailed
        ? `Verify FAILED (không scrape được tab Lời mời). Đã invite ${emails.length} email.`
        : needsReloadRetry
          ? `Verified ${verifiedEmails.length}/${emails.length} — còn ${unverifiedEmails.length} email, F5 lại để ChatGPT load tiếp...`
          : `Verified ${verifiedEmails.length}/${emails.length} email trong tab Lời mời.`,
      current: verifiedEmails.length,
      total: emails.length,
    },
    true,
  );

  // LUÔN trả ok:true kèm verified/unverified — KHÔNG tự quyết success/fail ở đây.
  // Runner (background) sẽ: (1) F5 lại nếu needs_reload_retry còn trong budget,
  // (2) upsert verified, (3) gọi reconcile-after-invite để DỌN các email
  // unverified (scrape OK) khỏi dashboard, (4) đánh dấu task FAILED nếu 0 email
  // verified (scrape OK).
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
      needs_reload_retry: needsReloadRetry,
    },
  };
}
