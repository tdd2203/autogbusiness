/**
 * GIỜ UTC cho mọi thứ dính CHU KỲ HOÁ ĐƠN.
 *
 * Vì sao có file riêng thay vì dùng `locale-format`: hai loại mốc trong dashboard
 * phải hiện bằng hai múi giờ KHÁC nhau, và trộn chúng là nguồn khiếu nại chắc chắn.
 *
 *   · Nhật ký, giao dịch ví, ngày đăng ký… → giờ MÁY người xem, như xưa.
 *   · Mốc chốt chu kỳ, hạn dùng, kỳ hoá đơn → giờ **UTC**, vì luật tính hạn và tính
 *     tiền chạy hoàn toàn bằng ngày lịch UTC (xem `EXPIRY_RULES.md` §3.6.4). Hiện
 *     theo giờ máy thì khách Việt Nam thấy "hết hạn 1/9 10:00" trong khi luật nói
 *     03:00 — hai con số cho cùng một thời điểm.
 *
 * Nên mốc chu kỳ LUÔN kèm nhãn `UTC`. Nhãn là phần của con số, không phải trang trí:
 * bỏ nhãn đi thì người đọc mặc định hiểu là giờ mình, và lại lệch 7 tiếng.
 */

import type { Lang } from "../i18n";
import { localeTag } from "./locale-format";

export const UTC_LABEL = "UTC";

const UTC_DATE: Intl.DateTimeFormatOptions = {
  timeZone: "UTC",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
};

const UTC_TIME: Intl.DateTimeFormatOptions = {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

function toDate(value: string | Date): Date | null {
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Ngày UTC, vd `08/09/2026`. `—` khi mốc rỗng/hỏng. */
export function formatUtcDate(lang: Lang, value: string | Date | null): string {
  const d = value == null ? null : toDate(value);
  if (!d) return "—";
  return d.toLocaleDateString(localeTag(lang), UTC_DATE);
}

/** Giờ UTC 24h, vd `03:00`. */
export function formatUtcTime(lang: Lang, value: string | Date | null): string {
  const d = value == null ? null : toDate(value);
  if (!d) return "—";
  return d.toLocaleTimeString(localeTag(lang), UTC_TIME);
}

/**
 * MỘT MỐC CHU KỲ, kèm nhãn: `08/09/2026 03:00 UTC`.
 *
 * Đây là hàm mà mọi chỗ hiện hạn dùng / mốc chốt / kỳ hoá đơn phải gọi. Đừng tự
 * `toLocaleString` ở component: thiếu `timeZone: "UTC"` là lệch 7 tiếng, mà nhìn
 * màn hình không thể biết nó lệch.
 */
export function formatCycleMoment(
  lang: Lang,
  value: string | Date | null,
): string {
  const d = value == null ? null : toDate(value);
  if (!d) return "—";
  return `${formatUtcDate(lang, d)} ${formatUtcTime(lang, d)} ${UTC_LABEL}`;
}

/**
 * Chênh lệch giờ MÁY so với UTC, dạng `+7` / `+5:30` / `−3`.
 *
 * Dùng dấu trừ thật (U+2212) chứ không phải gạch nối: đứng cạnh số giờ thì gạch
 * nối dễ đọc nhầm thành khoảng.
 */
export function localUtcOffsetLabel(at: Date = new Date()): string {
  // `getTimezoneOffset` trả về số phút phải CỘNG vào giờ máy để ra UTC, nên nó
  // ngược dấu với cách người ta nói "UTC+7". Đảo dấu ngay để khỏi nhầm về sau.
  const minutes = -at.getTimezoneOffset();
  const sign = minutes < 0 ? "−" : "+";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `${sign}${h}` : `${sign}${h}:${String(m).padStart(2, "0")}`;
}

/** Máy người xem có đang ở đúng UTC không (thì khỏi nhắc chênh lệch). */
export function isMachineOnUtc(at: Date = new Date()): boolean {
  return at.getTimezoneOffset() === 0;
}
