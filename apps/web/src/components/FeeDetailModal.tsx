/**
 * Khối "vì sao ra con số này" — DÙNG CHUNG cho ô mời và các màn hình gia hạn.
 *
 * Tách khỏi trang Mời (2026-09-09) khi màn hình gia hạn cũng phải giải thích giá:
 * ở không gian chốt theo chu kỳ hoá đơn, gia hạn giữa kỳ chỉ trả phần lẻ tới mốc
 * chốt nên con số không còn là "đơn giá × số tháng" — không bày phép tính ra thì
 * người bán không biết báo với khách thế nào. Hai màn hình dùng CHUNG một khối để
 * không có chỗ nào giải thích theo kiểu riêng.
 *
 * Nguồn dữ liệu: `invite-preview → detail` và `renew-preview → items` (cùng bộ trường).
 */
import { Fragment } from "react";
import { useI18n } from "../i18n";
import { formatVnd } from "../lib/wallet";
import { formatVnDate, formatVnMoment } from "../lib/cycle-time";

/** Một dòng giải thích giá do server trả về (`invite-preview` → `detail`). */
export type FeeDetailRow = {
  email: string;
  fee: number;
  /** Đơn vị NỬA NGÀY (số nguyên) — phần lẻ có thật, đừng làm tròn khi hiện. */
  half_days: number;
  from: string;
  to: string | null;
  unit_price_vnd?: number;
  /** Chỉ có ở chế độ neo theo mốc chốt. */
  prorated_half_days?: number;
  whole_months?: number;
  cycle_days?: number;
  cycle_start?: string;
  cycle_end?: string;
};

/**
 * POPUP "vì sao ra con số này".
 *
 * Người bán nhìn "Tổng phí 20.000đ" thì không biết giải thích với khách thế nào —
 * nhất là ở chế độ neo theo mốc chốt, nơi giá đổi theo NGÀY nên hai email mua cách
 * nhau vài hôm ra hai con số khác nhau.
 *
 * BỐ CỤC: trường nào GIỐNG NHAU ở mọi email thì nói MỘT LẦN ở đầu, trường nào khác
 * nhau mới thành cột trong bảng. Mời một mẻ thường cùng không gian, cùng ngày, nên
 * gần như mọi thứ trùng — lặp lại từng khối cho mỗi email là bắt người đọc dò xem
 * có gì khác nhau không, trong khi câu trả lời là "không". Ngược lại, mời lẫn hai
 * không gian khác chu kỳ thì bảng tự mọc thêm cột đúng chỗ khác nhau.
 *
 * ⚠️ CỐ Ý KHÔNG tính lại tiền ở đây. Popup chỉ bày ra các THÀNH PHẦN (đơn giá, số
 * ngày lẻ, số chu kỳ trọn) rồi hiện `fee` do server chốt. Tự nhân chia lại ở client
 * là dựng thêm một nguồn sự thật thứ hai cho tiền — có ngày nó lệch với số thật sự
 * bị trừ, mà lệch kiểu đó thì không ai tin màn hình nữa.
 *
 * Mốc hiện theo GIỜ VIỆT NAM (chốt user 8/9/2026): đại lý và khách đọc giờ VN. Giờ
 * UTC chỉ còn ở đồng hồ trang Cài đặt để chủ cửa hàng tra khi cần.
 */
export function FeeDetailModal({
  rows,
  onClose,
}: {
  rows: FeeDetailRow[];
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const num = (halfDays: number) =>
    (halfDays / 2).toLocaleString(lang === "zh-CN" ? "zh-CN" : "vi-VN");

  // Mỗi trường tự khai: nhãn, cách hiện, và (nếu có) dòng chú thích. `value` trả
  // chuỗi để so trùng — trùng hết thì lên đầu, không thì thành cột.
  const fields: {
    key: string;
    label: string;
    value: (r: FeeDetailRow) => string;
    /** Bản GỌN cho ô trong bảng — khối trên rộng rãi, cột thì không. */
    short?: (r: FeeDetailRow) => string;
    hint?: string;
  }[] = [
    {
      key: "cycle",
      label: t("invite.feeDetailCycle"),
      short: (r) =>
        r.cycle_start && r.cycle_end
          ? `${formatVnDate(lang, r.cycle_start)} → ${formatVnDate(
              lang,
              r.cycle_end,
            )}`
          : "",
      value: (r) =>
        r.cycle_start && r.cycle_end
          ? `${formatVnDate(lang, r.cycle_start)} → ${formatVnDate(
              lang,
              r.cycle_end,
            )}${
              r.cycle_days != null
                ? ` · ${t("invite.feeDetailDays", { n: String(r.cycle_days) })}`
                : ""
            }`
          : "",
    },
    {
      key: "to",
      label: t("invite.feeDetailUntil"),
      value: (r) => formatVnMoment(lang, r.to),
      short: (r) => formatVnMoment(lang, r.to),
      hint: t("invite.feeDetailUntilHint"),
    },
    {
      // GỘP "thời gian thực dùng" + "số ngày" làm MỘT. Tách đôi thì thành hai con
      // số trông như mâu thuẫn (16 ngày 19 giờ vs 17 ngày); để cạnh nhau kèm mũi
      // tên thì tự nó giải thích luật nửa-ngày.
      key: "span",
      label: t("invite.feeDetailSpan"),
      value: (r) => {
        const rounded = t("invite.feeDetailDays", { n: num(r.half_days) });
        if (!r.to) return rounded;
        const ms = new Date(r.to).getTime() - new Date(r.from).getTime();
        if (!Number.isFinite(ms) || ms <= 0) return rounded;
        const d = Math.floor(ms / 86400000);
        const h = Math.floor((ms % 86400000) / 3600000);
        const real =
          h === 0
            ? t("invite.feeDetailDays", { n: String(d) })
            : t("invite.feeDetailSpanValue", { d: String(d), h: String(h) });
        return `${real} → ${t("invite.feeDetailRounded", { n: rounded })}`;
      },
      short: (r) => t("invite.feeDetailDays", { n: num(r.half_days) }),
    },
    {
      key: "unit",
      label: t("invite.feeDetailUnit"),
      value: (r) => {
        if (r.unit_price_vnd == null) return "";
        const perMonth = t("invite.feeDetailUnitValue", {
          price: formatVnd(r.unit_price_vnd),
        });
        if (!r.cycle_days) return perMonth;
        // Giá THẬT của một ngày và giá SAU khi làm tròn lên bội trăm. Chỉ hiện số
        // đã làm tròn thì người bán nhân ngược lại ra sai; chỉ hiện số thật thì
        // không khớp con số trên hoá đơn.
        const exact = Math.round(r.unit_price_vnd / r.cycle_days);
        const rounded = Math.ceil(r.unit_price_vnd / r.cycle_days / 100) * 100;
        return `${perMonth} · ${t("invite.feeDetailUnitPerDay", {
          price: formatVnd(exact),
        })} · ${t("invite.feeDetailUnitRounded", {
          price: formatVnd(rounded),
        })}`;
      },
    },
    {
      // Thay cho "Phần lẻ" + "Chu kỳ trọn" — hai nhãn đó là tiếng lóng nội bộ,
      // người bán đọc không ra. Ở đây nói thẳng TỈ LỆ dùng để nhân tiền.
      //
      // CỐ Ý không kèm kết quả: tiền của mỗi email nằm ở cột Thành tiền do server
      // chốt. Nhân ra ở đây là dựng nguồn sự thật thứ hai cho tiền.
      key: "ratio",
      label: t("invite.feeDetailRatio"),
      value: (r) => {
        const parts: string[] = [];
        if ((r.prorated_half_days ?? 0) > 0 && r.cycle_days) {
          parts.push(
            t("invite.feeDetailRatioDays", {
              n: num(r.prorated_half_days ?? 0),
              total: String(r.cycle_days),
            }),
          );
        }
        if ((r.whole_months ?? 0) > 0) {
          parts.push(
            t("invite.feeDetailMonths", { n: String(r.whole_months) }),
          );
        }
        return parts.join(" + ");
      },
    },
  ];

  const used = fields.filter((f) => rows.some((r) => f.value(r) !== ""));
  const shared = used.filter(
    (f) => new Set(rows.map((f2) => f.value(f2))).size === 1,
  );
  const varying = used.filter((f) => !shared.includes(f));

  return (
    <div className="tg-modal-backdrop" onClick={onClose}>
      <div
        className="tg-modal"
        // TỰ CO GIÃN theo nội dung: `fit-content` cho modal rộng đúng bằng thứ nó
        // phải chứa, `min()` chặn hai đầu — không tràn khỏi màn hình, cũng không
        // hẹp đến mức bảng phải cuộn khi thừa chỗ. Để cứng một con số thì mời một
        // không gian sẽ thừa mênh mông, còn mời lẫn nhiều không gian lại bị cắt.
        style={{
          width: "fit-content",
          minWidth: "min(94vw, 560px)",
          maxWidth: "min(94vw, 1080px)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tg-modal-head">
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <h3 className="tg-h" style={{ flex: 1 }}>
              {t("invite.feeDetailTitle")}
            </h3>
            <button
              className="ntpl-x"
              onClick={onClose}
              aria-label={t("common.close")}
            >
              ×
            </button>
          </div>
        </div>
        <div className="tg-modal-body">
          {/* DÙNG CHUNG cho mọi email — nói một lần, gom trong MỘT thẻ để mắt thấy
              ngay đây là phần chung, còn bảng bên dưới mới là phần riêng. */}
          <div
            className="fee-detail-shared"
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: "2px 14px",
            }}
          >
          {shared.map((f) => (
            <div className="info-row" key={f.key}>
              <div className="key">{f.label}</div>
              <div className="val" style={{ lineHeight: 1.6 }}>
                {/* Tách theo dấu · để mỗi mệnh đề tự xuống dòng nguyên vẹn, không
                    bị bẻ giữa "làm tròn 700 đ / ngày". */}
                {f
                  .value(rows[0])
                  .split(" · ")
                  .map((part, i) => (
                    <Fragment key={part}>
                      {/* KHOẢNG TRẮNG THẬT giữa các đoạn — không có nó thì trình
                          duyệt không có chỗ ngắt dòng, mà mỗi đoạn lại `nowrap`
                          nên cả dòng tràn ra ngoài và bị cắt cụt. */}
                      {i > 0 && " "}
                      <span style={{ whiteSpace: "nowrap" }}>
                        {/* Dấu phân cách đi KÈM đoạn phía sau: để nó đứng cuối
                            đoạn trước thì xuống dòng sẽ có dấu · mồ côi. */}
                        {i > 0 && (
                          <span style={{ color: "var(--ink-3)" }}>{"· "}</span>
                        )}
                        {part}
                      </span>
                    </Fragment>
                  ))}
                {f.hint && (
                  <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                    {f.hint}
                  </div>
                )}
              </div>
            </div>
          ))}
          </div>

          <div
            style={{
              marginTop: 18,
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--ink-3)",
            }}
          >
            {t("invite.feeDetailPerEmail")}
          </div>
          <div
            style={{
              marginTop: 8,
              border: "1px solid var(--border)",
              borderRadius: 12,
              // Cuộn ngang thay vì CẮT khi bảng rộng hơn modal. Trên màn hẹp bảng
              // đã XẾP CHỒNG (xem `.fee-detail-table`) nên không còn gì để cuộn.
              overflowX: "auto",
            }}
          >
            <table className="data-table data-table-compact fee-detail-table">
              <thead>
                <tr>
                  <th>{t("invite.feeDetailEmail")}</th>
                  {varying.map((f) => (
                    <th key={f.key}>{f.label}</th>
                  ))}
                  <th style={{ textAlign: "right" }}>
                    {t("invite.feeDetailFee")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.email}>
                    {/* `data-label` là nhãn cột dùng lại khi bảng XẾP CHỒNG trên
                        màn hẹp — thead bị ẩn nên không còn gì nói cột nào là cột
                        nào (xem `.fee-detail-table` trong index.css). */}
                    <td data-label="">{r.email}</td>
                    {varying.map((f) => (
                      <td
                        key={f.key}
                        data-label={f.label}
                        style={{ whiteSpace: "nowrap" }}
                      >
                        {(f.short ?? f.value)(r) || "—"}
                      </td>
                    ))}
                    <td
                      data-label={t("invite.feeDetailFee")}
                      style={{
                        textAlign: "right",
                        fontFamily: "var(--font-mono)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {formatVnd(r.fee)}
                    </td>
                  </tr>
                ))}
                {/* Tổng nằm ngay dưới các dòng chứ không bắt người đọc tự cộng —
                    đây là con số họ sẽ đối chiếu với footer bên ngoài. */}
                <tr style={{ background: "var(--bg)", fontWeight: 600 }}>
                  <td colSpan={1 + varying.length}>
                    {t("invite.feeDetailTotal")}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontFamily: "var(--font-mono)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {formatVnd(rows.reduce((sum, r) => sum + r.fee, 0))}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
