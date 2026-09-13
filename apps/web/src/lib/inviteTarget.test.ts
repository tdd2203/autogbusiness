import { describe, it, expect } from "vitest";
import {
  buildEmailPins,
  emailTargetWorkspace,
  pickBatchWorkspace,
} from "./inviteTarget";

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

describe("email không đi theo đích của cả mẻ", () => {
  const members = [
    { email: "Dangngoi@x.org", workspace_id: "a", status: "active" },
    { email: "choxacnhan@x.org", workspace_id: "a", status: "pending" },
    { email: "daroi@x.org", workspace_id: "a", status: "removed" },
  ];

  it("email đang giữ chỗ ở một không gian thì mời lại vào đúng đó", () => {
    const pins = buildEmailPins({ members, history: undefined });
    expect(emailTargetWorkspace("dangngoi@x.org", pins, "b")).toBe("a");
    expect(emailTargetWorkspace("choxacnhan@x.org", pins, "b")).toBe("a");
  });

  it("khách cũ đã rời đội về lại không gian cũ, không theo đích chung", () => {
    const pins = buildEmailPins({
      members,
      history: {
        "daroi@x.org": { home_workspace_id: "c", workspaces: [{ workspace_id: "c" }] },
      },
    });
    expect(emailTargetWorkspace("daroi@x.org", pins, "b")).toBe("c");
    // Về chỗ cũ vẫn chiếm một suất mới ở đó — không được đếm như người đang ngồi.
    expect(pins.seat.has("daroi@x.org")).toBe(false);
  });

  it("chỗ đang ngồi ngoài danh sách đích chỉ lộ qua lịch sử vẫn được giữ", () => {
    const pins = buildEmailPins({
      members: [],
      history: {
        "ngoaitam@x.org": {
          home_workspace_id: "z",
          workspaces: [{ workspace_id: "z", holds_seat: true }],
        },
      },
    });
    expect(pins.seat.get("ngoaitam@x.org")).toBe("z");
    expect(emailTargetWorkspace("NgoaiTam@x.org", pins, "b")).toBe("z");
  });

  it("chỗ đang ngồi thắng chỗ cũ", () => {
    const pins = buildEmailPins({
      members,
      history: {
        "dangngoi@x.org": { home_workspace_id: "c", workspaces: [{ workspace_id: "c" }] },
      },
    });
    expect(emailTargetWorkspace("dangngoi@x.org", pins, "b")).toBe("a");
  });

  it("email mới toanh, hoặc chỗ cũ ngoài tầm với, đi theo đích của cả mẻ", () => {
    const pins = buildEmailPins({
      members,
      history: {
        "vochu@x.org": { home_workspace_id: null, workspaces: [{ workspace_id: "c" }] },
      },
    });
    expect(emailTargetWorkspace("moitoanh@x.org", pins, "b")).toBe("b");
    expect(emailTargetWorkspace("vochu@x.org", pins, "b")).toBe("b");
  });
});
