import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, countPendingTasks, whoami } from "../shared/api";
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
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [running, setRunning] = useState(false);
  const [lastRunMsg, setLastRunMsg] = useState<string | null>(null);
  const [showChangelog, setShowChangelog] = useState(false);

  const refreshPendingCount = useCallback(async () => {
    const config = await getConfig();
    if (!config) return;
    try {
      const n = await countPendingTasks(config);
      setPendingCount(n);
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
      await refreshPendingCount();
    })();
  }, [refreshPendingCount]);

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
    await refreshPendingCount();
    setSaving(false);
  }

  async function onDisconnect(): Promise<void> {
    if (!window.confirm(t("popup.disconnectConfirm"))) return;
    await setConfig(null);
    setApiKey("");
    setStatus({ state: "disconnected" });
    setPendingCount(0);
  }

  async function onRunPending(): Promise<void> {
    setRunning(true);
    setLastRunMsg(null);
    try {
      const resp = (await chrome.runtime.sendMessage({ type: "run-pending" })) as
        | { ok: boolean; processed?: number; lastStatus?: string; lastDetail?: string }
        | undefined;
      if (resp?.ok) {
        setLastRunMsg(
          t("popup.runDone", { n: resp.processed ?? 0 }) +
            (resp.lastStatus && resp.lastStatus !== "idle"
              ? ` · ${resp.lastStatus}${resp.lastDetail ? `: ${resp.lastDetail}` : ""}`
              : ""),
        );
      }
    } finally {
      setRunning(false);
      await refreshPendingCount();
    }
  }

  const canRun = status.state === "connected" && !running;

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
            {status.workspace.seat_used ?? 0}/{status.workspace.seat_total ?? "—"}
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

      {status.state === "connected" && (
        <div style={{ marginBottom: 10 }}>
          <button
            type="button"
            className="primary"
            style={{ width: "100%" }}
            onClick={onRunPending}
            disabled={!canRun || pendingCount === 0}
          >
            {running
              ? t("popup.running")
              : pendingCount === 0
              ? t("popup.runPendingZero")
              : t("popup.runPending", { n: pendingCount })}
          </button>
          {lastRunMsg && (
            <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>
              {lastRunMsg}
            </div>
          )}
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6 }}>
            {t("popup.tipNoPolling")}
          </div>
        </div>
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

      <div className="footer">
        <span>{CHANGELOG[0].summary}</span>
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
