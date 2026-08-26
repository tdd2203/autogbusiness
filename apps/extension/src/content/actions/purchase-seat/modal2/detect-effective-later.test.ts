/**
 * Hộp nói "có hiệu lực vào kỳ sau" là ca DUY NHẤT mà số suất KHÔNG nhích lên dù
 * giao dịch đã đi qua. Nhận sót câu này ⇒ vòng F5 kết luận "chưa mua" ⇒ mua lại
 * ⇒ mua đúp bằng tiền thật. Nhận nhầm thì ngược lại: mất đường mua lại tự động,
 * chỉ tốn công người — nên test bám cả hai phía.
 */
import { describe, expect, it } from "vitest";

import { detectEffectiveLater } from "./detect-effective-later";

describe("detectEffectiveLater", () => {
  it("bắt đúng hộp trong ảnh user 26/8", () => {
    const text =
      "Xem lại thay đổi người dùng. Các thay đổi của bạn sẽ có hiệu lực vào lần gia hạn tiếp theo. " +
      "Thêm 1 suất Tiêu chuẩn · Có hiệu lực vào 25 tháng 9, 2026 · + 260.500 đ/tháng";
    const got = detectEffectiveLater(text);
    expect(got).not.toBeNull();
    expect(got).toMatch(/hiệu lực/);
  });

  it("bắt bản tiếng Anh và tiếng Trung", () => {
    expect(
      detectEffectiveLater("Add 1 Standard seat. Effective on September 25, 2026"),
    ).not.toBeNull();
    expect(
      detectEffectiveLater("Your changes take effect at your next renewal."),
    ).not.toBeNull();
    expect(detectEffectiveLater("更改将于 2026年9月25日 生效")).not.toBeNull();
  });

  it("hộp mua TRỪ TIỀN NGAY → null (không được chặn đường mua lại)", () => {
    expect(
      detectEffectiveLater(
        "Xem lại giao dịch mua. Thêm 1 suất Tiêu chuẩn. Tổng phải trả hôm nay 27.168 đ. " +
          "Hóa đơn hằng tháng hiện tại 17.193.000 đ + thuế",
      ),
    ).toBeNull();
    expect(
      detectEffectiveLater("Review purchase · Total due today $12.34 · Confirm purchase"),
    ).toBeNull();
  });
});
