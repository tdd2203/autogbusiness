import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useFormatDateTime, useT } from "../i18n";
import { useAuth } from "../hooks/useAuth";
import { confirm, toast } from "./Toast";
import type { AddedMember } from "../types";

/**
 * Tab "Telegram" trong Cài đặt (feature 004) — hai phần:
 *
 *  1. KẾT NỐI CỦA CHÍNH BẠN (mọi tài khoản): bấm "Kết nối Telegram" → server tạo
 *     deep-link dùng-một-lần `t.me/<bot>?start=<token>` → user bấm Start trong
 *     Telegram → webhook gán chat_id vào tài khoản. Phải đi đường này vì Bot API
 *     KHÔNG cho tra @username → chat_id và bot không được nhắn trước người lạ.
 *  2. TRẠNG THÁI HỆ THỐNG (chỉ super-admin): webhook đã đăng ký chưa, nhóm nào nhận
 *     bản tổng hợp, số tin đã gửi/lỗi 7 ngày, nút chạy job ngay để kiểm tra cấu hình.
 */

type TelegramStatus = {
  bot_configured: boolean;
  bot_username: string | null;
  linked: boolean;
  telegram_username: string | null;
  telegram_chat_id: number | null;
  linked_at: string | null;
  notify_enabled: boolean;
  reminder_days: number[];
  reminder_hour: number;
};

type AdminStatus = {
  bot_configured: boolean;
  /** Cấu hình đang hiệu lực đến từ đâu: .env (khoá cứng) | DB (nhập ở đây) | chưa có. */
  config_source: "env" | "db" | "none";
  bot_username: string | null;
  webhook_url: string | null;
  webhook_has_error: boolean;
  webhook_last_error: string | null;
  pending_updates: number;
  admin_chat_ids: number[];
  linked_users: number;
  contacts: number;
  sent_last_7d: number;
  failed_last_7d: number;
};

type LinkOut = { deep_link: string; token: string; expires_at: string };

/** 1 tài khoản Telegram đang nhận thông báo CỦA TÔI (mời qua link chia sẻ). */
type Subscription = {
  id: string;
  chat_id: number;
  display_name: string | null;
  scope: "all" | "selected";
  member_ids: string[];
  enabled: boolean;
  created_at: string;
};

export function TelegramSettings() {
  const t = useT();
  const qc = useQueryClient();
  const formatDateTime = useFormatDateTime();
  const { user } = useAuth();
  const isSuper = user?.is_super_admin === true;
  const [deepLink, setDeepLink] = useState<string | null>(null);

  const { data: status } = useQuery({
    queryKey: ["telegram-status"],
    queryFn: () => api<TelegramStatus>("/api/v1/telegram/status"),
  });

  const link = useMutation({
    mutationFn: () => api<LinkOut>("/api/v1/telegram/link", { method: "POST" }),
    onSuccess: (res) => {
      setDeepLink(res.deep_link);
      // Mở luôn Telegram: user chỉ còn 1 thao tác là bấm Start.
      window.open(res.deep_link, "_blank", "noopener");
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? String(e.detail) : t("telegram.linkError")),
  });

  const unlink = useMutation({
    mutationFn: () => api<void>("/api/v1/telegram/link", { method: "DELETE" }),
    onSuccess: () => {
      setDeepLink(null);
      qc.invalidateQueries({ queryKey: ["telegram-status"] });
      toast.success(t("telegram.unlinked"));
    },
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api<TelegramStatus>("/api/v1/telegram/preferences", {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["telegram-status"] }),
  });

  const test = useMutation({
    mutationFn: () => api<{ sent: boolean }>("/api/v1/telegram/test", { method: "POST" }),
    onSuccess: () => toast.success(t("telegram.testSent")),
    onError: (e) => {
      const detail = e instanceof ApiError ? e.detail : null;
      const message =
        detail && typeof detail === "object" && "message" in detail
          ? String((detail as { message: unknown }).message)
          : t("telegram.testError");
      toast.error(message);
    },
  });

  const scheduleText = status
    ? t("telegram.scheduleValue", {
        days: status.reminder_days.map((d) => `≤${d}d`).join(", "),
        hour: String(status.reminder_hour).padStart(2, "0"),
      })
    : "—";

  return (
    <div className="settings-section">
      <h3 className="display-h3">{t("telegram.title")}</h3>
      <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 4, marginBottom: 20 }}>
        {t("telegram.desc")}
      </p>

      {status && !status.bot_configured && (
        <div className="notice warn" style={{ marginBottom: 20 }}>
          <div className="notice-body">{t("telegram.notConfigured")}</div>
        </div>
      )}

      <div className="info-row">
        <div className="key">{t("telegram.account")}</div>
        <div className="val">
          {status?.linked ? (
            <>
              <span className="badge badge-success">{t("telegram.statusLinked")}</span>{" "}
              {status.telegram_username ? `@${status.telegram_username}` : `ID ${status.telegram_chat_id}`}
            </>
          ) : (
            <span className="badge badge-neutral">{t("telegram.statusUnlinked")}</span>
          )}
        </div>
      </div>

      {status?.linked && status.linked_at && (
        <div className="info-row">
          <div className="key">{t("telegram.linkedAt")}</div>
          <div className="val">{formatDateTime(status.linked_at)}</div>
        </div>
      )}

      <div className="info-row">
        <div className="key">{t("telegram.schedule")}</div>
        <div className="val">{scheduleText}</div>
      </div>

      {status?.linked && (
        <div className="info-row">
          <div className="key">{t("telegram.notifyEnabled")}</div>
          <div className="val">
            <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={status.notify_enabled}
                disabled={toggle.isPending}
                onChange={(e) => toggle.mutate(e.target.checked)}
              />
              {status.notify_enabled ? t("telegram.notifyOn") : t("telegram.notifyOff")}
            </label>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 20 }}>
        {!status?.linked ? (
          <button
            className="btn btn-primary"
            disabled={!status?.bot_configured || link.isPending}
            onClick={() => link.mutate()}
          >
            {link.isPending ? t("telegram.connecting") : t("telegram.connect")}
          </button>
        ) : (
          <>
            <button
              className="btn"
              disabled={test.isPending}
              onClick={() => test.mutate()}
            >
              {t("telegram.sendTest")}
            </button>
            <button
              className="btn btn-danger"
              disabled={unlink.isPending}
              onClick={async () => {
                if (await confirm(t("telegram.unlinkConfirm"), { danger: true })) {
                  unlink.mutate();
                }
              }}
            >
              {t("telegram.unlink")}
            </button>
          </>
        )}
        <button
          className="btn"
          onClick={() => qc.invalidateQueries({ queryKey: ["telegram-status"] })}
        >
          {t("telegram.refresh")}
        </button>
      </div>

      {deepLink && !status?.linked && (
        <div className="notice" style={{ marginTop: 16 }}>
          <div className="notice-body">
            <a href={deepLink} target="_blank" rel="noopener noreferrer">
              {t("telegram.openTelegram")}
            </a>
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-3)" }}>
              {t("telegram.linkHint")}
            </div>
          </div>
        </div>
      )}

      <SubscriptionsPanel botConfigured={status?.bot_configured === true} />

      {isSuper && <TelegramAdminPanel />}
    </div>
  );
}

/**
 * "Người nhận thông báo" — danh sách phát của CHÍNH tài khoản đang đăng nhập.
 *
 * Chủ tài khoản tạo 1 link chia sẻ, gửi cho ai thì người đó bấm Start là nhận được
 * TOÀN BỘ thông báo của tài khoản này; sau đó chủ tài khoản có thể thu hẹp từng
 * người xuống chỉ vài email. Khác "chỉ định theo email" ở modal chi tiết (dành cho
 * khách cuối của đúng email đó) — hai đường chạy song song.
 */
function SubscriptionsPanel({ botConfigured }: { botConfigured: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [editing, setEditing] = useState<Subscription | null>(null);

  const { data: subs = [] } = useQuery({
    queryKey: ["telegram-subscriptions"],
    queryFn: () => api<Subscription[]>("/api/v1/telegram/subscriptions"),
  });

  const invite = useMutation({
    mutationFn: () =>
      api<LinkOut>("/api/v1/telegram/subscriptions/invite", { method: "POST" }),
    onSuccess: (res) => setInviteLink(res.deep_link),
    onError: (e) =>
      toast.error(e instanceof ApiError ? String(e.detail) : t("telegram.linkError")),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/v1/telegram/subscriptions/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["telegram-subscriptions"] });
      toast.success(t("telegram.subRemoved"));
    },
  });

  const toggle = useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      api<Subscription>(`/api/v1/telegram/subscriptions/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: vars.enabled }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["telegram-subscriptions"] }),
  });

  return (
    <div style={{ marginTop: 32, paddingTop: 24, borderTop: "1px solid var(--line)" }}>
      <h3 className="display-h3">{t("telegram.subTitle")}</h3>
      <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 4, marginBottom: 16 }}>
        {t("telegram.subDesc")}
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <button
          className="btn btn-primary"
          disabled={!botConfigured || invite.isPending}
          onClick={() => invite.mutate()}
        >
          {invite.isPending ? t("telegram.connecting") : t("telegram.subCreateLink")}
        </button>
      </div>

      {inviteLink && (
        <div className="notice" style={{ marginBottom: 16 }}>
          <div className="notice-body">
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, wordBreak: "break-all" }}>
              {inviteLink}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <button
                className="btn btn-sm"
                onClick={() => {
                  navigator.clipboard?.writeText(inviteLink);
                  toast.success(t("telegram.subLinkCopied"));
                }}
              >
                {t("telegram.subCopyLink")}
              </button>
              <a className="btn btn-sm" href={inviteLink} target="_blank" rel="noopener noreferrer">
                {t("telegram.openTelegram")}
              </a>
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-3)" }}>
              {t("telegram.subLinkHint")}
            </div>
          </div>
        </div>
      )}

      {subs.length === 0 ? (
        <div className="cell-muted" style={{ fontSize: 13 }}>
          {t("telegram.subEmpty")}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table data-table-compact">
            <thead>
              <tr>
                <th>{t("telegram.subColRecipient")}</th>
                <th>{t("telegram.subColScope")}</th>
                <th style={{ width: 210 }}></th>
              </tr>
            </thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div style={{ fontWeight: 500, color: "var(--ink)" }}>
                      {s.display_name || `ID ${s.chat_id}`}
                    </div>
                    <div className="cell-muted" style={{ fontSize: 12 }}>
                      {s.enabled ? t("telegram.notifyOn") : t("telegram.notifyOff")}
                    </div>
                  </td>
                  <td>
                    {s.scope === "all"
                      ? t("telegram.subScopeAll")
                      : t("telegram.subScopeSelected", { n: s.member_ids.length })}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button className="btn btn-sm" onClick={() => setEditing(s)}>
                        {t("telegram.subEditScope")}
                      </button>
                      <button
                        className="btn btn-sm"
                        onClick={() => toggle.mutate({ id: s.id, enabled: !s.enabled })}
                      >
                        {s.enabled ? t("telegram.subPause") : t("telegram.subResume")}
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={async () => {
                          if (await confirm(t("telegram.subRemoveConfirm"), { danger: true })) {
                            remove.mutate(s.id);
                          }
                        }}
                      >
                        {t("common.delete")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ScopeModal subscription={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

/** Chọn người nhận này nhận TOÀN BỘ email của tôi hay chỉ vài email cụ thể. */
function ScopeModal({
  subscription,
  onClose,
}: {
  subscription: Subscription;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [scope, setScope] = useState<Subscription["scope"]>(subscription.scope);
  const [ids, setIds] = useState<string[]>(subscription.member_ids);
  const [q, setQ] = useState("");

  // Danh sách email của chính tôi — cùng queryKey với trang "Email đã add" nên
  // thường đã có sẵn trong cache, không phải tải lại.
  const { data: members = [] } = useQuery({
    queryKey: ["added-members", "self"],
    queryFn: () => api<AddedMember[]>("/api/v1/added-members"),
  });

  const save = useMutation({
    mutationFn: () =>
      api<Subscription>(`/api/v1/telegram/subscriptions/${subscription.id}`, {
        method: "PATCH",
        body: JSON.stringify({ scope, member_ids: scope === "selected" ? ids : [] }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["telegram-subscriptions"] });
      toast.success(t("telegram.subSaved"));
      onClose();
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? String(e.detail) : t("telegram.targetError")),
  });

  const filtered = members.filter((m) =>
    q.trim() ? m.email.toLowerCase().includes(q.trim().toLowerCase()) : true,
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      style={{ padding: 24 }}
      onClick={onClose}
    >
      <div
        style={{
          width: "min(560px, 100%)",
          maxHeight: "82vh",
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
        <h3 className="display-h3" style={{ margin: 0 }}>
          {t("telegram.subEditScope")} — {subscription.display_name || subscription.chat_id}
        </h3>

        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
          <input
            type="radio"
            checked={scope === "all"}
            onChange={() => setScope("all")}
          />
          {t("telegram.subScopeAllLabel")}
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
          <input
            type="radio"
            checked={scope === "selected"}
            onChange={() => setScope("selected")}
          />
          {t("telegram.subScopeSelectedLabel")}
        </label>

        {scope === "selected" && (
          <>
            <input
              className="form-input"
              placeholder={t("members.searchPlaceholder")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div
              style={{
                overflowY: "auto",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: 8,
                maxHeight: 280,
              }}
            >
              {filtered.length === 0 ? (
                <div className="cell-muted" style={{ fontSize: 13, padding: 8 }}>
                  {t("telegram.subNoEmails")}
                </div>
              ) : (
                filtered.map((m) => (
                  <label
                    key={m.id}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      padding: "4px 2px",
                      fontSize: 13,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={ids.includes(m.id)}
                      onChange={(e) =>
                        setIds((prev) =>
                          e.target.checked
                            ? [...prev, m.id]
                            : prev.filter((x) => x !== m.id),
                        )
                      }
                    />
                    <span style={{ fontFamily: "var(--font-mono)" }}>{m.email}</span>
                  </label>
                ))
              )}
            </div>
          </>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="btn btn-primary"
            disabled={save.isPending || (scope === "selected" && ids.length === 0)}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t("common.loading") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Bảng trạng thái + công cụ vận hành, chỉ super-admin thấy. */
function TelegramAdminPanel() {
  const t = useT();
  const qc = useQueryClient();
  const [token, setToken] = useState("");
  const [adminChat, setAdminChat] = useState("");

  const { data } = useQuery({
    queryKey: ["telegram-admin-status"],
    queryFn: () => api<AdminStatus>("/api/v1/telegram/admin/status"),
  });

  /** Lỗi backend trả {code, message} hoặc chuỗi — lấy ra câu đọc được. */
  const errText = (e: unknown, fallback: string) => {
    const detail = e instanceof ApiError ? e.detail : null;
    if (detail && typeof detail === "object" && "message" in detail) {
      return String((detail as { message: unknown }).message);
    }
    return detail ? String(detail) : fallback;
  };

  // Token do super-admin dán vào (@BotFather). Backend getMe xác thực rồi mới mã hoá
  // lưu DB — token KHÔNG bao giờ được trả ngược về giao diện.
  const saveToken = useMutation({
    mutationFn: () =>
      api<{ bot_username: string }>("/api/v1/telegram/admin/token", {
        method: "PUT",
        body: JSON.stringify({ bot_token: token.trim() }),
      }),
    onSuccess: (res) => {
      setToken("");
      qc.invalidateQueries({ queryKey: ["telegram-admin-status"] });
      qc.invalidateQueries({ queryKey: ["telegram-status"] });
      toast.success(t("telegram.adminTokenSaved", { bot: res.bot_username ?? "" }));
    },
    onError: (e) => toast.error(errText(e, t("telegram.adminTokenError"))),
  });

  const clearToken = useMutation({
    mutationFn: () => api<void>("/api/v1/telegram/admin/token", { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["telegram-admin-status"] });
      qc.invalidateQueries({ queryKey: ["telegram-status"] });
      toast.success(t("telegram.adminTokenCleared"));
    },
    onError: (e) => toast.error(errText(e, t("telegram.adminTokenError"))),
  });

  const saveAdminChat = useMutation({
    mutationFn: () =>
      api<{ admin_chat_ids: number[] }>("/api/v1/telegram/admin/admin-chat", {
        method: "PUT",
        body: JSON.stringify({ admin_chat_id: adminChat.trim() || null }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["telegram-admin-status"] });
      toast.success(t("telegram.adminChatSaved"));
    },
    onError: (e) => toast.error(errText(e, t("telegram.adminTokenError"))),
  });

  const fromEnv = data?.config_source === "env";

  const setupWebhook = useMutation({
    mutationFn: () =>
      api<{ webhook_url: string }>("/api/v1/telegram/admin/webhook", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["telegram-admin-status"] });
      toast.success(t("telegram.adminWebhookOk"));
    },
    onError: (e) => {
      const detail = e instanceof ApiError ? e.detail : null;
      toast.error(
        detail && typeof detail === "object" && "message" in detail
          ? String((detail as { message: unknown }).message)
          : String(detail ?? "error"),
      );
    },
  });

  const runNow = useMutation({
    mutationFn: () =>
      api<{ claimed: number; sent: number }>("/api/v1/telegram/admin/run-now", {
        method: "POST",
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["telegram-admin-status"] });
      toast.success(
        t("telegram.adminRunDone", { claimed: res.claimed, sent: res.sent }),
      );
    },
    onError: (e) => toast.error(e instanceof ApiError ? String(e.detail) : "error"),
  });

  return (
    <div style={{ marginTop: 32, paddingTop: 24, borderTop: "1px solid var(--line)" }}>
      <h3 className="display-h3">{t("telegram.adminTitle")}</h3>

      {/* Cấu hình bot: nhập token ngay đây thay vì SSH sửa .env rồi restart. */}
      <div style={{ marginTop: 16, marginBottom: 24 }}>
        {fromEnv ? (
          <div className="notice" style={{ marginBottom: 12 }}>
            <div className="notice-body">{t("telegram.adminFromEnv")}</div>
          </div>
        ) : (
          <>
            <label className="form-label">{t("telegram.adminTokenLabel")}</label>
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 8 }}>
              {t("telegram.adminTokenHint")}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                className="form-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="123456789:AAF..."
                style={{ flex: "1 1 260px" }}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <button
                className="btn btn-primary"
                disabled={token.trim().length < 20 || saveToken.isPending}
                onClick={() => saveToken.mutate()}
              >
                {saveToken.isPending ? t("common.loading") : t("common.save")}
              </button>
              {data?.bot_configured && (
                <button
                  className="btn btn-danger"
                  disabled={clearToken.isPending}
                  onClick={async () => {
                    if (await confirm(t("telegram.adminTokenClearConfirm"), { danger: true })) {
                      clearToken.mutate();
                    }
                  }}
                >
                  {t("telegram.adminTokenClear")}
                </button>
              )}
            </div>

            <label className="form-label" style={{ marginTop: 16 }}>
              {t("telegram.adminChatLabel")}
            </label>
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 8 }}>
              {t("telegram.adminChatHint")}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                className="form-input"
                placeholder="-1001234567890"
                style={{ flex: "1 1 260px" }}
                value={adminChat}
                onChange={(e) => setAdminChat(e.target.value)}
              />
              <button
                className="btn"
                disabled={saveAdminChat.isPending}
                onClick={() => saveAdminChat.mutate()}
              >
                {t("common.save")}
              </button>
            </div>
          </>
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="info-row">
          <div className="key">{t("telegram.adminWebhook")}</div>
          <div className="val" style={{ wordBreak: "break-all" }}>
            {data?.webhook_url || t("telegram.adminWebhookNone")}
            {data?.webhook_has_error && (
              <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 4 }}>
                {data.webhook_last_error}
              </div>
            )}
          </div>
        </div>
        <div className="info-row">
          <div className="key">{t("telegram.adminAdminChats")}</div>
          <div className="val">
            {data?.admin_chat_ids.length ? data.admin_chat_ids.join(", ") : "—"}
          </div>
        </div>
        <div className="info-row">
          <div className="key">{t("telegram.adminLinkedUsers")}</div>
          <div className="val">{data?.linked_users ?? "—"}</div>
        </div>
        <div className="info-row">
          <div className="key">{t("telegram.adminContacts")}</div>
          <div className="val">{data?.contacts ?? "—"}</div>
        </div>
        <div className="info-row">
          <div className="key">{t("telegram.adminSent7d")}</div>
          <div className="val">{data?.sent_last_7d ?? "—"}</div>
        </div>
        <div className="info-row">
          <div className="key">{t("telegram.adminFailed7d")}</div>
          <div className="val">{data?.failed_last_7d ?? "—"}</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
        <button
          className="btn"
          disabled={!data?.bot_configured || setupWebhook.isPending}
          onClick={() => setupWebhook.mutate()}
        >
          {t("telegram.adminSetupWebhook")}
        </button>
        <button
          className="btn"
          disabled={!data?.bot_configured || runNow.isPending}
          onClick={() => runNow.mutate()}
        >
          {t("telegram.adminRunNow")}
        </button>
      </div>
    </div>
  );
}
