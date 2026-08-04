import { describe, expect, it } from "vitest";
import { decideInviteOutcome } from "./invite-outcome";

const base = {
  submitEvidence: "dialog_closed" as const,
  verifiedEmails: [],
  unverifiedEmails: [],
  verifyScrapeFailed: false,
};

describe("quyết định kết cục lệnh mời", () => {
  it("ChatGPT đã báo đã gửi mà danh sách chưa hiện → KHÔNG báo hỏng, không xoá bản ghi", () => {
    // Đây là ca làm mất tiền (stockbox.m): tab Lời mời index trễ vài giây.
    const out = decideInviteOutcome({
      ...base,
      submitEvidence: "toast",
      unverifiedEmails: ["a@example.com"],
    });
    expect(out.status).toBe("COMPLETED");
    expect(out.shouldReconcile).toBe(false);
    expect(out.reason).toBe("trusted-toast");
  });

  it("không có xác nhận nào + quét sạch mà trắng tay → báo hỏng như cũ", () => {
    const out = decideInviteOutcome({
      ...base,
      submitEvidence: "dialog_closed",
      unverifiedEmails: ["a@example.com"],
    });
    expect(out.status).toBe("FAILED");
    expect(out.shouldReconcile).toBe(true);
    expect(out.reason).toBe("total-miss");
  });

  it("thấy một phần → COMPLETED, phần thiếu vẫn dọn phantom", () => {
    const out = decideInviteOutcome({
      ...base,
      verifiedEmails: ["a@example.com"],
      unverifiedEmails: ["b@example.com"],
    });
    expect(out.status).toBe("COMPLETED");
    expect(out.shouldReconcile).toBe(true);
  });

  it("thấy hết → COMPLETED, không dọn gì", () => {
    const out = decideInviteOutcome({
      ...base,
      verifiedEmails: ["a@example.com", "b@example.com"],
    });
    expect(out).toEqual({
      status: "COMPLETED",
      shouldReconcile: false,
      reason: "verified",
    });
  });

  it("không quét được danh sách → không kết luận, không xoá gì", () => {
    const out = decideInviteOutcome({
      ...base,
      unverifiedEmails: ["a@example.com"],
      verifyScrapeFailed: true,
    });
    expect(out.status).toBe("COMPLETED");
    expect(out.shouldReconcile).toBe(false);
    expect(out.reason).toBe("scrape-failed");
  });

  it("toast chỉ cứu ca chưa-thấy, KHÔNG che ca quét được là hỏng thật ở lần sau", () => {
    // Cùng input nhưng không còn email nào chưa xác minh → vẫn là 'verified'.
    const out = decideInviteOutcome({
      ...base,
      submitEvidence: "toast",
      verifiedEmails: ["a@example.com"],
    });
    expect(out.reason).toBe("verified");
  });
});
