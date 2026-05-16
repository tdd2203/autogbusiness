import { useEffect, useState, type FormEvent } from "react";
import { ApiError, whoami } from "../shared/api";
import { getConfig, setConfig } from "../shared/storage";
import type { ConnectionStatus, ExtensionConfig } from "../shared/types";

export default function App() {
  const [apiBaseUrl, setApiBaseUrl] = useState("http://localhost:8000");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>({ state: "checking" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const config = await getConfig();
      if (!config) {
        setStatus({ state: "disconnected", message: "Chưa cấu hình" });
        return;
      }
      setApiBaseUrl(config.apiBaseUrl);
      setApiKey(config.apiKey);
      await verify(config);
    })();
  }, []);

  async function verify(config: ExtensionConfig): Promise<void> {
    setStatus({ state: "checking" });
    try {
      const ws = await whoami(config);
      setStatus({ state: "connected", workspace: ws });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setStatus({ state: "error", message: "API key sai hoặc đã bị thu hồi" });
      } else if (e instanceof Error) {
        setStatus({ state: "error", message: e.message });
      } else {
        setStatus({ state: "error", message: "Lỗi không xác định" });
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
    setSaving(false);
  }

  async function onDisconnect(): Promise<void> {
    if (!window.confirm("Xoá cấu hình? Extension sẽ ngừng polling.")) return;
    await setConfig(null);
    setApiKey("");
    setStatus({ state: "disconnected", message: "Đã xoá cấu hình" });
  }

  async function onPollNow(): Promise<void> {
    await chrome.runtime.sendMessage({ type: "poll-now" });
  }

  return (
    <div>
      <h1>AutoGPT Admin</h1>

      {status.state === "connected" && (
        <div className="status connected">
          <div>
            <strong>✓ Kết nối</strong>: {status.workspace.name}
          </div>
          <div className="workspace-info">
            Plan: {status.workspace.plan ?? "—"} · Seat:{" "}
            {status.workspace.seat_used ?? 0}/{status.workspace.seat_total ?? "—"}
          </div>
        </div>
      )}
      {status.state === "checking" && (
        <div className="status disconnected">Đang kiểm tra…</div>
      )}
      {status.state === "disconnected" && (
        <div className="status disconnected">
          ✗ Chưa kết nối — nhập API key bên dưới
        </div>
      )}
      {status.state === "error" && (
        <div className="status error">✗ Lỗi: {status.message}</div>
      )}

      <form onSubmit={onSubmit}>
        <div className="field">
          <label>Backend URL</label>
          <input
            type="text"
            required
            value={apiBaseUrl}
            onChange={(e) => setApiBaseUrl(e.target.value)}
            placeholder="http://localhost:8000"
          />
        </div>
        <div className="field">
          <label>Extension API Key</label>
          <input
            type="password"
            required
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="dán key từ dashboard workspace…"
          />
        </div>
        <div className="row">
          <button type="submit" className="primary flex-1" disabled={saving}>
            {saving ? "Đang lưu…" : "Lưu & Kết nối"}
          </button>
          {status.state === "connected" && (
            <button
              type="button"
              className="secondary"
              onClick={onPollNow}
              title="Poll task ngay (debug)"
            >
              Poll
            </button>
          )}
          {(status.state === "connected" || status.state === "error") && (
            <button type="button" className="danger" onClick={onDisconnect}>
              Xoá
            </button>
          )}
        </div>
      </form>

      <div className="footer">
        <span>v0.1.0</span>
        <span>·</span>
        <span>Tuần 4 — skeleton</span>
      </div>
    </div>
  );
}
