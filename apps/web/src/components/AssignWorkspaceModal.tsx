/**
 * Modal gán quyền sở hữu 1 workspace cho sub-admin (super-admin only).
 *
 * Liệt kê toàn bộ sub-admin (user không phải super-admin), tick = đã gán. Toggle
 * checkbox → POST/DELETE assignment ngay. Backend lọc list workspace của sub-admin
 * theo các assignment này (xem routers/workspaces.py:list_workspaces).
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n";
import { toast } from "./Toast";
import type { Workspace, WorkspaceAssignment } from "../types";

type UserItem = {
  id: string;
  email: string;
  username: string;
  is_super_admin: boolean;
  is_active: boolean;
};

export function AssignWorkspaceModal({
  workspace,
  onClose,
}: {
  workspace: Workspace;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();

  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => api<UserItem[]>("/api/v1/users"),
  });

  const assignments = useQuery({
    queryKey: ["assignments", workspace.id],
    queryFn: () =>
      api<WorkspaceAssignment[]>(
        `/api/v1/workspaces/${workspace.id}/assignments`,
      ),
  });

  const assignedIds = useMemo(
    () => new Set((assignments.data ?? []).map((a) => a.user_id)),
    [assignments.data],
  );
  // Ngân sách hiện tại theo user_id (để khởi tạo input).
  const budgetById = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assignments.data ?? []) m.set(a.user_id, a.credit_budget ?? 0);
    return m;
  }, [assignments.data]);

  // Giá trị đang sửa trong từng ô nhập ngân sách (string để cho phép gõ dở).
  const [budgetDraft, setBudgetDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    // Đồng bộ draft khi assignments tải xong / đổi (chỉ điền ô chưa sửa).
    setBudgetDraft((prev) => {
      const next = { ...prev };
      for (const [uid, b] of budgetById) {
        if (next[uid] === undefined) next[uid] = String(b);
      }
      return next;
    });
  }, [budgetById]);

  const setBudget = useMutation({
    mutationFn: ({ userId, budget }: { userId: string; budget: number }) =>
      api(`/api/v1/workspaces/${workspace.id}/assignments`, {
        method: "POST",
        body: JSON.stringify({ user_id: userId, credit_budget: budget }),
      }),
    onSuccess: () => {
      toast.success(t("assign.budgetSaved"));
      qc.invalidateQueries({ queryKey: ["assignments", workspace.id] });
    },
    onError: () => toast.error(t("assign.budgetError")),
  });

  const subAdmins = useMemo(
    () => (users.data ?? []).filter((u) => !u.is_super_admin),
    [users.data],
  );

  const toggle = useMutation({
    mutationFn: ({ userId, assign }: { userId: string; assign: boolean }) =>
      assign
        ? api(`/api/v1/workspaces/${workspace.id}/assignments`, {
            method: "POST",
            body: JSON.stringify({ user_id: userId }),
          })
        : api(`/api/v1/workspaces/${workspace.id}/assignments/${userId}`, {
            method: "DELETE",
          }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["assignments", workspace.id] });
      qc.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="surface-card"
        style={{ width: 480, maxWidth: "100%", maxHeight: "80vh", display: "flex", flexDirection: "column", padding: 0 }}
      >
        <div className="table-head" style={{ padding: "16px 20px" }}>
          <div>
            <div className="table-title">{t("assign.title")}</div>
            <div className="table-meta" style={{ marginTop: 2 }}>
              {t("assign.subtitle", { name: workspace.name })}
            </div>
          </div>
          <button onClick={onClose} className="btn btn-ghost btn-sm">
            {t("common.close")}
          </button>
        </div>

        <div style={{ overflowY: "auto", padding: "8px 20px 20px" }}>
          {users.isLoading || assignments.isLoading ? (
            <div className="cell-muted" style={{ padding: 16 }}>
              {t("common.loading")}
            </div>
          ) : subAdmins.length === 0 ? (
            <div className="cell-muted" style={{ padding: 16 }}>
              {t("assign.noSubAdmins")}
            </div>
          ) : (
            <div className="grid" style={{ gap: 6 }}>
              {subAdmins.map((u) => {
                const assigned = assignedIds.has(u.id);
                return (
                  <label
                    key={u.id}
                    className="flex items-center"
                    style={{
                      gap: 10,
                      padding: "10px 12px",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius)",
                      opacity: u.is_active ? 1 : 0.55,
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={assigned}
                      disabled={toggle.isPending}
                      onChange={() =>
                        toggle.mutate({ userId: u.id, assign: !assigned })
                      }
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500 }}>{u.email}</div>
                      <div
                        className="cell-muted mono"
                        style={{ fontSize: 12 }}
                      >
                        {u.username}
                        {!u.is_active && ` · ${t("users.disabled")}`}
                      </div>
                    </div>
                    {assigned && (
                      <div
                        className="flex items-center"
                        style={{ gap: 6 }}
                        onClick={(e) => e.preventDefault()}
                      >
                        <input
                          type="number"
                          min={0}
                          title={t("assign.budgetLabel")}
                          value={budgetDraft[u.id] ?? ""}
                          disabled={setBudget.isPending}
                          onChange={(e) =>
                            setBudgetDraft((d) => ({ ...d, [u.id]: e.target.value }))
                          }
                          className="form-input"
                          style={{ width: 96 }}
                        />
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={
                            setBudget.isPending ||
                            !/^\d+$/.test((budgetDraft[u.id] ?? "").trim()) ||
                            Number(budgetDraft[u.id]) === budgetById.get(u.id)
                          }
                          onClick={() =>
                            setBudget.mutate({
                              userId: u.id,
                              budget: Number(budgetDraft[u.id]),
                            })
                          }
                        >
                          {t("assign.budgetSave")}
                        </button>
                      </div>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
