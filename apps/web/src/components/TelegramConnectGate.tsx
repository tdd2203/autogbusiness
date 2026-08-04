import { useT } from "../i18n";
import { useTelegramConnect } from "../hooks/useTelegramConnect";
import { toast } from "./Toast";

/**
 * Màn BẮT BUỘC kết nối Telegram — thay cho toàn bộ trang "Thông báo" khi tài khoản
 * chưa bấm Start bot.
 *
 * Vì sao chặn hẳn thay vì cho vào rồi hiện cảnh báo: mọi thứ trong trang Thông báo
 * (mời người nhận, gắn người nhận cho từng email, soạn nội dung tin) đều chỉ chạy
 * được sau khi có kênh Telegram. Cho xem trước chỉ tạo ra một trang toàn nút bấm vào
 * là lỗi, và người dùng không hiểu vì sao. Ở đây chỉ còn đúng một việc để làm.
 */
export function TelegramConnectGate() {
  const t = useT();
  const { status, deepLink, awaiting, link, refresh } = useTelegramConnect();
  const botConfigured = status?.bot_configured === true;

  return (
    <div className="page-fade">
      <div style={{ marginBottom: 32 }}>
        <div className="breadcrumb">{t("nav.notifications")}</div>
        <h1 className="display-h1">{t("telegram.gateTitle")}</h1>
        <p className="page-sub">{t("telegram.gateLead")}</p>
      </div>

      <div className="settings-section" style={{ maxWidth: 720 }}>
        {!botConfigured && status && (
          <div className="notice warn" style={{ marginBottom: 20 }}>
            <div className="notice-body">{t("telegram.notConfigured")}</div>
          </div>
        )}

        <ol
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {[
            t("telegram.gateStep1"),
            t("telegram.gateStep2"),
            t("telegram.gateStep3"),
          ].map((step, i) => (
            <li
              key={i}
              style={{ display: "flex", gap: 12, alignItems: "flex-start", fontSize: 14 }}
            >
              <span
                style={{
                  flex: "0 0 auto",
                  width: 24,
                  height: 24,
                  borderRadius: "50%",
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--ink-2)",
                }}
              >
                {i + 1}
              </span>
              <span style={{ color: "var(--ink-2)", lineHeight: 1.5 }}>{step}</span>
            </li>
          ))}
        </ol>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 24 }}>
          <button
            className="btn btn-primary"
            disabled={!botConfigured || link.isPending}
            onClick={() => link.mutate()}
          >
            {link.isPending ? t("telegram.connecting") : t("telegram.connect")}
          </button>
          <button className="btn" onClick={refresh}>
            {t("telegram.refresh")}
          </button>
        </div>

        {/* Link đã mở ở tab mới rồi, nhưng trình duyệt có thể chặn popup, hoặc user
            đang ngồi máy tính mà Telegram ở điện thoại ⇒ vẫn phải thấy link để copy. */}
        {deepLink && (
          <div className="notice" style={{ marginTop: 16 }}>
            <div className="notice-body">
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  wordBreak: "break-all",
                }}
              >
                {deepLink}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                <a
                  className="btn btn-sm btn-primary"
                  href={deepLink}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("telegram.openTelegram")}
                </a>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(deepLink);
                    toast.success(t("telegram.subLinkCopied"));
                  }}
                >
                  {t("telegram.subCopyLink")}
                </button>
              </div>
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-3)" }}>
                {t("telegram.linkHint")}
              </div>
              {awaiting && (
                <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-2)" }}>
                  ⏳ {t("telegram.connectWaiting")}
                </div>
              )}
            </div>
          </div>
        )}

        <p
          style={{
            fontSize: 12.5,
            color: "var(--ink-3)",
            marginTop: 20,
            marginBottom: 0,
            lineHeight: 1.6,
          }}
        >
          {t("telegram.gateWhy")}
          <br />
          {t("telegram.gateAfter")}
        </p>
      </div>
    </div>
  );
}
