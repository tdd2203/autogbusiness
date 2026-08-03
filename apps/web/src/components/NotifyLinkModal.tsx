import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n";
import { toast } from "./Toast";
import type { Member } from "../types";

/**
 * Modal "Thông báo" của MỘT email — mở từ menu hành động trên dòng email (có ngay sau
 * khi mời thành công).
 *
 * Việc cần làm chỉ có một: lấy link gửi cho khách. Khách bấm link + Start là nhận nhắc
 * gia hạn cho đúng email đó — không phải gõ `/email <địa chỉ>` nên không gõ sai, và
 * link không lộ email nào khác.
 *
 * Nếu email đã có người nhận, modal hiện trạng thái đó + nút gỡ để đổi người.
 *
 * Soạn nội dung tin KHÔNG nằm ở đây: mẫu có ba phạm vi (chung / theo người nhận / theo
 * email) nên gom hết vào một cửa duy nhất ở trang Thông báo — xem
 * `NotificationTemplateModal`. Để một nút soạn mẫu trong modal của từng email thì
 * không ai đoán được mẫu nào đang thắng mẫu nào.
 */
export function NotifyLinkModal({
  member,
  onClose,
}: {
  member: Member;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [link, setLink] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api<{ deep_link: string }>("/api/v1/telegram/notify-link", {
        method: "POST",
        body: JSON.stringify({ member_id: member.id }),
      }),
    onSuccess: (res) => setLink(res.deep_link),
    onError: (e) => {
      const detail = e instanceof ApiError ? e.detail : null;
      toast.error(
        detail && typeof detail === "object" && "message" in detail
          ? String((detail as { message: unknown }).message)
          : String(detail ?? t("telegram.linkError")),
      );
    },
  });

  const clearTarget = useMutation({
    mutationFn: () =>
      api(
        `/api/v1/workspaces/${member.workspace_id}/members/${member.id}/notify-target`,
        { method: "PATCH", body: JSON.stringify({ target: null }) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["added-members"] });
      qc.invalidateQueries({ queryKey: ["members"] });
      toast.success(t("telegram.notifyLinkCleared"));
    },
  });

  // Mở modal là tạo link luôn: người dùng vào đây chỉ để lấy link, không cần bấm thêm.
  useEffect(() => {
    create.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member.id]);

  const hasRecipient = !!member.notify_telegram_target;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      style={{ padding: 24 }}
      onClick={onClose}
    >
      <div
        style={{
          width: "min(520px, 100%)",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="display-h3" style={{ margin: 0 }}>
            {t("telegram.notifyLinkTitle")}
          </h3>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              color: "var(--ink-2)",
              marginTop: 4,
            }}
          >
            {member.email}
          </div>
        </div>

        {hasRecipient && (
          <div className="notice" style={{ margin: 0 }}>
            <div className="notice-body">
              {member.notify_telegram_chat_id
                ? t("telegram.notifyLinkHasRecipient", {
                    who: member.notify_telegram_target ?? "",
                  })
                : t("telegram.notifyLinkPending", {
                    who: member.notify_telegram_target ?? "",
                  })}
              <div style={{ marginTop: 8 }}>
                <button
                  className="btn btn-sm btn-danger"
                  disabled={clearTarget.isPending}
                  onClick={() => clearTarget.mutate()}
                >
                  {t("telegram.notifyLinkClear")}
                </button>
              </div>
            </div>
          </div>
        )}

        <p style={{ fontSize: 13, color: "var(--ink-3)", margin: 0 }}>
          {t("telegram.notifyLinkDesc")}
        </p>

        {create.isPending && (
          <div className="cell-muted" style={{ fontSize: 13 }}>
            {t("telegram.connecting")}
          </div>
        )}

        {link && (
          <>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                wordBreak: "break-all",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: 10,
              }}
            >
              {link}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  navigator.clipboard?.writeText(link);
                  toast.success(t("telegram.subLinkCopied"));
                }}
              >
                {t("telegram.subCopyLink")}
              </button>
              <a
                className="btn btn-sm"
                href={link}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("telegram.openTelegram")}
              </a>
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
              {t("telegram.notifyLinkHint")}
            </div>
          </>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn btn-ghost" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
