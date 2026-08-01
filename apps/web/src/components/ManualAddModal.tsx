/**
 * Modal "Thêm thủ công" — bản ghi quản lý cho email ĐÃ ở trên ChatGPT (auto-create).
 *
 * Khác InviteMemberModal:
 *   - KHÔNG mời qua extension, KHÔNG trừ ví (miễn phí) → không có khối phí / QR.
 *   - CHẶN CỨNG email không thuộc `verifiedDomain` (auto-create chỉ chạy cho miền đã
 *     xác minh) — email ngoài miền bị liệt kê + không cho submit.
 *   - Chỉ super-admin mở được (nút ở WorkspaceLayout gate theo is_super_admin).
 *
 * UX: paste email (1/dòng hoặc cách nhau comma) → mỗi email hợp lệ + thuộc miền hiện 1
 * row với "Số tháng" (mặc định 1) + preview hạn. Submit → POST /members/manual-add.
 */
import { useMemo, useState } from "react";
import { useFormatDate, useT } from "../i18n";
import { useIsMobile } from "../hooks/useIsMobile";
import { useManualAdd } from "../hooks/useManualAdd";
import { parseEmailsFromText } from "../lib/emailParser";

const DEFAULT_MONTHS = 1;
const MIN_MONTHS = 1;
const MAX_MONTHS = 60;
const QUICK_MONTHS = [1, 3, 6, 12] as const;
const DAYS_PER_MONTH = 30;

function clampMonths(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MONTHS;
  return Math.max(MIN_MONTHS, Math.min(MAX_MONTHS, Math.floor(n)));
}

export function ManualAddModal({
  workspaceId,
  verifiedDomain,
  onClose,
  onDone,
}: {
  workspaceId: string;
  verifiedDomain: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const isMobile = useIsMobile();
  const rowCols = isMobile ? "minmax(0,1fr) 112px 66px 22px" : "1fr 200px 130px 28px";
  const domain = (verifiedDomain ?? "").trim().toLowerCase();
  const suffix = "@" + domain;

  const formatExpiresDate = (months: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + months * DAYS_PER_MONTH);
    return formatDate(d, { day: "numeric", month: "short", year: "numeric" });
  };

  const [emailsText, setEmailsText] = useState("");
  const [monthsByEmail, setMonthsByEmail] = useState<Record<string, number>>({});

  const { validUnique, validRaw, invalid, duplicates } = useMemo(
    () => parseEmailsFromText(emailsText),
    [emailsText],
  );

  // Tách email hợp lệ theo miền: chỉ email thuộc verifiedDomain mới thêm được.
  const inDomain = useMemo(
    () => validUnique.filter((e) => domain && e.toLowerCase().endsWith(suffix)),
    [validUnique, domain, suffix],
  );
  const outOfDomain = useMemo(
    () => validUnique.filter((e) => !domain || !e.toLowerCase().endsWith(suffix)),
    [validUnique, domain, suffix],
  );

  const entries = useMemo(
    () =>
      inDomain.map((email) => ({
        email,
        emailRaw: validRaw[validUnique.indexOf(email)] ?? email,
        months: monthsByEmail[email] ?? DEFAULT_MONTHS,
      })),
    [inDomain, validRaw, validUnique, monthsByEmail],
  );

  const manualAdd = useManualAdd(workspaceId, {
    entries,
    onSuccess: () => {
      onDone();
      onClose();
    },
  });

  const canSubmit =
    !!domain &&
    entries.length > 0 &&
    outOfDomain.length === 0 &&
    !manualAdd.isPending;

  function handleSubmit() {
    if (!canSubmit) return;
    manualAdd.mutate();
  }

  function setMonthsFor(email: string, months: number) {
    setMonthsByEmail((m) => ({ ...m, [email]: clampMonths(months) }));
  }
  function applyMonthsToAll(months: number) {
    setMonthsByEmail((prev) => {
      const next = { ...prev };
      for (const email of inDomain) next[email] = clampMonths(months);
      return next;
    });
  }
  function removeEntry(emailLower: string) {
    setEmailsText((text) => {
      const lines = text.split(/\r?\n/);
      const kept: string[] = [];
      for (const line of lines) {
        const tokens = line.split(/[,;]/).map((s) => s.trim());
        const keptTokens = tokens.filter((tok) => tok.toLowerCase() !== emailLower);
        if (keptTokens.length === tokens.length) kept.push(line);
        else if (keptTokens.length > 0) kept.push(keptTokens.join(", "));
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
      style={{ padding: 24 }}
      role="dialog"
      aria-modal="true"
    >
      <div
        style={{
          width: "min(1040px, 100%)",
          maxHeight: "90vh",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 20,
          boxShadow:
            "0 40px 90px -30px rgba(0,0,0,.45), 0 12px 30px -14px rgba(0,0,0,.3)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "18px 22px",
            display: "flex",
            alignItems: "flex-start",
            gap: 14,
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ink)" }}>
              {t("manualAdd.title")}
            </div>
            <div
              style={{
                fontSize: 12.5,
                color: "var(--ink-3)",
                marginTop: 4,
                lineHeight: 1.5,
              }}
            >
              {domain
                ? t("manualAdd.subtitle", { domain })
                : t("manualAdd.noVerifiedDomain")}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={manualAdd.isPending}
            aria-label={t("common.cancel")}
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--ink-3)",
              fontSize: 14,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div
          style={{
            display: "flex",
            flexDirection: isMobile ? "column" : "row",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          {/* LEFT — paste + counters */}
          <div
            style={{
              width: isMobile ? "100%" : 360,
              flexShrink: 0,
              minHeight: 0,
              padding: "20px 20px",
              background: "var(--bg)",
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              borderBottom: isMobile ? "1px solid var(--border)" : "none",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <label
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                color: "var(--ink-3)",
                marginBottom: 8,
              }}
            >
              {t("invite.pasteLabelShort")}
            </label>
            <textarea
              value={emailsText}
              onChange={(e) => setEmailsText(e.target.value)}
              placeholder={
                domain
                  ? `user1@${domain}\nuser2@${domain}, user3@${domain}\n...`
                  : "user1@domain.com\n..."
              }
              disabled={manualAdd.isPending || !domain}
              spellCheck={false}
              autoFocus
              className="form-input"
              style={{
                resize: "vertical",
                minHeight: 220,
                flex: 1,
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                lineHeight: 1.6,
              }}
            />
            <div
              style={{
                marginTop: 10,
                fontSize: 11.5,
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <span
                style={{
                  color: entries.length > 0 ? "var(--success)" : "var(--ink-3)",
                  fontWeight: 600,
                }}
              >
                ✓ {t("invite.parsed", { n: entries.length })}
              </span>
              {invalid.length > 0 && (
                <span style={{ color: "var(--danger)" }}>
                  ⚠ {t("invite.invalidFormat", { n: invalid.length })}
                </span>
              )}
              {duplicates.length > 0 && (
                <span style={{ color: "var(--warning)" }}>
                  ⚠ {t("invite.duplicateSkipped", { n: duplicates.length })}
                </span>
              )}
            </div>

            {entries.length > 0 && (
              <div
                style={{
                  marginTop: 12,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "8px 10px",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  fontSize: 11.5,
                  color: "var(--ink-3)",
                  flexWrap: "wrap",
                }}
              >
                <span>{t("invite.applyToAll")}:</span>
                {QUICK_MONTHS.map((m) => (
                  <button
                    key={m}
                    onClick={() => applyMonthsToAll(m)}
                    disabled={manualAdd.isPending}
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11.5,
                      padding: "2px 9px",
                      borderRadius: 7,
                      border: "1px solid var(--border)",
                      background: "var(--bg)",
                      color: "var(--ink-2)",
                      cursor: "pointer",
                    }}
                  >
                    {m}
                    {t("invite.monthsShort")}
                  </button>
                ))}
              </div>
            )}

            {/* Ghi chú: chỉ ghi nhận, không mời, không trừ ví, chu kỳ chưa thanh toán. */}
            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                fontSize: 11.5,
                color: "var(--ink-3)",
                lineHeight: 1.5,
              }}
            >
              {t("manualAdd.note")}
            </div>

            {/* Email ngoài miền → chặn cứng (không cho submit). */}
            {outOfDomain.length > 0 && (
              <div
                style={{
                  marginTop: 12,
                  padding: "10px 12px",
                  background: "var(--surface)",
                  border: "1px solid var(--danger-border, var(--border))",
                  borderRadius: 10,
                  fontSize: 11.5,
                  color: "var(--danger)",
                }}
              >
                <div style={{ fontWeight: 600 }}>
                  {t("manualAdd.outOfDomainWarn", {
                    n: outOfDomain.length,
                    domain: domain || "—",
                  })}
                </div>
                <ul
                  style={{
                    marginTop: 6,
                    paddingLeft: 16,
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {outOfDomain.slice(0, 10).map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                  {outOfDomain.length > 10 && <li>... +{outOfDomain.length - 10}</li>}
                </ul>
              </div>
            )}

            {invalid.length > 0 && (
              <details style={{ marginTop: 12, fontSize: 11.5 }}>
                <summary style={{ cursor: "pointer", color: "var(--danger)" }}>
                  {t("invite.invalidShowList")}
                </summary>
                <ul
                  style={{
                    marginTop: 6,
                    paddingLeft: 16,
                    fontFamily: "var(--font-mono)",
                    color: "var(--danger)",
                  }}
                >
                  {invalid.slice(0, 20).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                  {invalid.length > 20 && <li>... +{invalid.length - 20}</li>}
                </ul>
              </details>
            )}
          </div>

          {/* RIGHT — parsed entries table */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
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
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 40,
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ink-2)" }}>
                  {t("invite.emptyTitle")}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--ink-3)",
                    marginTop: 6,
                    maxWidth: 300,
                    lineHeight: 1.5,
                  }}
                >
                  {t("manualAdd.emptyDesc")}
                </div>
              </div>
            ) : (
              <>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: rowCols,
                    columnGap: 8,
                    fontFamily: "var(--font-mono)",
                    fontSize: 10.5,
                    color: "var(--ink-3)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    padding: "12px 22px 10px",
                    borderBottom: "1px solid var(--border)",
                    background: "var(--bg)",
                  }}
                >
                  <div>{t("invite.colEmail")}</div>
                  <div>{t("invite.colMonths")}</div>
                  <div>{t("invite.colExpires")}</div>
                  <div></div>
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: "0 22px" }}>
                  {entries.map((row) => (
                    <div
                      key={row.email}
                      style={{
                        display: "grid",
                        gridTemplateColumns: rowCols,
                        columnGap: 8,
                        alignItems: "center",
                        padding: "8px 0",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          minWidth: 0,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: 12.5,
                            color: "var(--ink)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            flex: "0 1 auto",
                          }}
                          title={row.emailRaw}
                        >
                          {row.emailRaw}
                        </span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <button
                          onClick={() => setMonthsFor(row.email, row.months - 1)}
                          disabled={manualAdd.isPending || row.months <= MIN_MONTHS}
                          title={t("invite.monthsDecrement")}
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: 7,
                            border: "1px solid var(--border)",
                            background: "var(--surface)",
                            color: "var(--ink-2)",
                            cursor: "pointer",
                            fontSize: 14,
                            lineHeight: 1,
                          }}
                        >
                          −
                        </button>
                        <input
                          type="number"
                          value={row.months}
                          onChange={(e) => setMonthsFor(row.email, Number(e.target.value))}
                          min={MIN_MONTHS}
                          max={MAX_MONTHS}
                          disabled={manualAdd.isPending}
                          className="form-input"
                          style={{
                            width: isMobile ? 44 : 56,
                            textAlign: "center",
                            fontFamily: "var(--font-mono)",
                            padding: "4px 6px",
                          }}
                        />
                        <button
                          onClick={() => setMonthsFor(row.email, row.months + 1)}
                          disabled={manualAdd.isPending || row.months >= MAX_MONTHS}
                          title={t("invite.monthsIncrement")}
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: 7,
                            border: "1px solid var(--border)",
                            background: "var(--surface)",
                            color: "var(--ink-2)",
                            cursor: "pointer",
                            fontSize: 14,
                            lineHeight: 1,
                          }}
                        >
                          +
                        </button>
                        {!isMobile && (
                          <span style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                            {t("invite.monthsUnit")}
                          </span>
                        )}
                      </div>
                      <div
                        style={{
                          fontSize: 11.5,
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
                        disabled={manualAdd.isPending}
                        title={t("invite.removeRow")}
                        style={{
                          fontSize: 16,
                          lineHeight: 1,
                          background: "none",
                          border: "none",
                          color: "var(--ink-3)",
                          cursor: "pointer",
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

        {/* Footer */}
        <div
          style={{
            padding: "14px 22px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexShrink: 0,
            gap: 12,
          }}
        >
          <div style={{ fontSize: 12.5, color: "var(--ink-3)", minWidth: 0 }}>
            {entries.length > 0
              ? t("invite.parsed", { n: entries.length })
              : t("manualAdd.pasteHint")}
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button
              onClick={onClose}
              disabled={manualAdd.isPending}
              className="btn btn-ghost btn-sm"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="btn btn-primary btn-sm"
            >
              {manualAdd.isPending
                ? t("manualAdd.submitBusy")
                : t("manualAdd.submit", { n: entries.length })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
