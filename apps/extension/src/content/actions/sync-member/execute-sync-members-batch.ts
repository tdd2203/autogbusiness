import type { ExecuteActionResponse } from "../../../shared/messages";
import { reportProgress } from "../../progress";
import { TEXT_FALLBACKS } from "../../selectors";
import { locateMemberRow } from "../remove/locate-member";
import { clickTabAndWait } from "../sync";
import { scrapeCurrentTab } from "../sync/scrape-current-tab";

const LOG = "[autogpt-sync-batch]";

type FoundIn = "pending" | "active" | "none";

/** Ngân sách tổng cho cả action (backstop nội bộ, nhỏ hơn CONTENT_TIMEOUTS ở runner). */
const BATCH_BUDGET_MS = 4 * 60 * 1000;
/** Trần thời gian riêng cho bước quét tab "Lời mời" (phần còn lại dành cho check active). */
const PENDING_SCRAPE_BUDGET_MS = 2 * 60 * 1000;

/**
 * "Đồng bộ hàng loạt" — kiểm tra 1 DANH SÁCH email pending đã tham gia chưa,
 * bằng ĐÚNG MỘT lượt quét mỗi tab (thay cho fan-out N task SYNC_MEMBER, mỗi task
 * lại quay về tab "Lời mời" quét lại từ đầu — thừa, user report 2026-07-06).
 *
 * Luồng (khớp thuật toán user):
 *   1. Vào tab "Lời mời đang chờ xử lý" → quét TOÀN BỘ list 1 lần (scrapeCurrentTab
 *      tự lật trang nếu >1 trang; dưới 1 trang thì 1 lượt là đủ) → build pendingSet.
 *   2. Đối chiếu danh sách email với pendingSet: email nào có → found_in="pending".
 *   3. Các email CÒN LẠI (không khớp pending) → sang tab "Người dùng" kiểm tra
 *      từng email bằng ô lọc (locateMemberRow, pageThrough=false — ô lọc là nguồn
 *      sự thật, KHÔNG lật hết trang cho từng email). Thấy → "active" (đã tham
 *      gia); không thấy → "none".
 *
 * An toàn dữ liệu: "none" chỉ để BÁO (backend completion KHÔNG mark removed — xem
 * completion.py), nên một lần quét sót/timeout chỉ làm KHÔNG promote chứ không xoá
 * oan. "pending" ưu tiên hơn "none" (đã thấy trong pending thì không cần check active).
 *
 * READ-ONLY: chỉ scroll/lọc/đọc DOM. Trả ok:true kèm results per-email. Chỉ trả
 * ok:false khi KHÔNG vào được CẢ tab Lời mời LẪN tab Người dùng (không đủ căn cứ).
 */
export async function executeSyncMembersBatch(
  taskId: string,
  emails: string[],
): Promise<ExecuteActionResponse> {
  const targets = [
    ...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean)),
  ];
  console.log(`${LOG} START ${targets.length} email path=${location.pathname}`);

  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}). Mở chatgpt.com/admin/members trước.`,
    };
  }
  if (targets.length === 0) {
    return { ok: true, data: { results: [] } };
  }

  const startedAt = Date.now();
  const results = new Map<string, FoundIn>();

  // ----- Bước 1: quét TOÀN BỘ tab "Lời mời đang chờ xử lý" 1 lần -----
  await reportProgress(
    taskId,
    {
      phase: "searching",
      message: `Quét tab Lời mời đang chờ xử lý để đối chiếu ${targets.length} email...`,
    },
    true,
  );
  const pendingSet = new Set<string>();
  const onPending = await clickTabAndWait(
    "tab_pending_invites",
    TEXT_FALLBACKS.tabPendingInvites,
    1500,
    "tab=invites",
    12_000,
  );
  if (onPending) {
    const pendingDeadline = startedAt + PENDING_SCRAPE_BUDGET_MS;
    const { members } = await scrapeCurrentTab(
      taskId,
      "pending",
      "Lời mời",
      () => Date.now() > pendingDeadline,
    );
    for (const m of members) pendingSet.add(m.email.toLowerCase());
    console.log(`${LOG} tab Lời mời: quét được ${pendingSet.size} email`);
  } else {
    console.warn(
      `${LOG} không vào được tab Lời mời — mọi email sẽ kiểm tra ở tab Người dùng`,
    );
  }

  // ----- Bước 2: đối chiếu list với pendingSet -----
  const remaining: string[] = [];
  for (const email of targets) {
    if (pendingSet.has(email)) results.set(email, "pending");
    else remaining.push(email);
  }
  console.log(
    `${LOG} đối chiếu: ${targets.length - remaining.length} pending, ${remaining.length} cần check tab Người dùng`,
  );

  // ----- Bước 3: email không khớp pending → kiểm tra tab "Người dùng" 1 lượt -----
  if (remaining.length > 0) {
    await reportProgress(
      taskId,
      {
        phase: "searching",
        message: `Kiểm tra ${remaining.length} email còn lại ở tab Người dùng...`,
        current: targets.length - remaining.length,
        total: targets.length,
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
      // Không vào được tab Người dùng. Nếu tab Lời mời cũng không vào được →
      // không đủ căn cứ kết luận gì → FAILED rõ ràng (tránh báo sai hàng loạt).
      if (!onPending) {
        return {
          ok: false,
          error_code: "UI_ELEMENT_NOT_FOUND",
          error_message:
            "Không vào được cả tab Lời mời lẫn tab Người dùng để đối chiếu. Mở chatgpt.com/admin/members và thử lại.",
        };
      }
      // Vào được Lời mời nhưng không sang được Người dùng → các email còn lại
      // chưa xác minh được: coi là "none" (backend KHÔNG mark removed) — an toàn.
      console.warn(
        `${LOG} không sang được tab Người dùng — ${remaining.length} email còn lại để "none"`,
      );
      for (const email of remaining) results.set(email, "none");
    } else {
      for (const email of remaining) {
        if (Date.now() - startedAt > BATCH_BUDGET_MS) {
          console.warn(
            `${LOG} hết ngân sách ${BATCH_BUDGET_MS}ms — email còn lại để "none" (sẽ đối chiếu ở lần sau)`,
          );
          for (const rest of remaining) {
            if (!results.has(rest)) results.set(rest, "none");
          }
          break;
        }
        const row = await locateMemberRow(email, { pageThrough: false });
        results.set(email, row ? "active" : "none");
        console.log(
          `${LOG} tab Người dùng: ${email} → ${row ? "active (đã tham gia)" : "none"}`,
        );
      }
    }
  }

  const resultsArr = targets.map((email) => ({
    email,
    found_in: results.get(email) ?? "none",
  }));
  const activeCount = resultsArr.filter((r) => r.found_in === "active").length;
  const pendingCount = resultsArr.filter((r) => r.found_in === "pending").length;
  console.log(
    `${LOG} DONE: ${activeCount} active, ${pendingCount} pending, ${resultsArr.length - activeCount - pendingCount} none (${Date.now() - startedAt}ms)`,
  );

  await reportProgress(
    taskId,
    {
      phase: "verifying",
      message: `Xong: ${activeCount} đã tham gia, ${pendingCount} vẫn chờ, ${resultsArr.length - activeCount - pendingCount} không thấy.`,
      current: targets.length,
      total: targets.length,
    },
    true,
  );

  return { ok: true, data: { results: resultsArr } };
}
