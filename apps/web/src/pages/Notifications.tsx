import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n";
import type { AddedMember } from "../types";
import { TelegramSettings } from "../components/TelegramSettings";
import { TelegramConnectGate } from "../components/TelegramConnectGate";
import { NotifyLinkModal } from "../components/NotifyLinkModal";
import { NotificationTemplateModal } from "../components/NotificationTemplateModal";
import { useTelegramConnect } from "../hooks/useTelegramConnect";

/**
 * Trang "Thông báo" (mục riêng ở sidebar, mở cho MỌI người dùng).
 *
 * Gom mọi thứ liên quan nhắc gia hạn về một chỗ, thay vì rải trong Cài đặt:
 *   1. Kênh Telegram của tôi + người nhận được mời + mẫu nội dung — tái dùng nguyên
 *      component TelegramSettings (đang dùng ở Cài đặt → Telegram), không nhân bản code.
 *   2. Bảng TỪNG EMAIL: ai đang nhận thông báo của email đó, và nút lấy link gửi khách.
 *      Đây là phần trả lời câu "email này ai đang nhận nhắc?" mà trước phải mở từng
 *      dòng ở trang Email đã add mới biết.
 *
 * CHƯA KẾT NỐI TELEGRAM thì cả trang này chưa dùng được (mời người nhận, gắn người
 * nhận cho email, soạn nội dung — đều cần kênh Telegram), nên thay bằng màn kết nối
 * bắt buộc `TelegramConnectGate` cho tới khi tài khoản bấm Start bot.
 */
export default function Notifications() {
  const t = useT();
  const [q, setQ] = useState("");
  const [notifyMember, setNotifyMember] = useState<AddedMember | null>(null);
  const [editTemplate, setEditTemplate] = useState(false);
  const { status: tg } = useTelegramConnect();

  const { data: members = [], isLoading } = useQuery({
    queryKey: ["added-members", "self"],
    queryFn: () => api<AddedMember[]>("/api/v1/added-members"),
  });

  const rows = useMemo(() => {
    const live = members.filter(
      (m) => m.status === "active" || m.status === "pending",
    );
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? live.filter((m) => m.email.toLowerCase().includes(needle))
      : live;
    // Chưa gắn người nhận lên trước — đó là việc cần làm.
    return [...filtered].sort((a, b) => {
      const aSet = a.notify_telegram_chat_id ? 1 : 0;
      const bSet = b.notify_telegram_chat_id ? 1 : 0;
      if (aSet !== bSet) return aSet - bSet;
      return a.email.localeCompare(b.email);
    });
  }, [members, q]);

  const bound = rows.filter((m) => m.notify_telegram_chat_id).length;

  // Chưa biết trạng thái thì đứng yên — nháy màn "chưa kết nối" rồi đổi sang trang đủ
  // còn khó chịu hơn là chờ thêm một nhịp.
  if (!tg) {
    return (
      <div className="page-fade">
        <div className="cell-muted" style={{ fontSize: 13 }}>
          {t("common.loading")}
        </div>
      </div>
    );
  }

  if (!tg.linked) return <TelegramConnectGate />;

  return (
    <div className="page-fade">
      <div
        style={{
          marginBottom: 32,
          display: "flex",
          gap: 16,
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
        }}
      >
        <div>
          <div className="breadcrumb">{t("nav.notifications")}</div>
          <h1 className="display-h1">{t("notifications.title")}</h1>
          <p className="page-sub">{t("notifications.subtitle")}</p>
        </div>
        {/* MỘT nút duy nhất cho cả ba phạm vi mẫu (chung / theo người nhận / theo
            email) — chọn phạm vi ngay trong modal. Rải mỗi phạm vi một nút thì không
            ai biết mẫu nào đang thắng mẫu nào. */}
        <button className="btn btn-sm" onClick={() => setEditTemplate(true)}>
          {t("telegram.tplOpen")}
        </button>
      </div>

      {/* Không kèm cấu hình hệ thống (token bot/webhook/nhóm digest) — thứ đó thuộc
          Cài đặt → Telegram, chỉ super-admin đụng tới. Ở đây chỉ có việc của người
          dùng: kênh của mình, người nhận, và thông báo theo từng email. */}
      <TelegramSettings showSystemConfig={false} />

      <div style={{ marginTop: 32 }}>
        <h3 className="display-h3">{t("notifications.perEmailTitle")}</h3>
        <p
          style={{
            fontSize: 13,
            color: "var(--ink-3)",
            marginTop: 4,
            marginBottom: 16,
          }}
        >
          {t("notifications.perEmailDesc")}
        </p>

        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: 12,
          }}
        >
          <input
            className="form-input"
            style={{ maxWidth: 280 }}
            placeholder={t("members.searchPlaceholder")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <span className="cell-muted" style={{ fontSize: 13 }}>
            {t("notifications.boundCount", { bound, total: rows.length })}
          </span>
        </div>

        {isLoading ? (
          <div className="cell-muted" style={{ fontSize: 13 }}>
            {t("common.loading")}
          </div>
        ) : rows.length === 0 ? (
          <div className="cell-muted" style={{ fontSize: 13 }}>
            {t("addedEmails.empty")}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table data-table-compact">
              <thead>
                <tr>
                  <th>{t("member.colEmail")}</th>
                  <th>{t("notifications.colRecipient")}</th>
                  <th style={{ width: 150 }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id}>
                    <td className="cell-email">{m.email}</td>
                    <td style={{ fontSize: 13 }}>
                      {m.notify_telegram_chat_id ? (
                        <span style={{ color: "var(--success)" }}>
                          {m.notify_telegram_target}
                        </span>
                      ) : m.notify_telegram_target ? (
                        <span style={{ color: "var(--warning)" }}>
                          {m.notify_telegram_target} · {t("telegram.targetPending")}
                        </span>
                      ) : (
                        <span className="cell-muted">
                          {t("notifications.recipientSelf")}
                        </span>
                      )}
                    </td>
                    {/* Nút nằm im cho tới khi rê chuột vào dòng: bảng này để TRA CỨU
                        "email nào ai đang nhận", lấy link chỉ là việc thỉnh thoảng —
                        xem .row-reveal trong index.css. */}
                    <td style={{ textAlign: "right" }}>
                      <button
                        className="btn btn-sm row-reveal"
                        onClick={() => setNotifyMember(m)}
                        title={t("notifications.getLinkHint")}
                      >
                        {t("notifications.getLink")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {notifyMember && (
        <NotifyLinkModal
          member={notifyMember}
          onClose={() => setNotifyMember(null)}
        />
      )}

      {editTemplate && (
        <NotificationTemplateModal onClose={() => setEditTemplate(false)} />
      )}
    </div>
  );
}
