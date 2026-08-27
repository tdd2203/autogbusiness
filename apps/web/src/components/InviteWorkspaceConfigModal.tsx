/**
 * Modal cấu hình ĐÍCH MỜI theo từng user (nút ⚙️ trang "Mời thành viên", super-admin).
 *
 * Mỗi sub-admin 1 dòng: chọn "Toàn bộ" (được add email mới vào MỌI workspace, kể cả tạo
 * mới sau này) hoặc "Chỉ định" (tick từng workspace). Khi user đó add email MỚI, trang
 * Mời chọn NGẪU NHIÊN 1 workspace trong tập đã bật (email cũ/gia hạn giữ ws lịch sử).
 *
 * Sửa bao nhiêu dòng cũng được, thanh dưới đếm số thay đổi rồi lưu 1 lần qua
 * PUT /api/v1/invite-config/users/{id} (mỗi user 1 request, chạy song song).
 * Dùng chung bảng workspace_assignments với màn "Assign" ở trang Workspaces
 * (giữ credit_budget của record sẵn có).
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n";
import { confirm, toast } from "./Toast";
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

/** Ô tìm kiếm chỉ có ích khi danh sách đủ dài. */
const SEARCH_MIN_USERS = 6;
/** Ít workspace thì chọn tay nhanh hơn, khỏi bày nút Chọn hết / Bỏ hết. */
const BULK_CHIP_MIN = 3;

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
  const subAdmins = useMemo(() => configQ.data ?? [], [configQ.data]);

  const [query, setQuery] = useState("");

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

  function draftOf(u: InviteConfigUser): Draft {
    return draft[u.user_id] ?? { all: u.all_workspaces, ids: new Set(u.workspace_ids) };
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
  /** Chỉ định mà không tick ws nào → user đó không add được email mới. */
  function isEmptyPick(u: InviteConfigUser): boolean {
    const d = draftOf(u);
    return !d.all && d.ids.size === 0;
  }

  const dirtyUsers = useMemo(
    () => subAdmins.filter(isDirty),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subAdmins, draft],
  );
  const blockedCount = dirtyUsers.filter(isEmptyPick).length;
  const savableUsers = dirtyUsers.filter((u) => !isEmptyPick(u));

  const save = useMutation({
    mutationFn: async (users: InviteConfigUser[]) => {
      const results = await Promise.allSettled(
        users.map((u) => {
          const d = draftOf(u);
          return api(`/api/v1/invite-config/users/${u.user_id}`, {
            method: "PUT",
            body: JSON.stringify({
              all_workspaces: d.all,
              workspace_ids: [...d.ids],
            }),
          });
        }),
      );
      const saved = users
        .filter((_, i) => results[i].status === "fulfilled")
        .map((u) => {
          const d = draftOf(u);
          return { ...u, all_workspaces: d.all, workspace_ids: [...d.ids] };
        });
      return { saved, failed: results.length - saved.length };
    },
    onSuccess: ({ saved, failed }) => {
      // Ghi ngay giá trị vừa lưu vào cache để dấu "chưa lưu" tắt liền, không
      // phải chờ refetch (giữ nguyên nháp nên dòng không nháy về giá trị cũ).
      qc.setQueryData<InviteConfigUser[]>(["invite-config"], (old) =>
        old?.map((u) => saved.find((s) => s.user_id === u.user_id) ?? u),
      );
      if (saved.length) toast.success(t("inviteConfig.savedCount", { n: saved.length }));
      if (failed) toast.error(t("inviteConfig.saveErrorCount", { n: failed }));
      qc.invalidateQueries({ queryKey: ["invite-config"] });
      qc.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: () => toast.error(t("inviteConfig.saveError")),
  });

  function setMode(userId: string, all: boolean) {
    setDraft((d) => ({ ...d, [userId]: { all, ids: d[userId]?.ids ?? new Set() } }));
  }
  function toggleWs(u: InviteConfigUser, wsId: string) {
    setDraft((d) => {
      const cur = d[u.user_id] ?? draftOf(u);
      const ids = new Set(cur.ids);
      if (ids.has(wsId)) ids.delete(wsId);
      else ids.add(wsId);
      return { ...d, [u.user_id]: { all: false, ids } };
    });
  }
  function setAllWs(u: InviteConfigUser, on: boolean) {
    setDraft((d) => ({
      ...d,
      [u.user_id]: { all: false, ids: on ? new Set(workspaces.map((w) => w.id)) : new Set() },
    }));
  }
  function revert() {
    setDraft({});
  }

  async function requestClose() {
    if (dirtyUsers.length > 0) {
      const ok = await confirm(t("inviteConfig.discardConfirm", { n: dirtyUsers.length }), {
        okText: t("inviteConfig.discardOk"),
        danger: true,
      });
      if (!ok) return;
    }
    onClose();
  }

  // Esc đóng modal (vẫn qua cửa hỏi bỏ thay đổi).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        void requestClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtyUsers.length]);

  const q = query.trim().toLowerCase();
  const shownUsers = q
    ? subAdmins.filter(
        (u) =>
          u.email.toLowerCase().includes(q) || (u.username ?? "").toLowerCase().includes(q),
      )
    : subAdmins;
  const loading = configQ.isLoading || workspacesQ.isLoading;

  return (
    <div className="iwc-backdrop" onClick={() => void requestClose()}>
      <div
        className="surface-card iwc-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("inviteConfig.title")}
      >
        <div className="iwc-head">
          <div style={{ minWidth: 0 }}>
            <div className="table-title">{t("inviteConfig.title")}</div>
            <div className="table-meta" style={{ marginTop: 2 }}>
              {t("inviteConfig.subtitle")}
            </div>
          </div>
          <button onClick={() => void requestClose()} className="btn btn-ghost btn-sm">
            {t("common.close")}
          </button>
        </div>

        {!loading && subAdmins.length >= SEARCH_MIN_USERS && (
          <div className="iwc-toolbar">
            <input
              className="search-input iwc-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("inviteConfig.searchPlaceholder")}
            />
            <span className="iwc-count">
              {t("inviteConfig.userCount", { n: shownUsers.length })}
            </span>
          </div>
        )}

        <div className="iwc-body">
          {loading ? (
            <div className="cell-muted" style={{ padding: 16 }}>
              {t("common.loading")}
            </div>
          ) : subAdmins.length === 0 ? (
            <div className="cell-muted" style={{ padding: 16 }}>
              {t("assign.noSubAdmins")}
            </div>
          ) : shownUsers.length === 0 ? (
            <div className="cell-muted" style={{ padding: 16 }}>
              {t("inviteConfig.noMatch")}
            </div>
          ) : (
            shownUsers.map((u) => {
              const d = draftOf(u);
              const dirty = isDirty(u);
              const empty = isEmptyPick(u);
              return (
                <div
                  key={u.user_id}
                  className={`iwc-row${dirty ? " dirty" : ""}${u.is_active ? "" : " off"}`}
                >
                  <div className="iwc-row-top">
                    <span className="iwc-email" title={u.email}>
                      {u.email}
                      {!u.is_active && (
                        <span className="iwc-tag">{t("users.disabled")}</span>
                      )}
                      {dirty && <span className="iwc-dot" title={t("inviteConfig.edited")} />}
                    </span>

                    <div className="iwc-seg" role="group">
                      <button
                        type="button"
                        className={`iwc-seg-btn${d.all ? " on" : ""}`}
                        aria-pressed={d.all}
                        onClick={() => setMode(u.user_id, true)}
                      >
                        {t("inviteConfig.modeAll")}
                      </button>
                      <button
                        type="button"
                        className={`iwc-seg-btn${d.all ? "" : " on"}`}
                        aria-pressed={!d.all}
                        onClick={() => setMode(u.user_id, false)}
                      >
                        {t("inviteConfig.modeSpecific")}
                      </button>
                    </div>
                  </div>

                  {d.all ? (
                    <div className="iwc-hint">{t("inviteConfig.allHint")}</div>
                  ) : workspaces.length === 0 ? (
                    <div className="iwc-hint">{t("inviteConfig.noWorkspaces")}</div>
                  ) : (
                    <>
                      <div className="iwc-chips">
                        {workspaces.map((w) => {
                          const on = d.ids.has(w.id);
                          return (
                            <button
                              key={w.id}
                              type="button"
                              className={`iwc-chip${on ? " on" : ""}`}
                              aria-pressed={on}
                              onClick={() => toggleWs(u, w.id)}
                              title={w.name}
                            >
                              <span className="iwc-check" aria-hidden="true">
                                {on ? "✓" : "+"}
                              </span>
                              <span className="iwc-chip-name">{w.name}</span>
                            </button>
                          );
                        })}
                        {workspaces.length >= BULK_CHIP_MIN && (
                          <span className="iwc-bulk">
                            <button
                              type="button"
                              className="iwc-link"
                              onClick={() => setAllWs(u, true)}
                              disabled={d.ids.size === workspaces.length}
                            >
                              {t("inviteConfig.selectAll")}
                            </button>
                            <button
                              type="button"
                              className="iwc-link"
                              onClick={() => setAllWs(u, false)}
                              disabled={d.ids.size === 0}
                            >
                              {t("inviteConfig.clearAll")}
                            </button>
                          </span>
                        )}
                      </div>
                      <div className={`iwc-hint${empty ? " warn" : ""}`}>
                        {empty
                          ? t("inviteConfig.emptyPick")
                          : t("inviteConfig.pickedCount", {
                              n: d.ids.size,
                              total: workspaces.length,
                            })}
                      </div>
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>

        {dirtyUsers.length > 0 && (
          <div className="iwc-foot">
            <span className="iwc-foot-text">
              {t("inviteConfig.dirtyCount", { n: dirtyUsers.length })}
              {blockedCount > 0 && (
                <span className="iwc-foot-warn">
                  {" · "}
                  {t("inviteConfig.blockedCount", { n: blockedCount })}
                </span>
              )}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={revert}
              disabled={save.isPending}
            >
              {t("inviteConfig.revert")}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => save.mutate(savableUsers)}
              disabled={save.isPending || savableUsers.length === 0}
            >
              {save.isPending
                ? t("common.saving")
                : t("inviteConfig.saveAll", { n: savableUsers.length })}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
