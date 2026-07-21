/**
 * Modal cấu hình ĐÍCH MỜI theo từng user (nút ⚙️ trang "Mời thành viên", super-admin).
 *
 * Mỗi sub-admin 1 dòng: chọn "Toàn bộ" (được add email mới vào MỌI workspace, kể cả tạo
 * mới sau này) hoặc "Chỉ định" (tick từng workspace). Khi user đó add email MỚI, trang
 * Mời chọn NGẪU NHIÊN 1 workspace trong tập đã bật (email cũ/gia hạn giữ ws lịch sử).
 *
 * Lưu qua PUT /api/v1/invite-config/users/{id}. Dùng chung bảng workspace_assignments
 * với màn "Assign" ở trang Workspaces (giữ credit_budget của record sẵn có).
 */

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n";
import { toast } from "./Toast";
import type { Workspace } from "../types";

type InviteConfigUser = {
  user_id: string;
  email: string;
  username: string;
  is_active: boolean;
  all_workspaces: boolean;
  workspace_ids: string[];
};

type Draft = { all: boolean; ids: Set<string> };

export default function InviteWorkspaceConfigModal({
  onClose,
}: {
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();

  // Chỉ gọi DB khi mở modal (mount) + sau khi Lưu (invalidate). Cache 2′ để mở lại
  // ngay không gọi thừa. Không polling, không refetch on focus (mặc định global).
  const configQ = useQuery({
    queryKey: ["invite-config"],
    queryFn: () => api<InviteConfigUser[]>("/api/v1/invite-config/users"),
    staleTime: 2 * 60_000,
  });
  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api<Workspace[]>("/api/v1/workspaces"),
    staleTime: 2 * 60_000,
  });

  const workspaces = workspacesQ.data ?? [];

  // Nháp theo user_id (khởi tạo từ server, chỉ điền dòng chưa sửa).
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  useEffect(() => {
    if (!configQ.data) return;
    setDraft((prev) => {
      const next = { ...prev };
      for (const u of configQ.data!) {
        if (!next[u.user_id]) {
          next[u.user_id] = {
            all: u.all_workspaces,
            ids: new Set(u.workspace_ids),
          };
        }
      }
      return next;
    });
  }, [configQ.data]);

  const serverById = useMemo(() => {
    const m = new Map<string, InviteConfigUser>();
    for (const u of configQ.data ?? []) m.set(u.user_id, u);
    return m;
  }, [configQ.data]);

  const save = useMutation({
    mutationFn: ({ userId, d }: { userId: string; d: Draft }) =>
      api(`/api/v1/invite-config/users/${userId}`, {
        method: "PUT",
        body: JSON.stringify({
          all_workspaces: d.all,
          workspace_ids: [...d.ids],
        }),
      }),
    onSuccess: () => {
      toast.success(t("inviteConfig.saved"));
      qc.invalidateQueries({ queryKey: ["invite-config"] });
      qc.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: () => toast.error(t("inviteConfig.saveError")),
  });

  function setMode(userId: string, all: boolean) {
    setDraft((d) => ({ ...d, [userId]: { all, ids: d[userId]?.ids ?? new Set() } }));
  }
  function toggleWs(userId: string, wsId: string) {
    setDraft((d) => {
      const cur = d[userId] ?? { all: false, ids: new Set<string>() };
      const ids = new Set(cur.ids);
      if (ids.has(wsId)) ids.delete(wsId);
      else ids.add(wsId);
      return { ...d, [userId]: { all: false, ids } };
    });
  }
  function isDirty(u: InviteConfigUser): boolean {
    const d = draft[u.user_id];
    if (!d) return false;
    if (d.all !== u.all_workspaces) return true;
    if (d.all) return false; // Toàn bộ: không quan tâm danh sách ws
    const server = new Set(u.workspace_ids);
    if (d.ids.size !== server.size) return true;
    for (const id of d.ids) if (!server.has(id)) return true;
    return false;
  }

  const subAdmins = configQ.data ?? [];

  // Segmented control (Toàn bộ / Chỉ định) + chip workspace — gọn, ít viền.
  const segWrap: CSSProperties = {
    display: "inline-flex",
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: 2,
    gap: 2,
    flexShrink: 0,
  };
  const segBtn = (active: boolean): CSSProperties => ({
    border: "none",
    background: active ? "var(--success)" : "transparent",
    color: active ? "#fff" : "var(--ink-2)",
    fontSize: 12,
    fontWeight: 500,
    padding: "4px 12px",
    borderRadius: 6,
    cursor: "pointer",
    whiteSpace: "nowrap",
  });
  const chip = (on: boolean): CSSProperties => ({
    border: `1px solid ${on ? "var(--success)" : "var(--border)"}`,
    background: on ? "var(--success)" : "transparent",
    color: on ? "#fff" : "var(--ink-2)",
    fontSize: 12,
    padding: "3px 12px",
    borderRadius: 999,
    cursor: "pointer",
    maxWidth: 170,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
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
        style={{
          width: 560,
          maxWidth: "100%",
          maxHeight: "84vh",
          display: "flex",
          flexDirection: "column",
          padding: 0,
        }}
      >
        <div className="table-head" style={{ padding: "16px 20px" }}>
          <div>
            <div className="table-title">{t("inviteConfig.title")}</div>
            <div className="table-meta" style={{ marginTop: 2 }}>
              {t("inviteConfig.subtitle")}
            </div>
          </div>
          <button onClick={onClose} className="btn btn-ghost btn-sm">
            {t("common.close")}
          </button>
        </div>

        <div style={{ overflowY: "auto", padding: "8px 20px 20px" }}>
          {configQ.isLoading || workspacesQ.isLoading ? (
            <div className="cell-muted" style={{ padding: 16 }}>
              {t("common.loading")}
            </div>
          ) : subAdmins.length === 0 ? (
            <div className="cell-muted" style={{ padding: 16 }}>
              {t("assign.noSubAdmins")}
            </div>
          ) : (
            <div>
              {subAdmins.map((u) => {
                const d = draft[u.user_id] ?? {
                  all: u.all_workspaces,
                  ids: new Set(u.workspace_ids),
                };
                const server = serverById.get(u.user_id) ?? u;
                const dirty = isDirty(server);
                return (
                  <div
                    key={u.user_id}
                    style={{
                      padding: "10px 2px",
                      borderBottom: "1px solid var(--border)",
                      opacity: u.is_active ? 1 : 0.5,
                    }}
                  >
                    {/* dòng 1: email · chế độ · lưu */}
                    <div
                      className="flex items-center"
                      style={{ gap: 10, justifyContent: "space-between" }}
                    >
                      <span
                        title={u.email}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 13.5,
                          fontWeight: 500,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {u.email}
                        {!u.is_active && (
                          <span className="cell-muted" style={{ fontSize: 11, fontWeight: 400 }}>
                            {" · "}
                            {t("users.disabled")}
                          </span>
                        )}
                      </span>

                      <div style={segWrap}>
                        <button
                          type="button"
                          style={segBtn(d.all)}
                          onClick={() => setMode(u.user_id, true)}
                        >
                          {t("inviteConfig.modeAll")}
                        </button>
                        <button
                          type="button"
                          style={segBtn(!d.all)}
                          onClick={() => setMode(u.user_id, false)}
                        >
                          {t("inviteConfig.modeSpecific")}
                        </button>
                      </div>

                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        style={{ visibility: dirty ? "visible" : "hidden", flexShrink: 0 }}
                        disabled={save.isPending}
                        onClick={() => save.mutate({ userId: u.user_id, d })}
                      >
                        {t("inviteConfig.save")}
                      </button>
                    </div>

                    {/* dòng 2: chip workspace (chỉ khi Chỉ định) */}
                    {!d.all && (
                      <div
                        className="flex items-center"
                        style={{ flexWrap: "wrap", gap: 6, marginTop: 8 }}
                      >
                        {workspaces.length === 0 ? (
                          <span className="cell-muted" style={{ fontSize: 12 }}>
                            {t("inviteConfig.noWorkspaces")}
                          </span>
                        ) : (
                          workspaces.map((w) => {
                            const on = d.ids.has(w.id);
                            return (
                              <button
                                key={w.id}
                                type="button"
                                style={chip(on)}
                                onClick={() => toggleWs(u.user_id, w.id)}
                                title={w.name}
                              >
                                {w.name}
                              </button>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
