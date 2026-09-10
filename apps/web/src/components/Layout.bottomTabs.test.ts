import { describe, expect, it } from "vitest";
import { centerInvite } from "./Layout";

const tab = (labelKey: string) => ({ labelKey });

describe("centerInvite — thứ tự ô trên thanh đáy điện thoại", () => {
  it("đưa Mời vào ô giữa (ô thứ 3 trong 5, tính cả Menu)", () => {
    const tabs = [
      tab("nav.dashboard"),
      tab("nav.inviteMembers"),
      tab("nav.addedEmails"),
      tab("nav.renewals"),
    ];
    expect(centerInvite(tabs).map((t) => t.labelKey)).toEqual([
      "nav.dashboard",
      "nav.addedEmails",
      "nav.inviteMembers",
      "nav.renewals",
    ]);
  });

  it("không có mục Mời thì giữ nguyên thứ tự", () => {
    const tabs = [
      tab("nav.dashboard"),
      tab("nav.addedEmails"),
      tab("nav.renewals"),
      tab("nav.notifications"),
    ];
    expect(centerInvite(tabs)).toEqual(tabs);
  });

  it("Mời đã ở giữa thì trả về nguyên mảng, không tạo bản sao", () => {
    const tabs = [
      tab("nav.dashboard"),
      tab("nav.addedEmails"),
      tab("nav.inviteMembers"),
      tab("nav.renewals"),
    ];
    expect(centerInvite(tabs)).toBe(tabs);
  });

  it("ít hơn 3 ô thì Mời đứng cuối cùng thay vì vượt ngoài mảng", () => {
    const tabs = [tab("nav.inviteMembers"), tab("nav.dashboard")];
    expect(centerInvite(tabs).map((t) => t.labelKey)).toEqual([
      "nav.dashboard",
      "nav.inviteMembers",
    ]);
  });
});
