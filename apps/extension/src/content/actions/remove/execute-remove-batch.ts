import type { ExecuteActionResponse } from "../../../shared/messages";
import { reportProgress } from "../../progress";
import { executeRemove } from "./execute-remove";

const LOG = "[autogpt-remove-batch]";

/** Kết quả gỡ của MỘT email trong mẻ — background tách ra để báo về đúng lệnh của nó. */
export type BatchRemoveResult = {
  email: string;
  ok: boolean;
  /** Có bằng chứng member đã rời ChatGPT không (backend chỉ mark removed khi true). */
  verified?: boolean;
  /** Không có trong tab "Người dùng" và đã tự chứng minh ô lọc còn sống. */
  absent?: boolean;
  /** Gỡ được nhờ thu hồi lời mời chờ (fallback tab "Lời mời"). */
  via_revoke?: boolean;
  error_code?: string;
  error_message?: string;
};

/**
 * Lỗi thuộc về CẢ TRANG chứ không riêng một email — gặp là dừng mẻ ngay, mọi
 * lệnh còn lại trong mẻ nhận cùng lỗi này (chạy tiếp cũng chỉ hỏng y hệt, mà
 * mỗi lần thử lại tốn ~1 phút của ô tab).
 */
const PAGE_LEVEL_ERRORS = new Set(["PAGE_NOT_ADMIN", "NOT_LOGGED_IN_CHATGPT"]);

/**
 * GỠ NHIỀU EMAIL trong một lượt gọi content (mẻ gộp — xem
 * `apps/api/app/services/task_merge.py`).
 *
 * Không có gì "hàng loạt" trong thao tác trên ChatGPT: tab "Người dùng" gỡ từng
 * người một (lọc email → menu "..." → xác nhận → chờ biến mất). Cái tiết kiệm
 * được là phần CỐ ĐỊNH của mỗi lệnh: mở/F5 tab admin, chờ SPA render, chuyển về
 * sub-tab Người dùng, nhịp rate-limit giữa hai lệnh. Với năm lệnh gỡ, phần đó
 * lặp năm lần thành một.
 *
 * Mỗi email chạy ĐỘC LẬP: một email hỏng KHÔNG kéo theo email khác, vì mỗi email
 * ứng với một lệnh riêng ở backend và số phận (giữ `active` hay mark `removed`)
 * phải được chốt riêng. Chỉ lỗi cấp TRANG mới cắt cả mẻ.
 */
export async function executeRemoveBatch(
  taskId: string,
  emails: string[],
): Promise<ExecuteActionResponse> {
  const list = emails.map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) {
    return {
      ok: false,
      error_code: "UNKNOWN",
      error_message: "Mẻ gỡ rỗng (không có email nào).",
    };
  }

  const results: BatchRemoveResult[] = [];
  for (let i = 0; i < list.length; i++) {
    const email = list[i];
    await reportProgress(
      taskId,
      {
        phase: "batch-remove",
        message: `Gỡ ${email} (${i + 1}/${list.length})...`,
        current: i,
        total: list.length,
      },
      true,
    );
    let resp: ExecuteActionResponse;
    try {
      resp = await executeRemove(taskId, email);
    } catch (e) {
      resp = {
        ok: false,
        error_code: "UNKNOWN",
        error_message: e instanceof Error ? e.message : String(e),
      };
    }
    if (resp.ok) {
      const data = (resp.data ?? {}) as Record<string, unknown>;
      results.push({
        email,
        ok: true,
        verified: data.verified === true,
        absent: data.absent === true,
        via_revoke: data.via_revoke === true,
      });
      console.log(`${LOG} ${email}: OK (${i + 1}/${list.length})`);
      continue;
    }
    results.push({
      email,
      ok: false,
      error_code: resp.error_code,
      error_message: resp.error_message,
    });
    console.warn(`${LOG} ${email}: ${resp.error_code} — ${resp.error_message}`);
    if (PAGE_LEVEL_ERRORS.has(resp.error_code)) {
      // Trang không dùng được nữa → những email chưa chạy cũng chịu chung số
      // phận, ghi rõ lý do thay vì để chúng không có kết quả nào.
      for (const rest of list.slice(i + 1)) {
        results.push({
          email: rest,
          ok: false,
          error_code: resp.error_code,
          error_message:
            `Mẻ gỡ dừng ở ${email} vì lỗi cấp trang (${resp.error_code}): ` +
            `${resp.error_message}`,
        });
      }
      break;
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log(`${LOG} xong mẻ ${list.length} email: ${okCount} OK, ${list.length - okCount} hỏng`);
  // ok:true = "mẻ đã chạy", KHÔNG phải "mọi email đều gỡ được". Kết luận từng
  // email nằm trong `results` — background tách ra báo về từng lệnh.
  return { ok: true, data: { batch: true, results, total: list.length, ok_count: okCount } };
}
