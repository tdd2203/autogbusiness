import { describe, expect, it } from "vitest";

import { freeSeatsWithPendingDebt } from "./seat-math";

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
