/**
 * Mục "Giao diện" trong trang Cài đặt: chọn cỡ chữ.
 *
 * Bấm là đổi ngay chứ không có nút Lưu — người dùng phải NHÌN thấy cỡ mới rồi
 * mới biết có vừa mắt không, bắt lưu xong mới thấy thì phải bấm đi bấm lại.
 * Lưu tại máy nên không có lượt gọi API nào ở đây.
 */
import {
  DEFAULT_UI_SCALE,
  setUiScale,
  UI_SCALES,
  useUiScale,
  type UiScale,
} from "../lib/ui-scale";
import { useT } from "../i18n";

const LABEL_KEY: Record<UiScale, string> = {
  0.9: "appearance.scaleSmall",
  1: "appearance.scaleNormal",
  1.1: "appearance.scaleLarge",
  1.25: "appearance.scaleXLarge",
};

export function AppearanceSettings() {
  const t = useT();
  const scale = useUiScale();

  return (
    <div className="settings-section">
      <h3 className="display-h3">{t("appearance.title")}</h3>
      <p
        style={{
          fontSize: 13,
          color: "var(--ink-3)",
          marginTop: 4,
          marginBottom: 20,
        }}
      >
        {t("appearance.desc")}
      </p>

      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 18,
        }}
      >
        {UI_SCALES.map((s) => {
          const active = s === scale;
          return (
            <button
              key={s}
              type="button"
              onClick={() => setUiScale(s)}
              aria-pressed={active}
              style={{
                flex: "1 1 120px",
                minWidth: 120,
                padding: "12px 14px",
                borderRadius: "var(--radius)",
                border: active
                  ? "1.5px solid var(--accent)"
                  : "1px solid var(--border)",
                background: active ? "var(--surface-2)" : "var(--surface)",
                color: "var(--ink)",
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "inherit",
                boxShadow: active ? "var(--shadow-sm)" : "none",
              }}
            >
              {/* Chữ mẫu vẽ đúng theo cỡ của nút đó để so bằng mắt trước khi bấm. */}
              <div
                style={{
                  fontSize: 13.5 * s,
                  fontWeight: 600,
                  lineHeight: 1.3,
                  marginBottom: 3,
                }}
              >
                {t(LABEL_KEY[s])}
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: active ? "var(--ink-2)" : "var(--ink-3)",
                  fontWeight: 500,
                }}
              >
                {Math.round(s * 100)}%
                {s === DEFAULT_UI_SCALE ? ` · ${t("appearance.isDefault")}` : ""}
              </div>
            </button>
          );
        })}
      </div>

      <div
        style={{
          padding: "12px 14px",
          borderRadius: "var(--radius)",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          fontSize: 12.5,
          color: "var(--ink-2)",
          lineHeight: 1.55,
        }}
      >
        {t("appearance.note")}
      </div>
    </div>
  );
}
