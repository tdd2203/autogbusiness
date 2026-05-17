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
    <div className="max-w-xl">
      <h2 className="text-lg font-medium mb-4">{t("wsettings.title")}</h2>
      <form onSubmit={onSubmit} className="bg-white rounded shadow p-5 space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">
            {t("wsettings.rateInvite")}
          </label>
          <input
            type="number"
            min={0}
            max={600000}
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            className="w-full border rounded px-3 py-2"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">
            {t("wsettings.rateRole")}
          </label>
          <input
            type="number"
            min={0}
            max={600000}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="w-full border rounded px-3 py-2"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">
            {t("wsettings.rateRemove")}
          </label>
          <input
            type="number"
            min={0}
            max={600000}
            value={remove}
            onChange={(e) => setRemove(e.target.value)}
            className="w-full border rounded px-3 py-2"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
          />
          <span>{t("wsettings.dryRun")}</span>
        </label>
        {msg && (
          <div
            className={`text-sm ${
              msg.ok ? "text-emerald-700" : "text-rose-600"
            }`}
          >
            {msg.text}
          </div>
        )}
        <button
          disabled={save.isPending}
          className="bg-slate-900 text-white px-4 py-2 rounded disabled:opacity-60"
        >
          {save.isPending ? t("common.saving") : t("common.save")}
        </button>
      </form>
    </div>
  );
}
