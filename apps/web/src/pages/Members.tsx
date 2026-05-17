import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { useT } from "../i18n";
import type { Member, QueueItem } from "../types";
import { triggerExtensionRun } from "../hooks/useExtensionTrigger";
import { TaskCompletionBanner } from "../components/TaskCompletionBanner";
import { confirm, toast } from "../components/Toast";

type Role = "owner" | "admin" | "member";

const STATUS_BADGE: Record<string, string> = {
  active: "badge badge-success",
  pending: "badge badge-warning",
  removed: "badge badge-danger",
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
  const [search, setSearch] = useState("");

  const { data: members = [], isLoading } = useQuery({
    queryKey: ["members", workspaceId],
    queryFn: () =>
      api<Member[]>(`/api/v1/workspaces/${workspaceId}/members`),
    enabled: !!workspaceId,
  });

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

  const [lastSyncTaskId, setLastSyncTaskId] = useState<string | null>(null);
  const lastSyncTask = lastSyncTaskId
    ? recentTasks.find((t) => t.id === lastSyncTaskId) ?? null
    : null;
  const showSyncCompletion =
    lastSyncTask?.status === "COMPLETED" || lastSyncTask?.status === "FAILED";

  useEffect(() => {
    if (!showSyncCompletion || lastSyncTask?.status !== "COMPLETED") return;
    const timer = setTimeout(() => setLastSyncTaskId(null), 10000);
    return () => clearTimeout(timer);
  }, [showSyncCompletion, lastSyncTask?.status]);

  const prevSyncIdRef = useRef<string | null>(null);
  const lastRogueAskedRef = useRef<string | null>(null);
  useEffect(() => {
    const currentSyncId = activeSyncTask?.id ?? null;
    if (prevSyncIdRef.current && !currentSyncId) {
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
    }
    prevSyncIdRef.current = currentSyncId;
  }, [activeSyncTask?.id, qc, workspaceId]);

  const sync = useMutation({
    mutationFn: (includePending: boolean) =>
      api<{ queue_item_id: string; status: string }>(
        `/api/v1/workspaces/${workspaceId}/sync?include_pending=${includePending}`,
        { method: "POST" },
      ),
    onSuccess: (resp) => {
      setLastSyncTaskId(resp.queue_item_id);
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      triggerExtensionRun();
    },
  });

  const cancelTask = useMutation({
    mutationFn: async (taskId: string) => {
      const ok = await confirm(
        t("queue.cancelConfirm", { type: activeSyncTask?.type ?? "SYNC_DATA" }),
        {
          title: t("queue.cancelConfirmTitle"),
          okText: t("queue.cancelOk"),
          cancelText: t("common.cancel"),
          danger: true,
        },
      );
      if (!ok) throw new Error("__user_cancel__");
      return api<{ id: string; status: string }>(
        `/api/v1/queue/${taskId}/cancel`,
        { method: "POST" },
      );
    },
    onSuccess: () => {
      toast.success(t("queue.cancelOkToast"));
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
    },
    onError: (e) => {
      if (e instanceof Error && e.message === "__user_cancel__") return;
      toast.error(
        t("queue.cancelError", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    },
  });

  const revokeInvites = useMutation({
    mutationFn: (emails: string[]) =>
      api<{ queue_item_id: string; count: number }>(
        `/api/v1/workspaces/${workspaceId}/revoke-invites`,
        { method: "POST", body: JSON.stringify({ emails }) },
      ),
    onSuccess: (resp) => {
      toast.success(t("member.revokeToastOk", { n: resp.count }));
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
    },
    onError: (e) => {
      toast.error(
        t("member.revokeToastError", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    },
  });

  useEffect(() => {
    if (!activeSyncTask || activeSyncTask.status !== "COMPLETED") return;
    const rogue = (activeSyncTask.result?.rogue_pending_emails ?? []) as
      | string[]
      | undefined;
    if (!Array.isArray(rogue) || rogue.length === 0) return;
    if (lastRogueAskedRef.current === activeSyncTask.id) return;
    lastRogueAskedRef.current = activeSyncTask.id;

    (async () => {
      const list = rogue.slice(0, 10).join("\n");
      const more =
        rogue.length > 10
          ? t("member.rogueMore", { n: rogue.length - 10 })
          : "";
      const ok = await confirm(
        t("member.rogueBody", { n: rogue.length, list, more }),
        {
          title: t("member.rogueTitle", { n: rogue.length }),
          okText: t("member.rogueOk", { n: rogue.length }),
          cancelText: t("member.rogueCancel"),
          danger: true,
          requireType: "delete",
        },
      );
      if (ok) {
        revokeInvites.mutate(rogue);
      }
    })();
  }, [activeSyncTask?.id, activeSyncTask?.status]);

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

  const total = members.length;
  const activeCount = members.filter((m) => m.status === "active").length;
  const pendingCount = members.filter((m) => m.status === "pending").length;
  const queueCount = recentTasks.length;
  const recentFailed = recentTasks.filter((t) => t.status === "FAILED").length;
  const activeRate = total > 0 ? Math.round((activeCount / total) * 100) : 0;

  const filteredMembers = useMemo(() => {
    if (!search.trim()) return members;
    const s = search.trim().toLowerCase();
    return members.filter(
      (m) =>
        m.email.toLowerCase().includes(s) ||
        (m.name ?? "").toLowerCase().includes(s),
    );
  }, [members, search]);

  return (
    <div>
      {activeSyncTask && (
        <div style={{ marginBottom: 16 }}>
          <SyncProgressBanner
            task={activeSyncTask}
            onCancel={() => cancelTask.mutate(activeSyncTask.id)}
            canceling={cancelTask.isPending}
          />
        </div>
      )}
      {!activeSyncTask && showSyncCompletion && lastSyncTask && (
        <div style={{ marginBottom: 16 }}>
          <TaskCompletionBanner
            task={lastSyncTask}
            onDismiss={() => setLastSyncTaskId(null)}
          />
        </div>
      )}
      {!activeSyncTask && !lastSyncTask && sync.isSuccess && (
        <div className="notice" style={{ marginBottom: 16 }}>
          <div className="notice-icon">
            <div className="spinner" />
          </div>
          <div>
            <div className="notice-title">{t("member.syncRunning")}</div>
            <div className="notice-body">{t("member.syncQueued")}</div>
          </div>
        </div>
      )}
      {activeInviteCount > 0 && (
        <div className="notice warn" style={{ marginBottom: 16 }}>
          <div className="notice-icon">
            <div className="spinner" />
          </div>
          <div>
            <div className="notice-title">
              {t("member.invitesInFlight", { n: activeInviteCount })}
            </div>
          </div>
        </div>
      )}

      <div className="metrics" style={{ marginBottom: 24 }}>
        <Metric label={t("metrics.totalMembers")} value={total} />
        <Metric
          label={t("metrics.activeMembers")}
          value={activeCount}
          delta={t("metrics.activeRate", { n: activeRate })}
        />
        <Metric
          label={t("metrics.pendingInvites")}
          value={pendingCount}
          delta={pendingCount > 0 ? t("metrics.pendingHint") : ""}
        />
        <Metric
          label={t("metrics.queueTasks")}
          value={queueCount}
          delta={
            recentFailed > 0
              ? t("metrics.failureRate", {
                  n: Math.round((recentFailed / Math.max(queueCount, 1)) * 100),
                })
              : ""
          }
          deltaKind={recentFailed > 0 ? "down" : undefined}
        />
      </div>

      {showInvite && (
        <form
          onSubmit={onInviteSubmit}
          className="surface-card"
          style={{ padding: 20, marginBottom: 20 }}
        >
          <div className="display-h3" style={{ marginBottom: 12 }}>
            {t("member.inviteTitle")}
          </div>
          <div className="flex flex-wrap gap-3" style={{ marginBottom: 12 }}>
            <input
              required
              type="email"
              placeholder={t("member.inviteEmailPlaceholder")}
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              className="form-input"
              style={{ flex: 1, minWidth: 220 }}
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as Role)}
              className="form-input"
              style={{ width: 160 }}
            >
              <option value="member">{t("member.roleMember")}</option>
              <option value="admin">{t("member.roleAdmin")}</option>
            </select>
          </div>
          {inviteError && (
            <div style={{ color: "var(--danger)", fontSize: 12.5, marginBottom: 10 }}>
              {inviteError}
            </div>
          )}
          <div className="flex gap-2">
            <button disabled={invite.isPending} className="btn btn-primary">
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
              className="btn btn-ghost"
            >
              {t("common.cancel")}
            </button>
          </div>
        </form>
      )}

      <div className="table-card">
        <div className="table-head">
          <div>
            <div className="table-title">{t("member.listTitle")}</div>
            <div className="table-meta" style={{ marginTop: 2 }}>
              {t("members.countLabel", { n: total })}
            </div>
          </div>
          <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t("members.searchPlaceholder")}
            />
            {hasPermission("WORKSPACE_SYNC_TRIGGER") && (
              <button
                onClick={async () => {
                  const includePending = await confirm(
                    t("member.syncConfirmBody"),
                    {
                      title: t("member.syncConfirmTitle"),
                      okText: t("member.syncConfirmOk"),
                      cancelText: t("member.syncConfirmCancel"),
                    },
                  );
                  sync.mutate(includePending);
                }}
                disabled={sync.isPending || !!activeSyncTask}
                className="btn btn-ghost"
                title={t("member.syncTooltip")}
              >
                <RefreshIcon />
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
                className="btn btn-primary"
              >
                <PlusIcon />
                {t("member.inviteButton")}
              </button>
            )}
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("member.colEmail")}</th>
                <th>{t("member.colName")}</th>
                <th>{t("member.colRole")}</th>
                <th>{t("member.colStatus")}</th>
                <th>{t("member.colJoinedAt")}</th>
                <th style={{ textAlign: "right" }}>{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={6} className="cell-muted" style={{ textAlign: "center", padding: 32 }}>
                    {t("common.loading")}
                  </td>
                </tr>
              )}
              {!isLoading && filteredMembers.length === 0 && (
                <tr>
                  <td colSpan={6} className="cell-muted" style={{ textAlign: "center", padding: 32 }}>
                    {user?.is_super_admin
                      ? t("member.emptySuper")
                      : t("member.emptySub")}
                  </td>
                </tr>
              )}
              {filteredMembers.map((m) => (
                <tr key={m.id}>
                  <td className="cell-email">{m.email}</td>
                  <td className="cell-muted">{m.name ?? "—"}</td>
                  <td>
                    {m.chatgpt_role ? (
                      <span className="role-tag">
                        {t(
                          `member.role${m.chatgpt_role
                            .charAt(0)
                            .toUpperCase()}${m.chatgpt_role.slice(1)}`,
                        )}
                      </span>
                    ) : (
                      <span className="cell-muted">—</span>
                    )}
                  </td>
                  <td>
                    <span className={STATUS_BADGE[m.status] ?? "badge badge-neutral"}>
                      {t(
                        `member.status${m.status
                          .charAt(0)
                          .toUpperCase()}${m.status.slice(1)}`,
                      )}
                    </span>
                  </td>
                  <td className="cell-muted" style={{ fontSize: 12 }}>
                    {m.joined_at
                      ? new Date(m.joined_at).toLocaleDateString()
                      : "—"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <div
                      className="flex items-center justify-end"
                      style={{ gap: 6 }}
                    >
                      {canChangeRole &&
                        m.chatgpt_role &&
                        m.status === "active" && (
                          <select
                            value={m.chatgpt_role}
                            onChange={(e) =>
                              changeRole.mutate({
                                memberId: m.id,
                                role: e.target.value as Role,
                              })
                            }
                            className="form-input"
                            style={{ padding: "4px 8px", fontSize: 12, width: "auto" }}
                          >
                            <option value="member">{t("member.roleMember")}</option>
                            <option value="admin">{t("member.roleAdmin")}</option>
                            <option value="owner">{t("member.roleOwner")}</option>
                          </select>
                        )}
                      {canRemove && m.status === "pending" && (
                        <button
                          onClick={async () => {
                            const ok = await confirm(
                              t("member.confirmRevoke", { email: m.email }),
                              {
                                title: t("member.confirmRevokeTitle"),
                                okText: t("member.revokeAction"),
                                cancelText: t("common.cancel"),
                                danger: true,
                              },
                            );
                            if (ok) revokeInvites.mutate([m.email]);
                          }}
                          className="row-action warn"
                        >
                          {t("member.revokeAction")}
                        </button>
                      )}
                      {canRemove && m.status === "active" && (
                        <button
                          onClick={async () => {
                            const ok = await confirm(
                              t("member.confirmRemove", { email: m.email }),
                              {
                                title: t("member.confirmRemoveTitle"),
                                okText: t("member.removeAction"),
                                cancelText: t("common.cancel"),
                                danger: true,
                                requireType: "delete",
                              },
                            );
                            if (ok) remove.mutate(m.id);
                          }}
                          className="row-action"
                        >
                          {t("member.removeAction")}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  delta,
  deltaKind,
}: {
  label: string;
  value: number | string;
  delta?: string;
  deltaKind?: "up" | "down";
}) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {delta && (
        <div
          className={
            "metric-delta" +
            (deltaKind === "up"
              ? " up"
              : deltaKind === "down"
              ? " down"
              : "")
          }
        >
          {delta}
        </div>
      )}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="search-wrap">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.35-4.35" />
      </svg>
      <input
        className="search-input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M3 21v-5h5" />
    </svg>
  );
}

function SyncProgressBanner({
  task,
  onCancel,
  canceling,
}: {
  task: QueueItem;
  onCancel: () => void;
  canceling: boolean;
}) {
  const t = useT();
  const p = task.progress ?? {};
  const phase = (p.phase as string | undefined) ?? task.status;
  const current = p.current as number | undefined;
  const message = (p.message as string | undefined) ?? t(`progress.${phase}`);
  const showCount = typeof current === "number";

  const createdAt = new Date(task.created_at).getTime();
  const ageMs = Date.now() - createdAt;
  const isStale =
    (task.status === "PENDING" && ageMs > 60_000) ||
    (task.status === "IN_PROGRESS" && ageMs > 90_000 && !p.phase);

  return (
    <div className="notice">
      <div className="notice-icon">
        <div className="spinner" />
      </div>
      <div style={{ flex: 1 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <div className="notice-title">{t("member.syncRunning")}</div>
          {showCount && (
            <div
              style={{
                fontSize: 12,
                color: "var(--info)",
                fontFamily: "var(--font-mono)",
                marginLeft: "auto",
              }}
            >
              {t("progress.collected", { n: current ?? 0 })}
            </div>
          )}
        </div>
        <div className="notice-body">{message}</div>
        {isStale && (
          <div
            style={{
              marginTop: 6,
              fontSize: 11.5,
              color: "var(--warning)",
              background: "var(--warning-bg)",
              border: "1px solid #fde68a",
              borderRadius: 4,
              padding: "4px 8px",
            }}
          >
            ⚠ {t("queue.stuckHint")}
          </div>
        )}
      </div>
      <button
        onClick={onCancel}
        disabled={canceling}
        className="btn btn-ghost btn-sm"
        style={{ borderColor: "#fecaca", color: "var(--danger)" }}
      >
        {canceling ? t("queue.cancelOkBusy") : t("queue.cancel")}
      </button>
    </div>
  );
}
