import { describe, expect, it } from "vitest";
import { buildTxnRows, closingBalanceByDay, groupRowsByDay, traceRefundUsage } from "./wallet-history";
import { buildWalletReport, reportCsv, reportSheets } from "./wallet-report";
import type { MemberInfo } from "./wallet-report";
import type { WalletTxn } from "./wallet";
import type { XCell, XSheet } from "./xlsx";

/* Báo cáo ví viết lại 2026-08-30 ("xuất báo cáo khó nhìn và không trực quan"). Ba
   thứ phải đúng, vì sai là người đọc mất niềm tin vào cả file:
     1. Đầu kỳ + vào − ra = cuối kỳ (không thì báo cáo tự mâu thuẫn).
     2. Email mời chung một lệnh phải gom thành CỤM, kèm mã hoá đơn của lệnh đó.
     3. Lượt mời hỏng đã hoàn ghi rõ thực chi 0, không lẫn vào tiền đã tiêu. */

const QID = "11111111-1111-1111-1111-111111111111";
const FEE = 330_000;
const NOW = new Date("2026-08-30T07:00:00Z");

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
    created_at: "2026-08-30T02:00:00Z",
    ...over,
  } as WalletTxn;
}

/** Dựng báo cáo từ danh sách bút toán THÔ, đi đúng đường mà trang Ví đi. */
function report(items: WalletTxn[], members: MemberInfo[] = []) {
  const rows = buildTxnRows(items);
  const trace = traceRefundUsage(rows);
  return buildWalletReport({
    owner: "hoangdat",
    items,
    groups: groupRowsByDay(rows, { showVoided: true }),
    closing: closingBalanceByDay(items),
    trace,
    channel: null,
    showVoided: true,
    day: null,
    members,
    now: NOW,
  });
}

/** Giá trị thô của một ô trong sheet (bỏ lớp kiểu). */
const val = (c: XCell): string | number | null =>
  c !== null && typeof c === "object" ? c.v : (c as string | number | null);
const rowText = (row: XCell[]): string => row.map((c) => String(val(c) ?? "")).join(" | ");
const sheetOf = (sheets: XSheet[], name: string): XSheet => {
  const s = sheets.find((x) => x.name === name);
  if (!s) throw new Error(`thiếu sheet ${name}`);
  return s;
};

describe("buildWalletReport — số dư đầu/cuối kỳ", () => {
  it("đầu kỳ + vào − ra = cuối kỳ", () => {
    // Nạp 1.000.000 (dư 1.200.000 ⇒ đầu kỳ 200.000) rồi trừ 1 phí mời.
    const r = report([
      txn({ kind: "invite_fee", amount: -FEE, balance_after: 870_000, meta: { email: "a@x.com" }, created_at: "2026-08-30T03:00:00Z" }),
      txn({ kind: "topup", amount: 1_000_000, balance_after: 1_200_000, ref_type: "topup", created_at: "2026-08-30T02:00:00Z" }),
    ]);
    expect(r.opening).toBe(200_000);
    expect(r.moneyIn).toBe(1_000_000);
    expect(r.moneyOut).toBe(FEE);
    expect(r.closing).toBe(870_000);
    expect(r.opening + r.moneyIn - r.moneyOut).toBe(r.closing);
  });
});

describe("cụm lệnh mời", () => {
  /** 3 email mời cùng một lúc, trả qua hoá đơn QR (order_topup cùng `created_at`). */
  function batch(): WalletTxn[] {
    const at = "2026-08-30T02:00:00Z";
    return [
      txn({ kind: "invite_fee", amount: -FEE, balance_after: 0, meta: { email: "a@x.com" }, created_at: at }),
      txn({ kind: "invite_fee", amount: -FEE, balance_after: FEE, meta: { email: "b@x.com" }, created_at: at }),
      txn({ kind: "invite_fee", amount: -FEE, balance_after: 2 * FEE, meta: { email: "c@x.com" }, created_at: at }),
      txn({
        kind: "order_topup",
        amount: 3 * FEE,
        balance_after: 3 * FEE,
        ref_type: "order",
        ref_id: "22222222-2222-2222-2222-222222222222",
        ref_code: "ORD7K2M9QX",
        provider_txn_id: "10241902",
        created_at: at,
      }),
    ];
  }

  it("gom 3 email thành 1 cụm, đánh số lệnh bắt đầu từ 0", () => {
    const r = report(batch());
    const c = r.days[0].clusters[0];
    expect(c.label).toBe("Lệnh mời");
    expect(c.no).toBe(0);
    expect(c.charged).toBe(3);
    expect(c.spend).toBe(3 * FEE);
    expect(c.viaInvoice).toBe(true);
  });

  it("mã hoá đơn của bút toán hoá đơn lan sang MỌI dòng phí cùng cụm", () => {
    const r = report(batch());
    const fees = r.days[0].clusters[0].entries.filter((e) => e.email);
    expect(fees).toHaveLength(3);
    for (const e of fees) {
      expect(e.refCode).toBe("ORD7K2M9QX");
      expect(e.providerTxn).toBe("10241902");
    }
  });

  it("dải cụm ghi 'Lệnh mời · lệnh #0 · hoá đơn … · trả qua hoá đơn QR'", () => {
    const detail = sheetOf(reportSheets(report(batch())), "Chi tiết lệnh");
    const band = detail.rows.map(rowText).find((t) => t.startsWith("Lệnh mời"));
    expect(band).toBe("Lệnh mời · lệnh #0 · hoá đơn ORD7K2M9QX · trả qua hoá đơn QR 990.000");
  });

  it("email HỎNG của cùng mẻ nằm TRONG cụm, không trôi ra ngoài", () => {
    const at = "2026-08-30T02:00:00Z";
    const r = report([
      txn({ kind: "invite_refund", amount: FEE, balance_after: 0, meta: { email: "c@x.com" }, created_at: "2026-08-30T02:05:00Z" }),
      txn({ kind: "invite_fee", amount: -FEE, balance_after: 0, meta: { email: "a@x.com" }, created_at: at }),
      txn({ kind: "invite_fee", amount: -FEE, balance_after: FEE, meta: { email: "b@x.com" }, created_at: at }),
      txn({ kind: "invite_fee", amount: -FEE, balance_after: 2 * FEE, meta: { email: "c@x.com" }, reversed: true, created_at: at }),
      txn({ kind: "order_topup", amount: 3 * FEE, balance_after: 3 * FEE, ref_type: "order", ref_code: "ORD1", created_at: at }),
    ]);
    expect(r.days[0].clusters).toHaveLength(1);
    const c = r.days[0].clusters[0];
    expect(c.charged).toBe(2);
    expect(c.voided).toBe(1);
    // Lượt hỏng mang luôn mã hoá đơn của mẻ, không để trống như thể lệnh vô chủ.
    const bad = c.entries.find((e) => e.voided);
    expect(bad?.email).toBe("c@x.com");
    expect(bad?.refCode).toBe("ORD1");
  });

  it("email lẻ KHÔNG kẻ dải cụm", () => {
    const r = report([
      txn({ kind: "invite_fee", amount: -FEE, balance_after: 0, meta: { email: "a@x.com" } }),
    ]);
    expect(r.days[0].clusters[0].label).toBe("");
  });
});

describe("lượt mời hỏng", () => {
  it("ghi thực chi 0 và đánh dấu Kết quả là hỏng", () => {
    const r = report([
      txn({ kind: "invite_refund", amount: FEE, balance_after: FEE, meta: { email: "a@x.com" }, created_at: "2026-08-30T02:30:00Z" }),
      txn({ kind: "invite_fee", amount: -FEE, balance_after: 0, meta: { email: "a@x.com" }, reversed: true, created_at: "2026-08-30T02:00:00Z" }),
    ]);
    const e = r.days[0].clusters[0].entries[0];
    expect(e.voided).toBe(true);
    expect(e.outcome).toBe("Lỗi, đã hoàn phí");
    expect(e.label).toBe("Phí mời - Đã hoàn");
    expect(e.moneyIn).toBe(FEE);
    expect(e.moneyOut).toBe(FEE);
    // Dư trước = dư sau ⇒ nhìn một dòng là biết tiền có đi có về.
    expect(e.balanceBefore).toBe(e.balanceAfter);
    // Không tính vào thực chi của ngày, dù hai chiều tiền đều có mặt.
    expect(r.days[0].spend).toBe(0);
    expect(r.days[0].emails[0].spend).toBe(0);
    expect(r.days[0].emails[0].voided).toBe(1);
  });
});

describe("email đầy đủ", () => {
  it("in nguyên email, không cắt phần sau @", () => {
    const r = report([
      txn({ kind: "invite_fee", amount: -FEE, balance_after: 0, meta: { email: "nam.tran@congty.vn" } }),
    ]);
    expect(r.days[0].clusters[0].entries[0].email).toBe("nam.tran@congty.vn");
    expect(r.days[0].emails[0].email).toBe("nam.tran@congty.vn");
    expect(r.days[0].roster[0].email).toBe("nam.tran@congty.vn");
  });
});

describe("sheet Email trong ngày", () => {
  it("ghép trạng thái, hạn dùng và chuỗi đổi email từ danh sách thành viên", () => {
    const r = report(
      [txn({ kind: "invite_fee", amount: -FEE, balance_after: 0, meta: { email: "cu@x.com" } })],
      [
        {
          email: "cu@x.com",
          status: "removed",
          subscription_end_at: "2026-09-29T02:00:00Z",
          payment_status: "paid",
          removed_reason: "email_changed",
          email_changed_to: ["moi@x.com"],
          workspace_name: "GPT1",
        },
      ],
    );
    const row = r.days[0].roster[0];
    expect(row.status).toBe("Đã rời đội");
    expect(row.payment).toBe("Đã thu");
    expect(row.expiry).toBe("29/09/2026");
    expect(row.changedTo).toBe("cu@x.com → moi@x.com");
    expect(row.note).toBe("Đã đổi sang email khác");
    expect(r.hasMembers).toBe(true);
  });

  it("thiếu dữ liệu thành viên thì nói rõ trong sheet chứ không im lặng bỏ cột", () => {
    const r = report([txn({ kind: "invite_fee", amount: -FEE, balance_after: 0, meta: { email: "a@x.com" } })]);
    expect(r.hasMembers).toBe(false);
    const sheet = sheetOf(reportSheets(r), "Email trong ngày");
    expect(rowText(sheet.rows[0])).toContain("Không tải được danh sách email đã add");
  });
});

describe("dải ngày", () => {
  it("mọi sheet dùng chung một dòng tiêu đề ngày", () => {
    const sheets = reportSheets(
      report([
        txn({ kind: "topup", amount: 1_000_000, balance_after: 1_000_000, ref_type: "topup", created_at: "2026-08-30T02:00:00Z" }),
        txn({ kind: "invite_fee", amount: -FEE, balance_after: 670_000, meta: { email: "a@x.com" }, created_at: "2026-08-30T03:00:00Z" }),
      ]),
    );
    const band = "30/08/2026 — chủ nhật · tiền vào 1.000.000 · chi 330.000 · 1 mời mới";
    for (const name of ["Chi tiết lệnh", "Theo email", "Email trong ngày"]) {
      const texts = sheetOf(sheets, name).rows.map((row) => String(val(row[0]) ?? ""));
      expect(texts).toContain(band);
    }
  });
});

describe("reportCsv", () => {
  it("phẳng, ngăn cách ';', có cột lệnh + mã hoá đơn + kết quả", () => {
    const at = "2026-08-30T02:00:00Z";
    const lines = reportCsv(
      report([
        txn({ kind: "invite_fee", amount: -FEE, balance_after: 0, meta: { email: "a@x.com" }, created_at: at }),
        txn({ kind: "invite_fee", amount: -FEE, balance_after: FEE, meta: { email: "b@x.com" }, created_at: at }),
        txn({ kind: "order_topup", amount: 2 * FEE, balance_after: 2 * FEE, ref_type: "order", ref_code: "ORD1", created_at: at }),
      ]),
    ).split("\n");
    expect(lines[0]).toBe(
      "Ngày;Giờ;Lệnh;Nội dung;Kết quả;Email;Tiền vào (đ);Tiền ra (đ);Số dư trước (đ);Số dư sau (đ);Mã hoá đơn;Mã GD SePay;Ghi chú",
    );
    // Xuôi thời gian: b@x.com bị trừ trước (số dư 660.000 → 330.000), rồi tới a@x.com.
    expect(lines[1]).toContain("#0;Phí mời - Hoá đơn;Thành công;b@x.com;330000;330000;330000;330000;ORD1");
    expect(lines[2]).toContain("#0;Phí mời - Hoá đơn;Thành công;a@x.com;330000;330000;0;0;ORD1");
    // 2 email = 2 dòng. Dòng `order_topup` đã gộp vào dòng phí nên không còn dòng thứ 3.
    expect(lines).toHaveLength(3);
  });
});

/* Ca `sonvvng` 15/8/2026: lời mời THẬT SỰ vào đội nhưng bị chốt hỏng + hoàn phí, đồng
   bộ sau đó dựng lại member. Ví chỉ thấy "đã hoàn phí" nên báo cáo phải đối chiếu sang
   danh sách thành viên mới nói được rốt cuộc email có vào đội hay không. */
describe("lượt hỏng — đối chiếu với danh sách đội", () => {
  const bad = (members: MemberInfo[] = []) =>
    report(
      [
        txn({ kind: "invite_refund", amount: FEE, balance_after: FEE, meta: { email: "a@x.com" }, created_at: "2026-08-30T02:30:00Z" }),
        txn({ kind: "invite_fee", amount: -FEE, balance_after: 0, meta: { email: "a@x.com" }, reversed: true, created_at: "2026-08-30T02:00:00Z" }),
      ],
      members,
    );

  it("email VẪN trong đội ⇒ đòi truy thu", () => {
    const r = bad([{ email: "a@x.com", status: "active", subscription_end_at: null, payment_status: "unpaid" }]);
    expect(r.days[0].clusters[0].entries[0].note).toContain("Cần Truy Thu");
    expect(r.days[0].roster[0].outcome).toContain("Lỗi, đã hoàn phí. Cần Truy Thu");
  });

  it("email rời đội vì mời hỏng ⇒ đúng là chưa vào đội", () => {
    const r = bad([{ email: "a@x.com", status: "removed", subscription_end_at: null, payment_status: "unpaid", removed_reason: "invite_failed" }]);
    expect(r.days[0].roster[0].outcome).toContain("Đúng là chưa vào đội");
    expect(r.days[0].roster[0].outcome).not.toContain("Cần ");
  });

  it("email rời vì HẾT HẠN ⇒ nó đã từng ở trong đội, phải kiểm", () => {
    const r = bad([{ email: "a@x.com", status: "removed", subscription_end_at: null, payment_status: "unpaid", removed_reason: "expired" }]);
    expect(r.days[0].roster[0].outcome).toContain("Cần Kiểm");
    expect(r.days[0].roster[0].outcome).toContain("hết hạn");
  });

  it("không có danh sách thành viên ⇒ nói thẳng là chưa đối chiếu được", () => {
    expect(bad().days[0].roster[0].outcome).toContain("Chưa đối chiếu được");
  });
});

/* Ca thật ví hdh2102 ngày 30/8/2026 (user gửi ảnh file xuất): 50 lượt phí, 36 lượt
   hỏng đã hoàn đủ, 3 hoá đơn nuôi 14 suất thật. Bản cũ cộng cả tiền chạy vòng nên
   khối chỉ số ghi 16.500.000 vào và 16.500.000 ra — gấp 3,5 lần dòng tiền thật và
   không khớp nổi với sao kê ngân hàng ("dù hoàn hay không hoàn thì tổng số dư vào và
   ra không thể vượt quá những gì đối soát"). */
describe("tiền vào/ra không được phình vì lượt lỗi", () => {
  const OK = 14, BAD = 36, PER_ORDER = 5;

  function scene() {
    const txns: WalletTxn[] = [];
    let bal = 0;
    const at = (i: number) => `2026-08-30T0${1 + Math.floor(i / 30)}:${String(i % 60).padStart(2, "0")}:00Z`;
    let k = 0;
    // 3 hoá đơn nuôi 14 suất thật.
    for (let o = 0; o < 3; o++) {
      const seats = o < 2 ? PER_ORDER : OK - 2 * PER_ORDER;
      bal += seats * FEE;
      txns.push(txn({ kind: "order_topup", amount: seats * FEE, balance_after: bal, ref_type: "order", ref_code: `ORD${o}`, created_at: at(k) }));
      for (let i = 0; i < seats; i++) {
        bal -= FEE;
        txns.push(txn({ kind: "invite_fee", amount: -FEE, balance_after: bal, meta: { email: `ok${o}-${i}@x.com` }, created_at: at(k) }));
      }
      k += 1;
    }
    // 36 lượt hỏng: trừ phí rồi hoàn lại đủ, số dư về đúng chỗ cũ.
    for (let i = 0; i < BAD; i++) {
      const email = `bad${i}@x.com`;
      const ref = `q${i}`;
      bal -= FEE;
      txns.push(txn({ kind: "invite_fee", amount: -FEE, balance_after: bal, ref_id: ref, meta: { email }, reversed: true, created_at: at(k) }));
      bal += FEE;
      txns.push(txn({ kind: "invite_refund", amount: FEE, balance_after: bal, ref_id: ref, meta: { email }, created_at: at(k + 1) }));
      k += 2;
    }
    return txns.reverse(); // API trả mới → cũ
  }

  it("tổng vào/ra bằng đúng tiền thật, không cộng tiền chạy vòng", () => {
    const r = report(scene());
    expect(r.moneyIn).toBe(OK * FEE);
    expect(r.moneyOut).toBe(OK * FEE);
    expect(r.grossIn).toBe((OK + BAD) * FEE);
    expect(r.grossOut).toBe((OK + BAD) * FEE);
    expect(r.voidedAmount).toBe(BAD * FEE);
  });

  it("bỏ cả CẶP nên đẳng thức đầu + vào − ra = cuối vẫn đúng", () => {
    const r = report(scene());
    expect(r.opening + r.moneyIn - r.moneyOut).toBe(r.closing);
  });

  it("tổng theo ngày cũng không đếm lượt lỗi", () => {
    const r = report(scene());
    expect(r.days.reduce((s, d) => s + d.moneyIn, 0)).toBe(OK * FEE);
    expect(r.days.reduce((s, d) => s + d.moneyOut, 0)).toBe(OK * FEE);
  });

  it("dải ngày ghi tiền vào thật, không ghi 'nạp 0' khi tiền vào bằng hoá đơn", () => {
    const sheets = reportSheets(report(scene()));
    const band = sheetOf(sheets, "Chi tiết lệnh").rows
      .map((row) => String(val(row[0]) ?? ""))
      .find((t) => t.startsWith("30/08/2026"));
    expect(band).toContain(`tiền vào ${(OK * FEE).toLocaleString("vi-VN")}`);
    expect(band).not.toContain("nạp 0");
  });
});

/* Lượt trả THANG qua hoá đơn ghi 2 bút toán cùng lúc (+X vào ví rồi −X ra ngay). Hiện
   2 dòng thì một lượt mời đọc mất 2 dòng ngược dấu mà số dư không nhúc nhích
   (user 2026-08-30: "thể hiện 1 dòng thôi: Phí mời - Hoá đơn"). */
describe("gộp dòng hoá đơn vào dòng phí", () => {
  const at = "2026-08-30T02:00:00Z";

  it("1 email trả qua hoá đơn ⇒ ĐÚNG 1 dòng, ghi 'Phí mời - Hoá đơn'", () => {
    const r = report([
      txn({ kind: "invite_fee", amount: -FEE, balance_after: 0, meta: { email: "a@x.com" }, created_at: at }),
      txn({ kind: "order_topup", amount: FEE, balance_after: FEE, ref_type: "order", ref_code: "ORD1", created_at: at }),
    ]);
    const es = r.days[0].clusters[0].entries;
    expect(es).toHaveLength(1);
    expect(es[0].label).toBe("Phí mời - Hoá đơn");
    expect(es[0].email).toBe("a@x.com");
    expect(es[0].moneyIn).toBe(FEE);
    expect(es[0].moneyOut).toBe(FEE);
    // Dòng gộp ôm cả hai bút toán ⇒ số dư trước = sau, ví không nhúc nhích.
    expect(es[0].balanceBefore).toBe(0);
    expect(es[0].balanceAfter).toBe(0);
    expect(es[0].refCode).toBe("ORD1");
  });

  it("trừ thẳng số dư ví ⇒ ghi 'Phí mời - Số dư ví', không có dòng hoá đơn", () => {
    const r = report([
      txn({ kind: "invite_fee", amount: -FEE, balance_after: 0, meta: { email: "a@x.com" }, created_at: at }),
    ]);
    const es = r.days[0].clusters[0].entries;
    expect(es).toHaveLength(1);
    expect(es[0].label).toBe("Phí mời - Số dư ví");
    expect(es[0].moneyIn).toBe(0);
  });

  it("mẻ nhiều email: mỗi email một dòng, KHÔNG còn dòng hoá đơn riêng", () => {
    const r = report([
      txn({ kind: "invite_fee", amount: -FEE, balance_after: 0, meta: { email: "a@x.com" }, created_at: at }),
      txn({ kind: "invite_fee", amount: -FEE, balance_after: FEE, meta: { email: "b@x.com" }, created_at: at }),
      txn({ kind: "order_topup", amount: 2 * FEE, balance_after: 2 * FEE, ref_type: "order", ref_code: "ORD1", created_at: at }),
    ]);
    const es = r.days[0].clusters[0].entries;
    expect(es).toHaveLength(2);
    expect(es.every((e) => e.label === "Phí mời - Hoá đơn")).toBe(true);
    expect(es.reduce((s, e) => s + e.moneyIn, 0)).toBe(2 * FEE);
  });

  it("hoá đơn trả DƯ so với phí ⇒ phần dư vẫn có dòng riêng, không bị nuốt", () => {
    const r = report([
      txn({ kind: "invite_fee", amount: -FEE, balance_after: FEE, meta: { email: "a@x.com" }, created_at: at }),
      txn({ kind: "order_topup", amount: 2 * FEE, balance_after: 2 * FEE, ref_type: "order", ref_code: "ORD1", created_at: at }),
    ]);
    const es = r.days[0].clusters[0].entries;
    expect(es).toHaveLength(2);
    expect(es[1].moneyIn).toBe(FEE);
    expect(es[1].note).toBe("Tiền hoá đơn còn lại trong ví");
    // Tổng vào/ra của ngày không đổi so với khi hiện 2 dòng.
    expect(r.days[0].moneyIn).toBe(2 * FEE);
    expect(r.days[0].moneyOut).toBe(FEE);
  });
});

/* Thứ tự đọc của file xuất ngược với màn hình: màn hình mới-trước (mở ra thấy việc vừa
   xảy ra), file cũ-trước để cột số dư nối liền mạch và dòng cuối là số dư CHỐT
   (user 2026-08-30: "cuối cùng lệnh trừ số dư ví phải bằng 0"). */
describe("thứ tự xuôi thời gian", () => {
  function threeDays() {
    const mk = (d: string, h: string, bal: number, email: string) =>
      txn({ kind: "invite_fee", amount: -FEE, balance_after: bal, meta: { email }, created_at: `2026-08-${d}T0${h}:00:00Z` });
    // API trả mới → cũ.
    return [mk("30", "3", 0, "c@x.com"), mk("30", "2", FEE, "b@x.com"), mk("29", "2", 2 * FEE, "a@x.com")];
  }

  it("ngày cũ đứng trước ngày mới", () => {
    const r = report(threeDays());
    expect(r.days.map((d) => d.date)).toEqual(["2026-08-29", "2026-08-30"]);
  });

  it("trong ngày, số dư chạy giảm dần xuống dòng cuối", () => {
    const r = report(threeDays());
    const day30 = r.days[1].clusters.flatMap((c) => c.entries);
    expect(day30.map((e) => e.email)).toEqual(["b@x.com", "c@x.com"]);
    expect(day30.map((e) => e.balanceAfter)).toEqual([FEE, 0]);
    // Dòng cuối cùng mang đúng số dư chốt của kỳ.
    expect(day30[day30.length - 1].balanceAfter).toBe(r.closing);
  });

  it("Dư sau của dòng trên nối đúng Dư trước của dòng dưới", () => {
    const r = report(threeDays());
    const all = r.days.flatMap((d) => d.clusters.flatMap((c) => c.entries));
    for (let i = 1; i < all.length; i++) {
      expect(all[i].balanceBefore).toBe(all[i - 1].balanceAfter);
    }
  });
});

/* Ca ví hdh2102 ngày 30/8 (ảnh user gửi): số dư nhảy từ 0 lên 3.960.000 giữa hai dòng
   liền nhau, vì trang Ví GIẤU các khoản hoàn đã bị lượt sau tiêu hết còn báo cáo thì
   dùng lại đúng danh sách đã lọc đó. Sổ tiền thiếu dòng là không đối soát được. */
describe("sổ phải đủ dòng", () => {
  /** Hoàn 990.000 rồi lượt sau tiêu hết — trang Ví giấu dòng hoàn này đi. */
  function scene() {
    const t = (kind: WalletTxn["kind"], amount: number, bal: number, at: string, email: string, over: Partial<WalletTxn> = {}) =>
      txn({ kind, amount, balance_after: bal, meta: { email }, created_at: at, ...over });
    return [
      t("invite_fee", -FEE, 0, "2026-08-30T04:00:00Z", "moi3@x.com"),
      t("invite_fee", -FEE, FEE, "2026-08-30T04:00:00Z", "moi2@x.com"),
      t("invite_fee", -FEE, 2 * FEE, "2026-08-30T04:00:00Z", "moi1@x.com"),
      t("invite_refund", FEE, 3 * FEE, "2026-08-30T03:00:00Z", "hong3@x.com"),
      t("invite_refund", FEE, 2 * FEE, "2026-08-30T03:00:00Z", "hong2@x.com"),
      t("invite_refund", FEE, FEE, "2026-08-30T03:00:00Z", "hong1@x.com"),
    ];
  }

  it("khoản hoàn đã bị tiêu hết VẪN phải có dòng, không được giấu", () => {
    const r = report(scene());
    const emails = r.days.flatMap((d) => d.clusters.flatMap((c) => c.entries.map((e) => e.email)));
    expect(emails).toContain("hong1@x.com");
    expect(emails).toContain("hong2@x.com");
    expect(emails).toContain("hong3@x.com");
  });

  it("số dư nối liền mạch, không có chỗ đứt", () => {
    expect(report(scene()).chainBreaks).toBe(0);
  });

  it("thiếu bút toán thì ĐẾM ĐƯỢC và nói ra, không im lặng", () => {
    // Bỏ đúng một khoản hoàn giữa chừng ⇒ số dư nhảy 330.000 không có gì giải thích.
    const thieu = scene().filter((t) => (t.meta as { email: string }).email !== "hong2@x.com");
    expect(report(thieu).chainBreaks).toBe(1);
  });
});

/* Dòng gộp "Phí mời - Hoá đơn" ôm hai bút toán, nên nếu lấy Dư trước của riêng dòng
   phí thì nó lệch đúng bằng số tiền hoá đơn và chuỗi số dư đứt ngay tại đó. */
describe("dòng gộp vẫn nối được mạch số dư", () => {
  it("xen kẽ hoá đơn và trừ ví, chuỗi số dư không đứt chỗ nào", () => {
    const at = (h: number) => `2026-08-30T0${h}:00:00Z`;
    const items = [
      // mới → cũ
      txn({ kind: "invite_fee", amount: -FEE, balance_after: 0, meta: { email: "d@x.com" }, created_at: at(6) }),
      txn({ kind: "order_topup", amount: FEE, balance_after: FEE, ref_type: "order", ref_code: "O2", created_at: at(6) }),
      txn({ kind: "invite_fee", amount: -FEE, balance_after: 0, meta: { email: "c@x.com" }, created_at: at(5) }),
      txn({ kind: "topup", amount: FEE, balance_after: FEE, ref_type: "topup", created_at: at(4) }),
      txn({ kind: "invite_fee", amount: -FEE, balance_after: 0, meta: { email: "a@x.com" }, created_at: at(3) }),
      txn({ kind: "order_topup", amount: FEE, balance_after: FEE, ref_type: "order", ref_code: "O1", created_at: at(3) }),
    ];
    const r = report(items);
    expect(r.chainBreaks).toBe(0);
    const all = r.days.flatMap((d) => d.clusters.flatMap((c) => c.entries));
    expect(all.map((e) => `${e.balanceBefore}>${e.balanceAfter}`)).toEqual([
      "0>0", `0>${FEE}`, `${FEE}>0`, "0>0",
    ]);
  });
});

/* Ca thật ví hdh2102 30/8 (ảnh user gửi): 12 email mời hỏng liên tiếp mấy mẻ, hoàn phí
   đủ, rồi MỜI LẠI ĐƯỢC và bị tính phí đàng hoàng. Bản trước gắn cả 12 dòng nhãn
   "Cần Truy Thu" chỉ vì email đang ở trong đội — trong khi tiền đã thu ở lượt sau
   (user: "lỗi đã hoàn phí, và xác nhận chưa mời thành công sao lại truy thu?"). */
describe("mời lại thành công thì không đòi truy thu", () => {
  const inTeam: MemberInfo[] = [
    { email: "a@x.com", status: "active", subscription_end_at: null, payment_status: "unpaid" },
  ];

  /** Hỏng lúc 02:00 (hoàn 02:05), mời lại tính phí thật lúc 03:00. */
  const reInvited = () => [
    txn({ kind: "invite_fee", amount: -FEE, balance_after: 0, meta: { email: "a@x.com" }, created_at: "2026-08-30T03:00:00Z" }),
    txn({ kind: "invite_refund", amount: FEE, balance_after: FEE, ref_id: "q1", meta: { email: "a@x.com" }, created_at: "2026-08-30T02:05:00Z" }),
    txn({ kind: "invite_fee", amount: -FEE, balance_after: 0, ref_id: "q1", meta: { email: "a@x.com" }, reversed: true, created_at: "2026-08-30T02:00:00Z" }),
  ];

  it("dòng lỗi ghi 'đã mời lại thành công', KHÔNG đòi truy thu", () => {
    const r = report(reInvited(), inTeam);
    const bad = r.days.flatMap((d) => d.clusters.flatMap((c) => c.entries)).find((e) => e.voided);
    expect(bad?.note).toContain("Đã mời lại thành công sau đó.");
    expect(bad?.note).not.toContain("Truy Thu");
    expect(r.days[0].roster[0].outcome).not.toContain("Truy Thu");
  });

  it("hỏng mà KHÔNG mời lại, email vẫn trong đội ⇒ vẫn đòi truy thu", () => {
    const r = report(
      [
        txn({ kind: "invite_refund", amount: FEE, balance_after: FEE, ref_id: "q1", meta: { email: "a@x.com" }, created_at: "2026-08-30T02:05:00Z" }),
        txn({ kind: "invite_fee", amount: -FEE, balance_after: 0, ref_id: "q1", meta: { email: "a@x.com" }, reversed: true, created_at: "2026-08-30T02:00:00Z" }),
      ],
      inTeam,
    );
    const bad = r.days.flatMap((d) => d.clusters.flatMap((c) => c.entries)).find((e) => e.voided);
    expect(bad?.note).toContain("Cần Truy Thu");
  });

  it("cả mẻ lỗi hết thì dải cụm không ghi 'trừ số dư ví 0'", () => {
    const at = "2026-08-30T02:00:00Z";
    const r = report([
      txn({ kind: "invite_refund", amount: FEE, balance_after: 2 * FEE, ref_id: "q2", meta: { email: "b@x.com" }, created_at: "2026-08-30T02:05:00Z" }),
      txn({ kind: "invite_refund", amount: FEE, balance_after: FEE, ref_id: "q1", meta: { email: "a@x.com" }, created_at: "2026-08-30T02:05:00Z" }),
      txn({ kind: "invite_fee", amount: -FEE, balance_after: 0, ref_id: "q2", meta: { email: "b@x.com" }, reversed: true, created_at: at }),
      txn({ kind: "invite_fee", amount: -FEE, balance_after: FEE, ref_id: "q1", meta: { email: "a@x.com" }, reversed: true, created_at: at }),
    ]);
    const band = sheetOf(reportSheets(r), "Chi tiết lệnh").rows
      .map((row) => String(val(row[0]) ?? ""))
      .find((t) => t.startsWith("Lệnh mời"));
    expect(band).toContain("cả mẻ lỗi, đã hoàn đủ phí");
    expect(band).not.toContain("trừ số dư ví 0");
  });
});
