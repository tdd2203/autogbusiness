/**
 * REGRESSION 26/8/2026 — "mua thêm 1 suất mà tổng suất trên dashboard không tăng".
 *
 * GPT1: lệnh mời mua bù 1 suất, ChatGPT lên 152 suất, dashboard vẫn 151. Mọi
 * lệnh mời của workspace này đều là email ngoài tên miền ⇒ chạy hai pha, mà kết
 * quả Phase A' GHI ĐÈ kết quả Phase A — nơi DUY NHẤT có số liệu suất. Backend
 * nhận `result` trắng mọi trường `seat_*` nên không ghi lại được gì.
 */
import { describe, expect, it } from "vitest";
import { pickSeatFields, withExtraData } from "./invite-seat-fields";

/** `data` Phase A trả về sau khi đếm suất + mua bù 1 suất. */
const PHASE_A_DATA = {
  awaiting_external_reload: true,
  emails: ["a@gmail.com"],
  count: 1,
  role: "member",
  seat_check: "ok",
  seat_total: 151,
  seat_assigned: 147,
  seat_free: 0,
  seat_purchased: 1,
  seat_total_after: 152,
  seat_after_source: "purchase_counter",
};

describe("pickSeatFields", () => {
  it("lấy đúng các trường seat_*, BỎ cờ điều phối của Phase A", () => {
    const got = pickSeatFields(PHASE_A_DATA);
    expect(got.seat_total_after).toBe(152);
    expect(got.seat_purchased).toBe(1);
    expect(got).not.toHaveProperty("awaiting_external_reload");
    expect(got).not.toHaveProperty("emails");
  });

  it("data rỗng / không phải object → {}", () => {
    expect(pickSeatFields(undefined)).toEqual({});
    expect(pickSeatFields(null)).toEqual({});
    expect(pickSeatFields("x")).toEqual({});
    expect(pickSeatFields([1, 2])).toEqual({});
    expect(pickSeatFields({ emails: [] })).toEqual({});
  });
});

describe("withExtraData — số liệu suất sống sót qua Phase A'", () => {
  it("kết quả mời THÀNH CÔNG nhận được số suất của Phase A", () => {
    const phaseAPrime = { ok: true as const, data: { count: 1, submit_evidence: "toast" } };
    const merged = withExtraData(phaseAPrime, pickSeatFields(PHASE_A_DATA));
    const data = (merged as { data: Record<string, unknown> }).data;
    expect(data.seat_total_after).toBe(152);
    expect(data.submit_evidence).toBe("toast");
  });

  it("kết quả mời HỎNG cũng phải giữ — tiền đã trừ là thông tin quan trọng nhất", () => {
    const failed = {
      ok: false as const,
      error_code: "CONTENT_TIMEOUT" as const,
      error_message: "…",
    };
    const merged = withExtraData(failed, pickSeatFields(PHASE_A_DATA));
    expect((merged as { data: Record<string, unknown> }).data.seat_purchased).toBe(1);
  });

  it("khoá của Phase A' THẮNG khi trùng tên (số mới nhất)", () => {
    const phaseAPrime = { ok: true as const, data: { seat_total: 999 } };
    const merged = withExtraData(phaseAPrime, { seat_total: 151 });
    expect((merged as { data: Record<string, unknown> }).data.seat_total).toBe(999);
  });

  it("không có gì để gắp → trả nguyên response, không đẻ ra data rỗng", () => {
    const resp = { ok: true as const };
    expect(withExtraData(resp, {})).toBe(resp);
  });
});
