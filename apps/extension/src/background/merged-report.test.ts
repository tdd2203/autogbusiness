/**
 * Mẻ gộp: một lượt chạy, NHIỀU lệnh — mỗi lệnh phải nhận đúng phần kết quả của
 * mình khi báo về backend.
 *
 * Ca đắt nhất là lời mời: nếu email của lệnh A lọt sang kết quả của lệnh B thì
 * backend hoặc chấm thành công oan (giữ tiền của một lời mời chưa từng đi), hoặc
 * hoàn phí + xoá bản ghi của một lời mời ĐÃ đi. Cả hai đều là mất tiền thật, nên
 * phép lọc ở đây phải khoá bằng test.
 */
import { describe, expect, it } from "vitest";

import type { ExecuteActionResponse } from "../shared/messages";
import type { QueueItem } from "../shared/types";
import {
  readMergedTasks,
  splitResponseForTask,
  taskForMergedEntry,
} from "./merged-report";

const A = { id: "task-a", emails: ["a@x.com"] };
const B = { id: "task-b", emails: ["b@x.com", "c@x.com"] };

function inviteTask(payload: Record<string, unknown>): QueueItem {
  return {
    id: "task-a",
    type: "INVITE_MEMBER",
    status: "IN_PROGRESS",
    payload,
    workspace_id: "ws-1",
    created_at: "2026-08-28T00:00:00Z",
    picked_at: null,
  };
}

describe("readMergedTasks", () => {
  it("không có trường merged_tasks → không phải mẻ gộp", () => {
    expect(readMergedTasks({ emails: ["a@x.com"] })).toEqual([]);
    expect(readMergedTasks(undefined)).toEqual([]);
  });

  it("mẻ chỉ có ĐÚNG MỘT lệnh → coi như chạy lẻ (không rẽ nhánh gộp)", () => {
    expect(readMergedTasks({ merged_tasks: [A] })).toEqual([]);
  });

  it("đọc được id + email từng lệnh, hạ chữ thường", () => {
    const out = readMergedTasks({
      merged_tasks: [
        { id: "task-a", emails: ["A@X.com"] },
        { id: "task-b", emails: ["b@x.com", "c@x.com"] },
      ],
    });
    expect(out).toEqual([A, B]);
  });

  it("bỏ phần tử rác (thiếu id / sai kiểu)", () => {
    const out = readMergedTasks({
      merged_tasks: [A, B, { emails: ["z@x.com"] }, null, "x"],
    });
    expect(out.map((t) => t.id)).toEqual(["task-a", "task-b"]);
  });
});

describe("taskForMergedEntry", () => {
  it("đổi id + thu hẹp email, BỎ hẳn `email` số ít và danh sách mẻ", () => {
    const task = inviteTask({
      email: "a@x.com",
      emails: ["a@x.com", "b@x.com", "c@x.com"],
      role: "member",
      merged_tasks: [A, B],
    });
    const sub = taskForMergedEntry(task, B);
    expect(sub.id).toBe("task-b");
    expect(sub.payload.emails).toEqual(["b@x.com", "c@x.com"]);
    expect(sub.payload.email).toBeUndefined();
    expect(sub.payload.merged_tasks).toBeUndefined();
    expect(sub.payload.role).toBe("member");
    expect(sub.workspace_id).toBe("ws-1");
  });
});

describe("splitResponseForTask — INVITE_MEMBER", () => {
  const response: ExecuteActionResponse = {
    ok: true,
    data: {
      emails: ["a@x.com", "b@x.com", "c@x.com"],
      verified_emails: ["a@x.com", "b@x.com"],
      unverified_emails: ["c@x.com"],
      pending_members: [
        { email: "a@x.com", status: "pending" },
        { email: "b@x.com", status: "pending" },
      ],
      submit_evidence: "toast",
      verify_scrape_failed: false,
    },
  };

  it("lệnh A chỉ nhận email của A", () => {
    const out = splitResponseForTask("INVITE_MEMBER", A, response);
    expect(out.ok).toBe(true);
    const d = (out as { ok: true; data: Record<string, unknown> }).data;
    expect(d.emails).toEqual(["a@x.com"]);
    expect(d.verified_emails).toEqual(["a@x.com"]);
    expect(d.unverified_emails).toEqual([]);
    expect(d.pending_members).toEqual([{ email: "a@x.com", status: "pending" }]);
    // Bằng chứng "ChatGPT đã báo đã gửi" là của cả lượt gửi → mọi lệnh giữ nguyên.
    expect(d.submit_evidence).toBe("toast");
  });

  it("lệnh B giữ đúng email chưa xác minh của riêng nó", () => {
    const out = splitResponseForTask("INVITE_MEMBER", B, response);
    const d = (out as { ok: true; data: Record<string, unknown> }).data;
    expect(d.verified_emails).toEqual(["b@x.com"]);
    expect(d.unverified_emails).toEqual(["c@x.com"]);
    expect(d.pending_members).toEqual([{ email: "b@x.com", status: "pending" }]);
  });

  it("mẻ HỎNG cả lượt → mọi lệnh nhận nguyên lỗi đó (backend tự phân xử tiền)", () => {
    const failed: ExecuteActionResponse = {
      ok: false,
      error_code: "EXTERNAL_TOGGLE_FAILED",
      error_message: "không bật được toggle",
    };
    expect(splitResponseForTask("INVITE_MEMBER", A, failed)).toBe(failed);
    expect(splitResponseForTask("INVITE_MEMBER", B, failed)).toBe(failed);
  });
});

describe("splitResponseForTask — REMOVE_MEMBER", () => {
  const batch: ExecuteActionResponse = {
    ok: true,
    data: {
      batch: true,
      total: 2,
      results: [
        { email: "a@x.com", ok: true, verified: true },
        {
          email: "b@x.com",
          ok: false,
          error_code: "REMOVE_VERIFY_FAILED",
          error_message: "vẫn còn trong list",
        },
      ],
    },
  };

  it("email gỡ được → COMPLETED kèm bằng chứng verified", () => {
    const out = splitResponseForTask("REMOVE_MEMBER", A, batch);
    expect(out).toEqual({
      ok: true,
      data: { email: "a@x.com", verified: true, merged_batch: true },
    });
  });

  it("email gỡ hỏng → giữ nguyên mã lỗi của chính nó, KHÔNG lây sang email khác", () => {
    const out = splitResponseForTask(
      "REMOVE_MEMBER",
      { id: "task-b", emails: ["b@x.com"] },
      batch,
    );
    expect(out.ok).toBe(false);
    expect((out as { ok: false; error_code: string }).error_code).toBe(
      "REMOVE_VERIFY_FAILED",
    );
  });

  it("thiếu dòng kết quả → BÁO HỎNG (thà giữ thành viên còn hơn xoá-giả)", () => {
    const out = splitResponseForTask(
      "REMOVE_MEMBER",
      { id: "task-z", emails: ["z@x.com"] },
      batch,
    );
    expect(out.ok).toBe(false);
    expect((out as { ok: false; error_code: string }).error_code).toBe("VERIFY_FAILED");
  });

  it("mã lỗi lạ → UNKNOWN chứ không lọt kiểu sai xuống backend", () => {
    const weird: ExecuteActionResponse = {
      ok: true,
      data: { results: [{ email: "a@x.com", ok: false, error_code: "TÈ LE" }] },
    };
    const out = splitResponseForTask("REMOVE_MEMBER", A, weird);
    expect((out as { ok: false; error_code: string }).error_code).toBe("UNKNOWN");
  });
});

describe("splitResponseForTask — REVOKE_INVITES", () => {
  it("chỉ giữ dòng kết quả của email thuộc lệnh này", () => {
    const response: ExecuteActionResponse = {
      ok: true,
      data: {
        results: [
          { email: "a@x.com", ok: true },
          { email: "b@x.com", ok: false },
          { email: "c@x.com", ok: true },
        ],
      },
    };
    const out = splitResponseForTask("REVOKE_INVITES", B, response);
    const d = (out as { ok: true; data: Record<string, unknown> }).data;
    expect(d.results).toEqual([
      { email: "b@x.com", ok: false },
      { email: "c@x.com", ok: true },
    ]);
  });
});
