import { describe, it, expect } from "vitest";
import { pickBatchWorkspace } from "./inviteTarget";

const COUNT: Record<string, number> = { a: 3, b: 41, c: 12 };
const count = (id: string) => COUNT[id] ?? 0;
const ALL = ["a", "b", "c"];

describe("đích của cả mẻ trang Mời thành viên", () => {
  it("mặc định là không gian đông thành viên nhất", () => {
    expect(
      pickBatchWorkspace({
        picked: null,
        eligibleIds: ALL,
        invitableIds: ALL,
        memberCount: count,
      }),
    ).toBe("b");
  });

  it("bỏ qua không gian đã chạm trần dù nó đông nhất", () => {
    expect(
      pickBatchWorkspace({
        picked: null,
        eligibleIds: ALL,
        invitableIds: ["a", "c"],
        memberCount: count,
      }),
    ).toBe("c");
  });

  it("chạm trần hết thì vẫn trả về đông nhất, để backend nói câu từ chối", () => {
    expect(
      pickBatchWorkspace({
        picked: null,
        eligibleIds: ALL,
        invitableIds: [],
        memberCount: count,
      }),
    ).toBe("b");
  });

  it("hoà nhau thì giữ thứ tự danh sách đích", () => {
    expect(
      pickBatchWorkspace({
        picked: null,
        eligibleIds: ALL,
        invitableIds: ALL,
        memberCount: () => 0,
      }),
    ).toBe("a");
  });

  it("người dùng chọn tay thì thắng mặc định", () => {
    expect(
      pickBatchWorkspace({
        picked: "a",
        eligibleIds: ALL,
        invitableIds: ALL,
        memberCount: count,
      }),
    ).toBe("a");
  });

  it("lựa chọn rơi ra ngoài danh sách được cấp thì rụng, về lại mặc định", () => {
    expect(
      pickBatchWorkspace({
        picked: "z",
        eligibleIds: ALL,
        invitableIds: ALL,
        memberCount: count,
      }),
    ).toBe("b");
  });

  it("chưa được cấp chỗ nào thì không có đích", () => {
    expect(
      pickBatchWorkspace({
        picked: null,
        eligibleIds: [],
        invitableIds: [],
        memberCount: count,
      }),
    ).toBeUndefined();
  });
});
