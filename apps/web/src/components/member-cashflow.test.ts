import { describe, expect, it } from "vitest";
import {
  pairMemberCashflow,
  splitInheritedCashflow,
  visibleMemberOrders,
} from "./MemberDetailModal";

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

/* HOÁ ĐƠN THẤT BẠI Ở LẠI BAO LÂU (user 2026-08-29): "thất bại" = tiền ĐÃ nhận
   nhưng lượt mời email này hỏng nên phí đã hoàn. Nó là bằng chứng đối soát nên
   phải còn thấy được — 30 ngày khi chưa mời lại được, rút còn 7 ngày khi đã có
   lượt mời thành công sau đó. */
type Order = Parameters<typeof visibleMemberOrders>[0][number];

const NOW = Date.parse("2026-08-29T10:00:00Z");
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

function order(over: Partial<Order> & Pick<Order, "id">): Order {
  return {
    ref_code: "c6a67ae1172b13987b21",
    kind: "invite",
    amount_vnd: 330_000,
    status: "paid",
    paid_amount_vnd: 330_000,
    created_at: iso(40),
    paid_at: iso(40),
    fulfillment_error: null,
    ...over,
  } as Order;
}

describe("visibleMemberOrders", () => {
  it("hoá đơn bình thường không bao giờ bị giấu, dù rất cũ", () => {
    const old = order({ id: "o1", created_at: iso(400), paid_at: iso(400) });
    expect(visibleMemberOrders([old], [], NOW).map((o) => o.id)).toEqual(["o1"]);
  });

  it("mời hỏng chưa mời lại được: giữ 30 ngày rồi mới ẩn", () => {
    const keep = order({
      id: "keep",
      member_fee_refunded: true,
      member_refunded_at: iso(29),
    });
    const drop = order({
      id: "drop",
      member_fee_refunded: true,
      member_refunded_at: iso(31),
    });
    expect(visibleMemberOrders([keep, drop], [], NOW).map((o) => o.id)).toEqual([
      "keep",
    ]);
  });

  it("đã mời lại thành công sau đó: rút xuống 7 ngày", () => {
    const o = order({
      id: "o1",
      member_fee_refunded: true,
      member_refunded_at: iso(10),
    });
    const okLater = entry({
      id: "f9",
      kind: "invite_fee",
      amount: -FEE,
      created_at: iso(9),
    });
    expect(visibleMemberOrders([o], [okLater], NOW)).toHaveLength(0);
    // Cùng mốc đó mà lượt sau CŨNG hỏng (phí đã hoàn) thì vẫn là 30 ngày.
    const failLater = { ...okLater, reversed: true };
    expect(visibleMemberOrders([o], [failLater], NOW)).toHaveLength(1);
  });

  it("lượt thành công TRƯỚC lúc hoàn phí không rút ngắn thời hạn", () => {
    const o = order({
      id: "o1",
      member_fee_refunded: true,
      member_refunded_at: iso(10),
    });
    const okBefore = entry({
      id: "f8",
      kind: "invite_fee",
      amount: -FEE,
      created_at: iso(20),
    });
    expect(visibleMemberOrders([o], [okBefore], NOW)).toHaveLength(1);
  });

  it("thiếu mốc hoàn phí thì giữ lại — không giấu bằng chứng vì dữ liệu thiếu", () => {
    const o = order({
      id: "o1",
      member_fee_refunded: true,
      member_refunded_at: null,
      paid_at: null,
      created_at: "",
    });
    expect(visibleMemberOrders([o], [], NOW)).toHaveLength(1);
  });
});

/* GOM TIỀN QUA CHUỖI ĐỔI EMAIL (user 31/8/2026): email nhận là bản ghi MỚI nên
   panel của nó hiện 0 ₫ trong khi ghế đang dùng đã trả tiền dưới tên email cũ.
   API gom sang (`from_email`), web tách ra thành khung riêng — gom nhưng không lẫn. */
describe("splitInheritedCashflow", () => {
  const own = pairMemberCashflow([entry({ id: "n1", kind: "renew_fee", amount: -FEE })]);
  const inherited = pairMemberCashflow([
    entry({ id: "o1", kind: "invite_fee", amount: -FEE, from_email: "old@example.com" }),
  ]);

  it("khoản của email cũ tách sang khung riêng, khoản email mới ở lại", () => {
    const r = splitInheritedCashflow([...own, ...inherited], [], ["old@example.com"]);
    expect(r.ownRows.map((x) => (x.type === "entry" ? x.entry.id : x.fee.id))).toEqual(["n1"]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].email).toBe("old@example.com");
    expect(r.groups[0].rows).toHaveLength(1);
  });

  it("hoá đơn chia theo cùng một cờ", () => {
    const mine = order({ id: "om" });
    const theirs = order({ id: "ot", from_email: "old@example.com" });
    const r = splitInheritedCashflow([], [mine, theirs], ["old@example.com"]);
    expect(r.ownOrders.map((o) => o.id)).toEqual(["om"]);
    expect(r.groups[0].orders.map((o) => o.id)).toEqual(["ot"]);
  });

  it("email cũ chưa từng trả đồng nào thì KHÔNG dựng khung rỗng", () => {
    const r = splitInheritedCashflow(own, [], ["never-paid@example.com"]);
    expect(r.groups).toEqual([]);
    expect(r.ownRows).toHaveLength(1);
  });

  it("chưa từng đổi email: mọi thứ nằm ở phần của chính email đang xem", () => {
    const r = splitInheritedCashflow(own, [order({ id: "om" })], undefined);
    expect(r.groups).toEqual([]);
    expect(r.ownRows).toHaveLength(1);
    expect(r.ownOrders).toHaveLength(1);
  });
});
