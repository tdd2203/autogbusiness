import { describe, expect, it } from "vitest";

import { isSeatChangeConfirmLabel, seatsAddedInReview } from "./seat-change-review";

/** Chữ của hộp đúng như ảnh user 11/9/2026 (innerText, mỗi khối một dòng). */
const REVIEW_TEXT = [
  "Review seat changes",
  "Your changes take effect at your next renewal.",
  "Add 1 Standard seat",
  "Takes effect on September 11, 2026",
  "+ ₫260,500/mo",
  "Current monthly bill",
  "₫104,200,000 + tax",
  "400 Standard · 0 Premium",
  "New monthly bill",
  "₫103,158,000 + tax",
  "396 Standard · 0 Premium",
  "Back",
  "Update seats and send invites",
].join("\n");

describe("hộp Review seat changes", () => {
  it("nhận nút cập nhật suất kèm gửi lời mời", () => {
    expect(isSeatChangeConfirmLabel("Update seats and send invites")).toBe(true);
    expect(isSeatChangeConfirmLabel("Update seat and send invite")).toBe(true);
    expect(isSeatChangeConfirmLabel("Cập nhật suất và gửi lời mời")).toBe(true);
    expect(isSeatChangeConfirmLabel("更新席位并发送邀请")).toBe(true);
  });

  it("không nhận nhầm nút gửi thường hay nút mua kèm mời", () => {
    for (const label of [
      "Send invites",
      "Gửi lời mời",
      "Back",
      "Update",
      "Purchase seats and send invites",
      "Mua suất người dùng và gửi lời mời",
      "Xác nhận thay đổi",
    ]) {
      expect(isSeatChangeConfirmLabel(label)).toBe(false);
    }
  });

  it("đọc số suất ChatGPT định thêm, bỏ qua số suất của dòng hoá đơn", () => {
    expect(seatsAddedInReview(REVIEW_TEXT)).toBe(1);
    expect(seatsAddedInReview("Add 3 Standard seats\nAdd 1 Premium seat")).toBe(4);
    expect(seatsAddedInReview("Thêm 2 suất Tiêu chuẩn")).toBe(2);
    expect(seatsAddedInReview("添加 2 个标准席位")).toBe(2);
  });

  it("không có dòng thêm suất thì trả null", () => {
    expect(seatsAddedInReview("400 Standard · 0 Premium")).toBeNull();
    expect(seatsAddedInReview("")).toBeNull();
  });
});
