import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n";
import { toast } from "./Toast";
import type { Workspace } from "../types";

/**
 * NGÔN NGỮ HỆ THỐNG (super-admin) — đặt locale giao diện ChatGPT admin cho TỪNG
 * workspace ('vi' | 'en' | 'zh'). Extension dựa vào giá trị này (expected_locale)
 * để cảnh báo/định vị khi sync — TÁCH HẲN khỏi ngôn ngữ HIỂN THỊ dashboard
 * (per-user, đổi ở sidebar). Đổi tại đây chỉ ảnh hưởng thao tác extension, không
 * đổi giao diện của bất kỳ ai.
 */

type LocaleValue = Workspace["chatgpt_locale"];

const LOCALES: LocaleValue[] = ["vi", "en", "zh"];

export function SystemLanguageManager() {
  const t = useT();
  const qc = useQueryClient();

  const { data: workspaces, isLoading } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api<Workspace[]>("/api/v1/workspaces"),
  });

  const save = useMutation({
    mutationFn: (vars: { id: string; locale: LocaleValue }) =>
      api<Workspace>(`/api/v1/workspaces/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({ chatgpt_locale: vars.locale }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workspaces"] });
      toast.success(t("systemLang.saved"));
    },
    onError: (e) =>
      toast.error(
        e instanceof ApiError ? String(e.detail) : t("systemLang.saveError"),
      ),
  });

  return (
    <div className="settings-section">
      <h3 className="display-h3">{t("settings.sectionSystemLang")}</h3>
      <p
        style={{
          fontSize: 13,
          color: "var(--ink-3)",
          marginTop: 4,
          marginBottom: 20,
        }}
      >
        {t("systemLang.desc")}
      </p>

      {isLoading ? (
        <div className="cell-muted" style={{ fontSize: 13 }}>
          {t("common.loading")}
        </div>
      ) : (workspaces?.length ?? 0) === 0 ? (
        <div className="cell-muted" style={{ fontSize: 13 }}>
          {t("systemLang.empty")}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table data-table-compact">
            <thead>
              <tr>
                <th>{t("systemLang.colWorkspace")}</th>
                <th style={{ width: 200 }}>{t("systemLang.colLocale")}</th>
              </tr>
            </thead>
            <tbody>
              {workspaces?.map((ws) => (
                <tr key={ws.id}>
                  <td>
                    <div style={{ fontWeight: 500, color: "var(--ink)" }}>
                      {ws.name}
                    </div>
                    {ws.chatgpt_user_email && (
                      <div
                        className="cell-muted"
                        style={{
                          fontSize: 12,
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        {ws.chatgpt_user_email}
                      </div>
                    )}
                  </td>
                  <td>
                    <select
                      className="form-input"
                      style={{ padding: "6px 8px", fontSize: 13, maxWidth: 180 }}
                      value={ws.chatgpt_locale}
                      disabled={save.isPending}
                      onChange={(e) =>
                        save.mutate({
                          id: ws.id,
                          locale: e.target.value as LocaleValue,
                        })
                      }
                    >
                      {LOCALES.map((loc) => (
                        <option key={loc} value={loc}>
                          {t(`locale.${loc}`)}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
