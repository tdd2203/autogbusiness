/**
 * Modal CẬP NHẬT hàng loạt — paste-driven, song song với cách chọn checkbox trong bảng.
 *
 * UX:
 *   1. Admin chọn HÀNH ĐỘNG: Xoá khỏi workspace | Đổi giấy phép → ChatGPT/Codex.
 *   2. Paste danh sách email vào textarea (1/dòng hoặc cách nhau comma/;).
 *   3. Mỗi email hợp lệ hiện 1 row trong danh sách bên dưới (có nút × bỏ từng dòng).
 *   4. Submit → POST /members/bulk-remove HOẶC /members/bulk-change-license-type.
 *
 * Backend enqueue 1 task / member; email không khớp member nào (đã rời / sai
 * chính tả) trả về trong `skipped` → toast cảnh báo.
 *
 * Quyền: "Xoá" cần MEMBER_REMOVE; "Đổi giấy phép" cần super-admin. Chỉ hiện
 * những hành động user có quyền.
 */

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useT } from "../i18n";
import { useAuth } from "../hooks/useAuth";
import { useIsMobile } from "../hooks/useIsMobile";
import { api, ApiError } from "../lib/api";
import { toast } from "./Toast";

type BulkAction = "remove" | "license:ChatGPT" | "license:Codex";

const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;

function parseEmails(raw: string): {
  validUnique: string[];
  validRaw: string[];
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

export function BulkRemoveModal({
  workspaceId,
  onClose,
  onDone,
}: {
  workspaceId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const isMobile = useIsMobile();
  const { hasPermission, user } = useAuth();
  const canRemove = hasPermission("MEMBER_REMOVE");
  const canChangeLicense = user?.is_super_admin === true;

  const [emailsText, setEmailsText] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  // Hành động mặc định: ưu tiên "xoá" nếu có quyền, else đổi giấy phép.
  const [action, setAction] = useState<BulkAction>(
    canRemove ? "remove" : "license:ChatGPT",
  );
  const isRemove = action === "remove";

  const { validUnique, validRaw, invalid, duplicates } = useMemo(
    () => parseEmails(emailsText),
    [emailsText],
  );

  const bulkRemove = useMutation({
    mutationFn: () => {
      if (isRemove) {
        return api<{ count: number; emails: string[]; skipped: string[] }>(
          `/api/v1/workspaces/${workspaceId}/members/bulk-remove`,
          {
            method: "POST",
            body: JSON.stringify({ emails: validUnique }),
          },
        );
      }
      const newLicenseType = action.slice("license:".length);
      return api<{
        count: number;
        emails: string[];
        already?: string[];
        skipped: string[];
      }>(`/api/v1/workspaces/${workspaceId}/members/bulk-change-license-type`, {
        method: "POST",
        body: JSON.stringify({
          emails: validUnique,
          new_license_type: newLicenseType,
        }),
      });
    },
    onSuccess: (resp) => {
      toast.success(
        isRemove
          ? t("bulkRemove.resultQueued", { n: resp.count })
          : t("bulkLicense.resultQueued", { n: resp.count }),
      );
      if (resp.skipped.length > 0) {
        toast.error(
          t("bulkRemove.resultSkipped", {
            n: resp.skipped.length,
            list: resp.skipped.slice(0, 10).join(", "),
          }),
        );
      }
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
      toast.error(t("bulkRemove.resultError", { error: msg }));
    },
  });

  function removeEntry(emailLower: string) {
    setEmailsText((text) => {
      const lines = text.split(/\r?\n/);
      const kept: string[] = [];
      for (const line of lines) {
        const tokens = line.split(/[,;]/).map((s) => s.trim());
        const keptTokens = tokens.filter(
          (tok) => tok.toLowerCase() !== emailLower,
        );
        if (keptTokens.length === tokens.length) kept.push(line);
        else if (keptTokens.length > 0) kept.push(keptTokens.join(", "));
      }
      return kept.join("\n");
    });
  }

  const canSubmit = validUnique.length > 0 && confirmed && !bulkRemove.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full mx-4"
        style={{
          maxWidth: 820,
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "16px 20px 8px", borderBottom: "1px solid var(--border)" }}>
          <div className="text-base font-semibold text-slate-900">
            {t("bulkUpdate.modalTitle")}
          </div>
          <p className="text-xs text-slate-500 mt-1">{t("bulkUpdate.modalSubtitle")}</p>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: isMobile ? "column" : "row",
            flex: 1,
            minHeight: 0,
          }}
        >
          {/* LEFT — paste textarea + counters */}
          <div
            style={{
              width: isMobile ? "100%" : 360,
              flexShrink: 0,
              padding: "12px 16px",
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              borderBottom: isMobile ? "1px solid var(--border)" : "none",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <label className="block text-xs font-medium text-slate-700 mb-1">
              {t("bulkUpdate.actionLabel")}
            </label>
            <select
              value={action}
              onChange={(e) => {
                setAction(e.target.value as BulkAction);
                setConfirmed(false);
              }}
              disabled={bulkRemove.isPending}
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm mb-3 focus:outline-none focus:border-slate-900 disabled:opacity-60"
            >
              {canRemove && (
                <option value="remove">{t("bulkUpdate.actionRemove")}</option>
              )}
              {canChangeLicense && (
                <option value="license:ChatGPT">
                  {t("bulkUpdate.actionLicenseChatGPT")}
                </option>
              )}
              {canChangeLicense && (
                <option value="license:Codex">
                  {t("bulkUpdate.actionLicenseCodex")}
                </option>
              )}
            </select>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              {t("bulkRemove.pasteLabel")}
            </label>
            <textarea
              value={emailsText}
              onChange={(e) => setEmailsText(e.target.value)}
              placeholder={"user1@domain.com\nuser2@domain.com, user3@domain.com\n..."}
              disabled={bulkRemove.isPending}
              spellCheck={false}
              autoFocus
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-slate-900 disabled:opacity-60"
              style={{ resize: "vertical", minHeight: 240, flex: 1 }}
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
                ✓ {t("bulkRemove.parsed", { n: validUnique.length })}
              </span>
              {invalid.length > 0 && (
                <span style={{ color: "var(--danger, #dc2626)" }}>
                  ⚠ {t("bulkRemove.invalidFormat", { n: invalid.length })}
                </span>
              )}
              {duplicates.length > 0 && (
                <span style={{ color: "var(--warning, #d97706)" }}>
                  ⚠ {t("bulkRemove.duplicateSkipped", { n: duplicates.length })}
                </span>
              )}
            </div>
          </div>

          {/* RIGHT — parsed list */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {validUnique.length === 0 ? (
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
                {t("bulkRemove.pasteHint")}
              </div>
            ) : (
              <div style={{ flex: 1, overflowY: "auto", padding: "8px 20px" }}>
                {validRaw.map((emailRaw, idx) => (
                  <div
                    key={validUnique[idx]}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "6px 0",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        color: "var(--ink, #0f172a)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={emailRaw}
                    >
                      {emailRaw}
                    </span>
                    <button
                      onClick={() => removeEntry(validUnique[idx])}
                      disabled={bulkRemove.isPending}
                      className="text-slate-400 hover:text-rose-600 disabled:opacity-40"
                      title={t("bulkRemove.removeRow")}
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
            gap: 12,
          }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              color: isRemove ? "var(--danger, #dc2626)" : "var(--ink-2, #475569)",
              cursor: validUnique.length > 0 ? "pointer" : "default",
            }}
          >
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={validUnique.length === 0 || bulkRemove.isPending}
            />
            {isRemove
              ? t("bulkRemove.confirmCheckbox", { n: validUnique.length })
              : t("bulkUpdate.confirmLicense", {
                  n: validUnique.length,
                  license: action.slice("license:".length),
                })}
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onClose}
              disabled={bulkRemove.isPending}
              className="px-3 py-1.5 rounded text-sm border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={() => bulkRemove.mutate()}
              disabled={!canSubmit}
              className={
                isRemove
                  ? "px-3 py-1.5 rounded text-sm bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-60"
                  : "px-3 py-1.5 rounded text-sm bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-60"
              }
            >
              {bulkRemove.isPending
                ? t("bulkRemove.submitBusy")
                : isRemove
                  ? t("bulkRemove.submit", { n: validUnique.length })
                  : t("bulkUpdate.submitLicense", {
                      n: validUnique.length,
                      license: action.slice("license:".length),
                    })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
