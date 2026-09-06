import { describe, it, expect } from "vitest";
import { buildSeatRun, type SeatRunEntry } from "./seatRun";

const WS = "ws-pro";
const OTHER = "ws-gpt1";

const rows = (...emails: string[]): SeatRunEntry[] =>
  emails.map((email) => ({ email, workspaceId: WS, takesSeat: true }));

describe("dãy suất trang Mời thành viên", () => {
  it("một email: gộp thành 2 → 1", () => {
    const run = buildSeatRun(rows("a@x.com"), () => 2);
    expect(run.get("a@x.com")).toEqual({ kind: "single", from: 2, to: 1 });
  });

  it("nhiều email: số đầu, mũi tên ở giữa, số cuối", () => {
    const run = buildSeatRun(rows("a@x.com", "b@x.com", "c@x.com", "d@x.com"), () => 6);
    expect(run.get("a@x.com")).toEqual({ kind: "start", value: 6 });
    expect(run.get("b@x.com")).toEqual({ kind: "arrow" });
    expect(run.get("c@x.com")).toEqual({ kind: "arrow" });
    expect(run.get("d@x.com")).toEqual({ kind: "end", value: 2 });
  });

  it("email lấy nốt suất cuối (1 → 0) KHÔNG báo hết suất", () => {
    const one = buildSeatRun(rows("a@x.com"), () => 1);
    expect(one.get("a@x.com")).toEqual({ kind: "single", from: 1, to: 0 });
    const many = buildSeatRun(rows("a@x.com", "b@x.com"), () => 2);
    expect(many.get("b@x.com")).toEqual({ kind: "end", value: 0 });
  });

  it("chỉ dòng vượt quá số suất mới báo hết suất", () => {
    const run = buildSeatRun(rows("a@x.com", "b@x.com", "c@x.com"), () => 2);
    expect(run.get("a@x.com")).toEqual({ kind: "start", value: 2 });
    expect(run.get("b@x.com")).toEqual({ kind: "arrow" });
    expect(run.get("c@x.com")).toEqual({ kind: "none" });
  });

  it("hết sạch suất từ đầu: mọi dòng đều báo hết suất", () => {
    const run = buildSeatRun(rows("a@x.com", "b@x.com"), () => 0);
    expect(run.get("a@x.com")).toEqual({ kind: "none" });
    expect(run.get("b@x.com")).toEqual({ kind: "none" });
  });

  it("email đang giữ suất ở chính không gian đó không làm dãy tụt", () => {
    const run = buildSeatRun(
      [
        { email: "a@x.com", workspaceId: WS, takesSeat: false },
        { email: "b@x.com", workspaceId: WS, takesSeat: true },
      ],
      () => 3,
    );
    expect(run.get("a@x.com")).toEqual({ kind: "start", value: 3 });
    expect(run.get("b@x.com")).toEqual({ kind: "end", value: 2 });
  });

  it("dán trộn nhiều không gian: mỗi không gian một dãy riêng", () => {
    const run = buildSeatRun(
      [
        { email: "a@x.com", workspaceId: WS, takesSeat: true },
        { email: "b@x.com", workspaceId: OTHER, takesSeat: true },
        { email: "c@x.com", workspaceId: WS, takesSeat: true },
      ],
      (ws) => (ws === WS ? 4 : 1),
    );
    expect(run.get("a@x.com")).toEqual({ kind: "start", value: 4 });
    expect(run.get("c@x.com")).toEqual({ kind: "end", value: 2 });
    // Không gian kia chỉ có 1 dòng → vẫn là dạng gộp, không dính dãy bên cạnh.
    expect(run.get("b@x.com")).toEqual({ kind: "single", from: 1, to: 0 });
  });

  it("chưa đồng bộ tổng suất thì im lặng, không đoán số", () => {
    const run = buildSeatRun(rows("a@x.com", "b@x.com"), () => null);
    expect(run.get("a@x.com")).toEqual({ kind: "unknown" });
    expect(run.get("b@x.com")).toEqual({ kind: "unknown" });
  });

  it("dòng chưa resolve được không gian thì không có ô suất", () => {
    const run = buildSeatRun(
      [{ email: "a@x.com", workspaceId: undefined, takesSeat: true }],
      () => 5,
    );
    expect(run.has("a@x.com")).toBe(false);
  });
});
