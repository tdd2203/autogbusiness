import { useState, type FormEvent } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { ApiError } from "../lib/api";
import { useT } from "../i18n";

export default function Login() {
  const t = useT();
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: { pathname?: string } } };
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(identifier.trim(), password);
      const to = location.state?.from?.pathname ?? "/workspaces";
      navigate(to, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          typeof err.detail === "string" ? err.detail : t("auth.errorAuth"),
        );
      } else {
        setError(t("auth.errorConnection"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ background: "var(--bg)" }}
    >
      <form
        onSubmit={onSubmit}
        className="surface-card page-fade"
        style={{
          width: "100%",
          maxWidth: 380,
          padding: 32,
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <div
          className="flex items-baseline"
          style={{ gap: 8, marginBottom: 4 }}
        >
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 20,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              color: "var(--ink)",
            }}
          >
            {t("app.name")}
          </span>
          <span
            style={{
              fontSize: 11,
              color: "var(--ink-3)",
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.02em",
              textTransform: "uppercase",
            }}
          >
            {t("app.adminBadge")}
          </span>
        </div>
        <p
          style={{
            fontSize: 13,
            color: "var(--ink-3)",
            marginBottom: 28,
          }}
        >
          {t("auth.subtitle")}
        </p>

        <div style={{ marginBottom: 16 }}>
          <label className="form-label">{t("auth.identifier")}</label>
          <input
            autoFocus
            required
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            className="form-input"
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label className="form-label">{t("auth.password")}</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="form-input"
          />
        </div>

        {error && (
          <div
            style={{
              fontSize: 12.5,
              color: "var(--danger)",
              background: "var(--danger-bg)",
              border: "1px solid #fecaca",
              borderRadius: "var(--radius)",
              padding: "8px 12px",
              marginBottom: 16,
            }}
          >
            {error}
          </div>
        )}

        <button
          disabled={busy}
          className="btn btn-primary"
          style={{ width: "100%", justifyContent: "center", padding: "10px 14px" }}
        >
          {busy ? t("auth.loginBusy") : t("auth.login")}
        </button>
      </form>
    </div>
  );
}
