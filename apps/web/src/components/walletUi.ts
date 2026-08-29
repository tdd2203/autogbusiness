/**
 * Bộ mặt chung của "Ví": định dạng số, nhãn ngày và các hằng style.
 *
 * Tách khỏi `pages/Wallet.tsx` vì trang Quản trị Ví (xem ví của tài khoản khác) phải
 * trông Y HỆT ví của người dùng — chép lại một bản gần giống là sớm muộn hai bên lệch
 * nhau (user 2026-08-29). Đây là file thuần trình bày, không gọi API.
 */

import type React from "react";
import { vnDateKey } from "../lib/wallet-history";

/** Hôm nay theo lịch VIỆT NAM (YYYY-MM-DD) — khớp mốc ngày mà API dùng để chốt số. */
export function vnToday(): string {
  return vnDateKey(new Date().toISOString());
}

/** "2026-08-26" → "26/8/2026" (nhãn ngày kiểu Việt, bỏ số 0 thừa). */
export function vnDateLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d}/${m}/${y}`;
}

/** Số nguyên VND từ ô nhập (bỏ mọi ký tự không phải chữ số). */
export function parseVnd(text: string): number {
  const digits = text.replace(/\D/g, "");
  return digits ? Number(digits) : 0;
}

/** 3.300.000 → "3,3 tr" (nhãn ngắn trên nút chọn nhanh). */
export function shortVnd(n: number): string {
  const trim = (v: number) => String(Number(v.toFixed(1))).replace(".", ",");
  if (n >= 1_000_000_000) return `${trim(n / 1_000_000_000)} tỷ`;
  if (n >= 1_000_000) return `${trim(n / 1_000_000)} tr`;
  if (n >= 1_000) return `${trim(n / 1_000)} k`;
  return String(n);
}

/** Số tiền lớn không kèm ký hiệu (chữ "đ" hiện riêng, cỡ nhỏ hơn). */
export function bigVnd(n: number): string {
  return Math.abs(Math.round(n)).toLocaleString("vi-VN");
}

/** "2026-08-26" ± n ngày, vẫn theo lịch (không lệch vì múi giờ). */
export function shiftDay(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export const card: React.CSSProperties = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: 20, boxShadow: "var(--shadow-card)", minWidth: 0 };
export const cardKicker: React.CSSProperties = { fontSize: 10, letterSpacing: ".12em", color: "var(--ink-3)", fontFamily: "var(--font-mono)", textTransform: "uppercase", height: 24 };
export const cardTitle: React.CSSProperties = { fontSize: 17, fontWeight: 700, letterSpacing: "-.02em", color: "var(--ink)", marginBottom: 10 };
export const bigNumber: React.CSSProperties = { fontSize: 32, fontWeight: 800, letterSpacing: "-.03em", lineHeight: 1, color: "var(--ink)", whiteSpace: "nowrap" };
export const legendList: React.CSSProperties = { marginTop: 16, display: "flex", flexDirection: "column", gap: 9, fontSize: 12 };
export const input: React.CSSProperties = { width: "100%", padding: "12px 14px", border: "1px solid var(--border-strong)", borderRadius: "var(--radius)", fontSize: 14, background: "var(--surface)", color: "var(--ink)" };
export const primaryBtn: React.CSSProperties = { padding: "10px 18px", background: "var(--ink)", color: "var(--surface)", border: "none", borderRadius: "var(--radius)", fontSize: 13, fontWeight: 700, cursor: "pointer", flexShrink: 0 };
export const secondaryBtn: React.CSSProperties = { padding: "10px 16px", background: "var(--surface)", color: "var(--ink)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius)", fontSize: 13, fontWeight: 600, cursor: "pointer" };
export const linkBtn: React.CSSProperties = { background: "none", border: "none", padding: 0, fontSize: 12.5, fontWeight: 600, color: "var(--ink-3)", cursor: "pointer", flexShrink: 0 };
export const chip: React.CSSProperties = { border: "1px solid var(--border-strong)", borderRadius: 20, padding: "6px 13px", fontSize: 12.5, cursor: "pointer", background: "var(--surface)", color: "var(--ink-2)", whiteSpace: "nowrap" };
// Dùng nguyên `border` chứ không chỉ `borderColor`: React cảnh báo khi một style
// vừa có shorthand vừa có thuộc tính con cho cùng giá trị.
export const chipOn: React.CSSProperties = { background: "var(--ink)", color: "var(--surface)", border: "1px solid var(--ink)", fontWeight: 600 };
export const iconBtn: React.CSSProperties = { width: 32, height: 32, flexShrink: 0, border: "1px solid var(--border-strong)", background: "var(--surface)", borderRadius: 8, fontSize: 14, color: "var(--ink-2)", cursor: "pointer", display: "grid", placeItems: "center" };
export const panelTab: React.CSSProperties = { flex: 1, border: "none", borderRadius: 8, padding: 9, fontSize: 13, fontWeight: 600, cursor: "pointer", background: "transparent", color: "var(--ink-3)" };
export const panelTabOn: React.CSSProperties = { background: "var(--surface)", color: "var(--ink)", boxShadow: "var(--shadow-sm)" };
export const pickBtn: React.CSSProperties = { flex: 1, border: "1px solid var(--border-strong)", background: "var(--surface)", borderRadius: 8, padding: "9px 0", fontSize: 12.5, cursor: "pointer", color: "var(--ink-2)" };
export const previewLine: React.CSSProperties = { background: "var(--surface-2)", borderRadius: "var(--radius)", padding: "11px 13px", fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 };
