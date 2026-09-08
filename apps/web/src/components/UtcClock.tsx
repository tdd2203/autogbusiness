/**
 * ĐỒNG HỒ UTC+0 trong tab Tài khoản.
 *
 * Vì sao cần: mốc chốt chu kỳ, hạn dùng và kỳ hoá đơn đều tính bằng ngày lịch UTC
 * (`EXPIRY_RULES.md` §3.6.4), mà máy người xem thì ở giờ Việt Nam — lệch 7 tiếng.
 * Hệ quả cụ thể: mua lúc 6h sáng giờ VN được tính vào NGÀY UTC HÔM TRƯỚC, nên hạn
 * dùng nhìn qua như lệch một ngày. Có đồng hồ này thì đối chiếu được ngay thay vì
 * ngồi trừ nhẩm.
 *
 * Cố ý đặt ở trang Cài đặt chứ không nhét lên thanh trên cùng: nó là thứ để TRA khi
 * thấy con số lạ, không phải thứ phải nhìn suốt ngày.
 */

import { useEffect, useState } from "react";

import { useI18n } from "../i18n";
import {
  formatUtcDate,
  formatUtcTime,
  isMachineOnUtc,
  localUtcOffsetLabel,
} from "../lib/cycle-time";

export function UtcClock() {
  const { t, lang } = useI18n();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Nhịp 1 giây: đồng hồ đứng yên thì người ta không tin nó đang chạy thật.
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <>
      <div className="info-row">
        <div className="key">{t("settings.utcClock")}</div>
        <div className="val">
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {formatUtcDate(lang, now)} {formatUtcTime(lang, now)}
          </span>
          <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>
            {t("settings.utcClockDesc")}
          </div>
        </div>
      </div>
      {!isMachineOnUtc(now) && (
        <div className="info-row">
          <div className="key">{t("settings.utcOffset")}</div>
          <div className="val">UTC{localUtcOffsetLabel(now)}</div>
        </div>
      )}
    </>
  );
}
