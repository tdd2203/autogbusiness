/**
 * Repo không có jsdom → dựng ParentNode giả tối thiểu, chỉ đủ những gì
 * `findInviteSuccessToastText` / `isInviteDialogOpen` đụng tới:
 * `querySelectorAll(sel)` + `textContent`, `querySelector(sel)`.
 */
import { describe, expect, it } from "vitest";

import {
  findInviteSuccessToastText,
  isInviteDialogOpen,
} from "./invite-success-toast";

type FakeNode = { sel: string; text: string };

/** `nodes` khai báo theo selector nào khớp node đó (giữ đúng thứ tự DOM). */
function fakeRoot(nodes: FakeNode[]): ParentNode {
  const match = (sel: string) => nodes.filter((n) => n.sel === sel);
  return {
    querySelectorAll: (sel: string) =>
      match(sel).map((n) => ({ textContent: n.text })) as unknown as NodeListOf<Element>,
    querySelector: (sel: string) => {
      const hit = match(sel)[0];
      return hit ? ({ textContent: hit.text } as unknown as Element) : null;
    },
  } as unknown as ParentNode;
}

const status = (text: string): FakeNode => ({ sel: '[role="status"]', text });

describe("findInviteSuccessToastText", () => {
  it("đọc được toast thật của ChatGPT (ca 28/8/2026)", () => {
    const root = fakeRoot([status("Đã mời 3 users tham gia CHAT GPT PRO")]);
    expect(findInviteSuccessToastText(root)).toBe(
      "Đã mời 3 users tham gia CHAT GPT PRO",
    );
  });

  it("KHÔNG bỏ sót khi toast không phải node [role=status] ĐẦU TIÊN", () => {
    // Bản cũ dùng querySelectorFirst → chỉ soi node đầu, gặp banner tín dụng là
    // kết luận "không có toast" dù ChatGPT đã xác nhận.
    const root = fakeRoot([
      status("Một thành viên trong không gian làm việc đã chạm đến giới hạn"),
      status(""),
      status("Đã mời 3 users tham gia CHAT GPT PRO"),
    ]);
    expect(findInviteSuccessToastText(root)).toContain("Đã mời 3 users");
  });

  it("live-region rỗng KHÔNG được coi là bằng chứng", () => {
    expect(findInviteSuccessToastText(fakeRoot([status("")]))).toBeNull();
  });

  it("nút còn quay 'Đang gửi lời mời...' KHÔNG phải xác nhận", () => {
    expect(findInviteSuccessToastText(fakeRoot([status("Đang gửi lời mời...")]))).toBeNull();
  });

  it("khớp cả tiếng Anh và tiếng Trung", () => {
    expect(findInviteSuccessToastText(fakeRoot([status("Invitation sent")]))).toBe(
      "Invitation sent",
    );
    expect(findInviteSuccessToastText(fakeRoot([status("邀请已发送")]))).toBe("邀请已发送");
  });

  it("không có node nào khớp → null", () => {
    expect(findInviteSuccessToastText(fakeRoot([]))).toBeNull();
  });
});

describe("isInviteDialogOpen", () => {
  it("hộp thoại còn mở → true", () => {
    const root = fakeRoot([{ sel: '[role="dialog"]', text: "Mời thành viên" }]);
    expect(isInviteDialogOpen(root)).toBe(true);
  });

  it("đóng hẳn → false", () => {
    expect(isInviteDialogOpen(fakeRoot([status("Đã mời 3 users")]))).toBe(false);
  });
});
