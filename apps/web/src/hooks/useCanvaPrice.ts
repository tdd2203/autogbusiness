/**
 * Bảng giá Canva — NGUỒN DUY NHẤT cho mọi chỗ hiện giá của nhánh này.
 *
 * Canva bán theo BẬC (1 tháng 15.000 · 3 tháng 40.000 · 6 tháng 70.000 · 12 tháng
 * 100.000), khác hẳn ChatGPT bán theo đơn giá/tháng. Giá lại còn đặt riêng được cho
 * từng đại lý, nên trang mời TUYỆT ĐỐI không được tự nhân số: hiện một đằng mà lúc
 * trừ ví ra một nẻo là mất lòng tin ngay lần đầu dùng. Luôn đọc từ backend.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export type CanvaPriceTier = {
  /** Số tháng của gói. */
  months: number;
  /** Giá TRỌN GÓI cho ngần ấy tháng (không phải đơn giá/tháng). */
  price_vnd: number;
};

export type CanvaPriceTiers = {
  tiers: CanvaPriceTier[];
  /** Các mốc tháng được phép chào bán = đúng các bậc trong bảng. */
  sellable_months: number[];
  /** Bảng đang áp đến từ đâu: riêng đại lý / mặc định hệ thống / bảng gốc. */
  source: "user" | "system" | "builtin";
};

export const CANVA_PRICE_KEY = ["canva-price-tiers"] as const;

/** Bảng giá ĐANG ÁP cho chính người đang đăng nhập. */
export function useCanvaPriceTiers(enabled = true) {
  return useQuery<CanvaPriceTiers>({
    queryKey: CANVA_PRICE_KEY,
    queryFn: () => api<CanvaPriceTiers>("/api/v1/canva/price-tiers"),
    enabled,
    // Giá đổi bằng thao tác của super-admin chứ không tự trôi → không cần poll.
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Giá của một số tháng theo bảng bậc — dùng để hiện phí trước khi bấm mời.
 *
 * Quy tắc PHẢI khớp `app/services/canva_price.fee_for_months` bên backend: đúng bậc
 * thì lấy thẳng, tháng lẻ thì lấy bậc dưới gần nhất + phần dư theo đơn giá bậc đó,
 * làm tròn LÊN 1.000đ. Lệch công thức là hiện sai tiền.
 */
export function canvaFeeForMonths(tiers: CanvaPriceTier[], months: number | null): number {
  if (!tiers.length) return 0;
  const n = months && months >= 1 ? months : 1;
  const exact = tiers.find((t) => t.months === n);
  if (exact) return exact.price_vnd;
  const lower = tiers.filter((t) => t.months < n);
  const base = lower.length
    ? lower.reduce((a, b) => (a.months > b.months ? a : b))
    : tiers.reduce((a, b) => (a.months < b.months ? a : b));
  const perMonth = base.months ? base.price_vnd / base.months : base.price_vnd;
  const raw =
    base.months <= n ? base.price_vnd + (n - base.months) * perMonth : n * perMonth;
  return Math.ceil(raw / 1000) * 1000;
}
