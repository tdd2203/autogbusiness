/**
 * DailyGuideModal — popup hướng dẫn hiện MỘT lần mỗi ngày khi user vào dashboard.
 *
 * Mục đích: đẩy mẹo dùng ChatGPT tới người dùng đúng lúc họ mở web, thay vì gửi
 * Telegram rồi trôi mất. Nội dung bài + luật "khi nào hiện" nằm ở `lib/guides`;
 * ở đây chỉ là phần vẽ.
 *
 * Bài có thể chèn số liệu của CHÍNH người đang đọc (đơn giá tháng của họ) qua
 * `guide.vars`; câu nào cần số mà chưa có thì bị bỏ khỏi bài, không hiện số sai.
 *
 * Popup là một TRANG MỤC LỤC: cột trái liệt kê mọi bài đang có, cột phải là bài
 * đang đọc. Mỗi ngày hệ thống mở sẵn một bài (luật bốc bài ở `lib/guides`), còn
 * lại người đọc tự bấm sang bài khác — bấm sang bài khác KHÔNG đổi bài đã ghim
 * cho hôm nay, mở lại vẫn ra đúng bài của ngày.
 *
 * Popup này KHÔNG chặn việc gì cả: đóng lúc nào cũng được (nút ✕, nút "Đã hiểu",
 * phím Esc, bấm ra ngoài). Tick "Không hiện lại hôm nay" mới là tắt tới hết ngày.
 *
 * Xem DailyGuideModal.md.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useI18n } from "../i18n";
import { useAuth } from "../hooks/useAuth";
import { api } from "../lib/api";
import type { Wallet } from "../lib/wallet";
import { toast } from "./Toast";
import {
  cardKicker,
  cardTitle,
  primaryBtn as sharedPrimaryBtn,
  secondaryBtn,
} from "./walletUi";
import {
  GUIDES,
  fillGuideVars,
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
  const bodyRef = useRef<HTMLDivElement>(null);
  const day = useMemo(() => vnDayKey(), []);
  // Đơn giá tháng của chính người đang đọc, cho bài nào cần tới. CÙNG khoá cache
  // với `useWallet` nên không tốn thêm lượt gọi nếu trang đã hỏi ví; `enabled`
  // buộc chỉ hỏi khi popup mở, khỏi để mọi trang phải gánh một lượt gọi ví.
  const { user } = useAuth();
  const { data: wallet } = useQuery({
    queryKey: ["wallet", "balance"],
    queryFn: () => api<Wallet>("/api/v1/wallet"),
    enabled: !!guide && (!!user?.wallet_beta || !!user?.is_super_admin),
  });

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

  // Sang bài khác mà khung nội dung còn nằm ở chỗ cuộn cũ thì người đọc rơi vào
  // giữa bài mới, tưởng mất phần đầu.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [guide]);

  function close() {
    markSeenThisSession(day);
    if (mute) writeState({ ...readState(), mutedDay: day });
    setGuide(null);
  }

  // Bản in dựng lại nội dung ở trang riêng (xem `lib/guides/printable.ts`), chứ
  // in thẳng popup thì ra bản cụt: popup cuộn trong khung, ảnh còn lazy-load.
  function exportPdf() {
    if (!guide) return;
    // In ra phải là bài NGƯỜI ĐỌC đang thấy, kể cả phần số đã điền theo đơn giá
    // của họ — in bản thô là ra giấy đầy chỗ trống "{donGia}".
    const printed = openGuidePrint(
      fillGuideVars(
        guide.content[lang] ?? guide.content.vi,
        guide.vars?.({ feeVnd: wallet?.invite_fee_vnd ?? null }) ?? {},
      ),
      {
        lang,
        notesLabel: t("guide.notes"),
        baseUrl: window.location.href,
      },
    );
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
  const content = fillGuideVars(
    guide.content[lang] ?? guide.content.vi,
    guide.vars?.({ feeVnd: wallet?.invite_fee_vnd ?? null }) ?? {},
  );

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

        <div className="guide-split">
          {/* Mục lục: mọi bài đang có, bài đang đọc được tô. Một bài thì không vẽ
              cột nào — mục lục đúng một dòng chỉ tổ chiếm chỗ. */}
          {GUIDES.length > 1 && (
            <nav className="guide-index">
              {GUIDES.map((g) => {
                const label = (g.content[lang] ?? g.content.vi).title;
                const on = g.id === guide.id;
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setGuide(g)}
                    aria-current={on ? "true" : undefined}
                    className={on ? "guide-index-item on" : "guide-index-item"}
                  >
                    {label}
                  </button>
                );
              })}
            </nav>
          )}

          <div className="guide-content" ref={bodyRef}>
            <div className="guide-article">
              <p className="guide-lede guide-measure">{renderMarkup(content.intro)}</p>
              {/* Vạch dưới đoạn mở bài: tách phần "chuyện gì đang xảy ra" khỏi
                  danh sách bước, thay cho việc chừa một khoảng trắng to. */}
              <div className="guide-rule guide-measure" />

              {content.sections.map((section, si) => (
                <div key={si} style={{ marginTop: si === 0 ? 0 : 30 }}>
                  {section.heading && (
                    <div style={sectionHead} className="guide-measure">
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
                <div className="guide-notes guide-measure">
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
          </div>
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
    <div className="guide-step">
      <span className="guide-step-num">{String(index).padStart(2, "0")}</span>
      <div className="guide-step-main">
        <div className="guide-step-title guide-measure">{step.title}</div>
        <p className="guide-step-text guide-measure">{renderMarkup(step.body)}</p>
        {step.table && (
          <div className="guide-table-wrap guide-measure">
            <table className="data-table guide-table">
              <thead>
                <tr>
                  {step.table.head.map((cell, i) => (
                    <th key={i}>{renderMarkup(cell)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {step.table.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c}>{renderMarkup(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
// PHẦN THÂN BÀI nằm ở `index.css` (`.guide-split`, `.guide-article`,
// `.guide-measure`, `.guide-step*`, `.guide-table*`, `.guide-notes`) chứ không
// phải style inline như khung popup: chỗ đó cần media query cho màn hẹp, cần
// `:hover`, và bảng thì mượn thẳng `.data-table` của app.
const sectionHead: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12 };
const sectionHeadText: React.CSSProperties = { ...cardKicker, ...SANS, height: "auto", color: "var(--ink)", fontWeight: 700, flexShrink: 0 };
const sectionRule: React.CSSProperties = { height: 1, flex: 1, background: "var(--border)" };
const figure: React.CSSProperties = { margin: "12px 0 0", display: "flex", flexDirection: "column", gap: 7 };
const caption: React.CSSProperties = { ...SANS, fontSize: 11.5, color: "var(--ink-3)", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" };
const noteHead: React.CSSProperties = { ...cardKicker, ...SANS, height: "auto", color: "var(--warning)", marginBottom: 9, fontWeight: 700 };
const noteList: React.CSSProperties = { margin: 0, paddingLeft: 18, listStyleType: "disc", fontSize: 14.5, lineHeight: 1.65, color: "var(--ink-2)" };
const footer: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 22px", borderTop: "1px solid var(--border)", background: "var(--surface-2)", flexWrap: "wrap" };
const muteLabel: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--ink-2)", cursor: "pointer", userSelect: "none" };
const primaryBtn: React.CSSProperties = sharedPrimaryBtn;
