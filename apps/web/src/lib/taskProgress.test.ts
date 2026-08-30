import { describe, it, expect } from "vitest";
import { progressLine, progressStep } from "./taskProgress";
import type { QueueItem } from "../types";
import vi from "../i18n/locales/vi.json";
import zh from "../i18n/locales/zh-CN.json";

const dict = vi as Record<string, string>;
const t = (k: string) => dict[k] ?? k;

function task(over: Partial<QueueItem>): QueueItem {
  return {
    id: "t1",
    type: "INVITE_MEMBER",
    status: "IN_PROGRESS",
    payload: {},
    result: null,
    progress: null,
    error_code: null,
    error_message: null,
    workspace_id: null,
    created_by_id: null,
    created_by_username: null,
    created_at: "2026-08-30T03:00:00Z",
    picked_at: null,
    completed_at: null,
    ...over,
  } as QueueItem;
}

describe("progressLine", () => {
  it("kể chuyện theo bước người dùng hiểu, không lộ thao tác DOM", () => {
    const t1 = task({
      progress: {
        phase: "verifying",
        message: "Đợi ChatGPT xác nhận 1 lời mời (tối đa 25s)...",
      },
    });
    expect(progressLine(t, t1)).toBe("Đã mời, chờ xác nhận");
  });

  it("cùng phase nhưng khác loại lệnh thì nói khác nhau", () => {
    expect(progressStep("INVITE_MEMBER", "verifying")).toBe("invited");
    expect(progressStep("REMOVE_MEMBER", "verifying")).toBe("checking");
  });

  it("kèm số đếm khi đang chạy nhiều email", () => {
    const t1 = task({
      progress: { phase: "typing-email", current: 2, total: 5 },
    });
    expect(progressLine(t, t1)).toBe("Đang gửi lời mời (2/5)");
  });

  it("bỏ số đếm của lệnh mua suất (đếm bước nội bộ, không phải đầu việc)", () => {
    const t1 = task({
      type: "PURCHASE_SEAT",
      progress: { phase: "confirm_charge", current: 6, total: 9 },
    });
    expect(progressLine(t, t1)).toBe("Đang mua thêm suất");
  });

  it("phase lạ (extension mới hơn dashboard) rơi về câu chung", () => {
    const t1 = task({ progress: { phase: "wibble", message: "click #btn-42" } });
    expect(progressLine(t, t1)).toBe("Đang xử lý");
  });

  it("lệnh chưa chạy thì không thêm dòng trùng với nhãn trạng thái", () => {
    expect(progressLine(t, task({ status: "PENDING" }))).toBeNull();
    expect(progressLine(t, task({ status: "COMPLETED" }))).toBeNull();
  });

  it("mọi nhãn bước đều có bản tiếng Trung", () => {
    const steps = Object.keys(dict).filter((k) => k.startsWith("step."));
    expect(steps.length).toBeGreaterThan(10);
    for (const k of steps) {
      expect((zh as Record<string, string>)[k], k).toBeTruthy();
    }
  });
});
