/**
 * MẺ GỘP — tách kết quả của một lượt chạy thành kết quả CỦA TỪNG LỆNH.
 *
 * Backend (`apps/api/app/services/task_merge.py`) có thể trả về một lệnh kèm
 * `payload.merged_tasks` = danh sách các lệnh CÙNG LOẠI, cùng workspace, đang chờ
 * được chạy chung một lượt (ba lời mời gộp thành một lần mở hộp mời, năm lệnh gỡ
 * gộp thành một lần vào tab "Người dùng"…).
 *
 * Nguyên tắc bất di bất dịch: **gộp là chuyện của lúc CHẠY, không phải lúc BÁO
 * KẾT QUẢ.** Ở backend, tiền đi theo từng lệnh (giao dịch ví trỏ vào `queue_item`),
 * bản ghi lời mời cũng gắn với lệnh sinh ra nó — nên mỗi lệnh phải nhận đúng phần
 * kết quả của riêng nó, y như khi nó chạy một mình. Toàn bộ máy móc hoàn phí /
 * dọn bản ghi ma / mark removed ở `queue/completion.py` nhờ vậy không phải biết
 * mẻ gộp là gì.
 *
 * File này chỉ chứa hàm THUẦN (có test) — phần điều khiển tab/HTTP nằm ở
 * `runner.ts`.
 */

import type { ExecuteActionResponse } from "../shared/messages";
import type { QueueItem } from "../shared/types";

/** Một lệnh trong mẻ + phần email thuộc về nó. */
export type MergedTask = { id: string; emails: string[] };

/**
 * Đọc danh sách mẻ từ payload backend gửi kèm.
 *
 * Trả mảng RỖNG khi không phải mẻ gộp (không có trường, sai kiểu, hoặc chỉ có
 * đúng một lệnh) → caller đi đường cũ, không rẽ nhánh gì thêm.
 */
export function readMergedTasks(
  payload: Record<string, unknown> | undefined | null,
): MergedTask[] {
  const raw = (payload ?? {}).merged_tasks;
  if (!Array.isArray(raw) || raw.length <= 1) return [];
  const out: MergedTask[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || !e.id) continue;
    const emails = Array.isArray(e.emails)
      ? e.emails
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean)
      : [];
    out.push({ id: e.id, emails });
  }
  return out.length > 1 ? out : [];
}

/**
 * Bản sao của task cho MỘT lệnh trong mẻ: giữ nguyên loại/workspace/payload,
 * chỉ đổi `id` và thu hẹp phần email về đúng của lệnh đó.
 *
 * `email` (số ít) bị bỏ hẳn để không còn hai nguồn email chỏi nhau trong payload.
 */
export function taskForMergedEntry(task: QueueItem, entry: MergedTask): QueueItem {
  const payload: Record<string, unknown> = { ...(task.payload ?? {}) };
  delete payload.email;
  delete payload.merged_tasks;
  payload.emails = entry.emails;
  return { ...task, id: entry.id, payload };
}

/** Mã lỗi hợp lệ của `ExecuteActionResponse`; lạ/thiếu → "UNKNOWN". */
type ErrorCode = Extract<ExecuteActionResponse, { ok: false }>["error_code"];

const ERROR_CODES: readonly string[] = [
  "UI_ELEMENT_NOT_FOUND",
  "MEMBER_NOT_IN_WORKSPACE",
  "NOT_LOGGED_IN_CHATGPT",
  "TIMEOUT",
  "VERIFY_FAILED",
  "REMOVE_VERIFY_FAILED",
  "PAGE_NOT_ADMIN",
  "FAILED_UI_CHANGED",
  "LANGUAGE_MISMATCH",
  "CONTENT_NOT_INJECTED",
  "CONTENT_TIMEOUT",
  "STALE_BUILD",
  "EXTERNAL_TOGGLE_FAILED",
  "NOT_ENOUGH_SEATS",
  "SEAT_LOCK_REQUIRED",
  "SEAT_RELOAD_FAILED",
  "UNKNOWN",
];

export function errorCodeOf(v: unknown): ErrorCode {
  return (typeof v === "string" && ERROR_CODES.includes(v) ? v : "UNKNOWN") as ErrorCode;
}

function lowerList(v: unknown): string[] {
  return Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean)
    : [];
}

/** Lọc danh sách email, giữ THỨ TỰ gốc, chỉ giữ email thuộc lệnh này. */
function keepEmails(v: unknown, mine: Set<string>): string[] {
  return lowerList(v).filter((e) => mine.has(e));
}

/** Lọc mảng bản ghi member (mỗi phần tử có trường `email`). */
function keepRows(v: unknown, mine: Set<string>): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.filter((row): row is Record<string, unknown> => {
    if (!row || typeof row !== "object") return false;
    const email = (row as Record<string, unknown>).email;
    return typeof email === "string" && mine.has(email.trim().toLowerCase());
  });
}

/**
 * Phần kết quả thuộc về `entry` trong kết quả chung của cả mẻ.
 *
 * Lỗi CẢ MẺ (`ok:false`) đi nguyên vẹn xuống mọi lệnh: mẻ hỏng trước khi làm được
 * gì thì mọi lệnh trong đó đều hỏng y hệt như khi chạy riêng — backend tự lo phần
 * hoàn phí/hoãn phán xử cho từng lệnh theo đúng luật sẵn có.
 */
export function splitResponseForTask(
  type: QueueItem["type"],
  entry: MergedTask,
  response: ExecuteActionResponse,
): ExecuteActionResponse {
  if (!response.ok) return response;
  const data = (response.data ?? {}) as Record<string, unknown>;
  const mine = new Set(entry.emails);

  if (type === "REMOVE_MEMBER") {
    // Mẻ gỡ trả `results` từng email (execute-remove-batch.ts). Lệnh nào không có
    // dòng kết quả của mình thì KHÔNG được coi là xong — thà báo hỏng (member giữ
    // nguyên `active`, tick sau thử lại) còn hơn mark removed mà chưa ai gỡ.
    const results = Array.isArray(data.results)
      ? (data.results as Array<Record<string, unknown>>)
      : null;
    if (!results) return response; // lệnh gỡ lẻ (một email) — dạng data cũ.
    const email = entry.emails[0];
    const row = results.find(
      (r) =>
        typeof r?.email === "string" && r.email.trim().toLowerCase() === email,
    );
    if (!row) {
      return {
        ok: false,
        error_code: "VERIFY_FAILED",
        error_message:
          `Mẻ gỡ gộp không trả kết quả cho ${email} (mẻ có ` +
          `${results.length} dòng kết quả). Giữ nguyên thành viên, sẽ thử lại.`,
      };
    }
    if (row.ok === true) {
      return {
        ok: true,
        data: {
          email,
          verified: row.verified === true,
          ...(row.absent === true ? { absent: true } : {}),
          ...(row.via_revoke === true ? { via_revoke: true } : {}),
          merged_batch: true,
        },
      };
    }
    return {
      ok: false,
      error_code: errorCodeOf(row.error_code),
      error_message:
        typeof row.error_message === "string"
          ? row.error_message
          : `Gỡ ${email} thất bại trong mẻ gộp.`,
    };
  }

  if (type === "REVOKE_INVITES") {
    if (!Array.isArray(data.results)) return response;
    return {
      ok: true,
      data: { ...data, results: keepRows(data.results, mine), merged_batch: true },
    };
  }

  if (type === "INVITE_MEMBER") {
    const out: Record<string, unknown> = { ...data, merged_batch: true };
    if (data.emails !== undefined) out.emails = keepEmails(data.emails, mine);
    if (data.verified_emails !== undefined) {
      out.verified_emails = keepEmails(data.verified_emails, mine);
    }
    if (data.unverified_emails !== undefined) {
      out.unverified_emails = keepEmails(data.unverified_emails, mine);
    }
    if (data.pending_members !== undefined) {
      out.pending_members = keepRows(data.pending_members, mine);
    }
    if (typeof out.count === "number") out.count = entry.emails.length;
    return { ok: true, data: out };
  }

  return response;
}
