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

/**
 * REGRESSION 28/8/2026 — CÙNG một lớp lỗi, ở nhánh NẶNG HƠN NHIỀU.
 *
 * GPT1 mua thêm suất lên 270 mà dashboard đứng ở 257. Lệnh mời 10:08 về backend
 * TRẮNG mọi trường `seat_*`. Lần này KHÔNG phải nhánh mời-ngoài-tên-miền mà là
 * nhánh F5-VERIFY — đường đi của GẦN NHƯ MỌI lệnh mời: submit xong, background
 * F5 trang rồi gọi `VERIFY_PENDING_INVITE`, và `response = verifyResp` ghi đè
 * sạch `data` của pha submit, nơi duy nhất có số suất.
 *
 * Data của pha verify (`execute-verify-pending.ts`) KHÔNG có trường `seat_*` nào
 * → gắp lại là an toàn tuyệt đối, không có gì để đè nhầm.
 */
describe("withExtraData — số liệu suất sống sót qua F5-verify (Phase 2)", () => {
  /** `data` pha submit khi đường đọc tận nơi kết luận đủ chỗ, không mua gì. */
  const SUBMIT_DATA = {
    awaiting_reload_verify: true,
    emails: ["a@gmail.com"],
    count: 1,
    role: "member",
    submit_evidence: "toast",
    seat_check: "ok_page_cards",
    seat_total: 270,
    seat_assigned: 253,
    seat_free: 10,
    seat_pending_debt: 7,
    seat_pending_source: "chatgpt_tab",
    seat_purchased: 0,
  };

  /** `data` pha verify — không có trường suất nào. */
  const VERIFY_DATA = {
    verified_emails: ["a@gmail.com"],
    unverified_emails: [],
    pending_members: [],
    needs_reload_retry: false,
    verify_scrape_failed: false,
  };

  it("kết quả cuối mang đủ số suất để backend ghi về workspace", () => {
    const merged = withExtraData(
      { ok: true as const, data: { ...VERIFY_DATA } },
      pickSeatFields(SUBMIT_DATA),
    );
    const data = (merged as { data: Record<string, unknown> }).data;
    // `_absorb_seat_reading` cần đúng bộ ba này: scope KHÁC "skipped_headroom",
    // `seat_total` > 0 và `seat_assigned` hợp lệ.
    expect(data.seat_check).toBe("ok_page_cards");
    expect(data.seat_total).toBe(270);
    expect(data.seat_assigned).toBe(253);
    // Kết luận của pha verify không được đụng tới.
    expect(data.verified_emails).toEqual(["a@gmail.com"]);
    expect(data.needs_reload_retry).toBe(false);
    // Cờ điều phối của pha submit KHÔNG được bò sang kết quả cuối.
    expect(data).not.toHaveProperty("awaiting_reload_verify");
  });

  it("mua bù rồi mới mời: số suất SAU khi mua phải về tới backend", () => {
    const merged = withExtraData(
      { ok: true as const, data: { ...VERIFY_DATA } },
      pickSeatFields({
        ...SUBMIT_DATA,
        seat_purchased: 7,
        seat_total_after: 270,
        seat_assigned_after: 253,
      }),
    );
    const data = (merged as { data: Record<string, unknown> }).data;
    expect(data.seat_total_after).toBe(270);
    expect(data.seat_purchased).toBe(7);
  });
});
