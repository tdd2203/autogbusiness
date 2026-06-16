import type {
  ExecuteActionResponse,
  ChatGPTRole,
} from "../../../shared/messages";
import { sleep } from "../../human";
import { reportProgress } from "../../progress";
import { scrapePendingInvitesAfterInvite } from "../sync";

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
    `[autogpt-invite-verify] START: ${emails.length} email(s) role=${role} pathname=${location.pathname}${location.search}`,
  );

  // v0.6.6: sau F5 ở URL /admin/members?tab=invites, ChatGPT cần thời gian
  // re-fetch + render pending list. Tăng wait 800 → 2500ms để giảm trường
  // hợp scrape miss email vừa mời (user report v0.6.5 "load thiếu").
  await sleep(2500);

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

  // v0.6.6: 3 attempt với delay tăng dần. Sau F5 + Phase 1 đã đợi list stable,
  // attempt 1 thường đủ; attempt 2-3 phòng case ChatGPT index pending list
  // chậm (~5s) hoặc React Query cache warm-up. Break sớm khi tất cả verified.
  // Tăng từ [0, 2500] (v0.6.4-0.6.5) lên [0, 3000, 6000] để xử lý "load
  // thiếu" — user thấy email trên ChatGPT nhưng dashboard miss.
  const RETRY_DELAYS_MS = [0, 3000, 6000];
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

  // LUÔN trả ok:true kèm verified/unverified — KHÔNG tự quyết success/fail ở đây.
  // Runner (background) sẽ: (1) upsert verified, (2) gọi reconcile-after-invite để
  // DỌN các email unverified (scrape OK) khỏi dashboard, (3) đánh dấu task FAILED
  // nếu 0 email verified (scrape OK). Trước đây early-return ok:false làm runner
  // nhảy vào nhánh FAILED → BỎ QUA bước dọn phantom → email không có trong tab
  // 'Lời mời' vẫn hiển thị "đang chờ" trên dashboard (bug user report).
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
