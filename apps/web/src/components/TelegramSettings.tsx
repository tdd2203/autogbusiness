import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useFormatDateTime, useT } from "../i18n";
import { useAuth } from "../hooks/useAuth";
import { useTelegramConnect } from "../hooks/useTelegramConnect";
import type { TelegramStatus } from "../hooks/useTelegramConnect";
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

/** 1 tài khoản Telegram đang nhận thông báo CỦA TÔI (mời qua link chia sẻ). */
type Subscription = {
  id: string;
  chat_id: number;
  display_name: string | null;
  scope: "all" | "selected";
  member_ids: string[];
  enabled: boolean;
  created_at: string;
  /** Tên link đã đưa người này vào (null khi link đã gỡ/hết hạn). */
  invite_label: string | null;
};

/** 1 link mời còn hiệu lực — phạm vi email GẮN SẴN từ lúc tạo. */
type Invite = {
  token: string;
  deep_link: string;
  expires_at: string;
  created_at: string;
  label: string | null;
  scope: "all" | "selected";
  member_ids: string[];
  /** Số người đã bấm link này. */
  recipients: number;
};

/**
 * `showSystemConfig` — bảng CẤU HÌNH HỆ THỐNG (token bot, nhóm digest, webhook, số
 * liệu gửi) chỉ hiện ở **Cài đặt**, KHÔNG hở ra trang "Thông báo" của người dùng:
 * đó là cấu hình máy chủ dùng chung, không phải thứ đại lý cần thấy khi làm việc
 * hằng ngày (và cũng không nên mời gọi bấm nhầm "Gỡ token" giữa lúc đang chạy).
 */
export function TelegramSettings({
  showSystemConfig = true,
}: {
  showSystemConfig?: boolean;
} = {}) {
  const t = useT();
  const qc = useQueryClient();
  const formatDateTime = useFormatDateTime();
  const { user } = useAuth();
  const isSuper = user?.is_super_admin === true;
  // Trạng thái + luồng bấm Start dùng chung với màn bắt buộc kết nối
  // (`TelegramConnectGate`) — xem hooks/useTelegramConnect.ts.
  const { status, deepLink, setDeepLink, awaiting, setAwaiting, link, refresh } =
    useTelegramConnect();

  const unlink = useMutation({
    mutationFn: () => api<void>("/api/v1/telegram/link", { method: "DELETE" }),
    onSuccess: () => {
      setDeepLink(null);
      setAwaiting(false);
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

  const account = status?.linked
    ? status.telegram_username
      ? `@${status.telegram_username}`
      : `ID ${status.telegram_chat_id}`
    : "—";

  return (
    <div className="tg-stack">
      {/* THẺ 1 — kênh của tôi. Trạng thái nằm ngay cạnh tiêu đề (chip), thông số
          xếp thành lưới, bật/tắt là công tắc: nhìn một cái là biết "xong chưa, đang
          gửi cho ai, gửi lúc nào" mà không phải đọc hết mấy dòng chữ. */}
      <section className="tg-card">
        <div className="tg-head">
          <div className="tg-icon" aria-hidden="true">
            ✈
          </div>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h3 className="tg-h">{t("telegram.title")}</h3>
              {status?.linked ? (
                <span className="badge badge-success">{t("telegram.statusLinked")}</span>
              ) : (
                <span className="badge badge-neutral">{t("telegram.statusUnlinked")}</span>
              )}
            </div>
            <p className="tg-sub">{t("telegram.desc")}</p>
          </div>
        </div>

        {status && !status.bot_configured && (
          <div style={{ padding: "14px 20px 0" }}>
            <div className="notice warn">
              <div className="notice-body">{t("telegram.notConfigured")}</div>
            </div>
          </div>
        )}

        <div className="tg-meta">
          <div className="tg-meta-item">
            <div className="tg-meta-key">{t("telegram.account")}</div>
            <div className="tg-meta-val">{account}</div>
          </div>
          {status?.linked && status.linked_at && (
            <div className="tg-meta-item">
              <div className="tg-meta-key">{t("telegram.linkedAt")}</div>
              <div className="tg-meta-val">{formatDateTime(status.linked_at)}</div>
            </div>
          )}
          <div className="tg-meta-item">
            <div className="tg-meta-key">{t("telegram.schedule")}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {(status?.reminder_days ?? []).map((d) => (
                <span key={d} className="tg-chip">
                  {t("telegram.scheduleDayChip", { d: String(d) })}
                </span>
              ))}
              {status && (
                <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
                  {t("telegram.scheduleHour", {
                    hour: String(status.reminder_hour).padStart(2, "0"),
                  })}
                </span>
              )}
            </div>
          </div>
        </div>

        {status?.linked && (
          <div className="tg-line">
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>{t("telegram.notifyEnabled")}</div>
              <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
                {status.notify_enabled
                  ? `${t("telegram.notifyOn")} · ${account}`
                  : t("telegram.notifyOff")}
              </div>
            </div>
            <button
              type="button"
              className="tg-switch"
              aria-pressed={status.notify_enabled}
              aria-label={t("telegram.notifyEnabled")}
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(!status.notify_enabled)}
            >
              <span />
            </button>
          </div>
        )}

        <div className="tg-foot">
          {!status?.linked ? (
            <button
              className="btn btn-primary"
              disabled={!status?.bot_configured || link.isPending}
              onClick={() => link.mutate()}
            >
              {link.isPending ? t("telegram.connecting") : t("telegram.connect")}
            </button>
          ) : (
            <button
              className="btn btn-ghost"
              disabled={test.isPending}
              onClick={() => test.mutate()}
            >
              {t("telegram.sendTest")}
            </button>
          )}
          <button className="btn btn-ghost" onClick={refresh}>
            {t("telegram.refresh")}
          </button>
          {status?.linked && (
            <button
              className="btn btn-danger"
              style={{ marginLeft: "auto" }}
              disabled={unlink.isPending}
              onClick={async () => {
                if (await confirm(t("telegram.unlinkConfirm"), { danger: true })) {
                  unlink.mutate();
                }
              }}
            >
              {t("telegram.unlink")}
            </button>
          )}
        </div>

        {deepLink && !status?.linked && (
          <div style={{ padding: "0 20px 16px" }}>
            <div className="notice">
              <div className="notice-body">
                <a href={deepLink} target="_blank" rel="noopener noreferrer">
                  {t("telegram.openTelegram")}
                </a>
                <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-3)" }}>
                  {t("telegram.linkHint")}
                </div>
                {awaiting && (
                  <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-2)" }}>
                    ⏳ {t("telegram.connectWaiting")}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      <SubscriptionsPanel botConfigured={status?.bot_configured === true} />

      {isSuper && showSystemConfig && <TelegramAdminPanel />}
    </div>
  );
}

/**
 * "Người nhận thông báo" — danh sách phát của CHÍNH tài khoản đang đăng nhập.
 *
 * Hai bảng, đọc từ trên xuống đúng thứ tự công việc:
 *   1. LINK ĐANG PHÁT — chủ tài khoản tạo link kèm PHẠM VI EMAIL chọn sẵn, gửi cho
 *      ai thì người đó bấm Start là nhận đúng những email đã chọn cho họ. Nhiều link
 *      sống song song (mỗi người một suất), gỡ link nào thì link đó hết bấm được.
 *   2. NGƯỜI NHẬN — ai đã bấm link, đang nhận gì; sửa phạm vi / tạm ngưng / gỡ hẳn.
 *
 * Khác "chỉ định theo email" ở modal chi tiết (dành cho khách cuối của đúng email
 * đó) — hai đường chạy song song.
 */
/**
 * Chép link + báo "Đã sao chép link" bằng toast success (nổi giữa trên màn hình).
 * Trả false khi trình duyệt chặn clipboard (trang http, chưa cấp quyền) để chỗ gọi
 * còn kịp bày link ra cho người dùng chép tay — báo "đã chép" trong khi chưa chép
 * được là mất link.
 */
async function copyLink(text: string, okMsg: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(okMsg);
    return true;
  } catch {
    return false;
  }
}

function SubscriptionsPanel({ botConfigured }: { botConfigured: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const formatDateTime = useFormatDateTime();
  const [creating, setCreating] = useState(false);
  const [freshLink, setFreshLink] = useState<Invite | null>(null);
  // Link vừa tạo mà KHÔNG chép được vào clipboard → phải bày ra để chép tay.
  const [copyFailed, setCopyFailed] = useState<Invite | null>(null);
  const [editing, setEditing] = useState<Subscription | null>(null);

  // Vừa tạo link xong = đang gửi cho ai đó và chờ họ bấm. Hỏi lại đều để tên người
  // nhận tự hiện ra ngay khi họ bấm Start (chủ tài khoản thường ngồi chờ đúng lúc đó).
  // Dừng sau 10 phút: tab bỏ quên không nên gọi API mãi — bấm muộn hơn thì lần mở
  // trang sau vẫn thấy đủ.
  const [watching, setWatching] = useState(false);
  useEffect(() => {
    if (!freshLink) {
      setWatching(false);
      return;
    }
    setWatching(true);
    const id = setTimeout(() => setWatching(false), 10 * 60 * 1000);
    return () => clearTimeout(id);
  }, [freshLink]);
  const poll = watching ? 5000 : (false as const);

  const { data: subs = [] } = useQuery({
    queryKey: ["telegram-subscriptions"],
    queryFn: () => api<Subscription[]>("/api/v1/telegram/subscriptions"),
    refetchInterval: poll,
  });

  const { data: invites = [] } = useQuery({
    queryKey: ["telegram-invites"],
    queryFn: () => api<Invite[]>("/api/v1/telegram/invites"),
    refetchInterval: poll,
  });

  const revoke = useMutation({
    mutationFn: (token: string) =>
      api<void>(`/api/v1/telegram/invites/${token}`, { method: "DELETE" }),
    onSuccess: (_r, token) => {
      if (freshLink?.token === token) setFreshLink(null);
      if (copyFailed?.token === token) setCopyFailed(null);
      qc.invalidateQueries({ queryKey: ["telegram-invites"] });
      toast.success(t("telegram.subLinkRevoked"));
    },
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

  const scopeText = (scope: "all" | "selected", n: number) =>
    scope === "all"
      ? t("telegram.subScopeAll")
      : t("telegram.subScopeSelected", { n });

  return (
    <>
      {/* Hai thẻ đứng cạnh nhau vì đó là hai nửa của MỘT việc: bên trái tạo link,
          bên phải là link vừa tạo ra. Trước đây phải cuộn xuống bảng mới thấy link
          của mình. */}
      <div className="tg-grid">
        <section className="tg-card tg-pad">
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <h3 className="tg-h">{t("telegram.subTitle")}</h3>
            <p className="tg-sub">{t("telegram.subDesc")}</p>
          </div>

          {/* Ba câu, đánh số — thay đoạn văn 5 dòng cũ. Luật "bấm thêm link là CỘNG
              THÊM email" là chỗ dễ hiểu nhầm nhất nên vẫn phải nói, chỉ là nói gọn. */}
          <ol className="tg-steps">
            <li>
              <span className="tg-step-n">1</span>
              <span>{t("telegram.subStep1")}</span>
            </li>
            <li>
              <span className="tg-step-n">2</span>
              <span>{t("telegram.subStep2")}</span>
            </li>
            <li>
              <span className="tg-step-n">3</span>
              <span>{t("telegram.subStep3")}</span>
            </li>
          </ol>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn btn-primary"
              disabled={!botConfigured}
              onClick={() => setCreating(true)}
            >
              {t("telegram.subCreateLink")}
            </button>
          </div>

          {/* Đường bình thường: tạo xong link đã nằm sẵn trong clipboard + toast giữa
              trên màn hình, không bày thêm gì. Khối này CHỈ hiện khi trình duyệt chặn
              clipboard (trang http, chưa cấp quyền) — không có nó thì link vừa tạo coi
              như mất. */}
          {copyFailed && (
            <div className="notice">
              <div className="notice-body">
                <div
                  style={{ fontFamily: "var(--font-mono)", fontSize: 12, wordBreak: "break-all" }}
                >
                  {copyFailed.deep_link}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={async () => {
                      if (await copyLink(copyFailed.deep_link, t("telegram.subLinkCopied"))) {
                        setCopyFailed(null);
                      }
                    }}
                  >
                    {t("telegram.subCopyLink")}
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => setCopyFailed(null)}>
                    {t("common.close")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="tg-card tg-pad">
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h4 className="tg-h-sm">{t("telegram.subLinksTitle")}</h4>
            {invites.length > 0 && (
              <span className="table-meta">
                {t("telegram.subLinkCount", { n: invites.length })}
              </span>
            )}
          </div>
          <div className={invites.length > 4 ? "tg-list tg-list-scroll" : "tg-list"}>
            {invites.length === 0 ? (
              <div className="tg-empty">{t("telegram.subLinksEmpty")}</div>
            ) : (
              invites.map((inv) => (
                <div className="tg-item" key={inv.token}>
                  <div className="tg-item-main">
                    <div className="tg-item-title">
                      <span className="tg-dot" />
                      <span className="tg-item-name">
                        {inv.label || t("telegram.subNoLabel")}
                      </span>
                    </div>
                    <div
                      className="tg-item-sub"
                      title={t("telegram.subLinkMeta", {
                        scope: scopeText(inv.scope, inv.member_ids.length),
                        clicks: inv.recipients,
                        expires: formatDateTime(inv.expires_at),
                      })}
                    >
                      {t("telegram.subLinkMeta", {
                        scope: scopeText(inv.scope, inv.member_ids.length),
                        clicks: inv.recipients,
                        expires: formatDateTime(inv.expires_at),
                      })}
                    </div>
                  </div>
                  <div className="tg-item-acts">
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={async () => {
                        if (!(await copyLink(inv.deep_link, t("telegram.subLinkCopied")))) {
                          setCopyFailed(inv);
                        }
                      }}
                    >
                      {t("telegram.subCopyLink")}
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      disabled={revoke.isPending}
                      onClick={async () => {
                        if (await confirm(t("telegram.subLinkRevokeConfirm"), { danger: true })) {
                          revoke.mutate(inv.token);
                        }
                      }}
                    >
                      {t("telegram.subLinkRevoke")}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* Ai đã bấm link — cùng kiểu thẻ với "Link đang phát" để mắt đọc một lần là
          quen: chấm trạng thái + tên + chip, dòng dưới là phạm vi. */}
      <section className="tg-card tg-pad">
        <h4 className="tg-h-sm">{t("telegram.subPeopleTitle")}</h4>
        <div className={subs.length > 4 ? "tg-list tg-list-scroll" : "tg-list"}>
          {subs.length === 0 ? (
            <div className="tg-empty">{t("telegram.subEmpty")}</div>
          ) : (
            subs.map((s) => (
              <div className="tg-item" key={s.id}>
                <div className="tg-item-main">
                  <div className="tg-item-title">
                    <span className={s.enabled ? "tg-dot" : "tg-dot off"} />
                    <span className="tg-item-name">
                      {s.display_name || `ID ${s.chat_id}`}
                    </span>
                    <span className={s.enabled ? "tg-pill" : "tg-pill off"}>
                      {s.enabled ? t("telegram.notifyOn") : t("telegram.notifyOff")}
                    </span>
                  </div>
                  <div className="tg-item-sub">
                    {scopeText(s.scope, s.member_ids.length)}
                    {s.invite_label
                      ? ` · ${t("telegram.subViaLink", { label: s.invite_label })}`
                      : ""}
                  </div>
                </div>
                <div className="tg-item-acts">
                  <button className="btn btn-sm btn-ghost" onClick={() => setEditing(s)}>
                    {t("telegram.subEditScope")}
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
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
              </div>
            ))
          )}
        </div>
      </section>

      {creating && (
        <InviteModal
          onClose={() => setCreating(false)}
          onCreated={async (inv) => {
            setFreshLink(inv);
            setCreating(false);
            // Bấm OK = "tạo xong đưa link đây": chép luôn rồi đóng, việc kế tiếp
            // của người dùng là dán đi gửi chứ không phải đọc thêm hướng dẫn.
            if (!(await copyLink(inv.deep_link, t("telegram.subLinkCopied")))) {
              setCopyFailed(inv);
            }
          }}
        />
      )}

      {editing && (
        <ScopeModal subscription={editing} onClose={() => setEditing(null)} />
      )}
    </>
  );
}

/**
 * Chọn email cho MỘT người nhận — dùng chung cho "tạo link" và "sửa phạm vi" để hai
 * chỗ không lệch nhau (cùng ô tìm kiếm, cùng cách tick).
 */
function MemberPicker({
  ids,
  onChange,
}: {
  ids: string[];
  onChange: (next: string[]) => void;
}) {
  const t = useT();
  const { user } = useAuth();
  const [q, setQ] = useState("");

  // Danh sách email của chính tôi — cùng queryKey với trang "Email đã add" nên
  // thường đã có sẵn trong cache, không phải tải lại.
  const { data: all = [] } = useQuery({
    queryKey: ["added-members", "self"],
    queryFn: () => api<AddedMember[]>("/api/v1/added-members"),
  });

  // CHỈ email do CHÍNH TÔI add mới gắn được vào link: server chặn email của tài
  // khoản khác (`_owned_member_ids`), và mẻ nhắc cũng chỉ soi danh sách phát của
  // ĐÚNG chủ email. Super-admin xem được mọi email nên endpoint trả về cả email
  // của người khác — bày ra đây thì tick xong chỉ nhận về lỗi "chọn ít nhất 1
  // email của bạn". Lọc ngay tại nguồn để cái gì hiện ra là cái đó dùng được.
  const members = user
    ? all.filter((m) => m.invited_by_username === user.username)
    : all;

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? members.filter((m) => m.email.toLowerCase().includes(needle))
    : members;
  const picked = members.filter((m) => ids.includes(m.id));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <div className="tg-search">
        <span className="tg-search-icon" aria-hidden="true" />
        <input
          placeholder={t("members.searchPlaceholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="tg-picker">
        {filtered.length === 0 ? (
          <div style={{ padding: "12px 13px", fontSize: 13, color: "var(--ink-3)" }}>
            {t("telegram.subNoEmails")}
          </div>
        ) : (
          filtered.map((m) => {
            const on = ids.includes(m.id);
            return (
              // Cả dòng là vùng bấm — ô tick 16px giữa danh sách vài trăm email thì
              // bấm trượt liên tục.
              <button
                type="button"
                key={m.id}
                className={on ? "tg-pick on" : "tg-pick"}
                aria-pressed={on}
                onClick={() =>
                  onChange(on ? ids.filter((x) => x !== m.id) : [...ids, m.id])
                }
              >
                <span className="tg-pick-box" aria-hidden="true">
                  {on ? "✓" : ""}
                </span>
                <span className="tg-pick-email">{m.email}</span>
              </button>
            );
          })
        )}
      </div>
      {/* Tick xong thì nói thẳng ra người đó sẽ nhận thông báo của những email nào —
          không bắt người dùng cuộn ngược lên đếm lại dấu tick trước khi bấm OK. */}
      {picked.length > 0 && (
        <div className="tg-modal-hint" style={{ lineHeight: 1.5 }}>
          {t("telegram.subPickerSummary", { n: picked.length })}{" "}
          <span style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
            {picked.map((m) => m.email).join(", ")}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Tạo link mời + CHỌN SẴN email người bấm link sẽ nhận.
 *
 * Chọn phạm vi NGAY ĐÂY (thay vì phát link "nhận tất cả" rồi vào thu hẹp sau) vì
 * chỉ sửa được sau khi người ta đã bấm — tức là đã kịp thấy toàn bộ email của bạn.
 */
function InviteModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (invite: Invite) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<"all" | "selected">("all");
  const [ids, setIds] = useState<string[]>([]);

  const create = useMutation({
    mutationFn: () =>
      api<Invite>("/api/v1/telegram/subscriptions/invite", {
        method: "POST",
        body: JSON.stringify({
          label: label.trim() || null,
          scope,
          member_ids: scope === "selected" ? ids : [],
        }),
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["telegram-invites"] });
      onCreated(res);
    },
    onError: (e) => {
      const detail = e instanceof ApiError ? e.detail : null;
      toast.error(
        detail && typeof detail === "object" && "message" in detail
          ? String((detail as { message: unknown }).message)
          : String(detail ?? t("telegram.linkError")),
      );
    },
  });

  return (
    <div className="tg-modal-backdrop" onClick={onClose}>
      <div className="tg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tg-modal-head">
          <h3 className="tg-h">{t("telegram.subInviteTitle")}</h3>
          <p className="tg-sub">{t("telegram.subInviteScopeHint")}</p>
        </div>

        <div className="tg-modal-body">
          <label className="tg-field">
            <span className="tg-field-label">{t("telegram.subInviteLabel")}</span>
            <div className="tg-search">
              <input
                maxLength={64}
                placeholder={t("telegram.subInviteLabelPh")}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
          </label>

          <ScopeOptions scope={scope} onScope={setScope} picked={ids.length} />

          {scope === "selected" && <MemberPicker ids={ids} onChange={setIds} />}
        </div>

        <div className="tg-modal-foot">
          <span className="tg-modal-hint">{scopeHint(t, scope, ids.length)}</span>
          <button className="btn btn-ghost" style={{ marginLeft: "auto" }} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="btn btn-primary"
            disabled={create.isPending || (scope === "selected" && ids.length === 0)}
            onClick={() => create.mutate()}
          >
            {create.isPending ? t("telegram.connecting") : t("telegram.subInviteCreate")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Hai lựa chọn phạm vi, dạng thẻ bấm cả mảng — dùng chung cho "tạo link" và "sửa
 * phạm vi" để hai chỗ không lệch nhau.
 */
function ScopeOptions({
  scope,
  onScope,
  picked,
}: {
  scope: "all" | "selected";
  onScope: (next: "all" | "selected") => void;
  picked: number;
}) {
  const t = useT();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button
        type="button"
        className={scope === "all" ? "tg-opt on" : "tg-opt"}
        aria-pressed={scope === "all"}
        onClick={() => onScope("all")}
      >
        <span className="tg-radio" aria-hidden="true" />
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span className="tg-opt-title">{t("telegram.subScopeAllLabel")}</span>
          <span className="tg-opt-sub">{t("telegram.subScopeAllSub")}</span>
        </span>
      </button>
      <button
        type="button"
        className={scope === "selected" ? "tg-opt on" : "tg-opt"}
        aria-pressed={scope === "selected"}
        onClick={() => onScope("selected")}
      >
        <span className="tg-radio" aria-hidden="true" />
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span className="tg-opt-title">{t("telegram.subScopeSelectedLabel")}</span>
          <span className="tg-opt-sub">
            {picked > 0
              ? t("telegram.subScopePicked", { n: picked })
              : t("telegram.subScopeSelectedSub")}
          </span>
        </span>
      </button>
    </div>
  );
}

/** Câu tóm tắt ở chân modal: bấm nút bây giờ thì kết quả ra sao. */
function scopeHint(
  t: (key: string, vars?: Record<string, string | number>) => string,
  scope: "all" | "selected",
  picked: number,
): string {
  if (scope === "all") return t("telegram.subModalHintAll");
  return picked > 0
    ? t("telegram.subModalHintPicked", { n: picked })
    : t("telegram.subModalHintEmpty");
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

  return (
    <div className="tg-modal-backdrop" onClick={onClose}>
      <div className="tg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tg-modal-head">
          <h3 className="tg-h">{t("telegram.subEditScope")}</h3>
          <p className="tg-sub">{subscription.display_name || `ID ${subscription.chat_id}`}</p>
        </div>

        <div className="tg-modal-body">
          <ScopeOptions scope={scope} onScope={setScope} picked={ids.length} />
          {scope === "selected" && <MemberPicker ids={ids} onChange={setIds} />}
        </div>

        <div className="tg-modal-foot">
          <span className="tg-modal-hint">{scopeHint(t, scope, ids.length)}</span>
          <button className="btn btn-ghost" style={{ marginLeft: "auto" }} onClick={onClose}>
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
  // Token đã lưu trong DB ⇒ ẩn ô nhập, chỉ hiện bot đang chạy. Muốn đổi bot phải
  // bấm "Gỡ token" trước: token không bao giờ đọc lại được nên một cú dán đè nhầm
  // khi kênh đang chạy ổn là mất luôn cấu hình cũ.
  const tokenSaved = !fromEnv && data?.bot_configured === true;

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
    <div className="tg-card" style={{ padding: "20px 22px 22px" }}>
      <h3 className="tg-h" style={{ marginBottom: 4 }}>
        {t("telegram.adminTitle")}
      </h3>

      {/* Cấu hình bot: nhập token ngay đây thay vì SSH sửa .env rồi restart. */}
      <div style={{ marginTop: 16, marginBottom: 24 }}>
        {fromEnv ? (
          <div className="notice" style={{ marginBottom: 12 }}>
            <div className="notice-body">{t("telegram.adminFromEnv")}</div>
          </div>
        ) : (
          <>
            <label className="form-label">{t("telegram.adminTokenLabel")}</label>
            {tokenSaved ? (
              <>
                <div
                  className="notice success"
                  style={{ marginTop: 8, marginBottom: 8 }}
                >
                  <div
                    className="notice-body"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <span className="badge badge-success">
                      {t("telegram.adminTokenActive")}
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontWeight: 500,
                        color: "var(--ink)",
                      }}
                    >
                      {data?.bot_username
                        ? `@${data.bot_username}`
                        : t("telegram.adminBotUnknown")}
                    </span>
                    <button
                      className="btn btn-sm btn-danger"
                      style={{ marginLeft: "auto" }}
                      disabled={clearToken.isPending}
                      onClick={async () => {
                        if (
                          await confirm(t("telegram.adminTokenClearConfirm"), {
                            danger: true,
                          })
                        ) {
                          clearToken.mutate();
                        }
                      }}
                    >
                      {t("telegram.adminTokenClear")}
                    </button>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                  {t("telegram.adminTokenLockedHint")}
                </div>
              </>
            ) : (
              <>
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
                </div>
              </>
            )}

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
