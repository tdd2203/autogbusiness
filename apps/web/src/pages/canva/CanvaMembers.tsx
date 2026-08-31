/**
 * Trang "Thành viên team Canva" — danh sách, gia hạn, xoá, sao chép liên kết mời.
 *
 * Trang RIÊNG của nhánh Canva, không dùng lại `pages/Members.tsx` (đầy thứ chỉ
 * ChatGPT mới có: loại giấy phép, giới hạn tín dụng, đổi vai trò admin, hoá đơn).
 * Nhưng vẫn gọi ĐÚNG những endpoint member dùng chung — kỳ hạn, phí, ví, hàng đợi
 * là một bộ máy, không nhân bản.
 *
 * Cột "Liên kết mời" là thứ Canva có mà ChatGPT không: mỗi email một link riêng, chỉ
 * email đó dùng được (extension bắt lại lúc mời và lưu vào `members.invite_link`).
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiErrorText } from "../../lib/api";
import { useI18n } from "../../i18n";
import { useSeatMap } from "../../hooks/useWorkspaceSeats";
import type { Member, QueueItem, Workspace } from "../../types";
import { useCanvaPriceTiers } from "../../hooks/useCanvaPrice";

const CANVA_SEAT_TOTAL = 50;

function fmtDate(v: string | null): string {
  return v ? new Date(v).toLocaleDateString() : "—";
}

export default function CanvaMembers() {
  const { teamId = "" } = useParams();
  const { t } = useI18n();
  const qc = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [renewing, setRenewing] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { seatMap } = useSeatMap();
  const tiers = useCanvaPriceTiers();

  const team = useQuery({
    queryKey: ["workspace", teamId],
    queryFn: () => api<Workspace>(`/api/v1/workspaces/${teamId}`),
    enabled: !!teamId,
  });
  const members = useQuery({
    queryKey: ["canva-members", teamId],
    queryFn: () => api<Member[]>(`/api/v1/workspaces/${teamId}/members`),
    enabled: !!teamId,
  });
  // Lệnh gần đây của CHÍNH team này. Cần cho lần chạy thật đầu tiên: mời hỏng thì
  // câu lỗi của extension nằm ở đây chứ không hiện ra ở bảng thành viên.
  const tasks = useQuery({
    queryKey: ["canva-queue", teamId],
    queryFn: () => api<QueueItem[]>(`/api/v1/queue?workspace_id=${teamId}&limit=10`),
    enabled: !!teamId,
    refetchInterval: 5000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["canva-members", teamId] });
    qc.invalidateQueries({ queryKey: ["canva-queue", teamId] });
    qc.invalidateQueries({ queryKey: ["workspace-seats"] });
  };

  const sync = useMutation({
    mutationFn: () =>
      api(`/api/v1/queue`, {
        method: "POST",
        body: JSON.stringify({ type: "SYNC_DATA", workspace_id: teamId, payload: {} }),
      }),
    onSuccess: () => {
      setMsg(t("canva.syncQueued"));
      qc.invalidateQueries({ queryKey: ["canva-queue", teamId] });
    },
    onError: (e) => setErr(apiErrorText(e)),
  });

  const renew = useMutation({
    mutationFn: (v: { id: string; months: number }) =>
      api(`/api/v1/workspaces/${teamId}/members/${v.id}/renew`, {
        method: "POST",
        body: JSON.stringify({ months: v.months }),
      }),
    onSuccess: () => {
      setMsg(t("canva.renewDone"));
      setRenewing(null);
      invalidate();
    },
    onError: (e) => setErr(apiErrorText(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/workspaces/${teamId}/members/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setMsg(t("canva.removeQueued"));
      invalidate();
    },
    onError: (e) => setErr(apiErrorText(e)),
  });

  const rows = useMemo(
    () =>
      (members.data ?? [])
        .filter((m) => m.status !== "removed")
        .sort((a, b) => a.email.localeCompare(b.email)),
    [members.data],
  );

  const seats = seatMap.get(teamId);
  const used = seats?.seat_used ?? 0;
  const total = seats?.seat_total ?? team.data?.seat_total ?? CANVA_SEAT_TOTAL;

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <Link className="btn btn-ghost btn-sm" to="/canva/teams">
          ← {t("canva.backToTeams")}
        </Link>
      </div>
      <div
        className="flex items-center justify-between"
        style={{ marginBottom: 16, gap: 12, flexWrap: "wrap" }}
      >
        <div>
          <h1 className="display-h2">{team.data?.name ?? t("canva.membersTitle")}</h1>
          <div className="form-hint">
            {t("canva.seatLine", { used, total })}
          </div>
        </div>
        <button
          className="btn btn-ghost"
          disabled={sync.isPending}
          onClick={() => {
            setErr(null);
            sync.mutate();
          }}
        >
          {t("canva.syncNow")}
        </button>
      </div>

      {msg && (
        <div className="notice" style={{ marginBottom: 12 }}>
          <div style={{ flex: 1 }}>{msg}</div>
          <button className="btn btn-ghost btn-sm" onClick={() => setMsg(null)}>
            {t("common.dismiss")}
          </button>
        </div>
      )}
      {err && (
        <div className="notice warn" style={{ marginBottom: 12 }}>
          <div style={{ flex: 1 }}>{err}</div>
          <button className="btn btn-ghost btn-sm" onClick={() => setErr(null)}>
            {t("common.dismiss")}
          </button>
        </div>
      )}

      <div className="surface-card" style={{ padding: 0, overflowX: "auto" }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t("canva.colEmail")}</th>
              <th>{t("canva.colStatus")}</th>
              <th>{t("canva.colExpiry")}</th>
              <th>{t("canva.colInviteLink")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.isLoading && (
              <tr>
                <td colSpan={5}>{t("common.loading")}</td>
              </tr>
            )}
            {!members.isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={5}>{t("canva.emptyMembers")}</td>
              </tr>
            )}
            {rows.map((m) => (
              <tr key={m.id}>
                <td>{m.email}</td>
                <td>
                  {m.status === "active" ? t("canva.statusActive") : t("canva.statusPending")}
                </td>
                <td>{fmtDate(m.subscription_end_at)}</td>
                <td>
                  {m.invite_link ? (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        navigator.clipboard.writeText(m.invite_link as string);
                        setCopiedId(m.id);
                      }}
                    >
                      {copiedId === m.id ? t("common.copied") : t("canva.copyInviteLink")}
                    </button>
                  ) : (
                    <span className="form-hint">{t("canva.noInviteLink")}</span>
                  )}
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {renewing === m.id ? (
                    <span className="flex gap-2" style={{ justifyContent: "flex-end" }}>
                      {tiers.data?.tiers.map((tier) => (
                        <button
                          key={tier.months}
                          className="btn btn-primary btn-sm"
                          disabled={renew.isPending}
                          onClick={() => {
                            setErr(null);
                            renew.mutate({ id: m.id, months: tier.months });
                          }}
                        >
                          {t("canva.renewMonths", {
                            months: tier.months,
                            price: tier.price_vnd.toLocaleString("vi-VN"),
                          })}
                        </button>
                      ))}
                      <button className="btn btn-ghost btn-sm" onClick={() => setRenewing(null)}>
                        {t("common.cancel")}
                      </button>
                    </span>
                  ) : (
                    <>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setErr(null);
                          setRenewing(m.id);
                        }}
                      >
                        {t("canva.renew")}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (!window.confirm(t("canva.confirmRemove", { email: m.email })))
                            return;
                          setErr(null);
                          remove.mutate(m.id);
                        }}
                      >
                        {t("common.delete")}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="surface-card" style={{ padding: 16, marginTop: 20 }}>
        <div className="display-h3" style={{ marginBottom: 8 }}>
          {t("canva.recentTasks")}
        </div>
        {(tasks.data ?? []).length === 0 && (
          <div className="form-hint">{t("canva.noTasks")}</div>
        )}
        {(tasks.data ?? []).map((task) => (
          <div
            key={task.id}
            style={{
              display: "flex",
              gap: 10,
              alignItems: "baseline",
              padding: "6px 0",
              borderBottom: "1px solid var(--border)",
              flexWrap: "wrap",
            }}
          >
            <code style={{ fontSize: 12 }}>{task.type}</code>
            <span
              style={{
                fontSize: 12,
                color: task.status === "FAILED" ? "var(--danger)" : "var(--ink-2)",
              }}
            >
              {task.status}
            </span>
            <span className="form-hint">
              {new Date(task.created_at).toLocaleString()}
            </span>
            {task.error_message && (
              <span style={{ fontSize: 12, color: "var(--danger)", flexBasis: "100%" }}>
                {task.error_message}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
