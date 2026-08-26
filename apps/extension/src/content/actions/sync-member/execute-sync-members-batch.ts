import type { ExecuteActionResponse } from "../../../shared/messages";
import { reportProgress } from "../../progress";
import { TEXT_FALLBACKS } from "../../selectors";
import { clearMemberFilter, filterLookupOnce } from "../remove/member-filter";
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
 * Luồng: vào tab "Người dùng" ĐÚNG 1 lần → tìm TỪNG email bằng ô search, MỖI
 * EMAIL GÕ ĐÚNG 1 LẦN (`filterLookupOnce`). Thấy → active; ô lọc chạy xong mà
 * không có row → pending.
 *
 * GÕ 1 LẦN (user 2026-08-26): bản trước dùng `filterAndFindRow`, hễ miss là clear
 * ô lọc rồi gõ lại email lần hai. Mẻ "kiểm tra đã tham gia" thì gần như email nào
 * cũng miss (đang chờ tham gia = chưa có ở tab Người dùng) nên lần gõ thứ hai chỉ
 * lặp lại đúng kết quả cũ, đốt thêm ~4s/email. `filterLookupOnce` thay "gõ lại
 * cho chắc" bằng ĐỌC BẰNG CHỨNG: list có render lại theo query hay không. Chỉ khi
 * list đứng im như tờ (query bị Chrome throttle nuốt ở tab nền) nó mới gõ lại —
 * và từ email thứ hai trở đi, ô lọc đã tự chứng minh còn sống ở email trước
 * (`filterProvenAlive`) nên không cần cả lần gõ đó.
 *
 * Email nào ô lọc KHÔNG kết luận được thì KHÔNG có mặt trong `results` — thà thiếu
 * còn hơn báo "chưa tham gia" oan cho người đã tham gia. Backend chỉ reconcile
 * đúng những email được trả về.
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
  // Ô lọc đã PHẢN HỒI query ít nhất một lần trong mẻ này ⇒ nó còn sống ⇒ từ đây
  // "gõ xong list vẫn trống" là kết quả thật, không phải query bị nuốt.
  let filterProvenAlive = false;
  // Tab Người dùng không có ô lọc → quay về đường quét cũ (scroll-scan) cho cả mẻ.
  let noFilterBox = false;
  const unresolved: string[] = [];

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

    let foundIn: FoundIn | null = null;
    if (!noFilterBox) {
      const lookup = await filterLookupOnce(email, {
        assumeFilterAlive: filterProvenAlive,
      });
      if (lookup.filterResponded) filterProvenAlive = true;
      if (lookup.outcome === "found") foundIn = "active";
      else if (lookup.outcome === "absent") foundIn = "pending";
      else if (lookup.reason === "no_filter_input") {
        console.warn(`${LOG} tab Người dùng KHÔNG có ô lọc → quét vị trí như cũ`);
        noFilterBox = true;
      } else {
        console.warn(
          `${LOG} ${email}: ô lọc không kết luận được (${lookup.reason}) → BỎ QUA, không báo pending oan`,
        );
      }
    }
    if (foundIn === null && noFilterBox) {
      const row = await locateMemberRow(email, {
        pageThrough: false,
        preferFilter: true,
      });
      foundIn = row ? "active" : "pending";
    }

    if (foundIn) {
      results.set(email, foundIn);
      console.log(
        `${LOG} ${email} → ${foundIn === "active" ? "active (đã tham gia)" : "pending (chưa tham gia)"}`,
      );
    } else {
      unresolved.push(email);
    }
    await reportProgress(taskId, {
      phase: "searching",
      current: i + 1,
      total: targets.length,
      message: `Đã kiểm ${i + 1}/${targets.length} email`,
    });
  }

  // Trả ô "Lọc theo tên" về rỗng để không để tab ChatGPT kẹt ở kết quả lọc email cuối.
  await clearMemberFilter();

  // CHỈ trả email đã kết luận được. Email "inconclusive" (ô lọc không chạy) mà
  // trả 'pending' thì backend giữ nguyên trạng thái chờ cho người ĐÃ tham gia —
  // đúng cái lỗi "đồng bộ mấy lần vẫn còn pending" trước đây.
  const resultsArr = targets
    .filter((email) => results.has(email))
    .map((email) => ({ email, found_in: results.get(email) as FoundIn }));
  const activeCount = resultsArr.filter((r) => r.found_in === "active").length;
  const pendingCount = resultsArr.length - activeCount;
  console.log(
    `${LOG} DONE: ${activeCount} đã tham gia, ${pendingCount} chưa tham gia` +
      (unresolved.length ? `, ${unresolved.length} không kết luận được` : "") +
      ` (${Date.now() - startedAt}ms)`,
  );

  if (resultsArr.length === 0) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        `Ô "Lọc theo tên" của tab Người dùng không phản hồi — không kiểm được email nào ` +
        `trong ${targets.length} email. Mở chatgpt.com/admin/members và thử lại.`,
    };
  }

  await reportProgress(
    taskId,
    {
      phase: "verifying",
      message:
        `Xong: ${activeCount} đã tham gia, ${pendingCount} chưa tham gia` +
        (unresolved.length ? `, ${unresolved.length} chưa kiểm được.` : "."),
      current: targets.length,
      total: targets.length,
    },
    true,
  );

  return { ok: true, data: { results: resultsArr } };
}
