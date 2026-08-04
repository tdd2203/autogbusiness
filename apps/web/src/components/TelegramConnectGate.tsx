import { useT } from "../i18n";
import { useTelegramConnect } from "../hooks/useTelegramConnect";
import { useIsMobile } from "../hooks/useIsMobile";
import { TelegramLogo } from "./TelegramLogo";
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
  // Tiêu đề phải nằm GỌN 1 DÒNG (user 2026-08-04) — nhưng chỉ khi còn đủ bề ngang.
  // Ép nowrap ở màn hình hẹp thì chữ tràn ngang, cả trang phải cuộn ngang: đổi một
  // cái xấu lấy một cái tệ hơn. Dưới 640px cho xuống dòng như thường.
  const narrow = useIsMobile(639);

  return (
    <div
      className="page-fade"
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "6vh",
        paddingBottom: 48,
      }}
    >
      <div className="settings-section" style={{ width: "100%", maxWidth: 660 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}>
            <TelegramLogo size={76} />
          </div>
          <div className="breadcrumb">{t("nav.notifications")}</div>
          <h1
            style={{
              fontSize: narrow ? 22 : 25,
              lineHeight: 1.35,
              margin: 0,
              whiteSpace: narrow ? "normal" : "nowrap",
            }}
          >
            {t("telegram.gateTitle")}
          </h1>
        </div>

        {!botConfigured && status && (
          <div className="notice warn" style={{ marginTop: 20 }}>
            <div className="notice-body">{t("telegram.notConfigured")}</div>
          </div>
        )}

        <ol
          style={{
            margin: "24px 0 0",
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
              style={{ display: "flex", gap: 12, alignItems: "flex-start", fontSize: 15 }}
            >
              <span
                style={{
                  flex: "0 0 auto",
                  width: 26,
                  height: 26,
                  borderRadius: "50%",
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: "var(--ink-2)",
                }}
              >
                {i + 1}
              </span>
              <span style={{ color: "var(--ink-2)", lineHeight: 1.55 }}>{step}</span>
            </li>
          ))}
        </ol>

        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            justifyContent: "center",
            marginTop: 28,
          }}
        >
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
      </div>
    </div>
  );
}
