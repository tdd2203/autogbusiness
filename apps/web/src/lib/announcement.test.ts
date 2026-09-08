/** Luật "lượt này có phải ép đọc không" — ba điều kiện dễ nhầm nhất của đợt thông báo. */
import { describe, expect, it } from "vitest";
import { daysLeft, forcedGuideId, type Announcement, type AnnouncementAdmin } from "./announcement";

function ann(over: Partial<Announcement> = {}): Announcement {
  return {
    active: true,
    guide_id: "cycle-billing",
    lock_seconds: 15,
    day: "2026-09-08",
    seen_today: false,
    campaign: "cycle-billing:2026-09-08",
    ...over,
  };
}

describe("forcedGuideId", () => {
  it("trả bài khi đợt đang chạy và hôm nay chưa đọc", () => {
    expect(forcedGuideId(ann())).toBe("cycle-billing");
  });

  it("đọc rồi thì thôi — mỗi ngày đúng một lần", () => {
    expect(forcedGuideId(ann({ seen_today: true }))).toBeNull();
  });

  it("đợt tắt hoặc chưa có bài thì không ép ai", () => {
    expect(forcedGuideId(ann({ active: false }))).toBeNull();
    expect(forcedGuideId(ann({ guide_id: null }))).toBeNull();
    expect(forcedGuideId(ann({ guide_id: "" }))).toBeNull();
  });

  it("chưa hỏi được server thì coi như không có đợt", () => {
    // Mạng hỏng không được biến thành popup chặn màn hình.
    expect(forcedGuideId(undefined)).toBeNull();
    expect(forcedGuideId(null)).toBeNull();
  });
});

describe("daysLeft", () => {
  const admin = (over: Partial<AnnouncementAdmin>): AnnouncementAdmin =>
    ({
      ...ann(),
      enabled: true,
      start_day: "2026-09-08",
      end_day: "2026-09-12",
      days: 5,
      day_index: 1,
      max_days: 60,
      max_lock_seconds: 120,
      seen_today_count: 0,
      seen_total_count: 0,
      updated_at: null,
      updated_by: null,
      ...over,
    }) as AnnouncementAdmin;

  it("tính CẢ hôm nay", () => {
    expect(daysLeft(admin({ day_index: 1 }))).toBe(5);
    expect(daysLeft(admin({ day_index: 5 }))).toBe(1);
  });

  it("ngoài khung thì không có số ngày còn lại", () => {
    expect(daysLeft(admin({ day_index: null }))).toBeNull();
    expect(daysLeft(null)).toBeNull();
  });
});
