/**
 * Bộ đếm `[−] n [+]` và dòng tỉ lệ "148/151 đã gán" nói hai tổng khác nhau thì
 * tin bên nào — một trong hai đường quyết định dính tới tiền của luồng mời.
 */
import { describe, expect, it } from "vitest";

import { freeSeatsWithPendingDebt } from "../invite/seat-math";
import { resolveSeatTotals } from "./check-seat-availability";

describe("resolveSeatTotals", () => {
  it("hai nguồn khớp → chắc chắn, cho mua", () => {
    expect(resolveSeatTotals(151, 151)).toEqual({
      total: 151,
      safeTotal: 151,
      uncertain: false,
    });
  });

  it("không định vị được bộ đếm → không có gì để lệch, giữ dòng tỉ lệ", () => {
    expect(resolveSeatTotals(151, null)).toEqual({
      total: 151,
      safeTotal: 151,
      uncertain: false,
    });
  });

  it("lệch → tổng vẫn là DÒNG TỈ LỆ (suất đang có), chỉ gắn cờ cấm mua", () => {
    // Ca thật GPT1 24/8/2026: bộ đếm 150 (kỳ sau, có lượt hạ suất hẹn hiệu lực),
    // dòng tỉ lệ 151 (đang có). Bản cũ hạ tổng về 150 cho MỌI quyết định.
    expect(resolveSeatTotals(151, 150)).toEqual({
      total: 151,
      safeTotal: 150,
      uncertain: true,
    });
  });

  it("bộ đếm CAO hơn dòng tỉ lệ → tổng dè dặt vẫn là số thấp hơn", () => {
    expect(resolveSeatTotals(150, 151)).toEqual({
      total: 150,
      safeTotal: 150,
      uncertain: true,
    });
  });

  it("ca GPT1: hai lỗi đếm cộng lại mới ra 'thiếu 1 suất'", () => {
    // Sự thật trên màn hình ChatGPT: 151 suất, 148 đã gán, 2 lời mời đang chờ
    // → còn trống ĐÚNG 1, thừa sức mời thêm 1 email.
    const real = resolveSeatTotals(151, 150);
    expect(freeSeatsWithPendingDebt(real.total, 148, 2)).toBe(1);

    // Bản cũ sai CẢ HAI chiều, mỗi chiều mất đúng 1 suất:
    //   - hạ tổng về bộ đếm (150),
    //   - nợ suất lấy từ DB (3, trong đó 1 lời mời đã chết trên ChatGPT).
    // Mỗi lỗi một mình vẫn ra 0 ⇒ sửa một nửa thì lệnh mời vẫn chết.
    expect(freeSeatsWithPendingDebt(150, 148, 3)).toBe(0); // cả hai lỗi
    expect(freeSeatsWithPendingDebt(151, 148, 3)).toBe(0); // chỉ sửa tổng
    expect(freeSeatsWithPendingDebt(150, 148, 2)).toBe(0); // chỉ sửa nợ suất
  });
});
