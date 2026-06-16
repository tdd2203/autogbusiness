import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n";
import type { Workspace, WorkspaceSettings as WSettings } from "../types";

export default function WorkspaceSettings() {
  const t = useT();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const qc = useQueryClient();
  const [invite, setInvite] = useState("5000");
  const [role, setRole] = useState("3000");
  const [remove, setRemove] = useState("5000");
  const [dryRun, setDryRun] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [verifiedDomain, setVerifiedDomain] = useState("");
  const [domainMsg, setDomainMsg] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const { data: settings } = useQuery({
    queryKey: ["workspace-settings", workspaceId],
    queryFn: () =>
      api<WSettings>(`/api/v1/workspaces/${workspaceId}/settings`),
    enabled: !!workspaceId,
  });

  const { data: workspace } = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => api<Workspace>(`/api/v1/workspaces/${workspaceId}`),
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

  useEffect(() => {
    if (workspace) setVerifiedDomain(workspace.verified_domain ?? "");
  }, [workspace]);

  const saveDomain = useMutation({
    mutationFn: () =>
      api<Workspace>(`/api/v1/workspaces/${workspaceId}`, {
        method: "PATCH",
        body: JSON.stringify({ verified_domain: verifiedDomain.trim() }),
      }),
    onSuccess: () => {
      setDomainMsg({ ok: true, text: "Đã lưu tên miền xác minh" });
      qc.invalidateQueries({ queryKey: ["workspace", workspaceId] });
      qc.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: (e) =>
      setDomainMsg({
        ok: false,
        text: e instanceof ApiError ? String(e.detail) : "Lưu thất bại",
      }),
  });

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

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setDomainMsg(null);
          saveDomain.mutate();
        }}
        className="settings-section"
      >
        <h3 className="display-h3">Tên miền đã xác minh</h3>
        <p
          style={{
            fontSize: 13,
            color: "var(--ink-3)",
            marginTop: 4,
            marginBottom: 16,
          }}
        >
          Khi mời thành viên: nếu mọi email đều thuộc tên miền này thì không cần
          bật "cho phép mời ngoài tên miền". Để trống nếu chưa có.
        </p>
        <input
          placeholder="vd: ndaigroup.org"
          value={verifiedDomain}
          onChange={(e) => setVerifiedDomain(e.target.value)}
          className="form-input"
          style={{ marginBottom: 12 }}
        />
        {domainMsg && (
          <div
            style={{
              fontSize: 13,
              color: domainMsg.ok ? "var(--success)" : "var(--danger)",
              marginBottom: 12,
            }}
          >
            {domainMsg.text}
          </div>
        )}
        <button disabled={saveDomain.isPending} className="btn btn-primary">
          {saveDomain.isPending ? t("common.saving") : t("common.save")}
        </button>
      </form>
    </div>
  );
}
