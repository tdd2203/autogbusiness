import { describe, expect, it } from "vitest";

import { dashboardPendingDebt, freeSeatsWithPendingDebt } from "./seat-math";

describe("freeSeatsWithPendingDebt", () => {
  it("ca thật CHATGPT PRO 24/8/2026: 60/60 đã gán + 1 lời mời treo → HẾT chỗ", () => {
    expect(freeSeatsWithPendingDebt(60, 60, 1)).toBe(0);
  });

  it("ca thật GPT1 24/8/2026: 148/151 đã gán + 1 lời mời treo → còn 2 chỗ", () => {
    expect(freeSeatsWithPendingDebt(151, 148, 1)).toBe(2);
  });

  it("lời mời treo ăn vào chỗ trống — đây là điểm cả file này sinh ra", () => {
    // Không trừ nợ suất thì ra 3, mời 3 email sẽ có 1 người không có chỗ.
    expect(freeSeatsWithPendingDebt(151, 148, 3)).toBe(0);
  });

  it("không có lời mời treo thì đúng bằng tổng − đã gán", () => {
    expect(freeSeatsWithPendingDebt(151, 148, 0)).toBe(3);
  });

  it("KHÔNG BAO GIỜ âm — dùng vượt suất vẫn trả 0, không trả số âm", () => {
    // Workspace đang dùng vượt (ChatGPT cho phép trong lúc chờ thanh toán).
    expect(freeSeatsWithPendingDebt(60, 61, 2)).toBe(0);
  });

  it("nợ suất âm (dữ liệu hỏng) bị kẹp về 0, không được biến thành chỗ trống", () => {
    expect(freeSeatsWithPendingDebt(60, 58, -5)).toBe(2);
  });
});

describe("dashboardPendingDebt", () => {
  it("CA GIẾT LỆNH MỜI 24/8/2026 09:20 (task 7963e4d0): 148 đã gán, DB 147 active + 3 chờ", () => {
    // 1 trong 3 lời mời chờ đã được bấm nhận → nằm sẵn trong 148 "đã gán" của
    // ChatGPT, DB thì còn để 'pending'. Cộng thẳng 148 + 3 = 151 ⇒ tưởng kín
    // chỗ ⇒ đòi mua ⇒ chốt "cấm mua theo số chưa chắc" giết cả lệnh mời.
    expect(dashboardPendingDebt(150, 148, 3)).toBe(2);
    // Kết cục đúng: 151 suất − (148 + 2) = còn trống 1, thừa chỗ cho email mới.
    expect(freeSeatsWithPendingDebt(151, 148, dashboardPendingDebt(150, 148, 3))).toBe(1);
  });

  it("ca thật CHATGPT PRO 24/8/2026: 60/60 đã gán + 1 chờ → nợ vẫn là 1, KHÔNG được nuốt mất", () => {
    // Đây là ca user chốt "mời 1 email thì phải mua 2 suất". occupied 61 = 60
    // active + 1 chờ, chưa ai nhận nên không có gì để trừ.
    expect(dashboardPendingDebt(61, 60, 1)).toBe(1);
    expect(freeSeatsWithPendingDebt(60, 60, dashboardPendingDebt(61, 60, 1))).toBe(0);
  });

  it("ca thật GPT1 24/8/2026 sáng: 148/151 đã gán + 1 chờ → nợ 1, trống 2", () => {
    expect(dashboardPendingDebt(149, 148, 1)).toBe(1);
    expect(freeSeatsWithPendingDebt(151, 148, dashboardPendingDebt(149, 148, 1))).toBe(2);
  });

  it("CẢ 3 lời mời chờ đều đã bấm nhận → hết nợ, không được âm", () => {
    expect(dashboardPendingDebt(150, 150, 3)).toBe(0);
  });

  it("KẸP TRÊN bằng pending: ChatGPT mất người mà DB chưa biết KHÔNG biến thành nợ suất", () => {
    // 3 người bị gỡ trên ChatGPT bằng đường khác (đã gán 145 trong khi DB giữ
    // 150 chưa gỡ) — 5 chỗ chênh đó là suất TRỐNG, nợ vẫn đúng bằng 2 lời mời chờ.
    expect(dashboardPendingDebt(150, 145, 2)).toBe(2);
  });

  it("backend cũ chưa gửi occupied → giữ nguyên pending, hành vi y như trước", () => {
    expect(dashboardPendingDebt(undefined, 148, 3)).toBe(3);
    expect(dashboardPendingDebt(null, 148, 3)).toBe(3);
  });

  it("không có lời mời chờ thì không có nợ, dù hai nguồn lệch bao nhiêu", () => {
    expect(dashboardPendingDebt(150, 148, 0)).toBe(0);
    expect(dashboardPendingDebt(148, 150, 0)).toBe(0);
  });

  it("pending âm (dữ liệu hỏng) bị kẹp về 0", () => {
    expect(dashboardPendingDebt(150, 148, -5)).toBe(0);
  });
});
