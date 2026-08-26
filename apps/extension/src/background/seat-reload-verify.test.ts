/**
 * Chỗ này quyết định có tiêu tiền lần nữa hay không, nên test bám đúng ranh giới
 * đó: khi nào được phép nói "chưa mua" (⇒ mua lại), khi nào phải nói "không rõ".
 */
import { describe, expect, it } from "vitest";

import { judgeSeatsAfterReload } from "./seat-reload-verify";

describe("judgeSeatsAfterReload", () => {
  it("suất trên trang tăng đủ → đã mua, không mua lại", () => {
    const v = judgeSeatsAfterReload({
      qty: 1,
      counterBefore: 65,
      pageBefore: { total: 65, standard: 65 },
      after: { total: 66, standard: 66 },
    });
    expect(v).toMatchObject({ kind: "purchased", basis: "page_standard", delta: 1 });
  });

  it("suất y nguyên → chưa mua (được phép chạy lại luồng mua)", () => {
    const v = judgeSeatsAfterReload({
      qty: 1,
      counterBefore: 65,
      pageBefore: { total: 65, standard: 65 },
      after: { total: 65, standard: 65 },
    });
    expect(v).toMatchObject({ kind: "not_purchased", delta: 0 });
  });

  it("nhích được một phần → KHÔNG rõ, tuyệt đối không mua lại", () => {
    const v = judgeSeatsAfterReload({
      qty: 3,
      counterBefore: 65,
      pageBefore: { total: 65, standard: 65 },
      after: { total: 67, standard: 67 },
    });
    expect(v.kind).toBe("unclear");
  });

  it("không đọc được số sau khi tải lại → không rõ", () => {
    const v = judgeSeatsAfterReload({
      qty: 1,
      counterBefore: 65,
      pageBefore: { total: 65, standard: 65 },
      after: { total: null, standard: null },
    });
    expect(v.kind).toBe("unclear");
  });

  it("không có mốc 'trước' nào → không rõ, chứ không coi là chưa mua", () => {
    const v = judgeSeatsAfterReload({
      qty: 1,
      counterBefore: null,
      pageBefore: null,
      after: { total: 66, standard: 66 },
    });
    expect(v.kind).toBe("unclear");
  });

  it("mất số trang trước thì mượn bộ đếm hộp làm mốc", () => {
    const v = judgeSeatsAfterReload({
      qty: 2,
      counterBefore: 64,
      pageBefore: null,
      after: { total: 66, standard: 66 },
    });
    expect(v).toMatchObject({ kind: "purchased", basis: "counter_standard", delta: 2 });
  });

  it("workspace có suất Cao cấp: mốc bộ đếm so với TỔNG chỉ được phồng lên, không tụt", () => {
    // Bộ đếm 64 (Tiêu chuẩn), trang gộp thêm 5 suất Cao cấp mà KHÔNG tách được
    // loại → total 69. Delta phồng = 5 ⇒ "đã mua". Sai theo hướng an toàn: không
    // mua lại. Điều PHẢI KHÔNG xảy ra là kết luận "chưa mua" trong ca này.
    const v = judgeSeatsAfterReload({
      qty: 1,
      counterBefore: 64,
      pageBefore: null,
      after: { total: 69, standard: null },
    });
    expect(v.kind).not.toBe("not_purchased");
  });

  it("hộp nói 'có hiệu lực vào kỳ sau' → KHÔNG bao giờ kết luận chưa mua", () => {
    const v = judgeSeatsAfterReload({
      qty: 1,
      counterBefore: 65,
      pageBefore: { total: 65, standard: 65 },
      after: { total: 65, standard: 65 },
      effectiveLaterText: "Có hiệu lực vào 25 tháng 9, 2026",
    });
    // Suất y nguyên, nhưng đúng ra nó KHÔNG được nhích cho tới ngày gia hạn —
    // mua lại ở đây là mua đúp bằng tiền thật.
    expect(v.kind).toBe("unclear");
  });

  it("hiệu lực kỳ sau mà suất VẪN tăng đủ → vẫn là đã mua", () => {
    const v = judgeSeatsAfterReload({
      qty: 1,
      counterBefore: 65,
      pageBefore: { total: 65, standard: 65 },
      after: { total: 66, standard: 66 },
      effectiveLaterText: "Có hiệu lực vào 25 tháng 9, 2026",
    });
    expect(v.kind).toBe("purchased");
  });

  it("ChatGPT đã báo 'cập nhật thành công' → suất đứng im cũng KHÔNG được mua lại", () => {
    const v = judgeSeatsAfterReload({
      qty: 2,
      counterBefore: 66,
      pageBefore: { total: 66, standard: 66 },
      after: { total: 66, standard: 66 },
      successToastText: "Gói đăng ký của bạn đã được cập nhật thành công",
    });
    // Câu đó là ChatGPT tự nói tiền ĐÃ trừ. Số chưa nhích chỉ là trang chậm hoặc
    // hiệu lực kỳ sau — mua lại ở đây là trừ tiền lần hai cho cùng một task.
    expect(v.kind).toBe("unclear");
    expect(v.kind === "unclear" && v.reason).toContain("cập nhật thành công");
  });

  it("suất TỤT mà có báo thành công → vẫn không mua lại", () => {
    const v = judgeSeatsAfterReload({
      qty: 1,
      counterBefore: 65,
      pageBefore: { total: 65, standard: 65 },
      after: { total: 64, standard: 64 },
      successToastText: "Gói đăng ký của bạn đã được cập nhật thành công",
    });
    expect(v.kind).toBe("unclear");
  });

  it("báo thành công mà suất tăng đủ → chốt luôn là đã mua", () => {
    const v = judgeSeatsAfterReload({
      qty: 3,
      counterBefore: 65,
      pageBefore: { total: 65, standard: 65 },
      after: { total: 68, standard: 68 },
      successToastText: "Gói đăng ký của bạn đã được cập nhật thành công",
    });
    expect(v).toMatchObject({ kind: "purchased", delta: 3 });
  });

  it("suất TỤT sau khi tải lại (ai đó vừa giảm suất) → chưa mua", () => {
    const v = judgeSeatsAfterReload({
      qty: 1,
      counterBefore: 65,
      pageBefore: { total: 65, standard: 65 },
      after: { total: 64, standard: 64 },
    });
    expect(v).toMatchObject({ kind: "not_purchased", delta: -1 });
  });
});
