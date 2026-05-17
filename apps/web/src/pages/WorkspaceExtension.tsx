import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n";
import type { WorkspaceWithKey } from "../types";
import { confirm } from "../components/Toast";

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
    <div style={{ maxWidth: 720 }}>
      <div className="settings-section">
        <h3 className="display-h3">{t("extension.title")}</h3>
        <p
          style={{
            fontSize: 13,
            color: "var(--ink-3)",
            marginTop: 4,
            marginBottom: 20,
          }}
        >
          {t("extension.description")}
        </p>

        {revealedKey && (
          <div className="notice warn" style={{ marginBottom: 16, alignItems: "flex-start" }}>
            <div className="notice-icon">!</div>
            <div style={{ flex: 1 }}>
              <div className="notice-title">{t("extension.keyBannerTitle")}</div>
              <div className="notice-body" style={{ marginBottom: 8 }}>
                {t("extension.keyBannerWarning")}
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
                  {revealedKey}
                </code>
                <button
                  onClick={onCopy}
                  className="btn btn-primary btn-sm"
                  style={{ whiteSpace: "nowrap" }}
                >
                  {copied ? t("common.copied") : t("common.copy")}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
          <button
            onClick={() => reveal.mutate()}
            disabled={reveal.isPending}
            className="btn btn-primary"
          >
            {reveal.isPending
              ? t("extension.revealBusy")
              : t("extension.revealButton")}
          </button>
          <button
            onClick={async () => {
              const ok = await confirm(t("extension.regenConfirm"), {
                okText: t("extension.regenButton"),
                cancelText: t("common.cancel"),
                danger: true,
              });
              if (ok) regen.mutate();
            }}
            disabled={regen.isPending}
            className="btn btn-danger"
          >
            {regen.isPending
              ? t("extension.regenBusy")
              : t("extension.regenButton")}
          </button>
        </div>
        <p
          style={{
            fontSize: 11.5,
            color: "var(--ink-3)",
            marginTop: 12,
          }}
        >
          {t("extension.helpText")}
        </p>
      </div>
    </div>
  );
}
