/**
 * Bảng giá Canva ở FE phải cho ra ĐÚNG con số backend sẽ trừ.
 *
 * Công thức bị viết hai lần (backend `services/canva_price.py` để trừ tiền, FE
 * `useCanvaPrice.ts` để hiện giá trước khi bấm). Lệch nhau thì người dùng thấy một
 * giá rồi bị trừ giá khác — mất lòng tin ngay lần đầu. Các con số dưới đây SAO CHÉP
 * từ test backend `tests/test_canva_pricing.py`; sửa một bên thì phải sửa cả hai.
 */
import { describe, expect, it } from "vitest";
import { canvaFeeForMonths, type CanvaPriceTier } from "./useCanvaPrice";

const TIERS: CanvaPriceTier[] = [
  { months: 1, price_vnd: 15_000 },
  { months: 3, price_vnd: 40_000 },
  { months: 6, price_vnd: 70_000 },
  { months: 12, price_vnd: 100_000 },
];

describe("canvaFeeForMonths", () => {
  it("đúng bậc thì lấy thẳng giá bậc", () => {
    expect(canvaFeeForMonths(TIERS, 1)).toBe(15_000);
    expect(canvaFeeForMonths(TIERS, 3)).toBe(40_000);
    expect(canvaFeeForMonths(TIERS, 6)).toBe(70_000);
    expect(canvaFeeForMonths(TIERS, 12)).toBe(100_000);
  });

  it("tháng lẻ = bậc dưới gần nhất + phần dư, làm tròn lên 1.000", () => {
    expect(canvaFeeForMonths(TIERS, 8)).toBe(94_000);
    expect(canvaFeeForMonths(TIERS, 2)).toBe(30_000);
  });

  it("dài hơn bậc lớn nhất thì cộng tiếp theo đơn giá bậc đó", () => {
    expect(canvaFeeForMonths(TIERS, 24)).toBe(200_000);
  });

  it("không tháng / số âm vẫn tính một tháng", () => {
    expect(canvaFeeForMonths(TIERS, null)).toBe(15_000);
    expect(canvaFeeForMonths(TIERS, 0)).toBe(15_000);
  });

  it("bảng rỗng thì trả 0 chứ không nổ", () => {
    expect(canvaFeeForMonths([], 12)).toBe(0);
  });
});
