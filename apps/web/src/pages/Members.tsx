import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { useFormatDate, useT } from "../i18n";
import type { Member, QueueItem } from "../types";
import { triggerExtensionRun } from "../hooks/useExtensionTrigger";
import { TaskCompletionBanner } from "../components/TaskCompletionBanner";
import { confirm, toast } from "../components/Toast";

// Dashboard CHỈ cho phép đổi giữa 2 role này. admin/owner phải thao tác trực
// tiếp trên ChatGPT (an toàn — tránh dashboard cấp quyền cao bằng UI dễ nhầm).
// Member đã có role admin/owner từ trước → hiển thị label nhưng KHÔNG cho đổi.
type Role = "owner" | "admin" | "member" | "analytics_viewer";
const DASHBOARD_ALLOWED_ROLES: Role[] = ["member", "analytics_viewer"];

const STATUS_BADGE: Record<string, string> = {
  active: "badge badge-success",
  pending: "badge badge-warning",
  removed: "badge badge-danger",
};

export default function Members() {
  const t = useT();
  const formatDate = useFormatDate();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { hasPermission, user } = useAuth();
  const qc = useQueryClient();

  // Invite form đã được lift sang InviteMemberModal (WorkspaceLayout header).
  // Members.tsx chỉ còn hiển thị danh sách + filter + progress.
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

  // Auto-reload members list khi extension hoàn thành task (COMPLETED/FAILED)
  // mà thay đổi member state: INVITE_MEMBER, REMOVE_MEMBER, CHANGE_ROLE,
  // REVOKE_INVITES, SYNC_DATA. recent-tasks poll mỗi 2s → khi phát hiện task
  // mới chuyển sang terminal state → invalidate members query → list refresh
  // mà không cần F5.
  //
  // Track bằng ref: set các (id, status) đã xử lý — chỉ invalidate cho task
  // mới chuyển sang terminal (tránh invalidate liên tục khi task đã terminal).
  const seenTerminalRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const memberMutatingTypes = new Set([
      "INVITE_MEMBER",
      "REMOVE_MEMBER",
      "CHANGE_ROLE",
      "REVOKE_INVITES",
      "SYNC_DATA",
    ]);
    let shouldInvalidate = false;
    for (const task of recentTasks) {
      if (!memberMutatingTypes.has(task.type)) continue;
      if (task.status !== "COMPLETED" && task.status !== "FAILED") continue;
      const key = `${task.id}:${task.status}`;
      if (seenTerminalRef.current.has(key)) continue;
      seenTerminalRef.current.add(key);
      shouldInvalidate = true;
    }
    if (shouldInvalidate) {
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
    }
  }, [recentTasks, qc, workspaceId]);

  const activeTasks = recentTasks.filter(
    (t) => t.status === "PENDING" || t.status === "IN_PROGRESS",
  );
  const activeSyncTask = activeTasks.find((t) => t.type === "SYNC_DATA");
  const activeInviteTasks = activeTasks.filter(
    (t) => t.type === "INVITE_MEMBER",
  );
  const activeInviteCount = activeInviteTasks.length;
  // Lấy invite FAILED gần đây (trong recentTasks) để show debug info ngay banner
  // → user thấy được error code/message của task vừa fail mà không cần mở Queue tab.
  const recentFailedInvites = recentTasks
    .filter(
      (t) =>
        t.type === "INVITE_MEMBER" &&
        t.status === "FAILED" &&
        t.completed_at &&
        Date.now() - new Date(t.completed_at).getTime() < 60_000,
    )
    .slice(0, 3);

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

  // sync mutation đã được lift lên WorkspaceLayout (button nằm cùng hàng tabs).
  // Members.tsx vẫn theo dõi activeSyncTask để show banner progress + cancel.

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

  // Invite mutation đã chuyển sang InviteMemberModal (modal popup ở
  // WorkspaceLayout header). Members.tsx chỉ giữ remove + changeRole.

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

  const canRemove = hasPermission("MEMBER_REMOVE");
  const canChangeRole = user?.is_super_admin === true;

  const total = members.length;
  const activeCount = members.filter((m) => m.status === "active").length;
  const pendingCount = members.filter((m) => m.status === "pending").length;
  const queueCount = recentTasks.length;
  const recentFailed = recentTasks.filter((t) => t.status === "FAILED").length;
  const activeRate = total > 0 ? Math.round((activeCount / total) * 100) : 0;

  // Subscription tracking: phân loại theo subscription_end_at.
  //   - expired: end_at đã qua + status active/pending → cần remove
  //   - expiringSoon: 7 ngày tới hết hạn → admin nên check
  const now = Date.now();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const expiredMembers = members.filter(
    (m) =>
      m.subscription_end_at &&
      (m.status === "active" || m.status === "pending") &&
      new Date(m.subscription_end_at).getTime() <= now,
  );
  const expiringSoonMembers = members.filter(
    (m) =>
      m.subscription_end_at &&
      (m.status === "active" || m.status === "pending") &&
      new Date(m.subscription_end_at).getTime() > now &&
      new Date(m.subscription_end_at).getTime() - now <= SEVEN_DAYS_MS,
  );

  const cleanupExpired = useMutation({
    mutationFn: () =>
      api<{ count: number; emails: string[] }>(
        `/api/v1/workspaces/${workspaceId}/members/cleanup-expired`,
        { method: "POST" },
      ),
    onSuccess: (resp) => {
      toast.success(t("member.cleanupExpiredOk", { n: resp.count }));
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(msg);
    },
  });

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
      {!activeSyncTask && !lastSyncTask && false && (
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
          <div style={{ flex: 1 }}>
            <div className="notice-title">
              {t("member.invitesInFlight", { n: activeInviteCount })}
            </div>
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              {activeInviteTasks.map((task) => (
                <InviteProgressRow key={task.id} task={task} />
              ))}
            </div>
          </div>
        </div>
      )}
      {recentFailedInvites.length > 0 && (
        <div
          className="notice"
          style={{
            marginBottom: 16,
            background: "var(--bg-danger, #fee)",
            borderColor: "var(--border-danger, #fcc)",
          }}
        >
          <div className="notice-icon" style={{ color: "var(--ink-danger, #c00)" }}>
            ⚠
          </div>
          <div style={{ flex: 1 }}>
            <div className="notice-title">{t("member.inviteFailedRecent")}</div>
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
              {recentFailedInvites.map((task) => (
                <InviteFailedRow key={task.id} task={task} />
              ))}
            </div>
          </div>
        </div>
      )}
      {expiredMembers.length > 0 && (
        <div
          className="notice"
          style={{
            marginBottom: 16,
            background: "var(--bg-danger, #fee)",
            borderColor: "var(--border-danger, #fcc)",
          }}
        >
          <div className="notice-icon" style={{ color: "var(--ink-danger, #c00)" }}>⏰</div>
          <div style={{ flex: 1 }}>
            <div className="notice-title">
              {t("member.expiredBannerTitle", { n: expiredMembers.length })}
            </div>
            <div className="notice-body" style={{ marginTop: 4 }}>
              {t("member.expiredBannerBody")}
            </div>
            <div style={{ marginTop: 6, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--ink-2)" }}>
              {expiredMembers.slice(0, 5).map((m) => m.email).join(", ")}
              {expiredMembers.length > 5 ? ` +${expiredMembers.length - 5}` : ""}
            </div>
          </div>
          <button
            onClick={() => cleanupExpired.mutate()}
            disabled={cleanupExpired.isPending}
            className="btn btn-sm"
            style={{
              background: "var(--ink-danger, #c00)",
              color: "white",
              border: "none",
            }}
          >
            {cleanupExpired.isPending
              ? t("member.cleanupExpiredBusy")
              : t("member.cleanupExpiredBtn", { n: expiredMembers.length })}
          </button>
        </div>
      )}
      {expiringSoonMembers.length > 0 && expiredMembers.length === 0 && (
        <div
          className="notice warn"
          style={{ marginBottom: 16 }}
        >
          <div className="notice-icon">⚠</div>
          <div style={{ flex: 1 }}>
            <div className="notice-title">
              {t("member.expiringSoonBannerTitle", { n: expiringSoonMembers.length })}
            </div>
            <div style={{ marginTop: 4, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--ink-2)" }}>
              {expiringSoonMembers
                .slice(0, 5)
                .map((m) =>
                  `${m.email} (${m.subscription_end_at ? formatDate(m.subscription_end_at) : "?"})`,
                )
                .join(", ")}
              {expiringSoonMembers.length > 5 ? ` +${expiringSoonMembers.length - 5}` : ""}
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
            {/* Action buttons (Sync ChatGPT + Mời thành viên) đã được lift
                lên WorkspaceLayout header để nằm cùng hàng với tabs. */}
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
                <th>{t("member.colSubscription")}</th>
                <th>{t("member.colJoinedAt")}</th>
                <th style={{ textAlign: "right" }}>{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={7} className="cell-muted" style={{ textAlign: "center", padding: 32 }}>
                    {t("common.loading")}
                  </td>
                </tr>
              )}
              {!isLoading && filteredMembers.length === 0 && (
                <tr>
                  <td colSpan={7} className="cell-muted" style={{ textAlign: "center", padding: 32 }}>
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
                  <td style={{ fontSize: 12 }}>
                    <SubscriptionCell member={m} t={t} formatDate={formatDate} />
                  </td>
                  <td className="cell-muted" style={{ fontSize: 12 }}>
                    {m.joined_at ? formatDate(m.joined_at) : "—"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <div
                      className="flex items-center justify-end"
                      style={{ gap: 6 }}
                    >
                      {canChangeRole &&
                        m.chatgpt_role &&
                        m.status === "active" &&
                        (DASHBOARD_ALLOWED_ROLES.includes(m.chatgpt_role as Role) ? (
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
                            <option value="analytics_viewer">{t("member.roleAnalyticsViewer")}</option>
                          </select>
                        ) : (
                          // Member đang là admin/owner — KHÔNG cho đổi qua dashboard.
                          // Hiển thị label disabled + tooltip giải thích.
                          <span
                            title={t("member.roleEditOnChatGPT")}
                            style={{
                              padding: "4px 8px",
                              fontSize: 12,
                              color: "var(--ink-3)",
                              border: "1px dashed var(--border)",
                              borderRadius: 4,
                              cursor: "help",
                            }}
                          >
                            {m.chatgpt_role === "admin"
                              ? t("member.roleAdmin")
                              : t("member.roleOwner")}{" "}
                            🔒
                          </span>
                        ))}
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

/**
 * Hiển thị 1 dòng progress cho 1 invite task đang chạy.
 *
 * Show:
 *  - Email(s) đang invite (từ payload)
 *  - Phase + message hiện tại (từ progress)
 *  - Elapsed time (giúp phát hiện hang)
 *  - Stale warning nếu IN_PROGRESS > 90s không có phase mới
 */
function InviteProgressRow({ task }: { task: QueueItem }) {
  const t = useT();
  const p = task.progress ?? {};
  const phase = (p.phase as string | undefined) ?? null;
  const message = (p.message as string | undefined) ?? null;
  const current = p.current as number | undefined;
  const total = p.total as number | undefined;

  const payload = task.payload as Record<string, unknown>;
  const emails: string[] = Array.isArray(payload.emails)
    ? (payload.emails as string[])
    : typeof payload.email === "string"
      ? [payload.email]
      : [];
  const emailsLabel =
    emails.length === 0
      ? "—"
      : emails.length === 1
        ? emails[0]
        : `${emails[0]} +${emails.length - 1}`;

  const startMs = new Date(task.picked_at ?? task.created_at).getTime();
  const ageSec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  const isStale = task.status === "IN_PROGRESS" && ageSec > 90 && !phase;
  const isPending = task.status === "PENDING";

  return (
    <div
      style={{
        fontSize: 12,
        background: "rgba(255,255,255,0.5)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "6px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span
          className="mono"
          style={{ fontWeight: 600, color: "var(--ink)" }}
        >
          {emailsLabel}
        </span>
        <span
          style={{
            fontSize: 10,
            background: isPending ? "var(--ink-3)" : "var(--info)",
            color: "white",
            padding: "1px 6px",
            borderRadius: 3,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {task.status}
        </span>
        {phase && (
          <span
            style={{
              fontSize: 10,
              color: "var(--ink-2)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {phase}
          </span>
        )}
        {typeof current === "number" && typeof total === "number" && (
          <span style={{ fontSize: 10, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>
            {current}/{total}
          </span>
        )}
        <span
          style={{
            marginLeft: "auto",
            fontSize: 10,
            color: "var(--ink-3)",
            fontFamily: "var(--font-mono)",
          }}
          title={t("invite.progressElapsedHint")}
        >
          {ageSec}s
        </span>
      </div>
      {message && (
        <div style={{ color: "var(--ink-2)", fontSize: 11.5 }}>{message}</div>
      )}
      {isStale && (
        <div
          style={{
            fontSize: 11,
            color: "var(--warning)",
            background: "var(--warning-bg, #fef3c7)",
            border: "1px solid #fde68a",
            borderRadius: 4,
            padding: "3px 6px",
            marginTop: 2,
          }}
        >
          ⚠ {t("invite.progressStaleHint")}
        </div>
      )}
    </div>
  );
}

/** Dòng error cho invite task vừa FAILED — show error_code + message. */
function InviteFailedRow({ task }: { task: QueueItem }) {
  const t = useT();
  const payload = task.payload as Record<string, unknown>;
  const emails: string[] = Array.isArray(payload.emails)
    ? (payload.emails as string[])
    : typeof payload.email === "string"
      ? [payload.email]
      : [];
  const emailsLabel =
    emails.length === 0
      ? "—"
      : emails.length === 1
        ? emails[0]
        : `${emails[0]} +${emails.length - 1}`;

  return (
    <div
      style={{
        fontSize: 12,
        background: "rgba(255,255,255,0.7)",
        border: "1px solid #fcc",
        borderRadius: 6,
        padding: "6px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="mono" style={{ fontWeight: 600 }}>{emailsLabel}</span>
        {task.error_code && (
          <span
            style={{
              fontSize: 10,
              background: "#c00",
              color: "white",
              padding: "1px 6px",
              borderRadius: 3,
              fontFamily: "var(--font-mono)",
            }}
          >
            {task.error_code}
          </span>
        )}
        <span
          style={{
            marginLeft: "auto",
            fontSize: 10,
            color: "var(--ink-3)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {task.completed_at
            ? new Date(task.completed_at).toLocaleTimeString("vi-VN")
            : ""}
        </span>
      </div>
      {task.error_message && (
        <div
          style={{
            color: "var(--ink-2)",
            fontSize: 11.5,
            wordBreak: "break-word",
          }}
          title={t("invite.errorFullTooltip")}
        >
          {task.error_message}
        </div>
      )}
    </div>
  );
}

/**
 * Cell hiển thị subscription status cho 1 member row.
 *
 * Logic:
 *   - subscription_end_at = null: hiển thị "—" (không giới hạn).
 *   - end_at < now: badge ĐỎ "Hết hạn DD/MM" + days expired.
 *   - end_at < now + 7 days: badge VÀNG "Còn N ngày" — admin chú ý.
 *   - else: badge XÁM nhạt "DD/MM (N ngày)".
 *
 * Tooltip kèm `subscription_months` để admin biết originally bao nhiêu tháng.
 */
function SubscriptionCell({
  member,
  t,
  formatDate,
}: {
  member: Member;
  t: ReturnType<typeof useT>;
  formatDate: (value: string | Date, options?: Intl.DateTimeFormatOptions) => string;
}) {
  if (!member.subscription_end_at) {
    return <span className="cell-muted">—</span>;
  }
  const endMs = new Date(member.subscription_end_at).getTime();
  const nowMs = Date.now();
  const diffDays = Math.round((endMs - nowMs) / (24 * 60 * 60 * 1000));
  const endStr = formatDate(member.subscription_end_at, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const monthsLabel = member.subscription_months
    ? t("member.subscriptionMonths", { n: member.subscription_months })
    : "";
  const tooltip = monthsLabel ? `${endStr} · ${monthsLabel}` : endStr;

  if (diffDays <= 0) {
    return (
      <span
        className="badge badge-danger"
        title={tooltip}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        ⏰ {t("member.subExpired", { n: -diffDays })}
      </span>
    );
  }
  if (diffDays <= 7) {
    return (
      <span
        className="badge badge-warning"
        title={tooltip}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        ⚠ {t("member.subDaysLeft", { n: diffDays })}
      </span>
    );
  }
  return (
    <span
      style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-2)" }}
      title={tooltip}
    >
      {endStr}
      <span style={{ color: "var(--ink-3)", marginLeft: 4 }}>
        ({t("member.subDaysLeftShort", { n: diffDays })})
      </span>
    </span>
  );
}
