/**
 * DailyGuideModal — popup hướng dẫn hiện MỘT lần mỗi ngày khi user vào dashboard.
 *
 * Mục đích: đẩy mẹo dùng ChatGPT tới người dùng đúng lúc họ mở web, thay vì gửi
 * Telegram rồi trôi mất. Nội dung bài + luật "khi nào hiện" nằm ở `lib/guides`;
 * ở đây chỉ là phần vẽ.
 *
 * Popup này KHÔNG chặn việc gì cả: đóng lúc nào cũng được (nút ✕, nút "Đã hiểu",
 * phím Esc, bấm ra ngoài). Tick "Không hiện lại hôm nay" mới là tắt tới hết ngày.
 *
 * Xem DailyGuideModal.md.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { toast } from "./Toast";
import {
  cardKicker,
  cardTitle,
  primaryBtn as sharedPrimaryBtn,
  secondaryBtn,
} from "./walletUi";
import {
  findGuide,
  openGuidePrint,
  markSeenThisSession,
  pickGuideId,
  readSessionSeenDay,
  readState,
  shouldOpen,
  vnDayKey,
  writeState,
  type Guide,
  type GuideStep,
} from "../lib/guides";

/** Đợi một nhịp cho trang vẽ xong rồi mới bật popup — bật ngay lúc mount thì nó
 *  chồng lên khung xương đang tải, nhìn như lỗi. */
const OPEN_DELAY_MS = 700;

/** Handler do popup tự đăng ký khi mount (kiểu singleton giống `toast`) — nút
 *  "Hướng dẫn" ở trang Tổng quan gọi qua đây thay vì phải kéo state lên trên. */
let openHandler: (() => void) | null = null;

/** Mở lại bài hướng dẫn CỦA HÔM NAY theo yêu cầu người dùng.
 *
 *  Bỏ qua luật "đã xem trong tab này" và cả "không hiện lại hôm nay": ai bấm nút
 *  là đang muốn đọc, chặn lại thì nút thành nút hỏng. No-op nếu popup chưa mount
 *  (ngoài Layout) hoặc chưa có bài nào. */
export function openDailyGuide(): void {
  openHandler?.();
}

/** Đổi `**đậm**` thành <strong>. Đây là markup DUY NHẤT được phép trong nội dung
 *  bài, nên tách chuỗi là đủ — không cần parser, và không có đường cho HTML thô. */
function renderMarkup(text: string) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
    i % 2 === 1 ? (
      <strong key={i} style={{ color: "var(--ink)", fontWeight: 600 }}>
        {part}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export default function DailyGuideModal() {
  const { lang, t } = useI18n();
  const [guide, setGuide] = useState<Guide | null>(null);
  const [mute, setMute] = useState(false);
  const day = useMemo(() => vnDayKey(), []);

  useEffect(() => {
    const state = readState();
    if (!shouldOpen(day, state, readSessionSeenDay())) return;
    const id = pickGuideId(day, state);
    if (!id) return;
    const picked = findGuide(id);
    if (!picked) return;
    // Ghim bài theo ngày NGAY lúc chọn: mở tab thứ hai trong ngày phải ra đúng
    // bài này, không bốc lại bài khác.
    writeState({ ...state, day, guideId: id });
    const timer = setTimeout(() => setGuide(picked), OPEN_DELAY_MS);
    return () => clearTimeout(timer);
  }, [day]);

  const openNow = useCallback(() => {
    const state = readState();
    const id = pickGuideId(day, state);
    if (!id) return;
    const picked = findGuide(id);
    if (!picked) return;
    writeState({ ...state, day, guideId: id });
    setMute(false);
    setGuide(picked);
  }, [day]);

  useEffect(() => {
    openHandler = openNow;
    return () => {
      if (openHandler === openNow) openHandler = null;
    };
  }, [openNow]);

  function close() {
    markSeenThisSession(day);
    if (mute) writeState({ ...readState(), mutedDay: day });
    setGuide(null);
  }

  // Bản in dựng lại nội dung ở trang riêng (xem `lib/guides/printable.ts`), chứ
  // in thẳng popup thì ra bản cụt: popup cuộn trong khung, ảnh còn lazy-load.
  function exportPdf() {
    if (!guide) return;
    const printed = openGuidePrint(guide.content[lang] ?? guide.content.vi, {
      lang,
      notesLabel: t("guide.notes"),
      baseUrl: window.location.href,
    });
    if (!printed) toast.warning(t("guide.exportPdfBlocked"));
  }

  useEffect(() => {
    if (!guide) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Nghe lại khi `mute` đổi để `close` trong closure thấy giá trị mới nhất.
  }, [guide, mute]);

  if (!guide) return null;
  const content = guide.content[lang] ?? guide.content.vi;

  return (
    <div style={backdrop} onClick={close}>
      <div style={modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div style={header}>
          <div style={{ minWidth: 0 }}>
            <div style={eyebrow}>{content.eyebrow}</div>
            <div style={titleStyle}>{content.title}</div>
          </div>
          <div style={headerActions}>
            <button
              onClick={exportPdf}
              style={pdfBtn}
              title={t("guide.exportPdfTitle")}
            >
              <DownloadIcon />
              {t("guide.exportPdf")}
            </button>
            <button onClick={close} style={closeBtn} aria-label={t("common.close")}>
              ✕
            </button>
          </div>
        </div>

        <div style={body}>
          <p style={intro}>{renderMarkup(content.intro)}</p>

          {content.sections.map((section, si) => (
            <div key={si} style={{ marginTop: si === 0 ? 22 : 30 }}>
              {section.heading && (
                <div style={sectionHead}>
                  <span style={sectionHeadText}>{section.heading}</span>
                  <span style={sectionRule} />
                </div>
              )}
              {section.steps.map((step, i) => (
                <Step key={i} step={step} index={i + 1} zoomHint={t("guide.zoomHint")} />
              ))}
            </div>
          ))}

          {content.notes && content.notes.length > 0 && (
            <div style={noteBox}>
              <div style={noteHead}>{t("guide.notes")}</div>
              <ul style={noteList}>
                {content.notes.map((note, i) => (
                  <li key={i} style={{ marginTop: i === 0 ? 0 : 8 }}>
                    {renderMarkup(note)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div style={footer}>
          <label style={muteLabel}>
            <input
              type="checkbox"
              checked={mute}
              onChange={(e) => setMute(e.target.checked)}
              style={{ width: 15, height: 15, accentColor: "var(--ink)", cursor: "pointer" }}
            />
            {t("guide.dontShowToday")}
          </label>
          <button onClick={close} style={primaryBtn}>
            {t("guide.gotIt")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Step({
  step,
  index,
  zoomHint,
}: {
  step: GuideStep;
  index: number;
  zoomHint: string;
}) {
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <span style={stepNum}>{String(index).padStart(2, "0")}</span>
        <div style={{ minWidth: 0 }}>
          <div style={stepTitle}>{step.title}</div>
          <p style={stepBody}>{renderMarkup(step.body)}</p>
        </div>
      </div>
      {step.image && (
        <figure style={figure}>
          {/* Ảnh chụp màn hình co lại trong popup thì chữ bé; mở tab mới là cách
              phóng to rẻ nhất, không phải dựng lightbox riêng. */}
          <a href={step.image} target="_blank" rel="noreferrer" title={zoomHint}>
            <img
              src={step.image}
              alt={step.imageAlt ?? step.title}
              loading="lazy"
              decoding="async"
              style={{
                display: "block",
                width: "100%",
                maxWidth: step.imageMaxWidth ?? "100%",
                border: "1px solid var(--border)",
                borderRadius: 10,
                background: "var(--surface-2)",
              }}
            />
          </a>
          <figcaption style={caption}>
            <span>{step.caption}</span>
            {/* Nói thẳng ra là bấm được — ảnh chụp thu nhỏ đọc chữ không nổi, mà
                không ai đoán được cái ảnh tĩnh lại mở ra cỡ đầy đủ. */}
            <span style={{ color: "var(--ink-4)" }}>{zoomHint}</span>
          </figcaption>
        </figure>
      )}
    </div>
  );
}

/** Mũi tên xuống khay — dấu "tải về" quen mắt, khỏi kéo thêm bộ icon. */
function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 2v8m0 0 3-3m-3 3L5 7M2.5 12.5h11"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const backdrop: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 130, padding: 16 };
const modal: React.CSSProperties = { fontFamily: "var(--font-sans)", background: "var(--surface)", borderRadius: 18, width: 1120, maxWidth: "100%", maxHeight: "calc(92vh / var(--ui-scale))", display: "flex", flexDirection: "column", border: "1px solid var(--border)", boxShadow: "0 24px 70px -18px rgba(28,26,23,0.4), 0 2px 8px rgba(28,26,23,0.08)", overflow: "hidden" };
const header: React.CSSProperties = { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "18px 22px 15px", borderBottom: "1px solid var(--border)" };
// Nhãn nhỏ mượn cỡ chữ và độ giãn của `cardKicker` (10px, .12em, viết hoa) nhưng
// ĐỔI SANG Inter: popup này không dùng chữ máy, cả bài chỉ một mặt chữ (chốt
// 31/8/2026). `SANS` phải đứng SAU khi trải cardKicker, nếu không mono ghi đè lại.
const SANS = { fontFamily: "var(--font-sans)" } as const;
const eyebrow: React.CSSProperties = { ...cardKicker, ...SANS, height: "auto", color: "var(--success)", marginBottom: 5, fontWeight: 600 };
const titleStyle: React.CSSProperties = { ...cardTitle, fontSize: 22, marginBottom: 0, lineHeight: 1.3 };
const headerActions: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 };
const pdfBtn: React.CSSProperties = { ...secondaryBtn, padding: "6px 11px", fontSize: 12.5, display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", flexShrink: 0 };
const closeBtn: React.CSSProperties = { width: 30, height: 30, borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--ink-3)", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 };
const body: React.CSSProperties = { padding: "16px 22px 22px", overflowY: "auto", flex: 1 };
const intro: React.CSSProperties = { margin: 0, fontSize: 15, lineHeight: 1.65, color: "var(--ink-2)" };
const sectionHead: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12 };
const sectionHeadText: React.CSSProperties = { ...cardKicker, ...SANS, height: "auto", color: "var(--ink)", fontWeight: 700, flexShrink: 0 };
const sectionRule: React.CSSProperties = { height: 1, flex: 1, background: "var(--border)" };
const stepNum: React.CSSProperties = { ...SANS, fontSize: 13, color: "var(--success)", width: 22, flex: "none", fontWeight: 700 };
const stepTitle: React.CSSProperties = { ...cardTitle, fontSize: 16, marginBottom: 0, lineHeight: 1.4 };
const stepBody: React.CSSProperties = { margin: "5px 0 0", fontSize: 14.5, lineHeight: 1.6, color: "var(--ink-2)" };
const figure: React.CSSProperties = { margin: "12px 0 0 34px", display: "flex", flexDirection: "column", gap: 7 };
const caption: React.CSSProperties = { ...SANS, fontSize: 11.5, color: "var(--ink-3)", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" };
const noteBox: React.CSSProperties = { marginTop: 30, padding: "16px 18px", border: "1px solid var(--border)", background: "var(--surface-2)", borderRadius: 12 };
const noteHead: React.CSSProperties = { ...cardKicker, ...SANS, height: "auto", color: "var(--warning)", marginBottom: 10, fontWeight: 600 };
const noteList: React.CSSProperties = { margin: 0, paddingLeft: 18, listStyleType: "disc", fontSize: 14, lineHeight: 1.6, color: "var(--ink-2)" };
const footer: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 22px", borderTop: "1px solid var(--border)", background: "var(--surface-2)", flexWrap: "wrap" };
const muteLabel: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--ink-2)", cursor: "pointer", userSelect: "none" };
const primaryBtn: React.CSSProperties = sharedPrimaryBtn;
