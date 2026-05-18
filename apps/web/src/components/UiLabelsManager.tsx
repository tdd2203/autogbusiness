import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n";
import { toast } from "./Toast";

type Locale = "vi" | "en" | "zh";
type PagePath =
  | "/admin/members"
  | "/admin/billing"
  | "/admin/billing?tab=invoices"
  | "/admin/identity";

type UiLabel = {
  id: string;
  locale: string;
  page: string;
  control_key: string;
  label_text: string | null;
  aria_label: string | null;
  notes: Record<string, unknown> | null;
  stale: boolean;
  stale_reason: string | null;
  stale_count: number;
  version: number;
  updated_by_id: string | null;
  created_at: string;
  updated_at: string;
};

type CoverageCell = { total: number; filled: number; stale: number };
type CoverageResp = {
  pages: string[];
  locales: string[];
  matrix: Record<string, Record<string, CoverageCell>>;
};

type WorkspaceListItem = {
  id: string;
  name: string;
};

const LOCALES: Locale[] = ["vi", "en", "zh"];
const PAGES: PagePath[] = [
  "/admin/members",
  "/admin/billing",
  "/admin/billing?tab=invoices",
  "/admin/identity",
];
const CONTROL_KEYS_BY_PAGE: Record<PagePath, string[]> = {
  "/admin/members": [
    "tab_active_members",
    "tab_pending_invites",
    "tab_pending_requests",
    "invite_button_open",
    "invite_add_more_button",
    "invite_role_owner",
    "invite_role_admin",
    "invite_role_member",
    "invite_submit_button",
    // member_row_menu_button: icon-only — CSS selector handle, không cần text DB
    "menu_remove_member",
    "menu_change_role",
    "confirm_remove_button",
    "menu_revoke_invite",
    "confirm_revoke_button",
  ],
  "/admin/billing": ["tab_billing_plan", "tab_billing_invoices"],
  "/admin/billing?tab=invoices": ["tab_billing_invoices"],
  "/admin/identity": ["toggle_external_invites"],
};

const PAGE_HINT: Record<PagePath, string> = {
  "/admin/members": "Members — tabs, invite dialog, row menu, confirm",
  "/admin/billing": "Billing plan — tabs đầu trang",
  "/admin/billing?tab=invoices": "Invoices — tab hoá đơn (cần click)",
  "/admin/identity": "Identity — toggle 'lời mời từ miền ngoài'",
};

export function UiLabelsManager() {
  const t = useT();
  const qc = useQueryClient();
  const [selectedPage, setSelectedPage] = useState<PagePath>("/admin/members");
  const [selectedLocale, setSelectedLocale] = useState<Locale>("vi");
  const [edits, setEdits] = useState<Record<string, { label_text: string; aria_label: string }>>({});
  const [harvestWsId, setHarvestWsId] = useState<string>("");
  const [harvestTaskId, setHarvestTaskId] = useState<string | null>(null);
  // Timer FE: dashboard ticking độc lập với progress từ extension để user luôn
  // thấy "thời gian đang trôi" ngay cả khi extension chưa báo bước đầu tiên.
  const [harvestStartedAt, setHarvestStartedAt] = useState<number | null>(null);
  const [localElapsed, setLocalElapsed] = useState(0);

  const coverageQ = useQuery({
    queryKey: ["ui-labels-coverage"],
    queryFn: () => api<CoverageResp>("/api/v1/ui-labels/coverage"),
  });

  const labelsQ = useQuery({
    queryKey: ["ui-labels", selectedPage, selectedLocale],
    queryFn: () =>
      api<UiLabel[]>(
        `/api/v1/ui-labels?locale=${selectedLocale}&page=${encodeURIComponent(selectedPage)}`,
      ),
  });

  const staleQ = useQuery({
    queryKey: ["ui-labels-stale"],
    queryFn: () => api<UiLabel[]>(`/api/v1/ui-labels?stale=true`),
    refetchInterval: 30_000,
  });

  const workspacesQ = useQuery({
    queryKey: ["workspaces-for-harvest"],
    queryFn: () => api<WorkspaceListItem[]>("/api/v1/workspaces"),
  });

  const saveBulk = useMutation({
    mutationFn: (labels: Array<{ control_key: string; label_text: string; aria_label: string }>) =>
      api<UiLabel[]>("/api/v1/ui-labels/bulk", {
        method: "POST",
        body: JSON.stringify({
          locale: selectedLocale,
          page: selectedPage,
          labels: labels.map((l) => ({
            control_key: l.control_key,
            label_text: l.label_text || null,
            aria_label: l.aria_label || null,
          })),
        }),
      }),
    onSuccess: () => {
      setEdits({});
      qc.invalidateQueries({ queryKey: ["ui-labels"] });
      qc.invalidateQueries({ queryKey: ["ui-labels-coverage"] });
      qc.invalidateQueries({ queryKey: ["ui-labels-stale"] });
      toast.success(t("uiLabels.savedToast"));
    },
    onError: (e) => {
      toast.error(
        t("uiLabels.saveError", {
          err: e instanceof ApiError ? String(e.detail) : String(e),
        }),
      );
    },
  });

  const clearStale = useMutation({
    mutationFn: (id: string) =>
      api<UiLabel>(`/api/v1/ui-labels/${id}/clear-stale`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ui-labels"] });
      qc.invalidateQueries({ queryKey: ["ui-labels-coverage"] });
      qc.invalidateQueries({ queryKey: ["ui-labels-stale"] });
    },
  });

  const triggerHarvest = useMutation({
    mutationFn: ({ wsId, locale }: { wsId: string; locale: Locale }) =>
      api<{ queue_item_id: string; status: string; locale: string }>(
        `/api/v1/workspaces/${wsId}/harvest-labels`,
        {
          method: "POST",
          body: JSON.stringify({ locale }),
        },
      ),
    onSuccess: (data, vars) => {
      setHarvestTaskId(data.queue_item_id);
      setHarvestStartedAt(Date.now());
      setLocalElapsed(0);
      setSelectedLocale(vars.locale);
      toast.success(t("uiLabels.harvestQueued", { locale: vars.locale }));
    },
    onError: (e) => {
      toast.error(
        e instanceof ApiError ? String(e.detail) : t("uiLabels.harvestError"),
      );
    },
  });

  const harvestTaskQ = useQuery({
    queryKey: ["queue-item", harvestTaskId],
    queryFn: () =>
      api<{
        id: string;
        type: string;
        status: string;
        progress: {
          phase?: string;
          message?: string;
          current?: number;
          total?: number;
          scanned?: number;
          elapsed_sec?: number;
        } | null;
        result: { total?: number; pages?: Record<string, number> } | null;
        error_code: string | null;
        error_message: string | null;
      }>(`/api/v1/queue/${harvestTaskId}`),
    enabled: !!harvestTaskId,
    refetchInterval: harvestTaskId ? 1000 : false,
  });

  const cancelHarvest = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/queue/${id}/cancel`, { method: "POST" }),
    onSuccess: () => {
      setHarvestTaskId(null);
      setHarvestStartedAt(null);
      toast.info(t("uiLabels.harvestCancelled"));
    },
    onError: (e) => {
      toast.error(
        e instanceof ApiError ? String(e.detail) : t("uiLabels.harvestError"),
      );
    },
  });

  useEffect(() => {
    if (!harvestTaskQ.data) return;
    const status = harvestTaskQ.data.status;
    if (status === "COMPLETED") {
      const r = harvestTaskQ.data.result;
      toast.success(
        t("uiLabels.harvestDone", { total: r?.total ?? 0 }),
      );
      qc.invalidateQueries({ queryKey: ["ui-labels"] });
      qc.invalidateQueries({ queryKey: ["ui-labels-coverage"] });
      qc.invalidateQueries({ queryKey: ["ui-labels-stale"] });
      setHarvestTaskId(null);
      setHarvestStartedAt(null);
    } else if (status === "FAILED") {
      toast.error(
        t("uiLabels.harvestFailed", {
          err: harvestTaskQ.data.error_message ?? "unknown",
        }),
      );
      setHarvestTaskId(null);
      setHarvestStartedAt(null);
    }
  }, [harvestTaskQ.data, qc, t]);

  useEffect(() => {
    if (!harvestStartedAt) return;
    const tick = (): void => {
      setLocalElapsed(Math.round((Date.now() - harvestStartedAt) / 1000));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [harvestStartedAt]);

  const expectedKeys = CONTROL_KEYS_BY_PAGE[selectedPage] ?? [];
  const labelsByKey = useMemo(() => {
    const m: Record<string, UiLabel> = {};
    for (const row of labelsQ.data ?? []) {
      m[row.control_key] = row;
    }
    return m;
  }, [labelsQ.data]);

  function valueFor(key: string, field: "label_text" | "aria_label"): string {
    if (edits[key]?.[field] !== undefined) return edits[key][field];
    return labelsByKey[key]?.[field] ?? "";
  }

  function setEdit(key: string, field: "label_text" | "aria_label", value: string) {
    setEdits((prev) => ({
      ...prev,
      [key]: {
        label_text: prev[key]?.label_text ?? labelsByKey[key]?.label_text ?? "",
        aria_label: prev[key]?.aria_label ?? labelsByKey[key]?.aria_label ?? "",
        [field]: value,
      },
    }));
  }

  function saveCurrentPage() {
    const items = expectedKeys
      .map((k) => ({
        control_key: k,
        label_text: valueFor(k, "label_text").trim(),
        aria_label: valueFor(k, "aria_label").trim(),
      }))
      .filter((l) => l.label_text || l.aria_label);
    if (items.length === 0) {
      toast.warning(t("uiLabels.emptySaveWarn"));
      return;
    }
    saveBulk.mutate(items);
  }

  const staleRows = staleQ.data ?? [];
  const harvestRunning = !!harvestTaskId;
  const harvestProgress = harvestTaskQ.data?.progress;
  const harvestStatus = harvestTaskQ.data?.status ?? null;
  const hasExtensionSignal = !!(harvestProgress?.message || harvestProgress?.phase);
  // Watchdog: nếu sau 20s vẫn không có signal từ extension → cảnh báo user
  // kiểm tra tab ChatGPT mở chưa, extension online chưa.
  const watchdogTripped = harvestRunning && !hasExtensionSignal && localElapsed >= 20;

  return (
    <div className="settings-section">
      <h3 className="display-h3">{t("uiLabels.sectionHeader")}</h3>
      <p className="text-[13px] text-[var(--ink-3)] mt-1 mb-5">
        {t("uiLabels.intro")}
      </p>

      {staleRows.length > 0 && (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 mb-5 text-[13px]">
          <div className="font-semibold text-rose-700 mb-1">
            {t("uiLabels.staleBannerTitle", { n: staleRows.length })}
          </div>
          <div className="text-rose-700 mb-2">{t("uiLabels.staleBannerBody")}</div>
          <ul className="list-disc ml-5 max-h-32 overflow-auto">
            {staleRows.slice(0, 8).map((r) => (
              <li key={r.id}>
                <button
                  className="text-rose-700 underline hover:opacity-80"
                  onClick={() => {
                    setSelectedPage(r.page as PagePath);
                    setSelectedLocale(r.locale as Locale);
                  }}
                >
                  {r.locale} · {r.page} · {r.control_key}{" "}
                  <span className="opacity-70">×{r.stale_count}</span>
                </button>
              </li>
            ))}
            {staleRows.length > 8 && (
              <li className="opacity-70">+{staleRows.length - 8} ...</li>
            )}
          </ul>
        </div>
      )}

      <div className="mb-6">
        <div className="text-[12px] font-medium text-[var(--ink-3)] mb-2">
          {t("uiLabels.coverageTitle")}
        </div>
        <div className="overflow-x-auto">
          <table className="text-[12px] border-collapse w-full max-w-2xl">
            <thead>
              <tr>
                <th className="text-left p-2 border-b border-[var(--border)] font-medium">
                  Page
                </th>
                {LOCALES.map((l) => (
                  <th
                    key={l}
                    className="text-center p-2 border-b border-[var(--border)] font-medium uppercase"
                  >
                    {l}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PAGES.map((p) => (
                <tr key={p}>
                  <td className="p-2 border-b border-[var(--border)] font-mono text-[11px]">
                    {p}
                  </td>
                  {LOCALES.map((l) => {
                    const cell = coverageQ.data?.matrix?.[p]?.[l];
                    const isSelected = selectedPage === p && selectedLocale === l;
                    const total = cell?.total ?? CONTROL_KEYS_BY_PAGE[p].length;
                    const filled = cell?.filled ?? 0;
                    const stale = cell?.stale ?? 0;
                    const complete = filled >= total && total > 0;
                    return (
                      <td
                        key={l}
                        className="text-center p-1 border-b border-[var(--border)]"
                      >
                        <button
                          onClick={() => {
                            setSelectedPage(p);
                            setSelectedLocale(l);
                            setEdits({});
                          }}
                          className={`px-2 py-1 rounded font-mono text-[11px] border ${
                            isSelected
                              ? "bg-slate-900 text-white border-slate-900"
                              : complete
                                ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
                                : "bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100"
                          }`}
                          title={t("uiLabels.coverageTooltip", {
                            filled,
                            total,
                            stale,
                          })}
                        >
                          {filled}/{total}
                          {stale > 0 && (
                            <span className="ml-1 text-rose-600 font-bold">
                              ⚠{stale}
                            </span>
                          )}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mb-2 flex items-center justify-between flex-wrap gap-2">
        <div className="text-[13px]">
          <span className="font-semibold">{t("uiLabels.editingLabel")}: </span>
          <span className="font-mono">
            {selectedLocale} · {selectedPage}
          </span>
          <span className="text-[var(--ink-3)] ml-2">
            ({PAGE_HINT[selectedPage]})
          </span>
        </div>
        <button
          disabled={saveBulk.isPending}
          onClick={saveCurrentPage}
          className="btn btn-primary"
        >
          {saveBulk.isPending ? t("common.saving") : t("uiLabels.savePage")}
        </button>
      </div>

      <div className="border border-[var(--border)] rounded-md overflow-hidden">
        <table className="text-[12px] w-full">
          <thead className="bg-[var(--bg-subtle)]">
            <tr>
              <th className="text-left p-2 border-b border-[var(--border)] w-[180px]">
                control_key
              </th>
              <th className="text-left p-2 border-b border-[var(--border)]">
                label_text
              </th>
              <th className="text-left p-2 border-b border-[var(--border)] w-[120px]">
                aria_label
              </th>
              <th className="text-left p-2 border-b border-[var(--border)] w-[80px]">
                v
              </th>
              <th className="text-left p-2 border-b border-[var(--border)] w-[60px]"></th>
            </tr>
          </thead>
          <tbody>
            {expectedKeys.map((k) => {
              const row = labelsByKey[k];
              return (
                <tr key={k} className={row?.stale ? "bg-rose-50" : ""}>
                  <td className="p-2 border-b border-[var(--border)] font-mono text-[11px]">
                    {k}
                    {row?.stale && (
                      <div className="text-[10px] text-rose-700 mt-0.5">
                        ⚠ stale ×{row.stale_count}
                      </div>
                    )}
                  </td>
                  <td className="p-1 border-b border-[var(--border)]">
                    <input
                      value={valueFor(k, "label_text")}
                      onChange={(e) => setEdit(k, "label_text", e.target.value)}
                      placeholder={t("uiLabels.labelPlaceholder")}
                      className="w-full px-2 py-1 border border-transparent hover:border-[var(--border)] focus:border-slate-400 rounded text-[12px] font-mono bg-transparent focus:bg-white"
                    />
                  </td>
                  <td className="p-1 border-b border-[var(--border)]">
                    <input
                      value={valueFor(k, "aria_label")}
                      onChange={(e) => setEdit(k, "aria_label", e.target.value)}
                      placeholder="—"
                      className="w-full px-2 py-1 border border-transparent hover:border-[var(--border)] focus:border-slate-400 rounded text-[12px] font-mono bg-transparent focus:bg-white"
                    />
                  </td>
                  <td className="p-2 border-b border-[var(--border)] font-mono text-[11px] text-[var(--ink-3)]">
                    {row ? `v${row.version}` : "—"}
                  </td>
                  <td className="p-1 border-b border-[var(--border)]">
                    {row?.stale && (
                      <button
                        onClick={() => clearStale.mutate(row.id)}
                        className="text-[11px] text-emerald-700 underline hover:opacity-80"
                        title={t("uiLabels.clearStaleHint")}
                      >
                        OK
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-6 p-4 border border-[var(--border)] rounded-md bg-[var(--bg-subtle)]">
        <div className="text-[13px] font-semibold mb-1">
          🤖 {t("uiLabels.autoHarvestTitle")}
        </div>
        <p className="text-[12px] text-[var(--ink-3)] mb-3">
          {t("uiLabels.autoHarvestIntro")}
        </p>

        <div className="flex flex-wrap items-center gap-2 mb-3">
          <label className="text-[12px] font-medium">
            {t("uiLabels.pickWorkspace")}:
          </label>
          <select
            value={harvestWsId}
            onChange={(e) => setHarvestWsId(e.target.value)}
            disabled={harvestRunning}
            className="form-input text-[12px] py-1 max-w-xs"
          >
            <option value="">—</option>
            {(workspacesQ.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>

        <ol className="list-decimal ml-5 text-[12px] text-[var(--ink-2)] mb-3 space-y-1">
          <li>{t("uiLabels.autoStep1")}</li>
          <li>{t("uiLabels.autoStep2")}</li>
          <li>{t("uiLabels.autoStep3")}</li>
        </ol>

        <div className="flex flex-wrap items-center gap-2">
          {LOCALES.map((l) => (
            <button
              key={l}
              disabled={!harvestWsId || harvestRunning || triggerHarvest.isPending}
              onClick={() => triggerHarvest.mutate({ wsId: harvestWsId, locale: l })}
              className="btn btn-primary text-[12px] py-1.5 px-3"
            >
              {harvestRunning && harvestTaskQ.data?.status === "IN_PROGRESS"
                ? t("uiLabels.autoBusy")
                : t("uiLabels.autoButton", { locale: l.toUpperCase() })}
            </button>
          ))}
        </div>

        {harvestRunning && (
          <div className="mt-3 text-[12px] p-3 border border-amber-200 bg-amber-50 rounded">
            <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <div className="font-medium text-amber-800">
                  ⏳ {t("uiLabels.autoRunning")}
                </div>
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded uppercase ${
                    harvestStatus === "IN_PROGRESS"
                      ? "bg-emerald-100 text-emerald-700 border border-emerald-300"
                      : "bg-slate-100 text-slate-700 border border-slate-300"
                  }`}
                >
                  {harvestStatus === "IN_PROGRESS"
                    ? t("uiLabels.statusInProgress")
                    : harvestStatus === "PENDING"
                      ? t("uiLabels.statusPending")
                      : (harvestStatus ?? "—")}
                </span>
                <span className="text-[11px] text-amber-700 font-mono">
                  {localElapsed}s
                </span>
              </div>
              <button
                onClick={() =>
                  harvestTaskId && cancelHarvest.mutate(harvestTaskId)
                }
                disabled={cancelHarvest.isPending}
                className="text-[11px] text-rose-700 underline hover:opacity-80"
              >
                {cancelHarvest.isPending
                  ? t("common.loading")
                  : t("uiLabels.cancelHarvest")}
              </button>
            </div>

            {typeof harvestProgress?.current === "number" &&
              typeof harvestProgress?.total === "number" && (
                <div className="mb-2">
                  <div className="h-1.5 bg-amber-100 rounded overflow-hidden">
                    <div
                      className="h-full bg-amber-500 transition-all duration-300"
                      style={{
                        width: `${Math.min(
                          100,
                          Math.round(
                            (harvestProgress.current /
                              Math.max(1, harvestProgress.total)) *
                              100,
                          ),
                        )}%`,
                      }}
                    />
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-[11px] text-amber-700 font-mono">
                    <span>
                      {harvestProgress.current}/{harvestProgress.total}{" "}
                      {t("uiLabels.stepWord")}
                    </span>
                    <span>·</span>
                    <span>
                      {t("uiLabels.scannedCount", {
                        n: harvestProgress.scanned ?? 0,
                      })}
                    </span>
                    {typeof harvestProgress.elapsed_sec === "number" && (
                      <>
                        <span>·</span>
                        <span>ext {harvestProgress.elapsed_sec}s</span>
                      </>
                    )}
                  </div>
                </div>
              )}

            {!hasExtensionSignal && (
              <div className="mb-2">
                <div className="h-1.5 bg-amber-100 rounded overflow-hidden">
                  <div
                    className="h-full bg-amber-300 animate-pulse"
                    style={{ width: "20%" }}
                  />
                </div>
              </div>
            )}

            {harvestProgress?.message && (
              <div className="text-amber-700 text-[12px]">
                {harvestProgress.message}
              </div>
            )}

            {!harvestProgress?.message && (
              <div className="text-amber-600 text-[11px] italic">
                {t("uiLabels.waitingForExtension")}
              </div>
            )}

            {watchdogTripped && (
              <div className="mt-2 text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">
                ⚠ {t("uiLabels.watchdogWarn", { sec: localElapsed })}
              </div>
            )}
          </div>
        )}

        <p className="text-[11px] text-[var(--ink-3)] mt-3">
          {t("uiLabels.autoNote")}
        </p>
      </div>
    </div>
  );
}
