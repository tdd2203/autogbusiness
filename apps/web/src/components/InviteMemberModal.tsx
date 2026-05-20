/**
 * Modal mời thành viên — paste-driven.
 *
 * UX:
 *   1. Admin paste 1 danh sách email vào textarea (1/dòng hoặc cách nhau comma).
 *   2. Mỗi email hợp lệ tự xuất hiện 1 row trong bảng bên dưới với input "Số tháng"
 *      (default 1, có +/-) và preview "Hết hạn DD/MM/YYYY".
 *   3. Admin có thể chỉnh `months` per-email, hoặc click "Áp cho tất cả: 1th/3th/...".
 *   4. Submit → POST bulk-invite với `invites: [{email, subscription_months}]`.
 *
 * Subscription tracking dashboard-only: khi tới `subscription_end_at` (= now +
 * months × 30 ngày), background scheduler enqueue REMOVE_MEMBER + cảnh báo
 * trên Members page.
 *
 * State model:
 *   - emailsText: string — textarea source of truth cho TẬP email
 *   - monthsByEmail: Map<lowercase_email, months> — overrides per email
 *   - entries (derived): parse emailsText + map months → list để render table
 */

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useFormatDate, useT } from "../i18n";
import { api, ApiError } from "../lib/api";
import { toast } from "./Toast";

const INVITE_ROLE = "member" as const;
const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;
const DEFAULT_MONTHS = 1;
const MIN_MONTHS = 1;
const MAX_MONTHS = 60;
const QUICK_MONTHS = [1, 3, 6, 12] as const;
const DAYS_PER_MONTH = 30;

function clampMonths(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MONTHS;
  return Math.max(MIN_MONTHS, Math.min(MAX_MONTHS, Math.floor(n)));
}

function parseEmailsFromText(raw: string): {
  validUnique: string[]; // lowercase, dedup
  validRaw: string[]; // original case, dedup
  invalid: string[];
  duplicates: string[];
} {
  const tokens = raw
    .split(/[\n,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const validUnique: string[] = [];
  const validRaw: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];
  for (const tok of tokens) {
    if (!EMAIL_RE.test(tok)) {
      invalid.push(tok);
      continue;
    }
    const lower = tok.toLowerCase();
    if (seen.has(lower)) {
      duplicates.push(tok);
      continue;
    }
    seen.add(lower);
    validUnique.push(lower);
    validRaw.push(tok);
  }
  return { validUnique, validRaw, invalid, duplicates };
}

export function InviteMemberModal({
  workspaceId,
  onClose,
  onDone,
}: {
  workspaceId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const formatExpiresDate = (months: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + months * DAYS_PER_MONTH);
    return formatDate(d, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  };
  const [emailsText, setEmailsText] = useState("");
  // Per-email months override (default applies when not set).
  const [monthsByEmail, setMonthsByEmail] = useState<Record<string, number>>({});

  const { validUnique, validRaw, invalid, duplicates } = useMemo(
    () => parseEmailsFromText(emailsText),
    [emailsText],
  );

  // Derive entries: each valid email + months (override or default).
  const entries = useMemo(
    () =>
      validUnique.map((email, idx) => ({
        email,
        emailRaw: validRaw[idx] ?? email,
        months: monthsByEmail[email] ?? DEFAULT_MONTHS,
      })),
    [validUnique, validRaw, monthsByEmail],
  );

  // Modal cố định: chỉ đóng qua nút Huỷ hoặc submit success.
  // Why: paste nhiều email + chỉnh months tốn công, lỡ click backdrop / Esc
  // sẽ mất hết → không có shortcut nào dismiss modal.

  const bulkInvite = useMutation({
    mutationFn: () =>
      api<{ queue_item_id: string; count: number }>(
        `/api/v1/workspaces/${workspaceId}/members/bulk-invite`,
        {
          method: "POST",
          body: JSON.stringify({
            invites: entries.map((e) => ({
              email: e.email,
              subscription_months: e.months,
            })),
            role: INVITE_ROLE,
          }),
        },
      ),
    onSuccess: (resp) => {
      toast.success(t("invite.resultQueued", { n: resp.count }));
      onDone();
      onClose();
    },
    onError: (e) => {
      const msg =
        e instanceof ApiError
          ? String(e.detail)
          : e instanceof Error
            ? e.message
            : String(e);
      toast.error(t("invite.resultError", { error: msg }));
    },
  });

  function handleSubmit() {
    if (entries.length === 0) return;
    bulkInvite.mutate();
  }

  function setMonthsFor(email: string, months: number) {
    setMonthsByEmail((m) => ({ ...m, [email]: clampMonths(months) }));
  }

  function applyMonthsToAll(months: number) {
    setMonthsByEmail((prev) => {
      const next = { ...prev };
      for (const email of validUnique) next[email] = clampMonths(months);
      return next;
    });
  }

  /**
   * Remove 1 email khỏi danh sách: xoá đúng dòng tương ứng trong textarea
   * (giữ nguyên các dòng khác + comment/invalid).
   */
  function removeEntry(emailLower: string) {
    setEmailsText((text) => {
      const lines = text.split(/\r?\n/);
      const kept: string[] = [];
      for (const line of lines) {
        // 1 dòng có thể chứa nhiều email (comma) — filter tokens trong dòng.
        const tokens = line.split(/[,;]/).map((s) => s.trim());
        const keptTokens = tokens.filter(
          (tok) => tok.toLowerCase() !== emailLower,
        );
        if (keptTokens.length === tokens.length) {
          // Không có email này trong dòng → giữ nguyên
          kept.push(line);
        } else if (keptTokens.length > 0) {
          // Một số token bị xoá → reconstruct dòng
          kept.push(keptTokens.join(", "));
        }
        // else: cả dòng chỉ có email này → drop
      }
      return kept.join("\n");
    });
    setMonthsByEmail((m) => {
      const next = { ...m };
      delete next[emailLower];
      return next;
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full mx-4"
        style={{
          maxWidth: 1180,
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "16px 20px 8px", borderBottom: "1px solid var(--border)" }}>
          <div className="text-base font-semibold text-slate-900">
            {t("invite.modalTitle")}
          </div>
          <p className="text-xs text-slate-500 mt-1">{t("invite.modalSubtitlePasteV3")}</p>
        </div>

        {/* Body: 2 cột — paste trái cố định, bảng phải scroll riêng để scale theo
            số lượng email (vài chục → vài trăm vẫn nhìn được paste area). */}
        <div
          style={{
            display: "flex",
            flex: 1,
            minHeight: 0,
          }}
        >
          {/* LEFT — paste textarea + counters + apply-to-all + invalid */}
          <div
            style={{
              width: 380,
              flexShrink: 0,
              padding: "12px 16px",
              borderRight: "1px solid var(--border)",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <label className="block text-xs font-medium text-slate-700 mb-1">
              {t("invite.pasteLabel")}
            </label>
            <textarea
              value={emailsText}
              onChange={(e) => setEmailsText(e.target.value)}
              placeholder={"user1@domain.com\nuser2@domain.com, user3@domain.com\n..."}
              disabled={bulkInvite.isPending}
              spellCheck={false}
              autoFocus
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-slate-900 disabled:opacity-60"
              style={{ resize: "vertical", minHeight: 220, flex: 1 }}
            />
            <div
              style={{
                marginTop: 6,
                fontSize: 11,
                color: "var(--ink-3)",
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <span style={{ color: "var(--success, #059669)" }}>
                ✓ {t("invite.parsed", { n: entries.length })}
              </span>
              {invalid.length > 0 && (
                <span style={{ color: "var(--danger, #dc2626)" }}>
                  ⚠ {t("invite.invalidFormat", { n: invalid.length })}
                </span>
              )}
              {duplicates.length > 0 && (
                <span style={{ color: "var(--warning, #d97706)" }}>
                  ⚠ {t("invite.duplicateSkipped", { n: duplicates.length })}
                </span>
              )}
            </div>

            {entries.length > 0 && (
              <div
                style={{
                  marginTop: 10,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 8px",
                  background: "var(--bg, #f8fafc)",
                  borderRadius: 4,
                  fontSize: 11,
                  color: "var(--ink-3)",
                  flexWrap: "wrap",
                }}
              >
                <span>{t("invite.applyToAll")}:</span>
                {QUICK_MONTHS.map((m) => (
                  <button
                    key={m}
                    onClick={() => applyMonthsToAll(m)}
                    disabled={bulkInvite.isPending}
                    className="px-2 py-0.5 rounded text-xs border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {m}
                    {t("invite.monthsShort")}
                  </button>
                ))}
              </div>
            )}

            {invalid.length > 0 && (
              <details style={{ marginTop: 10, fontSize: 11 }}>
                <summary
                  style={{
                    cursor: "pointer",
                    color: "var(--danger, #dc2626)",
                  }}
                >
                  {t("invite.invalidShowList")}
                </summary>
                <ul
                  style={{
                    marginTop: 4,
                    paddingLeft: 16,
                    fontFamily: "var(--font-mono)",
                    color: "var(--danger, #dc2626)",
                  }}
                >
                  {invalid.slice(0, 20).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                  {invalid.length > 20 && <li>... +{invalid.length - 20}</li>}
                </ul>
              </details>
            )}

            <div
              style={{
                marginTop: "auto",
                paddingTop: 10,
                fontSize: 11,
                color: "var(--ink-3)",
                lineHeight: 1.5,
              }}
            >
              {t("invite.roleFixedHint")} · {t("invite.autoRemoveHint")}
            </div>
          </div>

          {/* RIGHT — parsed entries table, scroll riêng */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {entries.length === 0 ? (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 24,
                  fontSize: 12,
                  color: "var(--ink-3)",
                  textAlign: "center",
                }}
              >
                {t("invite.pasteHint")}
              </div>
            ) : (
              <>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 200px 130px 28px",
                    columnGap: 8,
                    fontSize: 11,
                    color: "var(--ink-3)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    fontWeight: 500,
                    padding: "10px 20px 8px",
                    borderBottom: "1px solid var(--border)",
                    background: "var(--bg, #f8fafc)",
                  }}
                >
                  <div>{t("invite.colEmail")}</div>
                  <div>{t("invite.colMonths")}</div>
                  <div>{t("invite.colExpires")}</div>
                  <div></div>
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: "0 20px" }}>
                  {entries.map((row) => (
                    <div
                      key={row.email}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 200px 130px 28px",
                        columnGap: 8,
                        alignItems: "center",
                        padding: "6px 0",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <div
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 12,
                          color: "var(--ink, #0f172a)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={row.emailRaw}
                      >
                        {row.emailRaw}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <button
                          onClick={() => setMonthsFor(row.email, row.months - 1)}
                          disabled={bulkInvite.isPending || row.months <= MIN_MONTHS}
                          className="px-2 py-1 rounded text-sm border border-slate-300 disabled:opacity-40"
                          title={t("invite.monthsDecrement")}
                        >
                          −
                        </button>
                        <input
                          type="number"
                          value={row.months}
                          onChange={(e) => setMonthsFor(row.email, Number(e.target.value))}
                          min={MIN_MONTHS}
                          max={MAX_MONTHS}
                          disabled={bulkInvite.isPending}
                          className="border rounded px-2 py-1 text-sm font-mono focus:outline-none disabled:opacity-50"
                          style={{
                            width: 56,
                            textAlign: "center",
                            borderColor: "var(--border)",
                          }}
                        />
                        <button
                          onClick={() => setMonthsFor(row.email, row.months + 1)}
                          disabled={bulkInvite.isPending || row.months >= MAX_MONTHS}
                          className="px-2 py-1 rounded text-sm border border-slate-300 disabled:opacity-40"
                          title={t("invite.monthsIncrement")}
                        >
                          +
                        </button>
                        <span style={{ fontSize: 10, color: "var(--ink-3)" }}>
                          {t("invite.monthsUnit")}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--ink-2)",
                          fontFamily: "var(--font-mono)",
                        }}
                        title={t("invite.expiresTooltip", {
                          months: row.months,
                          days: row.months * DAYS_PER_MONTH,
                        })}
                      >
                        {formatExpiresDate(row.months)}
                      </div>
                      <button
                        onClick={() => removeEntry(row.email)}
                        disabled={bulkInvite.isPending}
                        className="text-slate-400 hover:text-rose-600 disabled:opacity-40"
                        title={t("invite.removeRow")}
                        style={{
                          fontSize: 16,
                          lineHeight: 1,
                          background: "none",
                          border: "none",
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {entries.length > 0
              ? t("invite.parsed", { n: entries.length })
              : t("invite.pasteHint")}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onClose}
              disabled={bulkInvite.isPending}
              className="px-3 py-1.5 rounded text-sm border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={handleSubmit}
              disabled={bulkInvite.isPending || entries.length === 0}
              className="px-3 py-1.5 rounded text-sm bg-slate-900 text-white hover:bg-black disabled:opacity-60"
            >
              {bulkInvite.isPending
                ? t("invite.submitBusyShort")
                : t("invite.submit", { n: entries.length })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
