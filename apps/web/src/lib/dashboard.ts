/**
 * Kiểu dữ liệu trang "Tổng quan" — khớp `DashboardOverviewOut` ở
 * `apps/api/app/routers/dashboard.py`. Định nghĩa từng con số nằm trong docstring
 * của file đó; ở đây chỉ ghi lại những chỗ dễ đọc nhầm.
 */

export type DashboardToday = {
  date: string;
  new_count: number;
  renew_count: number;
  /** Mời lại email CÒN HẠN: miễn phí, KHÔNG cộng vào tổng của thẻ. */
  free_reinvite_count: number;
  failed_count: number;
  /** Đã trừ phần hoàn phí — khác tổng phí phát sinh. */
  fee_net: number;
  fee_refunded: number;
};

export type DashboardServing = {
  seats: number;
  active: number;
  pending: number;
};

export type DashboardWallet = {
  balance: number;
  held: number;
  fee: number;
  /** Ước tính theo phí mặc định của đại lý — từng email có thể có phí riêng. */
  invites_left: number;
};

export type DashboardRenewalRate = {
  days: number;
  new_count: number;
  renew_count: number;
  total: number;
  /** null = chưa lượt nào trong kỳ → hiện "—", không hiện 0%. */
  pct: number | null;
};

export type DashboardSeriesDay = {
  date: string;
  new_count: number;
  renew_count: number;
  failed_count: number;
  seats_end: number;
};

export type DashboardCompare = {
  today: number;
  avg7: number;
  week: number;
  prev_week: number;
  mtd: number;
  prev_mtd: number;
};

export type DashboardTodos = {
  /** Email có lời mời lỗi và tới giờ vẫn chưa được mời lại thành công. */
  failed_pending_reinvite: number;
  pending: number;
  unpaid: number;
  /** Đến hạn gia hạn trong dưới 3 ngày. */
  due3: number;
  /** Có sẵn từ API, chưa lên màn hình (bản thiết kế không có dòng này). */
  awaiting_approval: number;
  unbound_notify: number;
};

export type DashboardFailedEmail = {
  email: string;
  failed_at: string;
  /** refunded = đã hoàn phí · held = còn giữ tiền, mời lại miễn phí · none = không có phí. */
  fee_state: "refunded" | "held" | "none";
};

export type DashboardDueDay = { date: string; seats: number; money: number };

export type DashboardDueWeek = {
  from_date: string;
  to_date: string;
  seats: number;
  money: number;
  days: DashboardDueDay[];
};

export type DashboardFailReason = {
  code: string;
  label: string;
  message: string;
  count: number;
  /** false = mời lại cũng hỏng y hệt, phải báo quản trị viên. */
  self_serve: boolean;
};

export type DashboardQuality = {
  days: number;
  ok_count: number;
  failed_count: number;
  /** Hỏng ít nhất một lượt nhưng vẫn xong trong CÙNG ngày — công mời lại có thật. */
  retried_count: number;
  total: number;
  fail_pct: number | null;
  reasons: DashboardFailReason[];
};

export type DashboardOverview = {
  username: string;
  now: string;
  today: DashboardToday;
  serving: DashboardServing;
  /** null = tài khoản chưa bật Ví → trang ẩn hẳn thẻ Ví. */
  wallet: DashboardWallet | null;
  renewal_rate: DashboardRenewalRate;
  series: DashboardSeriesDay[];
  compare: DashboardCompare;
  todos: DashboardTodos;
  /** Danh sách đứng sau `todos.failed_pending_reinvite` — bấm dòng đó là bung ra. */
  failed_emails: DashboardFailedEmail[];
  due_weeks: DashboardDueWeek[];
  quality: DashboardQuality;
};

const WEEKDAYS = [
  "Chủ nhật",
  "Thứ hai",
  "Thứ ba",
  "Thứ tư",
  "Thứ năm",
  "Thứ sáu",
  "Thứ bảy",
];

/** "2026-08-30T09:12:00+07:00" → "Chủ nhật, 30/08/2026 · 09:12 giờ Việt Nam".
 *  Đọc thẳng các thành phần trong chuỗi ISO của backend (đã là giờ VN) thay vì
 *  qua `new Date()`: máy người dùng đặt múi giờ khác thì ngày sẽ lệch. */
export function vnNowLabel(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return iso;
  const [, y, mo, d, hh, mm] = m;
  const wd = WEEKDAYS[new Date(`${y}-${mo}-${d}T00:00:00Z`).getUTCDay()];
  return `${wd}, ${d}/${mo}/${y} · ${hh}:${mm} giờ Việt Nam`;
}

/** "2026-09-05" → "05/09". */
export function shortDay(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

/** Số tiền không kèm ký hiệu (chữ "đ" hiện riêng, cỡ nhỏ hơn) — giống trang Ví. */
export function money(n: number): string {
  return Math.abs(Math.round(n)).toLocaleString("vi-VN");
}

/** "4,4" cho 4.4 — phần trăm kiểu Việt. null → "—". */
export function pctLabel(p: number | null): string {
  return p == null ? "—" : `${String(p).replace(".", ",")}%`;
}

/** Chênh lệch giữa hai kỳ: "+327%" / "−47%" / "bằng mức". */
export function deltaLabel(now: number, before: number): string {
  if (before <= 0) return now > 0 ? "kỳ trước chưa có" : "bằng mức";
  const d = Math.round(((now - before) / before) * 100);
  if (d === 0) return "bằng mức";
  return d > 0 ? `+${d}%` : `−${Math.abs(d)}%`;
}
