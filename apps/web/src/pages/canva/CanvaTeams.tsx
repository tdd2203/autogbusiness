/**
 * Trang "Team Canva" — danh sách team + tạo team mới (super-admin).
 *
 * TÁCH HẲN khỏi trang "Không gian làm việc" của ChatGPT (user 2026-09-01: "làm riêng
 * 1 nhánh canva riêng, không chung với chatgpt"). Cùng gọi `GET /api/v1/workspaces`
 * nhưng luôn kèm `platform=canva` nên hai danh sách không bao giờ lẫn nhau.
 *
 * Khác ChatGPT ở ba chỗ hiển thị: suất là 50 CÓ SẴN của gói (không mua thêm được nên
 * không có nút mua), không có hoá đơn Stripe để đồng bộ, và không có tên miền xác minh.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import { useI18n } from "../../i18n";
import { useSeatMap } from "../../hooks/useWorkspaceSeats";
import type { Workspace, WorkspaceWithKey } from "../../types";

/** Suất mặc định của gói Canva trả phí — khớp models.CANVA_SEAT_TOTAL bên backend. */
const CANVA_SEAT_TOTAL = 50;

export default function CanvaTeams() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [seatTotal, setSeatTotal] = useState<string>(String(CANVA_SEAT_TOTAL));
  const [createdKey, setCreatedKey] = useState<WorkspaceWithKey | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const { seatMap } = useSeatMap();
  const { data: teams = [], isLoading } = useQuery({
    queryKey: ["workspaces", "canva"],
    queryFn: () => api<Workspace[]>("/api/v1/workspaces?platform=canva"),
  });

  const create = useMutation({
    mutationFn: () =>
      api<WorkspaceWithKey>("/api/v1/workspaces", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          platform: "canva",
          seat_total: seatTotal ? Number(seatTotal) : null,
        }),
      }),
    onSuccess: (ws) => {
      setCreatedKey(ws);
      setShowForm(false);
      setName("");
      setSeatTotal(String(CANVA_SEAT_TOTAL));
      qc.invalidateQueries({ queryKey: ["workspaces", "canva"] });
      qc.invalidateQueries({ queryKey: ["workspace-seats"] });
    },
    onError: (e) =>
      setFormError(e instanceof ApiError ? String(e.detail) : t("canva.createError")),
  });

  return (
    <div>
      <div
        className="flex items-center justify-between"
        style={{ marginBottom: 20, gap: 12, flexWrap: "wrap" }}
      >
        <div>
          <h1 className="display-h2">{t("canva.teamsTitle")}</h1>
          <div className="form-hint">{t("canva.teamsSubtitle")}</div>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => {
            setFormError(null);
            setShowForm((v) => !v);
          }}
        >
          {showForm ? t("common.cancel") : t("canva.createTeam")}
        </button>
      </div>

      {createdKey && (
        <div className="notice warn" style={{ marginBottom: 20, alignItems: "flex-start" }}>
          <div className="notice-icon">!</div>
          <div style={{ flex: 1 }}>
            <div className="notice-title">
              {t("canva.createdBanner", { name: createdKey.name })}
            </div>
            <div className="notice-body" style={{ marginBottom: 8 }}>
              {t("canva.apiKeyOnce")}
            </div>
            <div className="flex items-center gap-2">
              <code
                style={{
                  flex: 1,
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: "8px 10px",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  wordBreak: "break-all",
                }}
              >
                {createdKey.extension_api_key}
              </code>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => navigator.clipboard.writeText(createdKey.extension_api_key)}
              >
                {t("common.copy")}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setCreatedKey(null)}>
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <form
          className="surface-card"
          style={{ padding: 20, marginBottom: 20 }}
          onSubmit={(e) => {
            e.preventDefault();
            setFormError(null);
            create.mutate();
          }}
        >
          <div className="display-h3" style={{ marginBottom: 12 }}>
            {t("canva.createTeam")}
          </div>
          <input
            required
            className="form-input"
            style={{ marginBottom: 12 }}
            placeholder={t("canva.namePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            type="number"
            min={1}
            max={200}
            className="form-input"
            value={seatTotal}
            onChange={(e) => setSeatTotal(e.target.value)}
          />
          <div className="form-hint" style={{ margin: "6px 0 12px" }}>
            {t("canva.seatHint")}
          </div>
          {formError && (
            <div style={{ color: "var(--danger)", fontSize: 12.5, marginBottom: 10 }}>
              {formError}
            </div>
          )}
          <button className="btn btn-primary" disabled={create.isPending}>
            {create.isPending ? t("common.creating") : t("common.create")}
          </button>
        </form>
      )}

      <div className="surface-card" style={{ padding: 0, overflowX: "auto" }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t("canva.colTeam")}</th>
              <th>{t("canva.colSeats")}</th>
              <th>{t("canva.colSynced")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={4}>{t("common.loading")}</td>
              </tr>
            )}
            {!isLoading && teams.length === 0 && (
              <tr>
                <td colSpan={4}>{t("canva.emptyTeams")}</td>
              </tr>
            )}
            {teams.map((ws) => {
              const seats = seatMap.get(ws.id);
              const used = seats?.seat_used ?? ws.seat_used ?? 0;
              const total = seats?.seat_total ?? ws.seat_total ?? CANVA_SEAT_TOTAL;
              const full = total > 0 && used >= total;
              return (
                <tr key={ws.id}>
                  <td>
                    <Link to={`/canva/teams/${ws.id}/members`}>{ws.name}</Link>
                  </td>
                  <td>
                    <span style={full ? { color: "var(--danger)", fontWeight: 600 } : undefined}>
                      {used}/{total}
                    </span>
                    {full && (
                      <span className="form-hint" style={{ marginLeft: 8 }}>
                        {t("canva.seatFull")}
                      </span>
                    )}
                  </td>
                  <td>
                    {ws.last_synced_at
                      ? new Date(ws.last_synced_at).toLocaleString()
                      : "—"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <Link className="btn btn-ghost btn-sm" to={`/canva/teams/${ws.id}/members`}>
                      {t("canva.openMembers")}
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
