import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  fetchActiveTask,
  whoami,
  type ActiveTaskInfo,
} from "../shared/api";
import { getConfig, setConfig } from "../shared/storage";
import type { ConnectionStatus, ExtensionConfig } from "../shared/types";
import { useI18n, type Lang } from "../i18n";
import { CHANGELOG, KIND_COLOR, VERSION } from "../version";

export default function App() {
  const { t, lang, setLang } = useI18n();
  const [apiBaseUrl, setApiBaseUrl] = useState("http://localhost:18000");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>({ state: "checking" });
  const [saving, setSaving] = useState(false);
  const [activeInfo, setActiveInfo] = useState<ActiveTaskInfo | null>(null);
  const [showChangelog, setShowChangelog] = useState(false);

  const refreshActiveTask = useCallback(async () => {
    const config = await getConfig();
    if (!config) return;
    try {
      const info = await fetchActiveTask(config);
      setActiveInfo(info);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    (async () => {
      let config = await getConfig();
      if (!config) {
        setStatus({ state: "disconnected" });
        return;
      }
      // Auto-migrate: backend đã chuyển từ port default 8000 → 18000 ở v0.1.0.
      // User cũ có thể đã lưu URL :8000 trong storage → fetch fail "Failed to
      // fetch". Tự rewrite sang :18000 + persist lại, không bắt user click.
      const migrated = config.apiBaseUrl.replace(
        /^http:\/\/(localhost|127\.0\.0\.1):8000(\/?.*)$/i,
        "http://$1:18000$2",
      );
      if (migrated !== config.apiBaseUrl) {
        console.log(
          "[autogpt-popup] auto-migrate apiBaseUrl:",
          config.apiBaseUrl, "→", migrated,
        );
        config = { ...config, apiBaseUrl: migrated };
        await setConfig(config);
      }
      setApiBaseUrl(config.apiBaseUrl);
      setApiKey(config.apiKey);
      await verify(config);
      await refreshActiveTask();
    })();
  }, [refreshActiveTask]);

  // Poll active task mỗi 1.5s khi popup mở để hiển thị tiến trình real-time.
  // Popup close → effect cleanup → ngừng poll → không tốn quota khi popup ẩn.
  useEffect(() => {
    if (status.state !== "connected") return;
    const id = window.setInterval(() => {
      void refreshActiveTask();
    }, 1500);
    return () => window.clearInterval(id);
  }, [status.state, refreshActiveTask]);

  // AUTO-REFRESH whoami: khi SYNC_BILLING vừa chuyển sang terminal
  // (COMPLETED/FAILED) → re-fetch whoami để hiển thị seat mới. Track bằng
  // ref: lưu lại ID task IN_PROGRESS đã thấy, khi recent_completed có ID
  // trùng + type SYNC_BILLING → trigger refetch.
  const lastInProgressIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeInfo) return;
    // Lưu ID task IN_PROGRESS hiện tại
    if (activeInfo.in_progress) {
      lastInProgressIdRef.current = activeInfo.in_progress.id;
      return;
    }
    // Không có IN_PROGRESS. Check recent_completed — nếu match ID đã track
    // và type SYNC_BILLING → seat có thể vừa update → re-fetch whoami.
    const recent = activeInfo.recent_completed;
    if (
      recent &&
      recent.type === "SYNC_BILLING" &&
      recent.id === lastInProgressIdRef.current &&
      recent.status === "COMPLETED"
    ) {
      lastInProgressIdRef.current = null; // reset để không re-fetch lặp
      void (async () => {
        const cfg = await getConfig();
        if (cfg) await verify(cfg);
      })();
    }
  }, [activeInfo]);

  async function verify(config: ExtensionConfig): Promise<void> {
    setStatus({ state: "checking" });
    try {
      const ws = await whoami(config);
      setStatus({ state: "connected", workspace: ws });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setStatus({ state: "error", message: t("popup.errorBadKey") });
      } else if (e instanceof Error) {
        setStatus({ state: "error", message: e.message });
      } else {
        setStatus({ state: "error", message: t("popup.errorUnknown") });
      }
    }
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    const config: ExtensionConfig = {
      apiBaseUrl: apiBaseUrl.trim().replace(/\/$/, ""),
      apiKey: apiKey.trim(),
    };
    await setConfig(config);
    await verify(config);
    await refreshActiveTask();
    setSaving(false);
  }

  async function onDisconnect(): Promise<void> {
    if (!window.confirm(t("popup.disconnectConfirm"))) return;
    await setConfig(null);
    setApiKey("");
    setStatus({ state: "disconnected" });
    setActiveInfo(null);
  }

  return (
    <div>
      <div className="header-row">
        <h1>{t("popup.title")}</h1>
        <span
          className="version-badge"
          onClick={() => setShowChangelog((v) => !v)}
          title={t("popup.versionTooltip")}
        >
          v{VERSION} <span className="caret">{showChangelog ? "▴" : "▾"}</span>
        </span>
      </div>

      {showChangelog && (
        <div className="changelog-panel">
          {CHANGELOG.map((entry) => (
            <div key={entry.version} className="changelog-entry">
              <div className="changelog-header">
                <span className="changelog-version">v{entry.version}</span>
                <span
                  className="changelog-kind"
                  style={{ background: KIND_COLOR[entry.kind] }}
                >
                  {t(`popup.changelogKind.${entry.kind}`)}
                </span>
                <span className="changelog-date">{entry.date}</span>
              </div>
              <div className="changelog-summary">{entry.summary}</div>
              <ul className="changelog-details">
                {entry.details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {status.state === "connected" && (
        <div className="status connected">
          <div>
            <strong>{t("popup.statusConnected")}</strong>: {status.workspace.name}
          </div>
          <div className="workspace-info">
            {t("popup.plan")}: {status.workspace.plan ?? "—"} · {t("popup.seat")}:{" "}
            {status.workspace.seat_used ?? 0}/
            {status.workspace.seat_total ?? "—"}
          </div>
        </div>
      )}
      {status.state === "checking" && (
        <div className="status disconnected">{t("popup.statusChecking")}</div>
      )}
      {status.state === "disconnected" && (
        <div className="status disconnected">{t("popup.statusDisconnected")}</div>
      )}
      {status.state === "error" && (
        <div className="status error">
          {t("popup.statusError")}: {status.message}
        </div>
      )}

      {status.state === "connected" && activeInfo && (
        <ActiveTaskPanel info={activeInfo} t={t} />
      )}

      <form onSubmit={onSubmit}>
        <div className="field">
          <label>{t("popup.backendUrl")}</label>
          <input
            type="text"
            required
            value={apiBaseUrl}
            onChange={(e) => setApiBaseUrl(e.target.value)}
            placeholder="http://localhost:18000"
          />
        </div>
        <div className="field">
          <label>{t("popup.apiKey")}</label>
          <input
            type="password"
            required
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t("popup.apiKeyPlaceholder")}
          />
        </div>
        <div className="row">
          <button type="submit" className="secondary flex-1" disabled={saving}>
            {saving ? t("popup.connecting") : t("popup.connect")}
          </button>
          {(status.state === "connected" || status.state === "error") && (
            <button type="button" className="danger" onClick={onDisconnect}>
              {t("popup.disconnect")}
            </button>
          )}
        </div>
      </form>

      <div className="footer" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{CHANGELOG[0].summary}</span>
        <span style={{ marginLeft: "auto" }}>
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value as Lang)}
            style={{
              fontSize: 11,
              padding: "1px 2px",
              border: "1px solid #cbd5e1",
              borderRadius: 3,
              background: "white",
            }}
          >
            <option value="vi">VI</option>
            <option value="zh-CN">中文</option>
          </select>
        </span>
      </div>
    </div>
  );
}

/**
 * Panel "task đang chạy" — replace cho block "Không có task chờ" cũ.
 *
 * Hiển thị (ưu tiên giảm dần):
 *   1. in_progress: badge "Đang chạy", task type + message + thanh progress
 *   2. pending_count > 0: "N task đang chờ" (gray, ngắn)
 *   3. recent_completed: "Vừa xong: {type}" với status badge (60s gần đây)
 *   4. Nếu tất cả null/0: KHÔNG render gì (popup gọn)
 */
function ActiveTaskPanel({
  info,
  t,
}: {
  info: ActiveTaskInfo;
  t: (k: string, p?: Record<string, string | number>) => string;
}): React.ReactElement | null {
  const ip = info.in_progress;
  const recent = info.recent_completed;
  const pending = info.pending_count;

  if (!ip && pending === 0 && !recent) return null;

  if (ip) {
    const progress = (ip.progress ?? {}) as {
      phase?: string;
      message?: string;
      current?: number;
      total?: number;
      scanned?: number;
      elapsed_sec?: number;
    };
    const cur = progress.current ?? 0;
    const tot = progress.total ?? 0;
    const pct =
      tot > 0 ? Math.min(100, Math.round((cur / tot) * 100)) : null;
    return (
      <div
        style={{
          marginBottom: 10,
          padding: "8px 10px",
          background: "#eff6ff",
          border: "1px solid #bfdbfe",
          borderRadius: 6,
          fontSize: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <span
            style={{
              fontSize: 10,
              padding: "1px 6px",
              borderRadius: 3,
              background: "#2563eb",
              color: "white",
              fontWeight: 600,
              letterSpacing: "0.04em",
            }}
          >
            {t("popup.running")}
          </span>
          <span style={{ fontWeight: 600, color: "#1e3a8a" }}>{ip.type}</span>
          {progress.elapsed_sec !== undefined && (
            <span style={{ marginLeft: "auto", fontSize: 10, color: "#64748b" }}>
              {progress.elapsed_sec}s
            </span>
          )}
        </div>
        {progress.message && (
          <div style={{ fontSize: 11, color: "#1e40af", marginBottom: 4 }}>
            {progress.message}
          </div>
        )}
        {pct !== null && (
          <div style={{ marginTop: 4 }}>
            <div
              style={{
                height: 6,
                background: "#dbeafe",
                borderRadius: 3,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: "100%",
                  background: "#2563eb",
                  transition: "width 0.3s ease",
                }}
              />
            </div>
            <div style={{ fontSize: 10, color: "#475569", marginTop: 2, textAlign: "right" }}>
              {cur}/{tot} ({pct}%)
            </div>
          </div>
        )}
        {pending > 0 && (
          <div style={{ fontSize: 10, color: "#64748b", marginTop: 4 }}>
            + {t("popup.activePending", { n: pending })}
          </div>
        )}
      </div>
    );
  }

  if (pending > 0) {
    return (
      <div
        style={{
          marginBottom: 10,
          padding: "6px 10px",
          background: "#f1f5f9",
          borderRadius: 6,
          fontSize: 11,
          color: "#64748b",
        }}
      >
        ⧗ {t("popup.activePending", { n: pending })}
      </div>
    );
  }

  if (recent) {
    // Bỏ hoàn toàn hiển thị CONTENT_NOT_INJECTED — đây là lỗi infrastructure
    // được background runner tự recovery (executeScript → reload tab → recreate
    // tab). User KHÔNG cần thấy/thao tác. Cũng bỏ NOT_LOGGED_IN_CHATGPT vì
    // tương tự (background tự mở tab login nếu cần).
    const isInfraError =
      recent.error_code === "CONTENT_NOT_INJECTED" ||
      recent.error_code === "NOT_LOGGED_IN_CHATGPT";
    if (isInfraError) return null;

    const isOk = recent.status === "COMPLETED";
    return (
      <div
        style={{
          marginBottom: 10,
          padding: "6px 10px",
          background: isOk ? "#f0fdf4" : "#fef2f2",
          border: `1px solid ${isOk ? "#bbf7d0" : "#fecaca"}`,
          borderRadius: 6,
          fontSize: 11,
          color: isOk ? "#166534" : "#991b1b",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span>{isOk ? "✓" : "✗"}</span>
        <span style={{ fontWeight: 600 }}>{recent.type}</span>
        <span style={{ opacity: 0.7 }}>
          {isOk ? t("popup.recentDone") : recent.error_code ?? t("popup.recentFailed")}
        </span>
      </div>
    );
  }

  return null;
}
