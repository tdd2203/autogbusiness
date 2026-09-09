/**
 * Khối "vì sao ra con số này" của MỘT lượt gia hạn — dùng chung cho ô gia hạn lẻ và
 * popup gia hạn hàng loạt.
 *
 * Trước đây phần giải thích nằm trong một popup riêng, mà popup đó mở đè lên chính
 * modal gọi nó nên chữ bị che gần hết (user báo 9/9/2026). Nay nó là một khối bày
 * thẳng tại chỗ; hai màn hình dùng CHUNG khối này để không có nơi nào giải thích
 * theo kiểu riêng.
 *
 * ⚠️ KHÔNG tính lại tiền ở đây. Mọi con số đến từ `renew-preview`: phần lẻ
 * (`fee_prorated`), các chu kỳ trọn (`fee_whole`), tổng (`fee`) — server đã tách sẵn
 * và luôn cộng khít. Nhân chia lại ở web là dựng nguồn sự thật thứ hai cho tiền.
 */
import { useI18n, useT } from "../i18n";
import { formatVnd } from "../lib/wallet";
import { formatVnDate, formatVnMoment } from "../lib/cycle-time";
import type { RenewPreviewItem } from "../hooks/useRenewPreview";

/**
 * Một dòng "nhãn trái — số phải".
 *
 * Dùng flex + wrap chứ không phải hai cột cứng: trên điện thoại (~360px) nhãn kiểu
 * "12,5 ngày lẻ tới 30/09/2026" dài hơn nửa khối, cột cứng thì số bị đẩy tràn ra
 * ngoài và bị cắt. Wrap thì số tự rơi xuống dòng dưới mà vẫn canh phải.
 */
export function CalcRow({
  label,
  value,
  hint,
  strong = false,
}: {
  label: string;
  value: string;
  /** Chú thích nhỏ trong ngoặc, đứng sau giá trị (vd "hạn hiện tại"). */
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: "2px 10px",
      }}
    >
      <span
        style={{
          fontSize: strong ? 13 : 12.5,
          color: strong ? "var(--ink)" : "var(--ink-3)",
          fontWeight: strong ? 600 : 400,
        }}
      >
        {label}
      </span>
      <span
        style={{ marginLeft: "auto", textAlign: "right", overflowWrap: "anywhere" }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: strong ? 15 : 12.5,
            fontWeight: strong ? 700 : 500,
            color: "var(--ink)",
          }}
        >
          {value}
        </span>
        {hint && (
          <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}> ({hint})</span>
        )}
      </span>
    </div>
  );
}

export function RenewCalcRows({
  item,
  months,
  totalLabel,
  showUnit = true,
  showCycle = true,
}: {
  /** Một dòng `renew-preview → items`. */
  item: RenewPreviewItem;
  /** Số tháng người dùng đang chọn — chỉ để dựng nhãn ở không gian chế độ 30 ngày. */
  months: number;
  /** Có nhãn thì vẽ dòng tổng in đậm; bỏ trống khi nơi gọi đã có dòng tổng riêng. */
  totalLabel?: string;
  /** Tắt khi nơi gọi đã nói đơn giá một lần cho cả mẻ, khỏi lặp ở từng email. */
  showUnit?: boolean;
  /** Tắt khi nơi gọi đã nói chu kỳ một lần cho cả mẻ — cùng lý do với `showUnit`. */
  showCycle?: boolean;
}) {
  const t = useT();
  const { lang } = useI18n();
  // Nửa ngày là đơn vị THẬT của phần lẻ — hiện "12,5 ngày", đừng làm tròn.
  const halfDaysText = (halfDays: number) =>
    (halfDays / 2).toLocaleString(lang === "zh-CN" ? "zh-CN" : "vi-VN");
  // Điểm nối là hạn cũ (còn hạn) hay bây giờ (đã hết hạn) — người bán hỏi câu này
  // ngay khi thấy số ngày lẻ, nên nói luôn thay vì bắt họ đối chiếu hai mốc.
  const fromIsCurrentEnd =
    item.current_end_at != null &&
    new Date(item.from).getTime() === new Date(item.current_end_at).getTime();
  // Đơn giá tháng chỉ nói lên tổng ở nhánh tính theo tháng. Nhánh bảng giá bậc (Canva,
  // mua dài rẻ hơn) không nhân đơn giá, in nó ra là bày một con số tiền không liên
  // quan gì tới dòng tổng ngay bên dưới.
  const unitDrivesFee =
    item.unit_price_vnd != null &&
    (item.cycle_days != null || item.unit_price_vnd * months === item.fee);

  const feeLines: { key: string; label: string; value: number }[] = [];
  if ((item.prorated_half_days ?? 0) > 0 && item.fee_prorated != null) {
    feeLines.push({
      key: "prorated",
      label: t("subscription.calcProrated", {
        days: halfDaysText(item.prorated_half_days ?? 0),
        date: formatVnDate(lang, item.cycle_end ?? null),
      }),
      value: item.fee_prorated,
    });
  }
  if ((item.whole_months ?? 0) > 0 && item.fee_whole != null) {
    feeLines.push({
      key: "whole",
      label: t("subscription.calcWholeMonths", { n: item.whole_months ?? 0 }),
      value: item.fee_whole,
    });
  }
  // Không gian chế độ cũ (30 ngày) chỉ có một khoản. Chỉ in phép nhân khi nó ra ĐÚNG
  // số server chốt: bảng giá bậc không nhân được, in ra là người bán đọc thấy một
  // phép tính không khớp tổng ngay bên dưới.
  if (item.cycle_days == null && unitDrivesFee && item.unit_price_vnd != null) {
    feeLines.push({
      key: "legacy",
      label: t("subscription.calcMonthsLegacy", {
        n: months,
        price: formatVnd(item.unit_price_vnd),
      }),
      value: item.fee,
    });
  } else if (item.cycle_days == null) {
    // Bảng giá bậc (mua dài rẻ hơn): không có phép nhân nào để bày, nhưng vẫn phải
    // có MỘT dòng khoản — thiếu nó thì bấm vào email xong chỉ thấy đúng dòng tổng,
    // tức là không trả lời được câu "tiền này của cái gì".
    feeLines.push({
      key: "package",
      label: t("subscription.calcPackage", { n: months }),
      value: item.fee,
    });
  }

  return (
    <>
      {showCycle && item.cycle_start && item.cycle_end && item.cycle_days != null && (
        <CalcRow
          label={t("invite.feeDetailCycle")}
          value={t("subscription.calcCycleValue", {
            start: formatVnDate(lang, item.cycle_start),
            end: formatVnDate(lang, item.cycle_end),
            days: item.cycle_days,
          })}
        />
      )}
      {/* Giờ VN cho CẢ khối: dòng chu kỳ và dòng ngày lẻ đã là giờ VN, để riêng dòng
          này theo giờ máy thì máy đặt sai múi là hai dòng cạnh nhau lệch một ngày. */}
      <CalcRow
        label={t("invite.feeDetailFrom")}
        value={formatVnMoment(lang, item.from)}
        hint={
          fromIsCurrentEnd
            ? t("subscription.calcFromCurrent")
            : t("subscription.calcFromNow")
        }
      />
      {showUnit && unitDrivesFee && item.unit_price_vnd != null && (
        <CalcRow
          label={t("invite.feeDetailUnit")}
          value={t("invite.feeDetailUnitValue", {
            price: formatVnd(item.unit_price_vnd),
          })}
        />
      )}
      {feeLines.length > 0 && (
        <div style={{ height: 1, background: "var(--border)", margin: "2px 0" }} />
      )}
      {feeLines.map((line) => (
        <CalcRow key={line.key} label={line.label} value={formatVnd(line.value)} />
      ))}
      {totalLabel && (
        <CalcRow strong label={totalLabel} value={formatVnd(item.fee)} />
      )}
    </>
  );
}
