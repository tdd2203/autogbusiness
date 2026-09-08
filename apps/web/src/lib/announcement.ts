/** THÔNG BÁO HỆ THỐNG ép đọc — kiểu dữ liệu + đường gọi API.
 *
 *  Bình thường popup hướng dẫn đầu ngày đóng lúc nào cũng được. Khi vừa đổi cách
 *  tính tiền/hạn thì kiểu đó không tới được người cần đọc: đại lý bấm tắt theo
 *  phản xạ rồi hôm sau hỏi lại đúng thứ vừa thông báo. Một ĐỢT ép đọc giữ popup
 *  vài giây trước khi cho đóng, mỗi ngày một lần, trong mấy ngày rồi tự thôi.
 *
 *  Cấu hình đợt nằm ở SERVER (super-admin bật/tắt từ nút ⚙ trong popup) chứ không
 *  phải hằng số trong bundle: đổi một câu thông báo mà phải build lại web thì lúc
 *  cần thông báo gấp không ai kịp làm.
 *
 *  "Đã đọc hôm nay" cũng ở server, theo TÀI KHOẢN: để localStorage thì xoá cache
 *  hay đổi máy là bị ép lại từ đầu — phiền đúng người chịu đọc, còn người muốn né
 *  vẫn né được.
 *
 *  Backend: `apps/api/app/routers/announcements.py`.
 */
import { api } from "./api";

export type Announcement = {
  /** Hôm nay có đợt đang chạy không. */
  active: boolean;
  /** `Guide.id` bị ép đọc — khớp danh sách trong `lib/guides`. */
  guide_id: string | null;
  /** Số giây giữ popup trước khi cho đóng. */
  lock_seconds: number;
  /** Ngày (giờ VN) theo đồng hồ SERVER, không phải máy người dùng. */
  day: string;
  seen_today: boolean;
  campaign: string | null;
};

/** Bản đầy đủ cho super-admin: cấu hình đợt + đã bao nhiêu người đọc. */
export type AnnouncementAdmin = Announcement & {
  enabled: boolean;
  start_day: string | null;
  end_day: string | null;
  days: number;
  /** Hôm nay là ngày thứ mấy của đợt (1..days); null khi chưa chạy / đã hết. */
  day_index: number | null;
  max_days: number;
  max_lock_seconds: number;
  seen_today_count: number;
  seen_total_count: number;
  updated_at: string | null;
  updated_by: string | null;
};

export const ANNOUNCEMENT_KEY = ["announcement"] as const;
export const ANNOUNCEMENT_ADMIN_KEY = ["announcement", "admin"] as const;

export function fetchAnnouncement(): Promise<Announcement> {
  return api<Announcement>("/api/v1/announcement");
}

export function fetchAnnouncementAdmin(): Promise<AnnouncementAdmin> {
  return api<AnnouncementAdmin>("/api/v1/admin/announcement");
}

export type AnnouncementDraft = {
  enabled: boolean;
  guide_id: string | null;
  start_day: string | null;
  days: number;
  lock_seconds: number;
};

export function saveAnnouncement(body: AnnouncementDraft): Promise<AnnouncementAdmin> {
  return api<AnnouncementAdmin>("/api/v1/admin/announcement", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/** Ghi nhận đã đọc xong thông báo của hôm nay.
 *
 *  Gọi khi đồng hồ giữ popup chạy HẾT, không phải lúc mở popup: mở ra rồi F5 ngay
 *  thì chưa tính, mở lại vẫn bị giữ — đó mới là "ép đọc". */
export function markAnnouncementSeen(): Promise<Announcement> {
  return api<Announcement>("/api/v1/announcement/seen", { method: "POST" });
}

/** Bài bị ép đọc trong lượt vào web này, `null` khi không có gì phải ép.
 *
 *  Tách riêng để test được: ba điều kiện (đợt đang chạy, chưa đọc hôm nay, có bài)
 *  nằm rải trong `useEffect` thì không ai kiểm được. */
export function forcedGuideId(a: Announcement | null | undefined): string | null {
  if (!a || !a.active || a.seen_today) return null;
  return a.guide_id || null;
}

/** Số ngày còn lại của đợt tính CẢ hôm nay — câu "còn 3 ngày" cho admin. */
export function daysLeft(a: AnnouncementAdmin | null | undefined): number | null {
  if (!a || !a.day_index) return null;
  return Math.max(0, a.days - a.day_index + 1);
}
