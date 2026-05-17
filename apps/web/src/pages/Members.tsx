import { useEffect, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { useT } from "../i18n";
import type { Member, QueueItem } from "../types";
import { triggerExtensionRun } from "../hooks/useExtensionTrigger";
import { TaskCompletionBanner } from "../components/TaskCompletionBanner";

type Role = "owner" | "admin" | "member";

const ROLE_BADGE: Record<string, string> = {
  owner: "bg-purple-100 text-purple-800",
  admin: "bg-blue-100 text-blue-800",
  member: "bg-slate-100 text-slate-700",
};

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800",
  pending: "bg-amber-100 text-amber-800",
  removed: "bg-rose-100 text-rose-800",
};

export default function Members() {
  const t = useT();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { hasPermission, user } = useAuth();
  const qc = useQueryClient();

  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [inviteError, setInviteError] = useState<string | null>(null);

  const { data: members = [], isLoading } = useQuery({
    queryKey: ["members", workspaceId],
    queryFn: () =>
      api<Member[]>(`/api/v1/workspaces/${workspaceId}/members`),
    enabled: !!workspaceId,
  });

  // Poll recent tasks — bao gồm cả COMPLETED/FAILED để show kết quả sync xong.
  // Lọc active vs completed ở client.
  const { data: recentTasks = [] } = useQuery({
    queryKey: ["recent-tasks", workspaceId],
    queryFn: () =>
      api<QueueItem[]>(`/api/v1/queue?workspace_id=${workspaceId}&limit=50`),
    enabled: !!workspaceId,
    refetchInterval: 2000,
  });

  const activeTasks = recentTasks.filter(
    (t) => t.status === "PENDING" || t.status === "IN_PROGRESS",
  );
  const activeSyncTask = activeTasks.find((t) => t.type === "SYNC_DATA");
  const activeInviteCount = activeTasks.filter(
    (t) => t.type === "INVITE_MEMBER",
  ).length;

  // Track task ID của lần sync gần nhất → tìm trong recentTasks để show
  // completion banner với result data.
  const [lastSyncTaskId, setLastSyncTaskId] = useState<string | null>(null);
  const lastSyncTask = lastSyncTaskId
    ? recentTasks.find((t) => t.id === lastSyncTaskId) ?? null
    : null;
  const showSyncCompletion =
    lastSyncTask?.status === "COMPLETED" || lastSyncTask?.status === "FAILED";

  // Auto-dismiss SUCCESS banner sau 10s. FAILED giữ tới khi user dismiss.
  useEffect(() => {
    if (!showSyncCompletion || lastSyncTask?.status !== "COMPLETED") return;
    const timer = setTimeout(() => setLastSyncTaskId(null), 10000);
    return () => clearTimeout(timer);
  }, [showSyncCompletion, lastSyncTask?.status]);

  // Auto-refresh member list khi sync task vừa transition active → done
  const prevSyncIdRef = useRef<string | null>(null);
  useEffect(() => {
    const currentSyncId = activeSyncTask?.id ?? null;
    if (prevSyncIdRef.current && !currentSyncId) {
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
    }
    prevSyncIdRef.current = currentSyncId;
  }, [activeSyncTask?.id, qc, workspaceId]);

  const sync = useMutation({
    mutationFn: () =>
      api<{ queue_item_id: string; status: string }>(
        `/api/v1/workspaces/${workspaceId}/sync`,
        { method: "POST" },
      ),
    onSuccess: (resp) => {
      setLastSyncTaskId(resp.queue_item_id);
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      triggerExtensionRun();
    },
  });

  const invite = useMutation({
    mutationFn: () =>
      api<Member>(`/api/v1/workspaces/${workspaceId}/members/invite`, {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      }),
    onSuccess: () => {
      setShowInvite(false);
      setInviteEmail("");
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      triggerExtensionRun();
    },
    onError: (e) => {
      setInviteError(
        e instanceof ApiError ? String(e.detail) : t("member.inviteError"),
      );
    },
  });

  const remove = useMutation({
    mutationFn: (memberId: string) =>
      api(`/api/v1/workspaces/${workspaceId}/members/${memberId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      triggerExtensionRun();
    },
  });

  const changeRole = useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: Role }) =>
      api(`/api/v1/workspaces/${workspaceId}/members/${memberId}/role`, {
        method: "PATCH",
        body: JSON.stringify({ new_role: role }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      triggerExtensionRun();
    },
  });

  function onInviteSubmit(e: FormEvent) {
    e.preventDefault();
    setInviteError(null);
    invite.mutate();
  }

  const canInvite = hasPermission("MEMBER_INVITE");
  const canRemove = hasPermission("MEMBER_REMOVE");
  const canChangeRole = user?.is_super_admin === true;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-medium">{t("member.listTitle")}</h2>
        <div className="flex gap-2">
          {hasPermission("WORKSPACE_SYNC_TRIGGER") && (
            <button
              onClick={() => sync.mutate()}
              disabled={sync.isPending || !!activeSyncTask}
              className="bg-white border px-4 py-2 rounded text-sm disabled:opacity-60"
              title={t("member.syncTooltip")}
            >
              {activeSyncTask
                ? t("member.syncRunning")
                : sync.isPending
                ? t("member.syncBusy")
                : t("member.syncButton")}
            </button>
          )}
          {canInvite && !showInvite && (
            <button
              onClick={() => setShowInvite(true)}
              className="bg-slate-900 text-white px-4 py-2 rounded text-sm"
            >
              {t("member.inviteButton")}
            </button>
          )}
        </div>
      </div>
      {activeSyncTask && <SyncProgressBanner task={activeSyncTask} />}
      {!activeSyncTask && showSyncCompletion && lastSyncTask && (
        <TaskCompletionBanner
          task={lastSyncTask}
          onDismiss={() => setLastSyncTaskId(null)}
        />
      )}
      {!activeSyncTask && !lastSyncTask && sync.isSuccess && (
        <div className="bg-blue-50 border border-blue-300 rounded p-3 mb-4 text-sm text-blue-900">
          {t("member.syncQueued")}
        </div>
      )}
      {activeInviteCount > 0 && (
        <div className="bg-amber-50 border border-amber-300 rounded p-3 mb-4 text-sm text-amber-900">
          {t("member.invitesInFlight", { n: activeInviteCount })}
        </div>
      )}

      {showInvite && (
        <form
          onSubmit={onInviteSubmit}
          className="bg-white rounded shadow p-5 mb-6 space-y-3"
        >
          <h2 className="font-medium">{t("member.inviteTitle")}</h2>
          <div className="flex gap-3">
            <input
              required
              type="email"
              placeholder={t("member.inviteEmailPlaceholder")}
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              className="flex-1 border rounded px-3 py-2"
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as Role)}
              className="border rounded px-3 py-2"
            >
              <option value="member">{t("member.roleMember")}</option>
              <option value="admin">{t("member.roleAdmin")}</option>
            </select>
          </div>
          {inviteError && (
            <div className="text-rose-600 text-sm">{inviteError}</div>
          )}
          <div className="flex gap-2">
            <button
              disabled={invite.isPending}
              className="bg-slate-900 text-white px-4 py-2 rounded disabled:opacity-60"
            >
              {invite.isPending
                ? t("member.inviteBusy")
                : t("member.inviteSubmit")}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowInvite(false);
                setInviteError(null);
              }}
              className="px-4 py-2 rounded border"
            >
              {t("common.cancel")}
            </button>
          </div>
        </form>
      )}

      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-700">
            <tr>
              <th className="p-3 font-medium">{t("member.colEmail")}</th>
              <th className="p-3 font-medium">{t("member.colName")}</th>
              <th className="p-3 font-medium">{t("member.colRole")}</th>
              <th className="p-3 font-medium">{t("member.colStatus")}</th>
              <th className="p-3 font-medium text-right">
                {t("common.actions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-slate-500">
                  {t("common.loading")}
                </td>
              </tr>
            )}
            {!isLoading && members.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-slate-500">
                  {user?.is_super_admin
                    ? t("member.emptySuper")
                    : t("member.emptySub")}
                </td>
              </tr>
            )}
            {members.map((m) => (
              <tr key={m.id} className="border-t">
                <td className="p-3 font-medium">{m.email}</td>
                <td className="p-3 text-slate-700">{m.name ?? "—"}</td>
                <td className="p-3">
                  {m.chatgpt_role ? (
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        ROLE_BADGE[m.chatgpt_role] ?? "bg-slate-100"
                      }`}
                    >
                      {t(`member.role${m.chatgpt_role.charAt(0).toUpperCase()}${m.chatgpt_role.slice(1)}`)}
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="p-3">
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      STATUS_BADGE[m.status] ?? "bg-slate-100"
                    }`}
                  >
                    {t(`member.status${m.status.charAt(0).toUpperCase()}${m.status.slice(1)}`)}
                  </span>
                </td>
                <td className="p-3 text-right space-x-2">
                  {canChangeRole && m.chatgpt_role && m.status === "active" && (
                    <select
                      value={m.chatgpt_role}
                      onChange={(e) =>
                        changeRole.mutate({
                          memberId: m.id,
                          role: e.target.value as Role,
                        })
                      }
                      className="border rounded px-2 py-1 text-xs"
                    >
                      <option value="member">{t("member.roleMember")}</option>
                      <option value="admin">{t("member.roleAdmin")}</option>
                      <option value="owner">{t("member.roleOwner")}</option>
                    </select>
                  )}
                  {canRemove && m.status !== "removed" && (
                    <button
                      onClick={() => {
                        if (
                          window.confirm(
                            t("member.confirmRemove", { email: m.email }),
                          )
                        ) {
                          remove.mutate(m.id);
                        }
                      }}
                      className="text-rose-600 hover:text-rose-700 text-xs"
                    >
                      {t("member.removeAction")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SyncProgressBanner({ task }: { task: QueueItem }) {
  const t = useT();
  const p = task.progress ?? {};
  const phase = (p.phase as string | undefined) ?? task.status;
  const current = p.current as number | undefined;
  const message = (p.message as string | undefined) ?? t(`progress.${phase}`);
  const showCount = typeof current === "number";

  return (
    <div className="bg-blue-50 border border-blue-300 rounded p-4 mb-4">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-3 h-3 rounded-full bg-blue-500 animate-pulse" />
        <div className="font-medium text-blue-900">{t("member.syncRunning")}</div>
        {showCount && (
          <div className="text-sm text-blue-700 ml-auto">
            {t("progress.collected", { n: current ?? 0 })}
          </div>
        )}
      </div>
      <div className="text-sm text-blue-800">{message}</div>
    </div>
  );
}
