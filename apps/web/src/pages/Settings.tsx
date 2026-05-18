import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError, setToken } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { useT } from "../i18n";
import { UiLabelsManager } from "../components/UiLabelsManager";

type SettingsTab = "account" | "security" | "uiLabels";

export default function Settings() {
  const t = useT();
  const { user, refresh } = useAuth();
  const [tab, setTab] = useState<SettingsTab>("account");
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      api<{ access_token: string }>("/api/v1/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ old_password: oldPw, new_password: newPw }),
      }),
    onSuccess: async (res) => {
      setToken(res.access_token);
      await refresh();
      setMsg({ ok: true, text: t("auth.changePasswordOk") });
      setOldPw("");
      setNewPw("");
    },
    onError: (e) => {
      setMsg({
        ok: false,
        text:
          e instanceof ApiError ? String(e.detail) : t("auth.changePasswordError"),
      });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    mut.mutate();
  }

  const joinedAt = user?.created_at
    ? new Date(user.created_at).toLocaleDateString()
    : "—";

  const displayName = user?.username ?? user?.email ?? "—";

  return (
    <div className="page-fade">
      <div style={{ marginBottom: 32 }}>
        <div className="breadcrumb">
          Account<span className="breadcrumb-sep">/</span>
          {t("nav.settings")}
        </div>
        <h1 className="display-h1">{t("settings.title")}</h1>
        <p className="page-sub">{t("settings.subtitle")}</p>
      </div>

      <div className="settings-grid">
        <nav className="settings-sidenav">
          <button
            onClick={() => setTab("account")}
            className={tab === "account" ? "settings-link active" : "settings-link"}
          >
            {t("settings.sectionAccount")}
          </button>
          <button
            onClick={() => setTab("security")}
            className={tab === "security" ? "settings-link active" : "settings-link"}
          >
            {t("settings.sectionSecurity")}
          </button>
          {user?.is_super_admin && (
            <button
              onClick={() => setTab("uiLabels")}
              className={tab === "uiLabels" ? "settings-link active" : "settings-link"}
            >
              {t("settings.sectionUiLabels")}
            </button>
          )}
        </nav>

        <div>
          {tab === "account" && (
            <div className="settings-section">
              <h3 className="display-h3">{t("settings.sectionAccountInfo")}</h3>
              <p
                style={{
                  fontSize: 13,
                  color: "var(--ink-3)",
                  marginTop: 4,
                  marginBottom: 20,
                }}
              >
                {t("settings.accountDesc")}
              </p>
              <div className="info-row">
                <div className="key">{t("settings.username")}</div>
                <div className="val">{displayName}</div>
              </div>
              <div className="info-row">
                <div className="key">{t("settings.role")}</div>
                <div className="val">
                  {user?.is_super_admin ? (
                    <span className="badge badge-info">{t("role.super")}</span>
                  ) : (
                    <span className="role-tag">{t("role.sub")}</span>
                  )}
                </div>
              </div>
              <div className="info-row">
                <div className="key">{t("settings.joinedAt")}</div>
                <div className="val">{joinedAt}</div>
              </div>
            </div>
          )}

          {tab === "uiLabels" && user?.is_super_admin && <UiLabelsManager />}

          {tab === "security" && (
            <div className="settings-section">
              <h3 className="display-h3">
                {t("settings.sectionPasswordHeader")}
              </h3>
              <p
                style={{
                  fontSize: 13,
                  color: "var(--ink-3)",
                  marginTop: 4,
                  marginBottom: 20,
                }}
              >
                {t("settings.passwordDesc")}
              </p>
              <form onSubmit={onSubmit}>
                <div style={{ marginBottom: 16 }}>
                  <label className="form-label">{t("auth.oldPassword")}</label>
                  <input
                    required
                    type="password"
                    placeholder="••••••••"
                    value={oldPw}
                    onChange={(e) => setOldPw(e.target.value)}
                    className="form-input"
                  />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <label className="form-label">{t("auth.newPassword")}</label>
                  <input
                    required
                    type="password"
                    minLength={8}
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    className="form-input"
                  />
                </div>
                {msg && (
                  <div
                    style={{
                      fontSize: 13,
                      color: msg.ok ? "var(--success)" : "var(--danger)",
                      marginBottom: 12,
                    }}
                  >
                    {msg.text}
                  </div>
                )}
                <button disabled={mut.isPending} className="btn btn-primary">
                  {mut.isPending
                    ? t("auth.changePasswordBusy")
                    : t("settings.update")}
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
