/**
 * Hộp thoại "Gỡ suất trả phí?" bồi sau khi gỡ member (ảnh user 8/9/2026).
 * Test chốt hai điều quan trọng nhất: nhận ra được hộp đó, và KHÔNG BAO GIỜ
 * chỉ vào nút gỡ suất — bấm nhầm là workspace tụt suất đã mua, phải mua lại.
 */
import { describe, expect, it } from "vitest";
import {
  decidePaidSeatDialog,
  isKeepPaidSeatText,
  isPaidSeatDialogText,
  isRemovePaidSeatText,
  pickKeepPaidSeatIndex,
} from "./paid-seat-guard";

/** Thân hộp thoại thật (ảnh user, bản en). */
const BODY_EN =
  "Remove the paid seat? mohammadmahdi ebrahimi has been removed. " +
  "Removing 1 Standard seat lowers your monthly bill by ₫286,550 starting September 11, 2026. " +
  "Current monthly bill 389 Standard seats ₫111,467,950 " +
  "After removal (monthly) 388 Standard seats ₫111,181,400 " +
  "The seat stays paid until renewal. You can review or undo this scheduled removal in Pending requests.";

const BODY_VI =
  "Gỡ suất trả phí? Nguyễn Văn A đã bị gỡ bỏ. Gỡ 1 suất Tiêu chuẩn làm giảm " +
  "hoá đơn hàng tháng của bạn ₫286.550 kể từ ngày 11 tháng 9, 2026. " +
  "Suất vẫn được tính tiền tới ngày gia hạn.";

const BODY_ZH =
  "移除付费席位？该成员已被移除。移除 1 个标准席位后，您的每月账单将减少 ₫286,550。席位在续订前仍为已付费状态。";

/** Thân hộp thoại XÁC NHẬN GỠ MEMBER thường — không được nhận nhầm. */
const BODY_CONFIRM_REMOVE =
  "Gỡ bỏ Nguyễn Văn A khỏi Không gian làm việc CHATGPT PRO? " +
  "Người này sẽ mất quyền truy cập ngay lập tức.";

describe("isPaidSeatDialogText", () => {
  it.each([
    ["en", BODY_EN],
    ["vi", BODY_VI],
    ["zh", BODY_ZH],
  ])("nhận ra hộp suất trả phí (%s)", (_l, body) => {
    expect(isPaidSeatDialogText(body)).toBe(true);
  });

  it("KHÔNG nhận nhầm dialog xác nhận gỡ member thường", () => {
    expect(isPaidSeatDialogText(BODY_CONFIRM_REMOVE)).toBe(false);
  });

  it("KHÔNG nhận nhầm dialog chỉ nói tiền mà không nói suất", () => {
    expect(isPaidSeatDialogText("Hoá đơn hàng tháng của bạn đã được cập nhật.")).toBe(
      false,
    );
  });

  it("thân rỗng → false", () => {
    expect(isPaidSeatDialogText("")).toBe(false);
  });
});

describe("nhãn nút", () => {
  it.each(["Keep paid seat", "Giữ suất trả phí", "Giữ suất", "保留付费席位"])(
    "nút giữ suất: %s",
    (t) => {
      expect(isKeepPaidSeatText(t)).toBe(true);
      expect(isRemovePaidSeatText(t)).toBe(false);
    },
  );

  it.each(["Remove paid seat", "Gỡ suất trả phí", "Xoá suất", "移除付费席位"])(
    "nút gỡ suất: %s",
    (t) => {
      expect(isRemovePaidSeatText(t)).toBe(true);
    },
  );

  it("nhãn xác nhận gỡ member KHÔNG bị coi là nút suất", () => {
    for (const t of [
      "Gỡ bỏ khỏi không gian làm việc",
      "Remove from workspace",
      "Remove member",
      "Hủy bỏ",
      "移除成员",
    ]) {
      expect(isKeepPaidSeatText(t)).toBe(false);
      expect(isRemovePaidSeatText(t)).toBe(false);
    }
  });
});

describe("pickKeepPaidSeatIndex", () => {
  it("chọn đúng nút giữ suất, không đụng nút đỏ đứng sau", () => {
    expect(pickKeepPaidSeatIndex(["Keep paid seat", "Remove paid seat"])).toBe(0);
    expect(pickKeepPaidSeatIndex(["Giữ suất trả phí", "Gỡ suất trả phí"])).toBe(0);
    expect(pickKeepPaidSeatIndex(["保留付费席位", "移除付费席位"])).toBe(0);
  });

  it("nút giữ suất đứng SAU nút gỡ vẫn chọn đúng", () => {
    expect(pickKeepPaidSeatIndex(["Remove paid seat", "Keep paid seat"])).toBe(1);
  });

  it("deny-list thắng: nhãn nút đỏ có cả chữ 'giữ' cũng không được chọn", () => {
    // Ca giả định ChatGPT đặt nhãn kiểu "Giữ suất? Không — gỡ suất trả phí".
    expect(pickKeepPaidSeatIndex(["Giữ suất, gỡ suất trả phí"])).toBe(-1);
  });

  it("khớp CHÍNH XÁC được ưu tiên hơn 'chứa chuỗi'", () => {
    // "Giữ suất" khớp chứa-chuỗi ở index 0, nhưng index 1 khớp chính xác.
    expect(pickKeepPaidSeatIndex(["Giữ suất cho người khác", "Giữ suất"])).toBe(1);
  });

  it("ChatGPT đổi nhãn nút giữ → -1 (không bấm gì) chứ KHÔNG rơi sang nút đỏ", () => {
    expect(pickKeepPaidSeatIndex(["Để nguyên", "Remove paid seat"])).toBe(-1);
  });

  it("danh sách rỗng → -1", () => {
    expect(pickKeepPaidSeatIndex([])).toBe(-1);
  });
});

describe("decidePaidSeatDialog", () => {
  it("hộp thật (en) → bấm giữ suất", () => {
    expect(
      decidePaidSeatDialog(BODY_EN, ["Keep paid seat", "Remove paid seat"]),
    ).toEqual({ kind: "keep", index: 0 });
  });

  it("hộp thật (vi) → bấm giữ suất", () => {
    expect(
      decidePaidSeatDialog(BODY_VI, ["Giữ suất trả phí", "Gỡ suất trả phí"]),
    ).toEqual({ kind: "keep", index: 0 });
  });

  it("dialog xác nhận gỡ member thường → không đụng vào", () => {
    expect(
      decidePaidSeatDialog(BODY_CONFIRM_REMOVE, [
        "Hủy bỏ",
        "Gỡ bỏ khỏi không gian làm việc",
      ]),
    ).toEqual({ kind: "not_paid_seat" });
  });

  it("thân đổi hết chữ nhưng nút vẫn tên cũ → vẫn bắt được", () => {
    expect(
      decidePaidSeatDialog("Bạn có chắc không?", [
        "Keep paid seat",
        "Remove paid seat",
      ]),
    ).toEqual({ kind: "keep", index: 0 });
  });

  it("đúng hộp nhưng không nhận ra nút giữ → unknown_labels, KHÔNG bấm", () => {
    const d = decidePaidSeatDialog(BODY_EN, ["Not now", "Remove paid seat"]);
    expect(d.kind).toBe("unknown_labels");
    if (d.kind === "unknown_labels") {
      expect(d.buttons).toEqual(["Not now", "Remove paid seat"]);
    }
  });
});
