import { describe, expect, it } from "vitest";
import { removalBadge } from "./RemovedEmailsList";
import vi from "../i18n/locales/vi.json";
import zhCN from "../i18n/locales/zh-CN.json";
import type { AddedMember } from "../types";

/* Ranh giới đang kiểm: "đã xoá, ĐÃ XÁC MINH" và "đã ra lệnh xoá, CHƯA xác nhận" là
   HAI trạng thái khác nhau, và bảng "Đã xoá" phải nói ra sự khác nhau đó.

   Ca thật 1/9/2026: đổi email lethithuphuong14042002 → lttp1404, lệnh thu hồi chết
   với FAILED_UI_CHANGED, email cũ vẫn ở trên ChatGPT ăn một ghế — mà dashboard hiện
   badge xám "Đổi sang email khác" y như một ca trót lọt. */

const t =
  (dict: Record<string, string>) =>
  (key: string, params?: Record<string, string | number>): string => {
    let value = dict[key];
    expect(value, `thiếu key i18n: ${key}`).toBeDefined();
    for (const [k, v] of Object.entries(params ?? {})) {
      value = value!.replaceAll(`{${k}}`, String(v));
    }
    return value!;
  };

const row = (extra: Partial<AddedMember>): AddedMember =>
  ({
    id: "m1",
    email: "old@example.com",
    status: "removed",
    removed_reason: "email_changed",
    ...extra,
  }) as AddedMember;

describe("removalBadge", () => {
  it("đổi email trót lọt: badge trung tính, giữ nguyên nhãn cũ", () => {
    const b = removalBadge(row({ email_changed_to: ["new@example.com"] }));
    expect(b.className).toContain("badge-neutral");
    expect(t(vi as Record<string, string>)(b.key, { email: b.email! })).toBe(
      "Đổi sang email khác",
    );
  });

  it("gỡ chưa xác nhận: badge cảnh báo, nói rõ CHƯA gỡ được", () => {
    const b = removalBadge(
      row({
        email_changed_to: ["new@example.com"],
        email_change_stuck_at: "2026-09-01T07:05:39Z",
        email_change_stuck_to: "new@example.com",
      }),
    );
    expect(b.className).toContain("badge-warning");
    const label = t(vi as Record<string, string>)(b.key, { email: b.email! });
    expect(label).toContain("new@example.com");
    expect(label).toContain("chưa gỡ được");
    // KHÔNG được đọc thành "xong việc".
    expect(label).not.toBe("Đổi sang email khác");
  });

  it("thiếu email kế thừa vẫn cảnh báo được (không lòi key i18n)", () => {
    const b = removalBadge(row({ email_change_stuck_at: "2026-09-01T07:05:39Z" }));
    expect(b.email).toBeNull();
    for (const dict of [vi, zhCN] as Record<string, string>[]) {
      expect(t(dict)(b.key)).not.toContain("removedReason.");
    }
  });

  it("lý do khác (hết hạn) không bị nhánh mới nuốt", () => {
    const b = removalBadge(row({ removed_reason: "expired", email_changed_to: [] }));
    expect(b.className).toContain("badge-warning");
    expect(t(vi as Record<string, string>)(b.key)).toBe("Hết hạn");
  });

  it("cả hai bản dịch đều có chuỗi cảnh báo của modal chi tiết", () => {
    for (const dict of [vi, zhCN] as Record<string, string>[]) {
      for (const key of [
        "memberDetail.badgeRemovalUnconfirmed",
        "memberDetail.badgeRemovalUnconfirmedMovedTo",
        "memberDetail.removalUnconfirmedNote",
        "memberDetail.removedUnconfirmedRingLabel",
        "memberLog.action.MEMBER_EMAIL_CHANGE_REMOVE_FAILED",
      ]) {
        expect(dict[key], `thiếu ${key}`).toBeTruthy();
      }
    }
  });
});
