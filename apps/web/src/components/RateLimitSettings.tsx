import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n";
import { toast } from "./Toast";

/**
 * HẠN MỨC THAO TÁC (super-admin) — khoảng cách tối thiểu giữa hai lần cùng một
 * người bấm cùng một nút nặng.
 *
 * Vì sao chỉnh được từ đây thay vì để hằng số trong code: mỗi lần muốn nới một
 * nút lại phải sửa code + deploy thì lúc đại lý kêu bị chặn giữa đợt mời không
 * ai kịp làm. Backend giữ catalog (tên nút, mặc định, trần) — trang này chỉ vẽ
 * lại những gì backend khai, nên thêm nút mới ở backend là giao diện tự có dòng.
 *
 * Backend: `apps/api/app/action_limit.py` + `routers/admin_limits.py`.
 */

type ActionLimit = {
  key: string;
  label: string;
  hint: string;
  scope: "workspace" | "user" | string;
  seconds: number;
  default_sec: number;
  max_sec: number;
};

type RateLimitSettingsData = {
  enabled: boolean;
  exempt_super_admin: boolean;
  effective: boolean;
  actions: ActionLimit[];
  updated_at: string | null;
  updated_by: string | null;
};

/**
 * Câu chữ hiện lên UI cho một lỗi bất kỳ do `api()` ném ra. Backend trả `detail`
 * khi thì chuỗi, khi thì `{code, message}` (429 cooldown, 403 thiếu quyền) nên
 * bóc thẳng `String(e.detail)` là có ngày in ra `[object Object]`.
 */
function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const d = e.detail as { message?: unknown } | string | null | undefined;
    if (typeof d === "string" && d) return d;
    if (d && typeof d === "object" && typeof d.message === "string" && d.message) {
      return d.message;
    }
  }
  return e instanceof Error && e.message ? e.message : fallback;
}

type Unit = "s" | "m" | "h";

const MULTIPLIER: Record<Unit, number> = { s: 1, m: 60, h: 3600 };

/** Chọn đơn vị đọc thuận mắt nhất cho một số giây (18000 → 5 tiếng, 90 → 90 giây). */
function pickUnit(seconds: number): Unit {
  if (seconds >= 3600 && seconds % 3600 === 0) return "h";
  if (seconds >= 60 && seconds % 60 === 0) return "m";
  return "s";
}

type Draft = { value: number; unit: Unit };

function toDraft(seconds: number): Draft {
  const unit = pickUnit(seconds);
  return { value: Math.round(seconds / MULTIPLIER[unit]), unit };
}

function toSeconds(draft: Draft): number {
  return Math.max(0, Math.round(draft.value * MULTIPLIER[draft.unit]));
}

/** Số giây → câu ngắn đọc được, khớp `describe_seconds` phía backend. */
function describe(total: number, t: (k: string, p?: Record<string, string>) => string): string {
  if (total < 60) return t("rateLimit.fmtSec", { n: String(total) });
  if (total < 3600) return t("rateLimit.fmtMin", { n: String(Math.round(total / 60)) });
  return t("rateLimit.fmtHour", { n: String(Math.round((total / 3600) * 10) / 10) });
}

export function RateLimitSettings() {
  const t = useT();
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin", "rate-limits"],
    queryFn: () => api<RateLimitSettingsData>("/api/v1/admin/rate-limits"),
  });

  const [enabled, setEnabled] = useState(true);
  const [exemptSuper, setExemptSuper] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  // Nạp lại state nháp mỗi khi server trả bản mới (kể cả sau khi lưu) — nếu
  // không, giá trị bị kẹp về trần ở backend sẽ không hiện ra trên ô nhập.
  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled);
    setExemptSuper(data.exempt_super_admin);
    setDrafts(
      Object.fromEntries(data.actions.map((a) => [a.key, toDraft(a.seconds)])),
    );
  }, [data]);

  const save = useMutation({
    mutationFn: (body: {
      enabled: boolean;
      exempt_super_admin: boolean;
      cooldowns: Record<string, number>;
    }) =>
      api<RateLimitSettingsData>("/api/v1/admin/rate-limits", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: (fresh) => {
      qc.setQueryData(["admin", "rate-limits"], fresh);
      toast.success(t("rateLimit.saved"));
    },
    onError: (e) => toast.error(errorText(e, t("rateLimit.saveError"))),
  });

  const dirty = useMemo(() => {
    if (!data) return false;
    if (enabled !== data.enabled) return true;
    if (exemptSuper !== data.exempt_super_admin) return true;
    return data.actions.some((a) => {
      const draft = drafts[a.key];
      return draft !== undefined && toSeconds(draft) !== a.seconds;
    });
  }, [data, enabled, exemptSuper, drafts]);

  /** Tên nút: ưu tiên bản dịch của dashboard, thiếu thì lấy nhãn backend gửi kèm. */
  function localized(prefix: string, key: string, fallback: string): string {
    const full = `rateLimit.${prefix}.${key}`;
    const value = t(full);
    return value === full ? fallback : value;
  }

  function onSave() {
    if (!data) return;
    const cooldowns: Record<string, number> = {};
    for (const action of data.actions) {
      const draft = drafts[action.key];
      cooldowns[action.key] = toSeconds(draft ?? toDraft(action.seconds));
    }
    save.mutate({
      enabled,
      exempt_super_admin: exemptSuper,
      cooldowns,
    });
  }

  function onResetDefaults() {
    if (!data) return;
    setDrafts(
      Object.fromEntries(
        data.actions.map((a) => [a.key, toDraft(a.default_sec)]),
      ),
    );
  }

  if (isLoading) {
    return (
      <div className="settings-section">
        <div className="cell-muted" style={{ fontSize: 13 }}>
          {t("common.loading")}
        </div>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="settings-section">
        <div className="notice danger">
          <div>
            <div className="notice-title">{t("rateLimit.loadError")}</div>
            <div className="notice-body">
              {errorText(error, t("rateLimit.loadError"))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h3 className="display-h3">{t("settings.sectionRateLimit")}</h3>
      <p
        style={{
          fontSize: 13,
          color: "var(--ink-3)",
          marginTop: 4,
          marginBottom: 20,
        }}
      >
        {t("rateLimit.desc")}
      </p>

      {!data.effective && (
        <div className="notice warn" style={{ marginBottom: 20 }}>
          <div>
            <div className="notice-title">{t("rateLimit.killSwitchTitle")}</div>
            <div className="notice-body">{t("rateLimit.killSwitchBody")}</div>
          </div>
        </div>
      )}

      <label
        style={{
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
          marginBottom: 14,
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <span>
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>
            {t("rateLimit.enabledLabel")}
          </span>
          <span
            style={{ display: "block", fontSize: 12, color: "var(--ink-3)" }}
          >
            {t("rateLimit.enabledHint")}
          </span>
        </span>
      </label>

      <label
        style={{
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
          marginBottom: 22,
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={exemptSuper}
          onChange={(e) => setExemptSuper(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <span>
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>
            {t("rateLimit.exemptSuperLabel")}
          </span>
          <span
            style={{ display: "block", fontSize: 12, color: "var(--ink-3)" }}
          >
            {t("rateLimit.exemptSuperHint")}
          </span>
        </span>
      </label>

      <div style={{ overflowX: "auto" }}>
        <table className="data-table data-table-compact">
          <thead>
            <tr>
              <th>{t("rateLimit.colAction")}</th>
              <th style={{ width: 120 }}>{t("rateLimit.colScope")}</th>
              <th style={{ width: 220 }}>{t("rateLimit.colInterval")}</th>
            </tr>
          </thead>
          <tbody>
            {data.actions.map((action) => {
              const draft = drafts[action.key] ?? toDraft(action.seconds);
              const seconds = toSeconds(draft);
              const maxValue = Math.floor(
                action.max_sec / MULTIPLIER[draft.unit],
              );
              return (
                <tr key={action.key}>
                  <td>
                    <div style={{ fontWeight: 500, color: "var(--ink)" }}>
                      {localized("action", action.key, action.label)}
                    </div>
                  </td>
                  <td>
                    <span className="role-tag">
                      {action.scope === "workspace"
                        ? t("rateLimit.scopeWorkspace")
                        : t("rateLimit.scopeUser")}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        className="form-input"
                        type="number"
                        min={0}
                        max={maxValue}
                        value={draft.value}
                        style={{
                          padding: "6px 8px",
                          fontSize: 13,
                          width: 90,
                        }}
                        onChange={(e) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [action.key]: {
                              ...draft,
                              value: Math.max(
                                0,
                                Math.min(maxValue, Number(e.target.value) || 0),
                              ),
                            },
                          }))
                        }
                      />
                      <select
                        className="form-input"
                        value={draft.unit}
                        style={{ padding: "6px 8px", fontSize: 13, width: 96 }}
                        onChange={(e) =>
                          setDrafts((prev) => ({
                            ...prev,
                            // Đổi đơn vị GIỮ NGUYÊN số giây đang đặt, chỉ đổi cách
                            // hiển thị — bằng không "60 giây" bấm sang phút thành
                            // 60 phút một cách âm thầm.
                            [action.key]: {
                              value: Math.max(
                                0,
                                Math.round(
                                  seconds / MULTIPLIER[e.target.value as Unit],
                                ),
                              ),
                              unit: e.target.value as Unit,
                            },
                          }))
                        }
                      >
                        <option value="s">{t("rateLimit.unitSec")}</option>
                        <option value="m">{t("rateLimit.unitMin")}</option>
                        <option value="h">{t("rateLimit.unitHour")}</option>
                      </select>
                    </div>
                    <div
                      className="cell-muted"
                      style={{ fontSize: 11, marginTop: 4 }}
                    >
                      {seconds === 0
                        ? t("rateLimit.noLimit")
                        : t("rateLimit.defaultIs", {
                            n: describe(action.default_sec, t),
                          })}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          marginTop: 20,
        }}
      >
        <button
          className="btn btn-primary"
          disabled={!dirty || save.isPending}
          onClick={onSave}
        >
          {save.isPending ? t("common.saving") : t("common.save")}
        </button>
        <button
          className="btn btn-ghost"
          disabled={save.isPending}
          onClick={onResetDefaults}
        >
          {t("rateLimit.resetDefaults")}
        </button>
        {data.updated_at && (
          <span className="cell-muted" style={{ fontSize: 12 }}>
            {t("rateLimit.updatedBy", {
              who: data.updated_by ?? "—",
            })}
          </span>
        )}
      </div>
    </div>
  );
}
