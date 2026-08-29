import type { ExecuteActionResponse, ScrapedMember } from "../../../shared/messages";
import { sleep } from "../../human";
import { reportProgress } from "../../progress";
import { TEXT_FALLBACKS } from "../../selectors";
import { locateMemberRow } from "../remove/locate-member";
import { clearMemberFilter, filterLookupOnce } from "../remove/member-filter";
import { clickTabAndWait, DEFAULT_TAB_VERIFY } from "../sync";
import { scrapeAllRows } from "../sync/scrape-all-rows";

const LOG = "[autogpt-invite-active]";

/** Ngân sách nội bộ — nằm gọn trong CONTENT_TIMEOUTS.INVITE_MEMBER (300s). */
const BUDGET_MS = 100_000;
/**
 * Nghỉ giữa 2 email: clear ô lọc rồi chờ list ĐẦY LẠI trước khi gõ email sau
 * (user 2026-08-29: *"các thao tác tìm kiếm thực hiện chậm thôi, để cho nó load
 * tìm xong rồi mới tìm tiếp"*).
 *
 * Không chỉ là "đi chậm cho chắc": gõ email mới lên ĐÚNG kết quả lọc của email
 * cũ thì list vốn đã trống — trống rồi vẫn trống ⇒ `filterLookupOnce` không có
 * gì để nhận ra query đã chạy, phải đoán qua `assumeFilterAlive`. Clear trước
 * làm list đầy lại, nên mỗi lượt tra đều tự có bằng chứng ô lọc còn sống.
 */
const BETWEEN_EMAILS_MS = 900;

/**
 * Phase 2b của INVITE_MEMBER — chạy SAU khi verify tab "Lời mời" đã kết luận còn
 * email KHÔNG thấy trong pending (scrape OK). Trước đây mọi email như vậy bị coi
 * là "phantom" → backend mark 'removed' / hoãn chờ sync. Nhưng một email vừa mời
 * có thể đã được CHẤP NHẬN NGAY (mời nhiều email một lượt thì chuyện này xảy ra
 * thường xuyên) → rời tab "Lời mời", sang thẳng tab "Người dùng" (active). Bước
 * này tra CHÍNH các email đó ở tab "Người dùng" để không xoá oan / hoãn oan.
 *
 * CÁCH TRA (sửa 2026-08-29): dùng `filterLookupOnce` — ĐÚNG cách mà
 * `execute-sync-members-batch` đã dùng — thay cho `locateMemberRow(pageThrough:false)`.
 * Bản cũ sai ở hai chỗ, cùng dẫn tới "đã tham gia mà báo không thấy":
 *   1. `locateMemberRow` thấy tab Người dùng KHÔNG có thanh phân trang (list
 *      virtualized 150+ member thì đúng là không có) là bỏ ô lọc, quay ra
 *      scroll-scan — mà scroll-scan trên list virtualized chỉ thấy vài row gần
 *      đỉnh ⇒ email nằm giữa/cuối coi như không tồn tại.
 *   2. `clickTabAndWait` gọi KHÔNG kèm mốc kiểm chứng URL ⇒ tab admin còn kẹt ở
 *      `?tab=invites` do chính lượt mời vừa rồi để lại thì cú click hụt không ai
 *      biết, và cái "không thấy" ở đây là không thấy trong tab SAI.
 *
 * Mỗi email tra tuần tự, gõ trọn email vào ô lọc, chờ list phản hồi xong mới
 * sang email kế. Email nào ô lọc KHÔNG kết luận nổi thì KHÔNG kể là "không có" —
 * để nguyên trong unverified cho backend xử như cũ.
 *
 * READ-ONLY. Trả `active_members` (đã tham gia, cần upsert active) + `active_emails`
 * (để runner loại khỏi unverified trước khi reconcile) + `inconclusive_emails`
 * (không tra được — chỉ để ghi nhật ký).
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
    return { ok: true, data: { active_members: [], active_emails: [], inconclusive_emails: [] } };
  }

  await reportProgress(
    taskId,
    {
      phase: "verifying",
      message: `${targets.length} email không thấy ở tab Lời mời — tìm ở tab Người dùng xem đã tham gia chưa...`,
      current: 0,
      total: targets.length,
    },
    true,
  );

  // ĐÒI KIỂM CHỨNG URL: tab admin được tái dùng nên `?tab=invites` của chính
  // lượt mời vừa rồi còn nguyên; click hụt mà không soát lại thì mọi kết luận
  // dưới đây là kết luận trên tab Lời mời.
  const onActive = await clickTabAndWait(
    "tab_active_members",
    TEXT_FALLBACKS.tabActiveMembers,
    800,
    DEFAULT_TAB_VERIFY,
    12_000,
  );
  if (!onActive) {
    console.warn(`${LOG} không vào được tab Người dùng — bỏ qua (giữ nguyên unverified)`);
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        `Không vào được tab Người dùng để kiểm tra email đã tham gia ` +
        `(URL hiện tại '${location.search || "(rỗng)"}').`,
    };
  }

  const startedAt = Date.now();
  const activeMembers: ScrapedMember[] = [];
  const activeEmails: string[] = [];
  const inconclusive: string[] = [];
  // Ô lọc đã phản hồi ít nhất một query trong mẻ này ⇒ còn sống.
  let filterProvenAlive = false;
  // Tab Người dùng không có ô lọc → cả mẻ quay về đường quét cũ.
  let noFilterBox = false;

  for (let i = 0; i < targets.length; i++) {
    const email = targets[i];
    if (Date.now() - startedAt > BUDGET_MS) {
      const rest = targets.slice(i);
      console.warn(
        `${LOG} hết ngân sách ${BUDGET_MS}ms — ${rest.length} email chưa tra: giữ nguyên unverified`,
      );
      inconclusive.push(...rest);
      break;
    }

    if (i > 0) {
      // Trả list về đầy đủ rồi mới gõ email kế — xem BETWEEN_EMAILS_MS.
      await clearMemberFilter();
      await sleep(BETWEEN_EMAILS_MS);
    }

    let row: HTMLElement | null = null;
    let resolved = false;
    if (!noFilterBox) {
      const lookup = await filterLookupOnce(email, {
        assumeFilterAlive: filterProvenAlive,
      });
      if (lookup.filterResponded) filterProvenAlive = true;
      if (lookup.outcome === "found") {
        row = lookup.row ?? null;
        resolved = true;
      } else if (lookup.outcome === "absent") {
        resolved = true;
      } else if (lookup.reason === "no_filter_input") {
        console.warn(`${LOG} tab Người dùng KHÔNG có ô lọc → quét vị trí như cũ`);
        noFilterBox = true;
      } else {
        console.warn(
          `${LOG} ${email}: ô lọc không kết luận được (${lookup.reason}) → giữ nguyên unverified`,
        );
      }
    }
    if (!resolved && noFilterBox) {
      // preferFilter=true để KHÔNG rơi vào scroll-scan trên list virtualized;
      // ở nhánh này ô lọc vắng mặt thật nên nó tự scroll-scan best-effort.
      row = await locateMemberRow(email, { pageThrough: false, preferFilter: true });
      resolved = true;
    }

    if (!resolved) {
      inconclusive.push(email);
    } else if (row) {
      // Row đang render (ô lọc đã rút gọn) → scrape lấy name/role/license. Nếu vì
      // lý do gì scrapeAllRows bỏ sót, vẫn ghi nhận active với data tối thiểu.
      const scraped = scrapeAllRows().find((m) => m.email.toLowerCase() === email);
      activeMembers.push(
        scraped
          ? { ...scraped, status: "active" }
          : { email, name: null, chatgpt_role: null, license_type: null, status: "active", joined_at: null },
      );
      activeEmails.push(email);
      console.log(`${LOG} ${email} → ĐÃ THAM GIA (active) — sẽ upsert active, không xoá`);
    } else {
      console.log(`${LOG} ${email} → KHÔNG có ở tab Người dùng`);
    }

    await reportProgress(taskId, {
      phase: "verifying",
      current: i + 1,
      total: targets.length,
      message: `Đã tìm ${i + 1}/${targets.length} email ở tab Người dùng`,
    });
  }

  // Trả ô "Lọc theo tên" về rỗng để không để tab ChatGPT kẹt ở kết quả lọc cuối.
  await clearMemberFilter();

  console.log(
    `${LOG} DONE: ${activeEmails.length}/${targets.length} email đã sang tab Người dùng (active)` +
      (inconclusive.length ? `, ${inconclusive.length} không tra được` : "") +
      ` (${Date.now() - startedAt}ms)`,
  );

  return {
    ok: true,
    data: {
      active_members: activeMembers,
      active_emails: activeEmails,
      inconclusive_emails: inconclusive,
    },
  };
}
