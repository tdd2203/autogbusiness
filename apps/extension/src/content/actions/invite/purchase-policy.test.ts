import { describe, expect, it } from "vitest";

import { blockedPurchaseReason } from "./purchase-policy";

describe("blockedPurchaseReason", () => {
  it("KHÔNG có giấy phép ⇒ cấm mua (fail-closed)", () => {
    // Backend cũ, hay một đường tạo lệnh quên gắn `seat_purchase`. Mặc định phải
    // là CẤM: tiền đã trừ trên ChatGPT không đòi lại được.
    expect(blockedPurchaseReason(undefined, 387, 1)).toMatch(/không kèm giấy phép/i);
  });

  it("email chưa từng tham gia ⇒ cấm, và nói nguyên văn câu của backend", () => {
    const reason = "Lệnh có email chưa từng tham gia không gian này (a@b.com).";
    expect(
      blockedPurchaseReason({ allowed: false, maxTotal: null, reason }, 100, 1),
    ).toBe(reason);
  });

  it("bị cấm mà backend không gửi câu nào ⇒ vẫn có câu mặc định", () => {
    expect(
      blockedPurchaseReason({ allowed: false, maxTotal: null }, 100, 1),
    ).toMatch(/không được phép mua/i);
  });

  it("ca thật GPT1 7/9/2026: trần 387, đang 387 suất, mua 1 ⇒ CẤM", () => {
    // Đúng lệnh mời `tnguyen281187` đã nâng suất lên 388 và bị trừ ₫41.452.
    const blocked = blockedPurchaseReason(
      { allowed: true, maxTotal: 387 },
      387,
      1,
    );
    expect(blocked).not.toBeNull();
    expect(blocked).toContain("388");
    expect(blocked).toContain("387");
  });

  it("mua tới ĐÚNG trần vẫn được — trần là mức trên, không phải mức cấm", () => {
    expect(blockedPurchaseReason({ allowed: true, maxTotal: 388 }, 387, 1)).toBeNull();
  });

  it("không đặt trần ⇒ khách cũ mua bao nhiêu cũng được", () => {
    expect(blockedPurchaseReason({ allowed: true, maxTotal: null }, 387, 5)).toBeNull();
  });

  it("vượt trần nhiều suất một lúc cũng bị chặn", () => {
    expect(blockedPurchaseReason({ allowed: true, maxTotal: 390 }, 387, 5)).not.toBeNull();
  });
});
