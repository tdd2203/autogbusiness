/**
 * LƯỢT ĐỌC KIỂM sau khi đã mua suất — chốt chặn "không mua lần hai".
 *
 * Bối cảnh: mua suất xong mà trang còn lớp phủ thì content trả quyền về
 * background; background tải lại trang rồi gọi LẠI lệnh mời với
 * `seatsPurchasedAlready = N` (⇒ `opts.alreadyPurchased` ở đây). Lượt đó chỉ
 * được ĐỌC KIỂM. Mua tiếp là mua đúp bằng tiền thật cho cùng một lệnh mời.
 *
 * Test gọi thẳng `ensureSeatsForInvite` (không phải một hàm con thuần) đúng vì
 * thứ cần khoá là THỨ TỰ: chốt `alreadyPurchased` phải đứng TRƯỚC lời gọi
 * `executePurchaseSeat`. Ai đó dời cú gọi mua lên trên chốt thì chỉ bộ test này
 * bắt được.
 *
 * Vế thứ hai: mọi đường ra của lượt đọc kiểm phải mang theo `seat_purchased = N`.
 * Trả 0 là khai man "lệnh này không tiêu tiền" — dashboard mất dấu khoản đã trừ,
 * và `withExtraData` bên `runner.ts` ưu tiên số của lượt sau nên số thật của lượt
 * mua bị số 0 này đè mất.
 *
 * Không có jsdom → chỉ dựng đúng mấy global mà hàm chạm tới.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const executePurchaseSeat = vi.fn();
const checkSeatAvailability = vi.fn();

vi.mock("../../human", () => ({ sleep: async () => {} }));
vi.mock("../../progress", () => ({ reportProgress: async () => {} }));
vi.mock("../external-invites/navigate", () => ({ navigateTo: async () => true }));
vi.mock("./read-member-count", () => ({ readMemberCountFromPage: () => null }));
vi.mock("./count-pending-invites", () => ({
  countPendingInvites: async () => ({ authoritative: true, emails: [], reason: null }),
}));
vi.mock("../purchase-seat/read-seat-cards", () => ({
  readSeatCardsFromPage: () => null,
  describeSeatCards: () => "",
}));
vi.mock("../purchase-seat/check-seat-availability", () => ({
  checkSeatAvailability: (...a: unknown[]) => checkSeatAvailability(...a),
}));
vi.mock("../purchase-seat/execute-purchase-seat", () => ({
  executePurchaseSeat: (...a: unknown[]) => executePurchaseSeat(...a),
}));

import { ensureSeatsForInvite } from "./ensure-seats";

/** Hộp "Quản lý suất" đọc ra `total` suất, `assigned` đã gán. */
function seatModal(
  total: number,
  assigned: number,
  extra: Record<string, unknown> = {},
) {
  return {
    supported: true,
    modalClosed: true,
    availability: { total, assigned, free: Math.max(0, total - assigned) },
    ratioTotal: total,
    safeTotal: total,
    uncertain: false,
    uncertainReason: null,
    stepperTotal: total,
    modalText: "",
    source: "modal",
    cards: null,
    error: null,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // @ts-expect-error — dựng global tối thiểu cho content script
  globalThis.location = { pathname: "/admin/members", search: "" };
  executePurchaseSeat.mockResolvedValue({
    ok: true,
    data: { confirm_charge_clicked: true },
  });
});

describe("đã mua ở lượt trước → CẤM mua lần hai", () => {
  it("đọc lại vẫn thiếu suất: dừng, KHÔNG gọi luồng mua", async () => {
    checkSeatAvailability.mockResolvedValue(seatModal(62, 62));

    const r = await ensureSeatsForInvite("task-1", 1, ["a@x.com"], undefined, {
      alreadyPurchased: 2,
    });

    expect(executePurchaseSeat).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe("SEAT_PURCHASE_FAILED");
    expect(r.error_message).toContain("ĐÃ MUA 2 suất");
    expect(r.data.seat_purchased).toBe(2);
  });

  it("đọc lại thấy đủ: mời tiếp, vẫn khai đúng 2 suất đã mua", async () => {
    checkSeatAvailability.mockResolvedValue(seatModal(64, 62));

    const r = await ensureSeatsForInvite("task-1", 1, ["a@x.com"], undefined, {
      alreadyPurchased: 2,
    });

    expect(executePurchaseSeat).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.data.seat_purchased).toBe(2);
  });

  it("số suất đọc ra KHÔNG chắc: dừng mà vẫn giữ dấu 2 suất đã trừ tiền", async () => {
    // Bộ đếm và dòng tỉ lệ nói hai tổng khác nhau — hay gặp ngay sau một cú mua
    // chập chờn. Nhánh này cấm mua (đúng), nhưng nếu nó khai `seat_purchased: 0`
    // thì số 0 sẽ ĐÈ số thật của lượt mua khi `runner.ts` gắp `seat_*` sang kết
    // quả cuối ⇒ dashboard tưởng lệnh này không tiêu đồng nào.
    checkSeatAvailability.mockResolvedValue(
      seatModal(62, 62, { uncertain: true, uncertainReason: "bộ đếm 150, dòng tỉ lệ 151" }),
    );

    const r = await ensureSeatsForInvite("task-1", 1, ["a@x.com"], undefined, {
      alreadyPurchased: 2,
    });

    expect(executePurchaseSeat).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.data.seat_purchased).toBe(2);
  });
});

describe("lượt mời bình thường (chưa mua gì) vẫn mua bù như cũ", () => {
  it("thiếu suất → gọi đúng luồng mua với số suất còn thiếu", async () => {
    checkSeatAvailability.mockResolvedValue(seatModal(62, 62));

    await ensureSeatsForInvite("task-1", 1, ["a@x.com"]);

    expect(executePurchaseSeat).toHaveBeenCalledWith("task-1", 1);
  });

  it("đang chạy song song (noPurchase) thì trả khoá chứ không mua", async () => {
    checkSeatAvailability.mockResolvedValue(seatModal(62, 62));

    const r = await ensureSeatsForInvite("task-1", 1, ["a@x.com"], undefined, {
      noPurchase: true,
    });

    expect(executePurchaseSeat).not.toHaveBeenCalled();
    expect(r.error_code).toBe("SEAT_LOCK_REQUIRED");
  });
});
