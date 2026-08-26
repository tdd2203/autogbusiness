import { describe, expect, it } from "vitest";
import { groupTxns } from "./WalletAdmin";
import type { WalletTxn } from "../lib/wallet";

/* Trang Ví phía ADMIN gom nhóm theo cách riêng (có chip lọc, không gộp rút tiền)
   nhưng phải xử lý lượt mời hỏng GIỐNG trang Ví người dùng: cặp phí ↔ hoàn tách ra
   nhóm riêng để ẩn mặc định, tiền hoá đơn đọng lại thì vẫn hiện (user 2026-08-26). */

const QID = "33333333-3333-3333-3333-333333333333";
const FEE = 100_000;
const AT = "2026-08-26T10:00:00Z";

let n = 0;
function txn(over: Partial<WalletTxn> & Pick<WalletTxn, "kind" | "amount">): WalletTxn {
  n += 1;
  return {
    id: `t${n}`,
    balance_after: 0,
    held_after: 0,
    ref_type: "invite",
    ref_id: QID,
    meta: null,
    created_at: AT,
    ...over,
  } as WalletTxn;
}
const fee = (email: string, reversed = false, at = AT) =>
  txn({ kind: "invite_fee", amount: -FEE, meta: { email }, reversed, created_at: at });
const refund = (email: string, at = "2026-08-26T10:30:00Z") =>
  txn({ kind: "invite_refund", amount: FEE, meta: { email }, created_at: at });

describe("groupTxns (Ví admin)", () => {
  it("cặp phí ↔ hoàn thành MỘT nhóm 'voided', không còn dòng nào khác", () => {
    const groups = groupTxns([refund("a@x.com"), fee("a@x.com", true)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].voided).toHaveLength(1);
    expect(groups[0].txns).toHaveLength(0);
    expect(groups[0].category).toBe("refund"); // lọt chip "Hoàn"
  });

  it("lượt 3 email hỏng 1: nhóm phí còn 2 email + nhóm hỏng riêng", () => {
    const groups = groupTxns([
      refund("c@x.com"),
      fee("a@x.com"),
      fee("b@x.com"),
      fee("c@x.com", true),
    ]);
    expect(groups).toHaveLength(2);
    const [live, voided] = groups;
    expect(live.txns.map((t) => t.meta?.email)).toEqual(["a@x.com", "b@x.com"]);
    expect(live.category).toBe("fee");
    expect(live.voidedSiblings).toBe(1);
    expect(voided.voided).toHaveLength(1);
    expect(voided.key).not.toBe(live.key); // key phải khác kẻo React trùng
  });

  it("hỏng khi trả qua hoá đơn: dòng hoá đơn ở lại, có số tiền đọng trong ví", () => {
    const groups = groupTxns([
      refund("a@x.com"),
      fee("a@x.com", true),
      txn({ kind: "order_topup", amount: FEE, ref_type: "order" }),
    ]);
    expect(groups).toHaveLength(2);
    const live = groups.find((g) => g.txns.length > 0)!;
    const voided = groups.find((g) => g.voided.length > 0)!;
    expect(live.txns[0].kind).toBe("order_topup");
    expect(live.invoiceStranded).toBe(FEE);
    expect(voided.invoiceStranded).toBe(FEE);
  });

  it("bút toán hoàn lẻ (không thấy phí) vẫn là dòng thường, không bị giấu", () => {
    const groups = groupTxns([refund("z@x.com")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].voided).toHaveLength(0);
    expect(groups[0].category).toBe("refund");
  });

  it("nạp tiền + điều chỉnh vẫn phân loại như cũ", () => {
    const groups = groupTxns([
      txn({ kind: "adjust", amount: 50_000, ref_type: null, created_at: "2026-08-26T09:00:00Z" }),
      txn({ kind: "topup", amount: 200_000, ref_type: "topup", created_at: "2026-08-26T08:00:00Z" }),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["other", "topup"]);
  });
});
