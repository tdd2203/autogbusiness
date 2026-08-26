import { describe, expect, it } from "vitest";
import { buildTxnCsv, buildTxnRows, countVoidedInvites, groupRowsByDay, rowChannel, traceRefundUsage } from "./wallet-history";
import type { WalletTxn } from "./wallet";

/* Ca thật: mời hỏng thì phí bị trừ rồi hoàn lại đủ (2 bút toán ngược dấu, 2 thời
   điểm). Trước đây lịch sử hiện chúng ở 2 chỗ rời nhau, dòng phí còn gắn nhãn
   "✓ Thành công" ⇒ user phải tự ghép mới biết rốt cuộc không mất tiền
   (yêu cầu 2026-08-26: "lệnh lỗi tự triệt tiêu ... khó nhìn khó hiểu"). */

const QID = "11111111-1111-1111-1111-111111111111";
const FEE = 100_000;

let seq = 0;
function txn(over: Partial<WalletTxn> & Pick<WalletTxn, "kind" | "amount">): WalletTxn {
  seq += 1;
  return {
    id: `t${seq}`,
    balance_after: 0,
    held_after: 0,
    ref_type: "invite",
    ref_id: QID,
    meta: null,
    created_at: "2026-08-26T10:00:00Z",
    ...over,
  } as WalletTxn;
}

const feeOf = (email: string, at = "2026-08-26T10:00:00Z", reversed = false) =>
  txn({ kind: "invite_fee", amount: -FEE, meta: { email }, created_at: at, reversed });
const refundOf = (email: string, at = "2026-08-26T10:30:00Z") =>
  txn({ kind: "invite_refund", amount: FEE, meta: { email }, created_at: at });

describe("buildTxnRows — mời hỏng đã hoàn phí", () => {
  it("gộp cặp phí ↔ hoàn thành 1 dòng đặt đúng chỗ lượt mời", () => {
    // API trả mới → cũ: bút toán hoàn đứng trước phí của nó.
    const rows = buildTxnRows([refundOf("a@x.com"), feeOf("a@x.com", "2026-08-26T10:00:00Z", true)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("voided");
    if (rows[0].type !== "voided") throw new Error("unreachable");
    expect(rows[0].pairs).toHaveLength(1);
    expect(rows[0].pairs[0].fee.meta?.email).toBe("a@x.com");
    expect(rows[0].key).toBe("2026-08-26T10:00:00Z"); // đứng ở mốc MỜI, không phải mốc hoàn
    expect(countVoidedInvites(rows)).toBe(1);
  });

  it("lượt mời 3 email hỏng 1: dòng gộp còn 2 email, dòng hỏng tách riêng", () => {
    const at = "2026-08-26T09:00:00Z";
    const rows = buildTxnRows([
      refundOf("c@x.com"),
      feeOf("a@x.com", at),
      feeOf("b@x.com", at),
      feeOf("c@x.com", at, true),
    ]);
    const group = rows.find((r) => r.type === "group");
    const voided = rows.find((r) => r.type === "voided");
    if (group?.type !== "group" || voided?.type !== "voided") throw new Error("thiếu dòng");
    expect(group.txns.map((t) => t.meta?.email)).toEqual(["a@x.com", "b@x.com"]);
    expect(group.voidedCount).toBe(1);
    expect(voided.pairs).toHaveLength(1);
  });

  it("trả qua hoá đơn mà mời hỏng: dòng hoá đơn Ở LẠI, kèm số tiền đọng trong ví", () => {
    const at = "2026-08-26T08:00:00Z";
    const rows = buildTxnRows([
      refundOf("a@x.com"),
      feeOf("a@x.com", at, true),
      txn({ kind: "order_topup", amount: FEE, created_at: at, ref_type: "order" }),
    ]);
    const group = rows.find((r) => r.type === "group");
    const voided = rows.find((r) => r.type === "voided");
    if (group?.type !== "group" || voided?.type !== "voided") throw new Error("thiếu dòng");
    // Tiền hoá đơn đã vào ví rồi phí hoàn về ⇒ ví DÔI RA, không được giấu đi.
    expect(group.txns).toHaveLength(1);
    expect(group.txns[0].kind).toBe("order_topup");
    expect(group.invoiceStranded).toBe(FEE);
    expect(voided.invoiceStranded).toBe(FEE);
  });

  it("bút toán hoàn không tìm thấy phí (rơi ngoài trang) thì vẫn hiện, không giấu", () => {
    const rows = buildTxnRows([refundOf("z@x.com")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("group");
    expect(countVoidedInvites(rows)).toBe(0);
  });

  it("phí reversed nhưng chưa có bút toán hoàn trong danh sách thì để nguyên", () => {
    const rows = buildTxnRows([feeOf("a@x.com", "2026-08-26T10:00:00Z", true)]);
    expect(rows[0].type).toBe("group");
    expect(countVoidedInvites(rows)).toBe(0);
  });

  it("rút tiền vẫn gộp theo ref_id như cũ", () => {
    const wid = "w-1";
    const rows = buildTxnRows([
      txn({ kind: "withdraw_settle", amount: 0, ref_type: "withdrawal", ref_id: wid, created_at: "2026-08-26T12:00:00Z" }),
      txn({ kind: "withdraw_hold", amount: -50_000, ref_type: "withdrawal", ref_id: wid, created_at: "2026-08-26T11:00:00Z" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("withdraw");
  });
});

/* Giao diện Ví mới (mockup 2026-08-26) xếp lịch sử theo NGÀY, mỗi ngày chốt
   Nạp/Chi/Seat, và lọc theo "tiền đi đường nào". Khoá luật ở đây vì tổng ngày sai
   thì user đối soát ra số lệch mà không có cách nào biết. */
describe("groupRowsByDay — gom theo ngày VN + chip lọc", () => {
  const feeAt = (at: string, email: string) =>
    txn({ kind: "invite_fee", amount: -FEE, meta: { email }, created_at: at });

  it("gom theo ngày VIỆT NAM, không phải ngày UTC", () => {
    // 2026-08-25T18:00Z = 26/8 01:00 giờ VN ⇒ phải nằm ở ngày 26.
    const rows = buildTxnRows([feeAt("2026-08-25T18:00:00Z", "a@x.com")]);
    expect(groupRowsByDay(rows)[0].date).toBe("2026-08-26");
  });

  it("chốt Nạp/Chi/Seat của từng ngày", () => {
    const at1 = "2026-08-26T02:00:00Z";
    const at2 = "2026-08-26T03:00:00Z";
    const rows = buildTxnRows([
      txn({ kind: "topup", amount: 3_300_000, created_at: at2, ref_type: "topup" }),
      feeAt(at1, "a@x.com"),
      feeAt(at1, "b@x.com"),
    ]);
    const [g] = groupRowsByDay(rows);
    expect(g.topup).toBe(3_300_000);
    expect(g.spend).toBe(2 * FEE);
    expect(g.seats).toBe(2);
  });

  it("trả qua hoá đơn: KHÔNG cộng tiền hoá đơn vào ô Nạp (nó chảy thẳng vào phí)", () => {
    const at = "2026-08-26T02:00:00Z";
    const rows = buildTxnRows([
      txn({ kind: "order_topup", amount: FEE, created_at: at, ref_type: "order" }),
      feeAt(at, "a@x.com"),
    ]);
    const [g] = groupRowsByDay(rows);
    expect(g.topup).toBe(0);
    expect(g.spend).toBe(FEE);
    expect(rowChannel(g.rows[0])).toBe("invoice");
  });

  it("phí trừ thẳng ví là kênh wallet, nạp/hoàn là kênh in", () => {
    const rows = buildTxnRows([
      txn({ kind: "topup", amount: 100, created_at: "2026-08-26T04:00:00Z", ref_type: "topup" }),
      feeAt("2026-08-26T02:00:00Z", "a@x.com"),
    ]);
    expect(rows.map(rowChannel)).toEqual(["in", "wallet"]);
    expect(groupRowsByDay(rows, { channel: "wallet" })[0].rows).toHaveLength(1);
    expect(groupRowsByDay(rows, { channel: "in" })[0].rows).toHaveLength(1);
  });

  it("lượt mời hỏng chỉ hiện khi bật công tắc, và không tính vào Chi/Seat", () => {
    const at = "2026-08-26T02:00:00Z";
    const rows = buildTxnRows([refundOf("a@x.com", "2026-08-26T02:30:00Z"), feeOf("a@x.com", at, true)]);
    expect(groupRowsByDay(rows)).toHaveLength(0);
    const [g] = groupRowsByDay(rows, { showVoided: true });
    expect(g.rows).toHaveLength(1);
    expect(g.spend).toBe(0);
    expect(g.seats).toBe(0);
    // Chip "Trừ số dư ví" không được kéo lượt hỏng vào — nó không phải dòng tiền.
    expect(groupRowsByDay(rows, { showVoided: true, channel: "wallet" })).toHaveLength(0);
  });

  it("lọc theo 1 ngày thì bỏ hết ngày khác", () => {
    const rows = buildTxnRows([
      feeAt("2026-08-26T02:00:00Z", "a@x.com"),
      feeAt("2026-08-25T02:00:00Z", "b@x.com"),
    ]);
    expect(groupRowsByDay(rows)).toHaveLength(2);
    const only = groupRowsByDay(rows, { day: "2026-08-25" });
    expect(only).toHaveLength(1);
    expect(only[0].rows).toHaveLength(1);
  });

  it("yêu cầu rút gối ngày xếp theo mốc GIỮ và nhóm ngày vẫn mới→cũ", () => {
    const wid = "w-1";
    const rows = buildTxnRows([
      txn({ kind: "withdraw_settle", amount: 0, ref_type: "withdrawal", ref_id: wid, created_at: "2026-08-26T02:00:00Z" }),
      txn({ kind: "withdraw_hold", amount: -50_000, ref_type: "withdrawal", ref_id: wid, created_at: "2026-08-25T02:00:00Z" }),
      feeAt("2026-08-26T01:00:00Z", "a@x.com"),
    ]);
    expect(groupRowsByDay(rows).map((g) => g.date)).toEqual(["2026-08-26", "2026-08-25"]);
  });
});

describe("buildTxnCsv — xuất báo cáo đối soát", () => {
  it("mỗi bút toán một dòng, kèm kênh tiền + email", () => {
    const at = "2026-08-26T02:00:00Z"; // 09:00 giờ VN
    const rows = buildTxnRows([
      txn({ kind: "order_topup", amount: FEE, created_at: at, ref_type: "order" }),
      txn({ kind: "invite_fee", amount: -FEE, created_at: at, meta: { email: "a@x.com" }, balance_after: 0 }),
    ]);
    const lines = buildTxnCsv(groupRowsByDay(rows)).split("\n");
    expect(lines[0]).toBe("Ngày;Giờ;Loại;Kênh;Email;Số tiền (đ);Số dư sau (đ)");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("2026-08-26;09:00:00;Nạp qua hoá đơn;Thanh toán trực tiếp;;");
    expect(lines[2]).toContain("Phí mời;Thanh toán trực tiếp;a@x.com;-100000;0");
  });

  it("lượt mời hỏng ghi THỰC CHI 0, không ghi số phí đã trừ rồi trả lại", () => {
    const rows = buildTxnRows([
      refundOf("a@x.com", "2026-08-26T02:30:00Z"),
      feeOf("a@x.com", "2026-08-26T02:00:00Z", true),
    ]);
    const lines = buildTxnCsv(groupRowsByDay(rows, { showVoided: true })).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("Mời hỏng (đã hoàn phí);a@x.com;0;");
  });
});

/* Nguồn gốc tiền (user 2026-08-26): mời hỏng trả qua hoá đơn ⇒ tiền ở lại ví;
   lượt mời SAU tiêu đúng khoản đó thì phải nói rõ "dùng tiền hoàn từ email nào",
   và khoản hoàn bị tiêu hết thì triệt tiêu chứ không nằm lại như tiền mới. */
describe("traceRefundUsage — lần nguồn gốc tiền hoàn", () => {
  /** Ca thật trong ảnh: hỏng lúc 12:56 → mời lại lúc 13:05 tiêu đúng khoản đó. */
  function scene() {
    const bad = "2026-08-26T05:56:29Z";
    const good = "2026-08-26T06:05:08Z";
    return buildTxnRows([
      txn({ kind: "invite_fee", amount: -FEE, created_at: good, meta: { email: "good@x.com" }, balance_after: 0 }),
      refundOf("bad@x.com", "2026-08-26T05:57:00Z"),
      txn({ kind: "invite_fee", amount: -FEE, created_at: bad, meta: { email: "bad@x.com" }, balance_after: 0, reversed: true }),
      txn({ kind: "order_topup", amount: FEE, created_at: bad, balance_after: FEE, ref_type: "order" }),
    ]);
  }

  it("dòng phí sau mang nguồn gốc là email đã hoàn", () => {
    const rows = scene();
    const { funding } = traceRefundUsage(rows);
    const feeRow = rows.find((r) => r.type === "group" && r.txns.some((t) => t.meta?.email === "good@x.com"));
    expect(feeRow).toBeTruthy();
    expect(funding.get(feeRow!)).toEqual([{ email: "bad@x.com", amount: FEE }]);
  });

  it("khoản hoàn bị tiêu hết ⇒ triệt tiêu, mặc định ẩn khỏi lịch sử", () => {
    const rows = scene();
    const { usage } = traceRefundUsage(rows);
    const creditRow = rows.find((r) => r.type === "group" && r.txns[0].kind === "order_topup");
    expect(usage.get(creditRow!)).toMatchObject({ used: FEE, total: FEE, emails: ["bad@x.com"] });

    const hidden = new Set([creditRow!]);
    const shown = groupRowsByDay(rows, { hidden }).flatMap((g) => g.rows);
    expect(shown).not.toContain(creditRow);
    // Bật công tắc thì xem lại được — tiền có đi có về vẫn phải tra được.
    expect(groupRowsByDay(rows, { hidden, showVoided: true }).flatMap((g) => g.rows)).toContain(creditRow);
  });

  it("chưa lượt nào tiêu tới thì khoản hoàn vẫn hiện nguyên", () => {
    const bad = "2026-08-26T05:56:29Z";
    const rows = buildTxnRows([
      refundOf("bad@x.com", "2026-08-26T05:57:00Z"),
      txn({ kind: "invite_fee", amount: -FEE, created_at: bad, meta: { email: "bad@x.com" }, balance_after: 0, reversed: true }),
      txn({ kind: "order_topup", amount: FEE, created_at: bad, balance_after: FEE, ref_type: "order" }),
    ]);
    const { usage, funding } = traceRefundUsage(rows);
    const creditRow = rows.find((r) => r.type === "group" && r.txns[0].kind === "order_topup");
    expect(usage.get(creditRow!)).toMatchObject({ used: 0, total: FEE });
    expect(funding.size).toBe(0);
  });

  it("tiêu FIFO: khoản hoàn CŨ bị ăn trước", () => {
    const mk = (at: string, email: string) => [
      txn({ kind: "order_topup", amount: FEE, created_at: at, balance_after: FEE, ref_type: "order" }),
      txn({ kind: "invite_fee", amount: -FEE, created_at: at, meta: { email }, balance_after: 0, reversed: true }),
      refundOf(email, at.replace("00Z", "30Z")),
    ];
    const rows = buildTxnRows([
      // mới → cũ
      txn({ kind: "invite_fee", amount: -FEE, created_at: "2026-08-26T09:00:00Z", meta: { email: "good@x.com" }, balance_after: FEE }),
      ...mk("2026-08-26T08:00:00Z", "bad2@x.com").reverse(),
      ...mk("2026-08-26T07:00:00Z", "bad1@x.com").reverse(),
    ]);
    const { funding } = traceRefundUsage(rows);
    const feeRow = rows.find((r) => r.type === "group" && r.txns.some((t) => t.meta?.email === "good@x.com"));
    // Chỉ tiêu 1 lượt ⇒ ăn khoản hoàn CŨ nhất (bad1), khoản mới (bad2) còn nguyên.
    expect(funding.get(feeRow!)).toEqual([{ email: "bad1@x.com", amount: FEE }]);
  });

  it("lượt mời trả qua hoá đơn KHÔNG tiêu tiền hoàn (không đụng số dư)", () => {
    const bad = "2026-08-26T05:00:00Z";
    const later = "2026-08-26T06:00:00Z";
    const rows = buildTxnRows([
      txn({ kind: "invite_fee", amount: -FEE, created_at: later, meta: { email: "good@x.com" }, balance_after: FEE }),
      txn({ kind: "order_topup", amount: FEE, created_at: later, balance_after: 2 * FEE, ref_type: "order" }),
      refundOf("bad@x.com", "2026-08-26T05:30:00Z"),
      txn({ kind: "invite_fee", amount: -FEE, created_at: bad, meta: { email: "bad@x.com" }, balance_after: 0, reversed: true }),
      txn({ kind: "order_topup", amount: FEE, created_at: bad, balance_after: FEE, ref_type: "order" }),
    ]);
    expect(traceRefundUsage(rows).funding.size).toBe(0);
  });
});
