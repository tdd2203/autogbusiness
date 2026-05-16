import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import type { WorkspaceSettings as WSettings } from "../types";

export default function WorkspaceSettings() {
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
      setMsg({ ok: true, text: "Đã lưu cài đặt" });
      qc.invalidateQueries({ queryKey: ["workspace-settings", workspaceId] });
    },
    onError: (e) =>
      setMsg({
        ok: false,
        text: e instanceof ApiError ? String(e.detail) : "Lỗi lưu",
      }),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    save.mutate();
  }

  return (
    <div className="max-w-xl">
      <h2 className="text-lg font-medium mb-4">Cài đặt workspace</h2>
      <form onSubmit={onSubmit} className="bg-white rounded shadow p-5 space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">
            Rate limit — Invite (ms giữa các thao tác)
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
            Rate limit — Change role (ms)
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
            Rate limit — Remove (ms)
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
          <span>
            Dry-run mode (Extension log thao tác nhưng KHÔNG thực thi trên
            ChatGPT)
          </span>
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
          {save.isPending ? "Đang lưu..." : "Lưu"}
        </button>
      </form>
    </div>
  );
}
