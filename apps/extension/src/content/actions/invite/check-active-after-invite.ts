import type { ExecuteActionResponse, ScrapedMember } from "../../../shared/messages";
import { reportProgress } from "../../progress";
import { TEXT_FALLBACKS } from "../../selectors";
import { locateMemberRow } from "../remove/locate-member";
import { clickTabAndWait } from "../sync";
import { scrapeAllRows } from "../sync/scrape-all-rows";

const LOG = "[autogpt-invite-active]";

/**
 * Phase 2b của INVITE_MEMBER — chạy SAU khi verify tab "Lời mời" đã kết luận còn
 * email KHÔNG thấy trong pending (scrape OK). Trước đây mọi email như vậy bị coi
 * là "phantom" → backend mark 'removed'. Nhưng một email vừa mời có thể đã được
 * người dùng CHẤP NHẬN NHANH → rời tab "Lời mời", sang thẳng tab "Người dùng"
 * (active). Bước này kiểm tra CHÍNH các email đó ở tab "Người dùng" để không xoá
 * oan (user report: lần đồng bộ lời mời mới nhất xoá nhầm email đã tham gia).
 *
 * Chỉ đọc tab "Người dùng" (không đụng tab "Lời mời"). Với mỗi email dùng
 * `locateMemberRow(pageThrough=false)` — ô lọc là nguồn sự thật, KHÔNG lật hết
 * trang cho từng email (giống REMOVE / sync-members-batch bước 3). Thấy row →
 * scrape thành ScrapedMember status="active" để runner upsert đúng trạng thái.
 *
 * READ-ONLY. Trả `active_members` (đã tham gia, cần upsert active) + `active_emails`
 * (danh sách email active để runner loại khỏi unverified trước khi reconcile).
 * `ok:false` chỉ khi KHÔNG vào được tab "Người dùng" (không đủ căn cứ — runner
 * giữ nguyên hành vi cũ, benefit-of-doubt).
 */
export async function executeCheckActiveAfterInvite(
  taskId: string,
  emails: string[],
): Promise<ExecuteActionResponse> {
  const targets = [
    ...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean)),
  ];
  console.log(`${LOG} START ${targets.length} email path=${location.pathname}`);

  if (targets.length === 0) {
    return { ok: true, data: { active_members: [], active_emails: [] } };
  }

  await reportProgress(
    taskId,
    {
      phase: "verifying",
      message: `${targets.length} email không thấy ở tab Lời mời — kiểm tra tab Người dùng xem đã tham gia chưa...`,
    },
    true,
  );

  const onActive = await clickTabAndWait(
    "tab_active_members",
    TEXT_FALLBACKS.tabActiveMembers,
    800,
    undefined,
    12_000,
  );
  if (!onActive) {
    console.warn(`${LOG} không vào được tab Người dùng — bỏ qua (giữ nguyên unverified)`);
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: "Không vào được tab Người dùng để kiểm tra email đã tham gia.",
    };
  }

  const activeMembers: ScrapedMember[] = [];
  const activeEmails: string[] = [];
  for (const email of targets) {
    const row = await locateMemberRow(email, { pageThrough: false });
    if (!row) {
      console.log(`${LOG} ${email} → KHÔNG có ở tab Người dùng`);
      continue;
    }
    // Row đang render (ô lọc đã rút gọn) → scrape lấy name/role/license. Nếu vì
    // lý do gì scrapeAllRows bỏ sót, vẫn ghi nhận active với data tối thiểu.
    const scraped = scrapeAllRows().find(
      (m) => m.email.toLowerCase() === email,
    );
    activeMembers.push(
      scraped
        ? { ...scraped, status: "active" }
        : { email, name: null, chatgpt_role: null, license_type: null, status: "active", joined_at: null },
    );
    activeEmails.push(email);
    console.log(`${LOG} ${email} → ĐÃ THAM GIA (active) — sẽ upsert active, không xoá`);
  }

  console.log(
    `${LOG} DONE: ${activeEmails.length}/${targets.length} email đã sang tab Người dùng (active)`,
  );

  return { ok: true, data: { active_members: activeMembers, active_emails: activeEmails } };
}
