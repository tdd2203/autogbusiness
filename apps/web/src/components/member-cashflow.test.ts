import { describe, expect, it } from "vitest";
import { pairMemberCashflow } from "./MemberDetailModal";

/* Khối "Dòng tiền" của 1 email: lượt mời hỏng ghi phí (−) rồi hoàn (+) ở 2 thời
   điểm khác nhau. Gộp thành 1 dòng để khỏi phải trừ nhẩm — nhưng KHÔNG giấu như
   trang Ví, vì khối này chính là chỗ phát hiện "email dùng miễn phí" (ca stockbox.m). */

const QID = "22222222-2222-2222-2222-222222222222";
const FEE = 100_000;

type Entry = Parameters<typeof pairMemberCashflow>[0][number];

function entry(over: Partial<Entry> & Pick<Entry, "id" | "kind" | "amount">): Entry {
  return {
    balance_after: 0,
    ref_type: "invite",
    ref_id: QID,
    meta: null,
    created_at: "2026-08-26T10:00:00Z",
    ...over,
  } as Entry;
}

describe("pairMemberCashflow", () => {
  it("ghép phí đã hoàn với bút toán hoàn dù danh sách xếp mới → cũ", () => {
    const refund = entry({ id: "r1", kind: "invite_refund", amount: FEE, created_at: "2026-08-26T10:30:00Z" });
    const fee = entry({ id: "f1", kind: "invite_fee", amount: -FEE, reversed: true });
    const rows = pairMemberCashflow([refund, fee]);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("voided");
    if (rows[0].type !== "voided") throw new Error("unreachable");
    expect(rows[0].fee.id).toBe("f1");
    expect(rows[0].refund.id).toBe("r1");
  });

  it("phí CHƯA hoàn và phí gia hạn giữ nguyên từng dòng", () => {
    const rows = pairMemberCashflow([
      entry({ id: "f2", kind: "renew_fee", amount: -FEE }),
      entry({ id: "f1", kind: "invite_fee", amount: -FEE }),
    ]);
    expect(rows.map((r) => r.type)).toEqual(["entry", "entry"]);
  });

  it("2 lượt hỏng liên tiếp ghép đúng cặp, không dùng lại một bút toán hoàn", () => {
    const rows = pairMemberCashflow([
      entry({ id: "r2", kind: "invite_refund", amount: FEE, ref_id: "q2", created_at: "2026-08-26T12:00:00Z" }),
      entry({ id: "f2", kind: "invite_fee", amount: -FEE, ref_id: "q2", reversed: true, created_at: "2026-08-26T11:00:00Z" }),
      entry({ id: "r1", kind: "invite_refund", amount: FEE, ref_id: "q1", created_at: "2026-08-26T10:30:00Z" }),
      entry({ id: "f1", kind: "invite_fee", amount: -FEE, ref_id: "q1", reversed: true }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.type === "voided")).toBe(true);
    if (rows[0].type !== "voided" || rows[1].type !== "voided") throw new Error("unreachable");
    expect([rows[0].refund.id, rows[1].refund.id]).toEqual(["r2", "r1"]);
  });

  it("thiếu bút toán hoàn (rơi ngoài limit) thì để nguyên dòng phí", () => {
    const rows = pairMemberCashflow([entry({ id: "f1", kind: "invite_fee", amount: -FEE, reversed: true })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("entry");
  });
});
