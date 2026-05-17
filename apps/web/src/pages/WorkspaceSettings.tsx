import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n";
import type { WorkspaceSettings as WSettings } from "../types";

export default function WorkspaceSettings() {
  const t = useT();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const qc = useQueryClient();
  const [invite, setInvite] = useState("5000");
  const [role, setRole] = useState("3000");
  const [remove, setRemove] = useState("5000");
  const [dryRun, setDryRun] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const { data: settings } = useQuery({
    queryKey: ["workspace-settings", workspaceId],
    queryFn: () =>
      api<WSettings>(`/api/v1/workspaces/${workspaceId}/settings`),
    enabled: !!workspaceId,
  });

  useEffect(() => {
    if (settings) {
      setInvite(String(settings.rate_limit_invite_ms));
      setRole(String(settings.rate_limit_role_ms));
      setRemove(String(settings.rate_limit_remove_ms));
      setDryRun(settings.dry_run_mode);
    }
  }, [settings]);

  const save = useMutation({
    mutationFn: () =>
      api<WSettings>(`/api/v1/workspaces/${workspaceId}/settings`, {
        method: "PATCH",
        body: JSON.stringify({
          rate_limit_invite_ms: Number(invite),
          rate_limit_role_ms: Number(role),
          rate_limit_remove_ms: Number(remove),
          dry_run_mode: dryRun,
        }),
      }),
    onSuccess: () => {
      setMsg({ ok: true, text: t("wsettings.saveOk") });
      qc.invalidateQueries({ queryKey: ["workspace-settings", workspaceId] });
    },
    onError: (e) =>
      setMsg({
        ok: false,
        text: e instanceof ApiError ? String(e.detail) : t("wsettings.saveError"),
      }),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    save.mutate();
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <form onSubmit={onSubmit} className="settings-section" style={{ marginBottom: 20 }}>
        <h3 className="display-h3">{t("wsettings.title")}</h3>
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
        <div style={{ marginBottom: 16 }}>
          <label className="form-label">{t("wsettings.rateInvite")}</label>
          <input
            type="number"
            min={0}
            max={600000}
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            className="form-input"
          />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label className="form-label">{t("wsettings.rateRole")}</label>
          <input
            type="number"
            min={0}
            max={600000}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="form-input"
          />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label className="form-label">{t("wsettings.rateRemove")}</label>
          <input
            type="number"
            min={0}
            max={600000}
            value={remove}
            onChange={(e) => setRemove(e.target.value)}
            className="form-input"
          />
        </div>
        <label
          className="flex items-center"
          style={{ gap: 8, fontSize: 13, marginBottom: 16 }}
        >
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
          />
          <span>{t("wsettings.dryRun")}</span>
        </label>
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
        <button disabled={save.isPending} className="btn btn-primary">
          {save.isPending ? t("common.saving") : t("common.save")}
        </button>
      </form>
    </div>
  );
}
