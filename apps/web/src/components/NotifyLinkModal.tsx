import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

        <TemplateEditor />

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn btn-ghost" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

type TemplateOut = {
  body: string | null;
  item_line: string | null;
  default_body: string;
  default_item_line: string;
  body_placeholders: string[];
  item_placeholders: string[];
  preview: string;
};

/**
 * Soạn NỘI DUNG thông báo riêng của tài khoản — mở ra từ chính nút "Thông báo".
 *
 * Mẫu gốc luôn hiện sẵn trong ô để sửa (không phải gõ từ số 0), và "Khôi phục mẫu gốc"
 * xoá cấu hình riêng để quay về mặc định hệ thống. Mẫu áp cho MỌI tin nhắc về email
 * của tài khoản này, kể cả tin gửi cho khách — nên đại lý xưng tên shop mình được.
 */
function TemplateEditor() {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [line, setLine] = useState("");
  const [touched, setTouched] = useState(false);

  const { data } = useQuery({
    queryKey: ["telegram-template"],
    queryFn: () => api<TemplateOut>("/api/v1/telegram/template"),
  });

  // Nạp giá trị hiện tại (hoặc mẫu gốc) vào ô soạn khi mở lần đầu.
  useEffect(() => {
    if (!data || touched) return;
    setBody(data.body ?? data.default_body);
    setLine(data.item_line ?? data.default_item_line);
  }, [data, touched]);

  const save = useMutation({
    mutationFn: (vars: { body: string | null; item_line: string | null }) =>
      api<TemplateOut>("/api/v1/telegram/template", {
        method: "PUT",
        body: JSON.stringify(vars),
      }),
    onSuccess: (res) => {
      qc.setQueryData(["telegram-template"], res);
      setTouched(false);
      toast.success(t("telegram.tplSaved"));
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? String(e.detail) : t("telegram.tplError")),
  });

  if (!open) {
    return (
      <button
        className="btn btn-sm"
        style={{ alignSelf: "flex-start" }}
        onClick={() => setOpen(true)}
      >
        {t("telegram.tplOpen")}
      </button>
    );
  }

  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        paddingTop: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t("telegram.tplTitle")}</div>
      <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{t("telegram.tplDesc")}</div>

      <label className="form-label">{t("telegram.tplBody")}</label>
      <textarea
        className="form-input"
        rows={7}
        style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
        value={body}
        onChange={(e) => {
          setTouched(true);
          setBody(e.target.value);
        }}
      />
      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
        {t("telegram.tplVars")}:{" "}
        {(data?.body_placeholders ?? []).map((p) => `{${p}}`).join("  ")}
      </div>

      <label className="form-label">{t("telegram.tplLine")}</label>
      <textarea
        className="form-input"
        rows={2}
        style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
        value={line}
        onChange={(e) => {
          setTouched(true);
          setLine(e.target.value);
        }}
      />
      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
        {t("telegram.tplVars")}:{" "}
        {(data?.item_placeholders ?? []).map((p) => `{${p}}`).join("  ")}
      </div>

      {data?.preview && (
        <>
          <label className="form-label">{t("telegram.tplPreview")}</label>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 10,
              fontSize: 12,
              margin: 0,
            }}
          >
            {data.preview}
          </pre>
        </>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          className="btn btn-primary btn-sm"
          disabled={save.isPending}
          onClick={() => save.mutate({ body: body.trim(), item_line: line.trim() })}
        >
          {save.isPending ? t("common.loading") : t("common.save")}
        </button>
        <button
          className="btn btn-sm"
          disabled={save.isPending}
          onClick={() => {
            setBody(data?.default_body ?? "");
            setLine(data?.default_item_line ?? "");
            save.mutate({ body: null, item_line: null });
          }}
        >
          {t("telegram.tplReset")}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
          {t("common.close")}
        </button>
      </div>
    </div>
  );
}
