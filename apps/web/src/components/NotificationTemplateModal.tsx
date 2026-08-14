import { useEffect, useMemo, useRef, useState } from "react";
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
 *   - `member` — áp cho tin về ĐÚNG một email, gửi tới đúng người mà email đó nhắm:
 *                khách được chỉ định, hoặc chính đại lý khi email chưa chỉ định ai.
 * Cụ thể hơn thì thắng: email > người nhận > tất cả — giống hệt lúc gửi thật
 * (`renewal_reminder.TemplateStore.pick`). Digest của nhóm admin hệ thống nằm ngoài
 * mọi mẫu tự soạn.
 *
 * Chỉ một nút mở ra màn hình này (trang Thông báo): tách thành nhiều nút rải rác thì
 * người dùng không bao giờ biết mẫu nào đang thắng mẫu nào.
 *
 * Bố cục: 3 bước đánh số (chọn nơi áp dụng → soạn → xem trước) trong khung modal dùng
 * chung của app (`.tg-modal`), nút Lưu nằm ở chân dính. Bảng "ai nhận tin nào" là thứ
 * chỉ đọc MỘT LẦN nên gấp lại được — mở sẵn bốn đoạn văn ngay đầu modal thì phần soạn
 * thảo (việc người ta vào đây để làm) bị đẩy khuất khỏi màn hình.
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
  sample_real: TemplateSample | null;
};

/**
 * Ai nhận tin nào — bảng này phải khớp `renewal_reminder._recipients_for`.
 *
 * Luật dễ hiểu nhầm nhất: email ĐÃ chỉ định người nhận thì đại lý KHÔNG nhận tin của
 * email đó nữa (nhánh `elif` bên server), nên phải nói thẳng ra chứ không để người
 * dùng tự đoán qua bản xem trước.
 */
const AUDIENCES = ["assignee", "owner", "subscriber", "admin"] as const;

/** Nhãn bước: số tròn + tiêu đề, thêm badge bên phải khi cần đếm mẫu riêng. */
function Step({
  n,
  title,
  badge,
}: {
  n: number;
  title: string;
  badge?: string;
}) {
  return (
    <div className="ntpl-step">
      <span className="ntpl-step-n">{n}</span>
      <span className="ntpl-step-t">{title}</span>
      {badge && <span className="ntpl-badge">{badge}</span>}
    </div>
  );
}

export function NotificationTemplateModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [scope, setScope] = useState<Scope>("all");
  const [chatId, setChatId] = useState<number | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [line, setLine] = useState("");
  const [touched, setTouched] = useState(false);
  const [tab, setTab] = useState<"real" | "sample">("real");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lineRef = useRef<HTMLTextAreaElement>(null);

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

  // Bản thứ hai bằng EMAIL THẬT: dữ liệu giả cho biết mẫu trông thế nào, dữ liệu thật
  // cho biết mẫu ấy áp lên đúng những gì mình đang có.
  const previewReal = useMemo(() => {
    if (!data?.sample_real) return "";
    return buildPreview(
      body.trim() || data.base_body,
      line.trim() || data.base_item_line,
      data.sample_real,
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

  // Badge trên thẻ phạm vi: nói thẳng "đã có mẫu riêng" / "3 mẫu riêng" thay vì dấu
  // "•" và "· 3" — ký hiệu không tự giải thích được nó đếm cái gì.
  const scopeBadge = (s: Scope) => {
    const n = customCount(s);
    if (n === 0) return undefined;
    return s === "all" ? t("telegram.tplHasCustom") : t("telegram.tplCustomN", { n });
  };

  /** Chèn `{biến}` vào đúng chỗ con trỏ — chép tay tên biến là nguồn lỗi chính tả. */
  const insertVar = (
    ref: React.RefObject<HTMLTextAreaElement>,
    setValue: (next: string) => void,
    name: string,
  ) => {
    const el = ref.current;
    if (!el) return;
    const token = `{${name}}`;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    setTouched(true);
    setValue(el.value.slice(0, start) + token + el.value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const vars = (
    ref: React.RefObject<HTMLTextAreaElement>,
    setValue: (next: string) => void,
    names: string[],
  ) => (
    <div className="ntpl-vars">
      <span className="ntpl-vars-label">{t("telegram.tplVarsHint")}</span>
      {names.map((p) => (
        <button
          key={p}
          type="button"
          className="ntpl-chip"
          onClick={() => insertVar(ref, setValue, p)}
        >
          {`{${p}}`}
        </button>
      ))}
    </div>
  );

  // Chỉ còn một bản xem trước hiện cùng lúc: hai bản chồng nhau đẩy nút Lưu xuống rất
  // sâu và người đọc không biết bản nào mới là tin thật của mình.
  const showReal = previewReal ? tab === "real" : false;

  return (
    <div className="tg-modal-backdrop" onClick={onClose}>
      <div
        className="tg-modal ntpl-modal"
        style={{ maxWidth: 620 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tg-modal-head">
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <h3 className="tg-h" style={{ flex: 1 }}>
              {t("telegram.tplTitle")}
            </h3>
            <button className="ntpl-x" onClick={onClose} aria-label={t("common.close")}>
              ×
            </button>
          </div>
          <p className="tg-sub">{t("telegram.tplSubtitle")}</p>
        </div>

        <div className="tg-modal-body">
          {/* ---------- 1. Nơi áp dụng ---------- */}
          <div className="tg-field">
            <Step n={1} title={t("telegram.tplScopeLabel")} />
            <div className="ntpl-opts">
              {scopes.map((s) => {
                const active = scope === s.key;
                const badge = scopeBadge(s.key);
                return (
                  <button
                    key={s.key}
                    type="button"
                    className={active ? "tg-opt on" : "tg-opt"}
                    aria-pressed={active}
                    onClick={() => setScope(s.key)}
                  >
                    <span className="tg-radio" aria-hidden="true" />
                    <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
                      <span className="tg-opt-title">
                        {s.label}
                        {badge && <span className="ntpl-badge">{badge}</span>}
                      </span>
                      <span className="tg-opt-sub">{s.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>

            {scope === "chat" && (
              <select
                className="form-input"
                style={{ marginTop: 4 }}
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
                style={{ marginTop: 4 }}
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
          </div>

          {/* Bảng "ai nhận tin nào": gấp lại, nhưng khi đang sửa một đích cụ thể thì
              nói ngay trên nhãn tin này tới tay ai. */}
          <details className="ntpl-who">
            <summary>
              <span className="ntpl-who-icon" aria-hidden="true">
                ?
              </span>
              <span style={{ flex: 1 }}>{t("telegram.tplWho")}</span>
              {audience && (
                <span className="ntpl-who-now">
                  {t("telegram.tplWhoNow", { who: t(`telegram.tplWho_${audience}`) })}
                </span>
              )}
            </summary>
            <div className="ntpl-who-list">
              {AUDIENCES.map((a) => (
                <div key={a} className={audience === a ? "ntpl-who-row on" : "ntpl-who-row"}>
                  <div className="ntpl-who-name">
                    {t(`telegram.tplWho_${a}`)}
                    {audience === a && (
                      <span className="ntpl-badge on">{t("telegram.tplWhoEditing")}</span>
                    )}
                  </div>
                  <div>{t(`telegram.tplWhoDesc_${a}`)}</div>
                </div>
              ))}
            </div>
          </details>

          {!ready ? (
            <div className="ntpl-empty">
              {scope === "chat" ? t("telegram.tplPickRecipient") : t("telegram.tplPickMember")}
            </div>
          ) : (
            <>
              {/* ---------- 2. Soạn nội dung ---------- */}
              <div className="tg-field">
                <Step n={2} title={t("telegram.tplCompose")} />

                <label className="form-label" style={{ margin: "2px 0 0" }}>
                  {t("telegram.tplBody")}
                </label>
                <textarea
                  ref={bodyRef}
                  className="form-input ntpl-ta"
                  rows={7}
                  value={body}
                  onChange={(e) => {
                    setTouched(true);
                    setBody(e.target.value);
                  }}
                />
                {vars(bodyRef, setBody, data?.body_placeholders ?? [])}

                <label className="form-label" style={{ margin: "6px 0 0" }}>
                  {t("telegram.tplLine")}
                </label>
                <textarea
                  ref={lineRef}
                  className="form-input ntpl-ta"
                  rows={2}
                  style={{ minHeight: 56 }}
                  value={line}
                  onChange={(e) => {
                    setTouched(true);
                    setLine(e.target.value);
                  }}
                />
                {vars(lineRef, setLine, data?.item_placeholders ?? [])}
              </div>

              {/* ---------- 3. Xem trước ---------- */}
              <div className="tg-field">
                <Step n={3} title={t("telegram.tplPreviewHead")} />
                <div className="ntpl-tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={showReal}
                    className={showReal ? "ntpl-tab on" : "ntpl-tab"}
                    disabled={!previewReal}
                    title={previewReal ? undefined : t("telegram.tplPreviewRealEmpty")}
                    onClick={() => setTab("real")}
                  >
                    {t("telegram.tplPreviewTabReal")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={!showReal}
                    className={!showReal ? "ntpl-tab on" : "ntpl-tab"}
                    onClick={() => setTab("sample")}
                  >
                    {t("telegram.tplPreviewTabSample")}
                  </button>
                </div>
                <div className="ntpl-note">
                  {showReal
                    ? t("telegram.tplPreviewRealHint", { n: data?.sample_real?.count ?? 0 })
                    : previewReal
                      ? t("telegram.tplPreviewSampleHint")
                      : t("telegram.tplPreviewRealEmpty")}
                </div>
                {(showReal ? previewReal : preview) && (
                  <TelegramPreview
                    html={showReal ? previewReal : preview}
                    invalidNote={t("telegram.tplPreviewInvalid")}
                  />
                )}
              </div>
            </>
          )}
        </div>

        {ready && (
          <div className="tg-modal-foot">
            {/* Xoá mẫu của RIÊNG phạm vi đang mở — phạm vi khác không bị đụng tới. */}
            <button
              className="btn btn-ghost btn-sm"
              disabled={save.isPending || !(data?.body || data?.item_line)}
              onClick={() => {
                setBody(data?.base_body ?? "");
                setLine(data?.base_item_line ?? "");
                save.mutate({ body: null, item_line: null });
              }}
            >
              {scope === "all" ? t("telegram.tplReset") : t("telegram.tplScopeClear")}
            </button>
            <button className="btn btn-ghost" style={{ marginLeft: "auto" }} onClick={onClose}>
              {t("common.close")}
            </button>
            <button
              className="btn btn-primary"
              disabled={save.isPending}
              onClick={() => save.mutate({ body: body.trim(), item_line: line.trim() })}
            >
              {save.isPending ? t("common.loading") : t("common.save")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
