import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n";
import { toast } from "./Toast";
import { buildPreview, TelegramPreview, type TemplateSample } from "./TelegramPreview";
import type { AddedMember } from "../types";

/**
 * Soạn NỘI DUNG thông báo — một cửa duy nhất cho cả ba phạm vi.
 *
 * Cùng một đại lý cần nói khác nhau tuỳ nơi, nên mẫu có phạm vi:
 *   - `all`    — mẫu chung, áp khi không có mẫu nào cụ thể hơn.
 *   - `chat`   — áp cho mọi tin gửi tới MỘT người nhận Telegram (nhân viên trực…).
 *   - `member` — áp cho tin về ĐÚNG một email (khách lẻ của email đó).
 * Cụ thể hơn thì thắng: email > người nhận > tất cả — giống hệt lúc gửi thật
 * (`renewal_reminder.TemplateStore.pick`).
 *
 * Chỉ một nút mở ra màn hình này (trang Thông báo): tách thành nhiều nút rải rác thì
 * người dùng không bao giờ biết mẫu nào đang thắng mẫu nào.
 */

type Scope = "all" | "chat" | "member";

type Recipient = { chat_id: number; label: string; kind: string };

type Override = {
  scope: Scope;
  chat_id: number | null;
  member_id: string | null;
  label: string | null;
  updated_at: string;
};

type TemplateOut = {
  scope: Scope;
  chat_id: number | null;
  member_id: string | null;
  body: string | null;
  item_line: string | null;
  default_body: string;
  default_item_line: string;
  base_body: string;
  base_item_line: string;
  body_placeholders: string[];
  item_placeholders: string[];
  preview: string;
  sample: TemplateSample;
  overrides: Override[];
  recipients: Recipient[];
  audience: string;
};

/**
 * Ai nhận tin nào — bảng này phải khớp `renewal_reminder._recipients_for`.
 *
 * Luật dễ hiểu nhầm nhất: email ĐÃ chỉ định người nhận thì đại lý KHÔNG nhận tin của
 * email đó nữa (nhánh `elif` bên server), nên phải nói thẳng ra chứ không để người
 * dùng tự đoán qua bản xem trước.
 */
const AUDIENCES = ["assignee", "owner", "subscriber", "admin"] as const;

export function NotificationTemplateModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [scope, setScope] = useState<Scope>("all");
  const [chatId, setChatId] = useState<number | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [line, setLine] = useState("");
  const [touched, setTouched] = useState(false);

  // Email của tôi — dùng chung queryKey với trang "Email đã add" nên thường có sẵn cache.
  const { data: members = [] } = useQuery({
    queryKey: ["added-members", "self"],
    queryFn: () => api<AddedMember[]>("/api/v1/added-members"),
  });

  // Chưa chọn đích thì vẫn hỏi mẫu chung: cần `recipients`/`overrides` để vẽ ô chọn.
  const ready = scope === "all" || (scope === "chat" ? chatId !== null : memberId !== null);
  const params =
    scope === "chat" && chatId !== null
      ? `?scope=chat&chat_id=${chatId}`
      : scope === "member" && memberId
        ? `?scope=member&member_id=${memberId}`
        : "?scope=all";

  const { data } = useQuery({
    queryKey: ["telegram-template", ready ? scope : "all", chatId, memberId],
    queryFn: () => api<TemplateOut>(`/api/v1/telegram/template${params}`),
  });

  // Đổi phạm vi = nạp lại nội dung của phạm vi đó, kể cả khi đang gõ dở: giữ lại chữ
  // của phạm vi trước rồi lưu nhầm sang phạm vi mới là hỏng đúng thứ người ta không
  // định sửa.
  useEffect(() => {
    setTouched(false);
  }, [scope, chatId, memberId]);

  useEffect(() => {
    if (!data || touched) return;
    // Chưa có mẫu riêng ⇒ khởi điểm là mẫu đang có hiệu lực (mẫu chung, không thì mẫu gốc).
    setBody(data.body ?? data.base_body);
    setLine(data.item_line ?? data.base_item_line);
  }, [data, touched]);

  const preview = useMemo(() => {
    if (!data) return "";
    // Ô để trống = xoá mẫu riêng ⇒ xem trước phải là mẫu sẽ dùng thay nó.
    return buildPreview(
      body.trim() || data.base_body,
      line.trim() || data.base_item_line,
      data.sample,
    );
  }, [body, line, data]);

  const save = useMutation({
    mutationFn: (vars: { body: string | null; item_line: string | null }) =>
      api<TemplateOut>("/api/v1/telegram/template", {
        method: "PUT",
        body: JSON.stringify({
          scope,
          chat_id: scope === "chat" ? chatId : null,
          member_id: scope === "member" ? memberId : null,
          ...vars,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["telegram-template"] });
      setTouched(false);
      toast.success(t("telegram.tplSaved"));
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? String(e.detail) : t("telegram.tplError")),
  });

  // Chỉ đánh dấu "đang sửa tin của ai" khi phạm vi trỏ tới MỘT đích cụ thể. Mẫu chung
  // áp cho cả ba loại người nhận nên chỉ tay vào một loại là nói sai.
  const audience = ready && scope !== "all" ? data?.audience : undefined;
  const overrides = data?.overrides ?? [];
  const hasOverride = (s: Scope, id: number | string | null) =>
    overrides.some((o) =>
      o.scope !== s
        ? false
        : s === "all"
          ? true
          : s === "chat"
            ? o.chat_id === id
            : o.member_id === id,
    );
  const customCount = (s: Scope) => overrides.filter((o) => o.scope === s).length;

  const scopes: { key: Scope; label: string; hint: string }[] = [
    { key: "all", label: t("telegram.tplScopeAll"), hint: t("telegram.tplScopeAllHint") },
    { key: "chat", label: t("telegram.tplScopeChat"), hint: t("telegram.tplScopeChatHint") },
    { key: "member", label: t("telegram.tplScopeMember"), hint: t("telegram.tplScopeMemberHint") },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      style={{ padding: 24 }}
      onClick={onClose}
    >
      <div
        style={{
          width: "min(560px, 100%)",
          maxHeight: "calc(100vh - 48px)",
          overflowY: "auto",
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
            {t("telegram.tplTitle")}
          </h3>
        </div>

        <div
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "10px 12px",
            fontSize: 12.5,
            lineHeight: 1.45,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{t("telegram.tplWho")}</div>
          {AUDIENCES.map((a) => (
            <div key={a} style={{ marginTop: 4, color: "var(--ink-2)" }}>
              <b style={{ color: audience === a ? "var(--ink)" : "var(--ink-2)" }}>
                {t(`telegram.tplWho_${a}`)}
                {audience === a && ` ← ${t("telegram.tplWhoEditing")}`}
              </b>{" "}
              — {t(`telegram.tplWhoDesc_${a}`)}
            </div>
          ))}
        </div>

        <label className="form-label" style={{ marginBottom: -4 }}>
          {t("telegram.tplScopeLabel")}
        </label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {scopes.map((s) => {
            const active = scope === s.key;
            const n = customCount(s.key);
            return (
              <button
                key={s.key}
                className={active ? "btn btn-sm btn-primary" : "btn btn-sm"}
                title={s.hint}
                onClick={() => setScope(s.key)}
              >
                {s.label}
                {n > 0 && (
                  <span style={{ opacity: 0.7, marginLeft: 6 }}>
                    {s.key === "all" ? "•" : `· ${n}`}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: -4 }}>
          {scopes.find((s) => s.key === scope)?.hint}
        </div>

        {scope === "chat" && (
          <select
            className="form-input"
            value={chatId ?? ""}
            onChange={(e) => setChatId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">{t("telegram.tplPickRecipient")}</option>
            {(data?.recipients ?? []).map((r) => (
              <option key={r.chat_id} value={r.chat_id}>
                {r.label} — {t(`telegram.tplWho_${r.kind}`)}
                {hasOverride("chat", r.chat_id) ? " ✎" : ""}
              </option>
            ))}
          </select>
        )}

        {scope === "member" && (
          <select
            className="form-input"
            value={memberId ?? ""}
            onChange={(e) => setMemberId(e.target.value || null)}
          >
            <option value="">{t("telegram.tplPickMember")}</option>
            {members
              .filter((m) => m.status === "active" || m.status === "pending")
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.email}
                  {hasOverride("member", m.id) ? " ✎" : ""}
                </option>
              ))}
          </select>
        )}

        {!ready ? (
          <div className="cell-muted" style={{ fontSize: 13 }}>
            {scope === "chat" ? t("telegram.tplPickRecipient") : t("telegram.tplPickMember")}
          </div>
        ) : (
          <>
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

            {preview && (
              <>
                <label className="form-label">{t("telegram.tplPreview")}</label>
                <TelegramPreview html={preview} invalidNote={t("telegram.tplPreviewInvalid")} />
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
              {/* Xoá mẫu của RIÊNG phạm vi đang mở — phạm vi khác không bị đụng tới. */}
              <button
                className="btn btn-sm"
                disabled={save.isPending || !(data?.body || data?.item_line)}
                onClick={() => {
                  setBody(data?.base_body ?? "");
                  setLine(data?.base_item_line ?? "");
                  save.mutate({ body: null, item_line: null });
                }}
              >
                {scope === "all" ? t("telegram.tplReset") : t("telegram.tplScopeClear")}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={onClose}>
                {t("common.close")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
