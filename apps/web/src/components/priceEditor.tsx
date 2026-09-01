/**
 * Mảnh dùng chung cho MỌI chỗ sửa giá bán (trang "Bảng giá Canva" và modal sửa giá
 * trong "Tài khoản phụ").
 *
 * Gom về một chỗ vì công thức đọc/ghi bậc giá phải khớp backend
 * (`app/services/canva_price.py`): hiện một đằng mà lúc trừ ví ra một nẻo là mất
 * lòng tin ngay lần đầu dùng. Hai màn hình chép tay hai bản là kiểu gì cũng lệch.
 */
import type { CanvaPriceTier } from "../hooks/useCanvaPrice";

/** Một bậc đang được gõ dở — giữ nguyên chuỗi để ô nhập không nhảy số. */
export type PriceRow = { months: string; price: string };

export const fmtVnd = (n: number) => Math.round(n || 0).toLocaleString("vi-VN");
/** Ô tiền chỉ giữ chữ số; người dùng gõ dấu chấm hay khoảng trắng đều không sao. */
export const digitsOnly = (v: string) => v.replace(/[^0-9]/g, "");
export const moneyText = (v: string) => (v ? fmtVnd(Number(v)) : "");

export const perMonth = (months: number, price: number) =>
  months > 0 ? price / months : 0;

export function toRows(tiers?: CanvaPriceTier[]): PriceRow[] {
  return (tiers ?? []).map((t) => ({
    months: String(t.months),
    price: String(t.price_vnd),
  }));
}

export function parseRows(rows: PriceRow[]): CanvaPriceTier[] {
  return rows
    .map((r) => ({ months: Number(r.months), price_vnd: Number(r.price) }))
    .filter(
      (r) =>
        Number.isFinite(r.months) &&
        r.months >= 1 &&
        Number.isFinite(r.price_vnd) &&
        r.price_vnd >= 0,
    )
    .sort((a, b) => a.months - b.months);
}

/** Giá theo tỉ lệ của giá chung, làm tròn 500đ cho số đẹp khi đọc. */
export function scaled(tiers: CanvaPriceTier[], factor: number): CanvaPriceTier[] {
  return tiers.map((t) => ({
    months: t.months,
    price_vnd: Math.round((t.price_vnd * factor) / 500) * 500,
  }));
}

/** Mức giảm nhanh so với giá chung — đủ dùng cho mọi lần thương lượng thường gặp. */
export const QUICK_OFF = [5, 10, 15];

/** Chip chọn một trong hai/ba lựa chọn — cái đang chọn tô nền để nhìn là biết ngay. */
export function chipStyle(on: boolean): React.CSSProperties {
  return {
    padding: "7px 13px",
    borderRadius: 20,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
    border: `1px solid ${on ? "var(--success)" : "var(--border-strong)"}`,
    background: on ? "var(--success)" : "var(--surface)",
    color: on ? "#fff" : "var(--ink-2)",
  };
}

export const ROW_CARD: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: "12px 14px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  background: "var(--surface-2)",
};

/** Ô nhập tiền: số căn phải + hậu tố "đ" dính liền, khỏi ai nhầm với số tháng. */
export function MoneyInput({
  value,
  onChange,
  width,
}: {
  value: string;
  onChange: (next: string) => void;
  width: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        width,
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
        background: "var(--surface)",
      }}
    >
      <input
        value={moneyText(value)}
        inputMode="numeric"
        onChange={(e) => onChange(digitsOnly(e.target.value))}
        style={{
          flex: 1,
          minWidth: 0,
          padding: "9px 11px",
          border: 0,
          outline: "none",
          textAlign: "right",
          fontSize: 15,
          fontWeight: 600,
          background: "transparent",
          color: "inherit",
        }}
      />
      <span
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 11px",
          fontSize: 13,
          color: "var(--ink-3)",
          background: "var(--surface-2)",
          borderLeft: "1px solid var(--border)",
        }}
      >
        đ
      </span>
    </div>
  );
}
