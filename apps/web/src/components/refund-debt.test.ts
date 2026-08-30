import { describe, expect, it } from "vitest";
import { isRefundDebtSettled } from "./MemberDetailModal";

/* Món nợ "đã hoàn phí mà email vẫn ở trong team" đã thu lại chưa — luật này quyết
   định dòng nhật ký hiện chấm ĐỎ "cần truy thu" hay chấm XANH "đã truy thu xong".
   Phải trùng khít với backend (`_flag_refunded_while_in_team`, members/reconcile.py):
   lệch nhau là một bên im còn một bên vẫn đỏ (user 26/8/2026). */

const FEE = 330_000;

type Entry = Parameters<typeof isRefundDebtSettled>[0][number];

function entry(over: Partial<Entry> & Pick<Entry, "id" | "kind" | "amount">): Entry {
  return {
    balance_after: 0,
    ref_type: null,
    ref_id: null,
    meta: null,
    created_at: "2026-08-15T12:00:00Z",
    ...over,
  } as Entry;
}

const fee = entry({
  id: "f1",
  kind: "invite_fee",
  amount: -FEE,
  reversed: true,
  created_at: "2026-08-15T12:58:00Z",
});
const refund = entry({
  id: "r1",
  kind: "invite_refund",
  amount: FEE,
  created_at: "2026-08-15T14:11:00Z",
});

describe("isRefundDebtSettled", () => {
  it("chưa thu lại đồng nào → còn nợ (ca sonvvng)", () => {
    expect(isRefundDebtSettled([refund, fee])).toBe(false);
  });

  it("admin truy thu tay bằng `adjust` → đã xong (ca congminhpanda 12/8)", () => {
    const truyThu = entry({
      id: "a1",
      kind: "adjust",
      amount: -FEE,
      created_at: "2026-08-15T14:41:00Z",
    });
    expect(isRefundDebtSettled([truyThu, refund, fee])).toBe(true);
  });

  it("đại lý bấm Thanh toán (`cycle_fee`) → đã xong", () => {
    // Đường CHÍNH từ 29/8/2026. Trước khi nhận `cycle_fee`, luật cũ vẫn báo đỏ
    // "cần truy thu" ngay sau khi đại lý vừa trả tiền — đúng kiểu nhầm lẫn mà bản
    // vá này sinh ra để dẹp.
    const daTra = entry({
      id: "c1",
      kind: "cycle_fee",
      amount: -FEE,
      ref_type: "cycle",
      created_at: "2026-08-29T13:00:00Z",
    });
    expect(isRefundDebtSettled([daTra, refund, fee])).toBe(true);
  });

  it("thu gộp nhiều kỳ (nhiều hơn số đã hoàn) vẫn tính là đã xong", () => {
    const gop = entry({
      id: "c2",
      kind: "cycle_fee",
      amount: -FEE * 2,
      created_at: "2026-08-29T13:00:00Z",
    });
    expect(isRefundDebtSettled([gop, refund, fee])).toBe(true);
  });

  it("mời lại TRÓT LỌT ngay sau khi hoàn → đã xong (ca mahlasaei2 28/8)", () => {
    // Mời hỏng đi theo chùm: hỏng → hoàn → thử lại ngay. Lượt thứ 4 trót lọt sau
    // 2,5 phút chính là tiền của tháng vừa bị hoàn.
    const moiLai = entry({
      id: "f2",
      kind: "invite_fee",
      amount: -FEE,
      created_at: "2026-08-15T14:13:30Z",
    });
    expect(isRefundDebtSettled([moiLai, refund, fee])).toBe(true);
  });

  it("mời lại THÁNG SAU không phải trả nợ tháng trước", () => {
    // Ngoài cửa sổ 1 giờ ⇒ mua tháng mới. Tính nhầm là giấu mất tiền — tệ hơn hẳn
    // so với báo đỏ thừa, nên chỗ lưỡng lự phải nghiêng về "còn nợ".
    const thangSau = entry({
      id: "f3",
      kind: "invite_fee",
      amount: -FEE,
      created_at: "2026-09-14T09:00:00Z",
    });
    expect(isRefundDebtSettled([thangSau, refund, fee])).toBe(false);
  });

  it("mời lại nhưng LẠI BỊ HOÀN tiếp thì chưa thu được gì", () => {
    const moiLaiHong = entry({
      id: "f4",
      kind: "invite_fee",
      amount: -FEE,
      reversed: true,
      created_at: "2026-08-15T14:13:30Z",
    });
    expect(isRefundDebtSettled([moiLaiHong, refund, fee])).toBe(false);
  });

  it("GIA HẠN tháng sau KHÔNG phải là trả nợ tháng trước", () => {
    // Đây là lý do không được rút gọn thành "thực thu > 0": `renew_fee` đẩy thực
    // thu lên dương trong khi món nợ cũ vẫn còn nguyên.
    const giaHan = entry({
      id: "rn1",
      kind: "renew_fee",
      amount: -FEE,
      created_at: "2026-09-14T09:00:00Z",
    });
    expect(isRefundDebtSettled([giaHan, refund, fee])).toBe(false);
  });

  it("bút toán thu TRƯỚC lần hoàn không tính (hoàn sau là nợ mới)", () => {
    const truyThuCu = entry({
      id: "a2",
      kind: "adjust",
      amount: -FEE,
      created_at: "2026-08-15T13:00:00Z",
    });
    expect(isRefundDebtSettled([truyThuCu, refund, fee])).toBe(false);
  });

  it("chưa từng bị hoàn phí → không có nợ nào để nói tới", () => {
    expect(isRefundDebtSettled([fee])).toBe(false);
  });

  it("hoàn nhiều lần thì tính theo lần hoàn CUỐI (ca phamminhthang 6 lượt)", () => {
    const refund2 = entry({
      id: "r2",
      kind: "invite_refund",
      amount: FEE,
      created_at: "2026-08-15T15:00:00Z",
    });
    const truyThu = entry({
      id: "a3",
      kind: "adjust",
      amount: -FEE,
      created_at: "2026-08-15T14:41:00Z", // sau lần hoàn 1, TRƯỚC lần hoàn 2
    });
    expect(isRefundDebtSettled([refund2, truyThu, refund, fee])).toBe(false);
  });
});
