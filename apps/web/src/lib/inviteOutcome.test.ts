import { describe, expect, it } from "vitest";
import { readInviteOutcome } from "./inviteOutcome";
import type { QueueItem } from "../types";

/* Câu hỏi mà banner phải trả lời được (user 29/8/2026): "email nào đã mời được?".
   Ba nhóm không được lẫn vào nhau — đặc biệt nhóm "chưa xác minh" KHÔNG phải hỏng,
   và nhóm hỏng vì hết suất thì tiền GIỮ LẠI chứ không hoàn. */

function task(over: Partial<QueueItem>): QueueItem {
  return {
    id: "q1",
    type: "INVITE_MEMBER",
    status: "COMPLETED",
    payload: {},
    result: null,
    progress: null,
    error_code: null,
    error_message: null,
    workspace_id: "w1",
    created_by_id: null,
    created_by_username: null,
    created_at: "2026-08-29T10:00:00Z",
    picked_at: null,
    completed_at: "2026-08-29T10:01:00Z",
    ...over,
  } as QueueItem;
}

function outcome(over: Record<string, unknown>) {
  return task({
    result: {
      invite_outcome: {
        invited: [],
        failed: [],
        pending_verify: [],
        refunded: [],
        seat_credit: [],
        reason_code: null,
        ...over,
      },
    },
  });
}

describe("readInviteOutcome", () => {
  it("task cũ chưa có invite_outcome → null để banner lùi về dòng tóm tắt", () => {
    expect(readInviteOutcome(task({ result: { verified_count: 3 } }))).toBeNull();
  });

  it("bỏ qua task không phải mời", () => {
    const t = outcome({ invited: ["a@x.com"] });
    expect(readInviteOutcome({ ...t, type: "SYNC_DATA" })).toBeNull();
  });

  it("liệt kê ĐỦ email, không cắt bớt", () => {
    const emails = Array.from({ length: 12 }, (_, i) => `u${i}@x.com`);
    const view = readInviteOutcome(outcome({ invited: emails }))!;
    expect(view.rows).toHaveLength(12);
    expect(view.counts.sent).toBe(12);
    expect(view.tone).toBe("success");
  });

  it("mời được vài email, hỏng vài email → vàng, mỗi email một dòng riêng", () => {
    const view = readInviteOutcome(
      outcome({
        invited: ["ok@x.com"],
        failed: ["bad@x.com"],
        refunded: ["bad@x.com"],
        reason_code: "VERIFY_FAILED",
        reason_text: "Đã bấm gửi nhưng chưa nhận được xác nhận từ ChatGPT.",
      }),
    )!;
    expect(view.tone).toBe("warn");
    expect(view.rows.map((r) => [r.email, r.kind])).toEqual([
      ["ok@x.com", "invited"],
      ["bad@x.com", "failed"],
    ]);
    expect(view.rows[1].noteKey).toBe("inviteOutcome.money.refunded");
    // Lý do hỏng nói MỘT lần cho cả nhóm, không lặp xuống từng dòng.
    expect(view.failureText).toBe(
      "Đã bấm gửi nhưng chưa nhận được xác nhận từ ChatGPT.",
    );
  });

  it("hết suất → GIỮ tiền cho email đó, không được nói đã hoàn phí", () => {
    const view = readInviteOutcome(
      outcome({
        failed: ["a@x.com"],
        seat_credit: ["a@x.com"],
        reason_code: "NOT_ENOUGH_SEATS",
      }),
    )!;
    expect(view.rows[0].noteKey).toBe("inviteOutcome.money.seatCredit");
    expect(view.tone).toBe("danger");
  });

  it("hỏng nhưng task không thu phí → im lặng về tiền, không bịa 'đã hoàn phí'", () => {
    const view = readInviteOutcome(outcome({ failed: ["a@x.com"] }))!;
    expect(view.rows[0].noteKey).toBeUndefined();
  });

  it("chưa xác minh KHÔNG phải hỏng: xanh, không đếm vào failed", () => {
    const view = readInviteOutcome(
      outcome({ pending_verify: ["a@x.com", "b@x.com"], reason_code: "TIMEOUT" }),
    )!;
    // Đã bấm gửi = đã mời. Chờ ChatGPT hiện ra là việc nội bộ, không phải cảnh báo.
    expect(view.tone).toBe("success");
    expect(view.counts).toEqual({ sent: 2, failed: 0 });
    // Gộp một loại: email chờ xác minh cũng hiện "đã mời, chờ người nhận đồng ý".
    expect(view.rows.every((r) => r.kind === "invited")).toBe(true);
    expect(view.rows.every((r) => r.noteKey === "inviteOutcome.invited")).toBe(true);
    // Không có email nào hỏng ⇒ không được hiện khung lý do hỏng.
    expect(view.failureText).toBeUndefined();
    expect(view.failureKey).toBeUndefined();
  });

  it("lý do hỏng lấy câu backend gửi, không tự dịch mã lỗi", () => {
    const view = readInviteOutcome(
      outcome({
        failed: ["a@x.com"],
        reason_code: "SEAT_PURCHASE_FAILED",
        reason_text: "Mua thêm suất không thành công nên lệnh dừng lại.",
      }),
    )!;
    expect(view.failureText).toBe(
      "Mua thêm suất không thành công nên lệnh dừng lại.",
    );
  });

  it("không có câu sẵn → câu chung, không phun mã kỹ thuật ra màn hình", () => {
    const view = readInviteOutcome(
      outcome({ failed: ["a@x.com"], reason_code: "SEAT_RELOAD_FAILED" }),
    )!;
    expect(view.failureText).toBeUndefined();
    expect(view.failureKey).toBe("inviteOutcome.reason.default");
  });

  it("tiêu đề đi theo kết cục, không theo status của task", () => {
    const done = readInviteOutcome(outcome({ invited: ["a@x.com"] }))!;
    expect(done.titleKey).toBe("inviteOutcome.doneTitle");

    const mixed = readInviteOutcome(
      outcome({ invited: ["a@x.com"], failed: ["b@x.com"] }),
    )!;
    expect(mixed.titleKey).toBe("inviteOutcome.partialTitle");

    // Chờ xác minh KHÔNG phải chuyện của người dùng: vẫn là "đã mời xong".
    const waiting = readInviteOutcome(outcome({ pending_verify: ["a@x.com"] }))!;
    expect(waiting.titleKey).toBe("inviteOutcome.doneTitle");

    // Có email hỏng thật thì mới được kêu.
    const partlyBroken = readInviteOutcome(
      outcome({ invited: ["a@x.com"], failed: ["b@x.com"], pending_verify: ["c@x.com"] }),
    )!;
    expect(partlyBroken.titleKey).toBe("inviteOutcome.partialTitle");

    const dead = readInviteOutcome(outcome({ failed: ["a@x.com"] }))!;
    expect(dead.titleKey).toBe("inviteOutcome.failedTitle");
  });

  it("outcome rỗng (không email nào) → null, khỏi vẽ khung trống", () => {
    expect(readInviteOutcome(outcome({}))).toBeNull();
  });
});
