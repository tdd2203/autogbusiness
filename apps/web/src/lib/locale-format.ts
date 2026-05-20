import type { Lang } from "../i18n";

export function localeTag(lang: Lang): string {
  return lang === "zh-CN" ? "zh-CN" : "vi-VN";
}

export function formatDateForLang(
  lang: Lang,
  value: string | Date,
  options?: Intl.DateTimeFormatOptions,
): string {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(localeTag(lang), options);
}

export function formatDateTimeForLang(
  lang: Lang,
  value: string | Date,
  dateOptions?: Intl.DateTimeFormatOptions,
): string {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  const tag = localeTag(lang);
  return `${d.toLocaleDateString(tag, dateOptions)} ${d.toLocaleTimeString(tag, {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}
