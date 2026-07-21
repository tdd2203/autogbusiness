import type { ExecuteActionResponse } from "../../../shared/messages";
import { reportProgress } from "../../progress";
import { TEXT_FALLBACKS } from "../../selectors";
import { clearMemberFilter } from "../remove/member-filter";
import { locateMemberRow } from "../remove/locate-member";
import { clickTabAndWait } from "../sync";

const LOG = "[autogpt-sync-batch]";

type FoundIn = "active" | "pending";

/** Ngân sách tổng cho cả action (backstop nội bộ, nhỏ hơn CONTENT_TIMEOUTS ở runner). */
const BATCH_BUDGET_MS = 4 * 60 * 1000;

/**
 * "Đồng bộ hàng loạt (kiểm tra đã tham gia)" — logic MỚI (user 2026-07-15), ĐƠN GIẢN.
 *
 * KHÔNG quét tab "Lời mời đang chờ xử lý" nữa. Lý do: lời mời đã được xác minh
 * THÀNH CÔNG ngay lúc mời (invite → check lời mời → verify), nên 1 email đang
 * "chờ tham gia" chỉ có đúng 2 khả năng:
 *   - ĐÃ tham gia  → xuất hiện ở tab "Người dùng"  → found_in="active"
 *   - CHƯA tham gia → KHÔNG có ở tab "Người dùng"   → found_in="pending" (giữ nguyên)
 *
 * Luồng: vào tab "Người dùng" ĐÚNG 1 lần → tìm TỪNG email bằng ô search
 * (`locateMemberRow` pageThrough=false — ô search là nguồn sự thật, không lật hết
 * trang cho từng email). Thấy → active; không thấy → pending.
 *
 * Bỏ hẳn khái niệm "none" + mọi thao tác tab Lời mời (scrape đếm-số-lượng cũ hay
 * sót row khi list virtualized → báo sai). Đơn giản = tin cậy.
 *
 * READ-ONLY: chỉ lọc/đọc DOM. Trả ok:true kèm results per-email. Chỉ trả ok:false
 * khi KHÔNG vào được tab "Người dùng" (không đủ căn cứ kết luận).
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

  // ----- Vào tab "Người dùng" 1 lần -----
  await reportProgress(
    taskId,
    {
      phase: "searching",
      message: `Tìm ${targets.length} email ở tab Người dùng...`,
      current: 0,
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
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        "Không vào được tab Người dùng để kiểm tra. Mở chatgpt.com/admin/members và thử lại.",
    };
  }

  // ----- Tìm từng email bằng ô search của tab "Người dùng" -----
  for (let i = 0; i < targets.length; i++) {
    const email = targets[i];
    if (Date.now() - startedAt > BATCH_BUDGET_MS) {
      console.warn(
        `${LOG} hết ngân sách ${BATCH_BUDGET_MS}ms — email còn lại để "pending" (đồng bộ lại lần sau)`,
      );
      for (const rest of targets) {
        if (!results.has(rest)) results.set(rest, "pending");
      }
      break;
    }
    const row = await locateMemberRow(email, {
      pageThrough: false,
      preferFilter: true,
    });
    results.set(email, row ? "active" : "pending");
    console.log(
      `${LOG} ${email} → ${row ? "active (đã tham gia)" : "pending (chưa tham gia)"}`,
    );
    await reportProgress(taskId, {
      phase: "searching",
      current: i + 1,
      total: targets.length,
      message: `Đã kiểm ${i + 1}/${targets.length} email`,
    });
  }

  // Trả ô "Lọc theo tên" về rỗng để không để tab ChatGPT kẹt ở kết quả lọc email cuối.
  await clearMemberFilter();

  const resultsArr = targets.map((email) => ({
    email,
    found_in: results.get(email) ?? "pending",
  }));
  const activeCount = resultsArr.filter((r) => r.found_in === "active").length;
  const pendingCount = resultsArr.length - activeCount;
  console.log(
    `${LOG} DONE: ${activeCount} đã tham gia, ${pendingCount} chưa tham gia (${Date.now() - startedAt}ms)`,
  );

  await reportProgress(
    taskId,
    {
      phase: "verifying",
      message: `Xong: ${activeCount} đã tham gia, ${pendingCount} chưa tham gia.`,
      current: targets.length,
      total: targets.length,
    },
    true,
  );

  return { ok: true, data: { results: resultsArr } };
}
