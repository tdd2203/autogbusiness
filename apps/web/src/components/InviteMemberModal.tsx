/**
 * Modal mời nhiều thành viên — 1 email/dòng. Role luôn là "member"
 * (theo policy: dashboard không mời thẳng owner/admin để giảm rủi ro
 * leo thang quyền; muốn nâng quyền thì làm sau qua change-role).
 *
 * Flow:
 *   1. User paste/gõ emails (mỗi dòng 1)
 *   2. Click submit → parse + dedupe + validate format
 *   3. POST /members/bulk-invite với role="member"
 */

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useT } from "../i18n";
import { api, ApiError } from "../lib/api";
import { toast } from "./Toast";

const INVITE_ROLE = "member" as const;

const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;

function parseEmails(raw: string): { valid: string[]; invalid: string[] } {
  const lines = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    if (EMAIL_RE.test(line)) valid.push(line);
    else invalid.push(line);
  }
  return { valid, invalid };
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
  const [emailsText, setEmailsText] = useState("");
  const { valid, invalid } = parseEmails(emailsText);

  // ESC = đóng (chỉ khi không submitting)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !bulkInvite.isPending) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  const bulkInvite = useMutation({
    mutationFn: () =>
      api<{ queue_item_id: string; count: number }>(
        `/api/v1/workspaces/${workspaceId}/members/bulk-invite`,
        {
          method: "POST",
          body: JSON.stringify({ emails: valid, role: INVITE_ROLE }),
        },
      ),
    onSuccess: (resp) => {
      toast.success(
        t("invite.resultQueued", {
          n: resp.count,
        }),
      );
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
    if (valid.length === 0) return;
    bulkInvite.mutate();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={() => !bulkInvite.isPending && onClose()}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: "85vh", overflowY: "auto" }}
      >
        <div className="text-base font-semibold mb-2 text-slate-900">
          {t("invite.modalTitle")}
        </div>
        <p className="text-xs text-slate-500 mb-3">
          {t("invite.modalSubtitle")}
        </p>

        <label className="block text-xs font-medium text-slate-700 mb-1">
          {t("invite.emailsLabel")}
        </label>
        <textarea
          value={emailsText}
          onChange={(e) => setEmailsText(e.target.value)}
          rows={8}
          placeholder={"user1@domain.com\nuser2@domain.com\n..."}
          disabled={bulkInvite.isPending}
          className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-slate-900 disabled:opacity-60"
          autoFocus
          spellCheck={false}
        />

        <div className="mt-2 flex items-center justify-between text-xs">
          <span className="text-emerald-700">
            {t("invite.parsed", { n: valid.length })}
          </span>
          {invalid.length > 0 && (
            <span className="text-rose-600">
              {t("invite.invalidFormat", { n: invalid.length })}
            </span>
          )}
        </div>

        {invalid.length > 0 && (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-rose-600">
              {t("invite.invalidShowList")}
            </summary>
            <ul className="mt-1 list-disc list-inside text-rose-700 font-mono">
              {invalid.slice(0, 20).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
              {invalid.length > 20 && <li>... +{invalid.length - 20}</li>}
            </ul>
          </details>
        )}

        <div className="mt-3 text-xs text-slate-500">
          {t("invite.roleFixedHint")}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={bulkInvite.isPending}
            className="px-3 py-1.5 rounded text-sm border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={handleSubmit}
            disabled={bulkInvite.isPending || valid.length === 0}
            className="px-3 py-1.5 rounded text-sm bg-slate-900 text-white hover:bg-black disabled:opacity-60"
          >
            {bulkInvite.isPending
              ? t("invite.submitBusyShort")
              : t("invite.submit", { n: valid.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
