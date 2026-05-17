import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n";
import type { WorkspaceWithKey } from "../types";

export default function WorkspaceExtension() {
  const t = useT();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const regen = useMutation({
    mutationFn: () =>
      api<WorkspaceWithKey>(
        `/api/v1/workspaces/${workspaceId}/regenerate-key`,
        { method: "POST" },
      ),
    onSuccess: (ws) => {
      setRevealedKey(ws.extension_api_key);
      setCopied(false);
    },
  });

  const reveal = useMutation({
    mutationFn: () =>
      api<WorkspaceWithKey>(
        `/api/v1/workspaces/${workspaceId}/reveal-key`,
        { method: "POST" },
      ),
    onSuccess: (ws) => {
      setRevealedKey(ws.extension_api_key);
      setCopied(false);
    },
  });

  function onCopy() {
    if (!revealedKey) return;
    navigator.clipboard.writeText(revealedKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-medium mb-4">{t("extension.title")}</h2>

      <div className="bg-white rounded shadow p-5 space-y-4">
        <div className="text-sm text-slate-700 space-y-2">
          <p>{t("extension.description")}</p>
        </div>

        {revealedKey && (
          <div className="bg-amber-50 border border-amber-300 rounded p-4">
            <div className="font-semibold text-amber-900 mb-1">
              {t("extension.keyBannerTitle")}
            </div>
            <p className="text-sm text-amber-800 mb-3">
              {t("extension.keyBannerWarning")}
            </p>
            <div className="flex gap-2 items-center">
              <code className="flex-1 bg-white border rounded px-3 py-2 text-xs font-mono break-all">
                {revealedKey}
              </code>
              <button
                onClick={onCopy}
                className="bg-slate-900 text-white px-3 py-2 rounded text-sm whitespace-nowrap"
              >
                {copied ? t("common.copied") : t("common.copy")}
              </button>
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={() => reveal.mutate()}
            disabled={reveal.isPending}
            className="bg-slate-900 text-white px-4 py-2 rounded text-sm disabled:opacity-60"
          >
            {reveal.isPending
              ? t("extension.revealBusy")
              : t("extension.revealButton")}
          </button>
          <button
            onClick={() => {
              if (window.confirm(t("extension.regenConfirm"))) {
                regen.mutate();
              }
            }}
            disabled={regen.isPending}
            className="bg-rose-600 text-white px-4 py-2 rounded text-sm disabled:opacity-60"
          >
            {regen.isPending
              ? t("extension.regenBusy")
              : t("extension.regenButton")}
          </button>
        </div>
        <p className="text-xs text-slate-500 mt-2">{t("extension.helpText")}</p>
      </div>
    </div>
  );
}
