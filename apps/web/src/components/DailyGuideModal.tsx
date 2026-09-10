/**
 * DailyGuideModal — popup hướng dẫn hiện MỘT lần mỗi ngày khi user vào dashboard.
 *
 * Mục đích: đẩy mẹo dùng ChatGPT tới người dùng đúng lúc họ mở web, thay vì gửi
 * Telegram rồi trôi mất. Nội dung bài + luật "khi nào hiện" nằm ở `lib/guides`;
 * ở đây chỉ là phần vẽ.
 *
 * Bài có thể chèn số liệu của CHÍNH người đang đọc (đơn giá tháng của họ) qua
 * `guide.vars`; câu nào cần số mà chưa có thì bị bỏ khỏi bài, không hiện số sai.
 * Bước nào bật `feeInput` thì có thêm ô gõ đơn giá khác để thử số — cả bài lẫn
 * bản PDF tính lại theo giá vừa gõ, và giá đó KHÔNG được lưu lại ở đâu.
 *
 * Popup là một TRANG MỤC LỤC: cột trái liệt kê mọi bài đang có, cột phải là bài
 * đang đọc. Mỗi ngày hệ thống mở sẵn một bài (luật bốc bài ở `lib/guides`), còn
 * lại người đọc tự bấm sang bài khác — bấm sang bài khác KHÔNG đổi bài đã ghim
 * cho hôm nay, mở lại vẫn ra đúng bài của ngày.
 *
 * Popup này KHÔNG chặn việc gì cả: đóng lúc nào cũng được (nút ✕, nút "Đã hiểu",
 * phím Esc, bấm ra ngoài). Tick "Không hiện lại hôm nay" mới là tắt tới hết ngày.
 *
 * NGOẠI LỆ DUY NHẤT là ĐỢT THÔNG BÁO HỆ THỐNG (`lib/announcement.ts`): khi
 * super-admin mở một đợt, popup mở đúng bài được chỉ định và GIỮ vài giây trước
 * khi cho đóng — mỗi người mỗi ngày một lần, hết số ngày của đợt thì tự thôi.
 * Nút ⚙ cạnh tiêu đề (chỉ super-admin thấy) là chỗ bật/tắt đợt đó.
 *
 * Xem DailyGuideModal.md.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  GUIDE_LANGS,
  PRINT_NOTES_LABEL,
  fillGuideVars,
  findGuide,
  openGuidePrint,
  markSeenThisSession,
  pickGuideId,
  readSessionSeenDay,
  readState,
  readerFeeVnd,
  shouldOpen,
  vnDayKey,
  writeState,
  type Guide,
  type GuideLang,
  type GuideStep,
  type GuideTable,
} from "../lib/guides";
import { MoneyInput } from "./priceEditor";
import { createHoverMenu, hoverMenuWrap } from "./hoverMenu";
import AnnouncementSettingsModal from "./AnnouncementSettingsModal";
import {
  ANNOUNCEMENT_KEY,
  fetchAnnouncement,
  forcedGuideId,
  markAnnouncementSeen,
} from "../lib/announcement";

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
  // Đơn giá người đọc tự gõ để thử (chuỗi chữ số, `null` = đang dùng giá thật).
  // Chỉ là state của lượt đọc này — không ghi vào ví, cũng không vào localStorage.
  const [feeDraft, setFeeDraft] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const day = useMemo(() => vnDayKey(), []);
  const qc = useQueryClient();
  // Số giây CÒN PHẢI GIỮ popup. `null` = lượt đọc thường, đóng lúc nào cũng được.
  const [lockLeft, setLockLeft] = useState<number | null>(null);
  // Lượt này là do đợt thông báo hệ thống mở, không phải bài ngẫu nhiên của ngày.
  const [forced, setForced] = useState(false);
  // Super-admin đang xem thử: giống hệt lượt ép đọc thật, chỉ khác là không ghi
  // "đã đọc hôm nay" lên server và không tắt popup của ngày.
  const [preview, setPreview] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  // Menu ngôn ngữ của nút Xuất PDF. Mở khi rê chuột, và mở/đóng được bằng bấm —
  // trên điện thoại không có chuột để rê. Đóng có TRỄ (xem `hoverMenu.ts`): đóng
  // ngay khi chuột vừa qua mép là không ai bấm kịp mục cuối.
  const [pdfOpen, setPdfOpen] = useState(false);
  const pdfHover = useRef(createHoverMenu(setPdfOpen));
  useEffect(() => () => pdfHover.current.dispose(), []);
  const locked = lockLeft !== null && lockLeft > 0;
  // Bản sao của `locked` cho `openNow` — hàm đó đăng ký một lần vào `openHandler`
  // nên closure của nó không thấy state mới, phải soi qua ref.
  const lockedRef = useRef(false);
  useEffect(() => {
    lockedRef.current = locked;
  }, [locked]);
  // Đơn giá tháng của chính người đang đọc, cho bài nào cần tới. CÙNG khoá cache
  // với `useWallet` nên không tốn thêm lượt gọi nếu trang đã hỏi ví; `enabled`
  // buộc chỉ hỏi khi popup mở, khỏi để mọi trang phải gánh một lượt gọi ví.
  const { user } = useAuth();
  const { data: wallet } = useQuery({
    queryKey: ["wallet", "balance"],
    queryFn: () => api<Wallet>("/api/v1/wallet"),
    enabled: !!guide && (!!user?.wallet_beta || !!user?.is_super_admin),
  });

  // Đợt ép đọc đang chạy (nếu có). Hỏi một lần cho mỗi lượt vào web: câu này nhẹ
  // nhưng cũng không có lý do hỏi lại giữa chừng — đợt đổi thì lần vào sau mới cần
  // biết. Lỗi mạng ⇒ coi như không có đợt: popup thường vẫn chạy, không ai bị chặn
  // màn hình vì một câu API hỏng.
  const announcement = useQuery({
    queryKey: ANNOUNCEMENT_KEY,
    queryFn: fetchAnnouncement,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const markSeen = useMutation({
    mutationFn: markAnnouncementSeen,
    onSuccess: (next) => qc.setQueryData(ANNOUNCEMENT_KEY, next),
  });

  const walletFee = wallet?.invite_fee_vnd ?? null;
  const feeVnd = readerFeeVnd(feeDraft, walletFee);
  // Bài đã điền số — dùng cho cả phần hiện trên màn hình lẫn bản in, khỏi hai
  // đường tính song song rồi lệch nhau.
  const content = useMemo(
    () =>
      guide
        ? fillGuideVars(
            guide.content[lang] ?? guide.content.vi,
            guide.vars?.({ feeVnd }) ?? {},
          )
        : null,
    [guide, lang, feeVnd],
  );

  // Quyết định mở popup gì cho LƯỢT VÀO WEB NÀY. Chạy đúng một lần, và chỉ sau khi
  // đã biết có đợt ép đọc hay không — hỏi xong mới quyết thì mới khỏi cảnh mở bài
  // ngẫu nhiên trước rồi giật sang bài thông báo nửa giây sau.
  const booted = useRef(false);
  const announcementReady = !announcement.isPending;
  const forcedId = forcedGuideId(announcement.data);
  useEffect(() => {
    if (!announcementReady || booted.current) return;
    booted.current = true;

    // Đợt ép đọc đi TRƯỚC luật thường: đã tick "không hiện lại hôm nay" hay đã đọc
    // bài của ngày thì vẫn phải xem thông báo. Bài của đợt không còn trong bundle
    // (vừa gỡ khỏi `GUIDES`) thì lui về luật thường, không treo popup rỗng.
    const announced = forcedId ? findGuide(forcedId) : null;
    if (announced) {
      const seconds = Math.max(0, announcement.data?.lock_seconds ?? 0);
      const timer = setTimeout(() => {
        setForced(true);
        setLockLeft(seconds);
        setGuide(announced);
      }, OPEN_DELAY_MS);
      return () => clearTimeout(timer);
    }

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
  }, [announcementReady, forcedId, day]);

  // Đồng hồ giữ popup. Chỉ đếm KHI TAB ĐANG HIỆN: trình duyệt bóp đồng hồ của tab
  // nền, mà đọc thì phải nhìn mới là đọc — để nó chạy trong tab ẩn thì mở web rồi
  // bỏ đó là xong nghĩa vụ.
  const counting = forced && lockLeft !== null && lockLeft > 0;
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      setLockLeft((left) => (left === null ? null : Math.max(0, left - 1)));
    }, 1000);
    return () => clearInterval(timer);
  }, [counting]);

  // Hết giờ giữ = đã đọc xong thông báo của hôm nay. Ghi nhận ngay tại đây chứ
  // không đợi người ta bấm đóng: bấm hay không thì họ cũng đã ngồi đủ số giây.
  // Ngược lại, F5 giữa chừng là chưa tính — mở lại vẫn bị giữ, đó mới là ép đọc.
  const marked = useRef(false);
  useEffect(() => {
    if (!forced || lockLeft === null || lockLeft > 0 || marked.current) return;
    marked.current = true;
    if (preview) return;
    markSeen.mutate();
    // Hôm nay thế là đủ: người vừa bị giữ mấy giây không nên mở tab khác lại gặp
    // thêm một bài ngẫu nhiên nữa.
    markSeenThisSession(day);
    writeState({ ...readState(), mutedDay: day });
    // `markSeen` là handle ổn định của react-query, đưa vào deps chỉ tổ chạy lại.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forced, lockLeft, day, preview]);

  /** Mở thử lượt ép đọc ĐÚNG như người dùng sẽ thấy, nhưng không ghi gì lên
   *  server. Super-admin cần xem trước khi bật đợt, và xem lại bao nhiêu lần cũng
   *  được — bật thật để tự thử thì xem xong một lần là hết ngày mới xem lại được,
   *  mà lúc đó cả nhà cũng đã bị ép đọc theo. */
  const previewNow = useCallback((guideId: string, seconds: number) => {
    const picked = findGuide(guideId);
    if (!picked) return;
    marked.current = false;
    setPreview(true);
    setForced(true);
    setMute(false);
    setLockLeft(Math.max(0, seconds));
    setGuide(picked);
  }, []);

  const openNow = useCallback(() => {
    // Đang giữ popup thông báo thì nút "Hướng dẫn" không được đổi bài giữa chừng.
    if (lockedRef.current) return;
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
    // Đơn giá gõ tay chỉ sống trong lượt đọc: sang bài khác hay đóng popup là về
    // đúng giá thật của họ.
    setFeeDraft(null);
  }, [guide]);

  function close() {
    // Chưa hết giờ giữ thì mọi đường đóng đều câm: nút ✕, Esc, bấm ra ngoài.
    if (locked) return;
    markSeenThisSession(day);
    if (mute) writeState({ ...readState(), mutedDay: day });
    setGuide(null);
    setForced(false);
    setPreview(false);
    setLockLeft(null);
  }

  // Bản in dựng lại nội dung ở trang riêng (xem `lib/guides/printable.ts`), chứ
  // in thẳng popup thì ra bản cụt: popup cuộn trong khung, ảnh còn lazy-load.
  function exportPdf(target: GuideLang) {
    if (!guide) return;
    // In ra phải mang đúng những con số trên màn hình, kể cả đơn giá người đọc
    // vừa gõ tay — in bản thô là ra giấy đầy chỗ trống "{donGia}". Nhưng NGÔN NGỮ
    // thì lấy theo nút họ vừa bấm, không theo bài đang đọc: đại lý in bản tiếng
    // Anh đưa khách nước ngoài trong khi mình vẫn đọc tiếng Việt.
    const printed = openGuidePrint(
      fillGuideVars(guide.content[target], guide.vars?.({ feeVnd }) ?? {}),
      {
        lang: target,
        notesLabel: PRINT_NOTES_LABEL[target] ?? t("guide.notes"),
        baseUrl: window.location.href,
      },
    );
    pdfHover.current.closeNow();
    if (!printed) toast.warning(t("guide.exportPdfBlocked"));
  }

  useEffect(() => {
    if (!guide) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Menu đang mở thì Esc chỉ thu menu lại — đóng luôn cả bài là mất chỗ đọc
      // chỉ vì lỡ mở nhầm một menu nhỏ.
      if (pdfOpen) {
        pdfHover.current.closeNow();
        return;
      }
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Nghe lại khi `mute`/`locked` đổi để `close` trong closure thấy giá trị mới
    // nhất — thiếu `locked` thì hết giờ giữ rồi Esc vẫn câm, vì handler đăng ký từ
    // lúc còn khoá.
  }, [guide, mute, locked, pdfOpen]);

  if (!guide || !content) return null;

  return (
    <div style={backdrop} onClick={close}>
      <div style={modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div style={header}>
          <div style={{ minWidth: 0 }}>
            {/* Ép đọc thì nói thẳng đây là thông báo hệ thống, không phải mẹo dùng
                hằng ngày — bằng không người ta tưởng popup hỏng vì bấm mãi không tắt. */}
            <div style={forced ? forcedEyebrow : eyebrow}>
              {forced ? t("announce.eyebrow") : content.eyebrow}
            </div>
            <div style={titleStyle}>{content.title}</div>
          </div>
          <div style={headerActions}>
            {user?.is_super_admin && (
              <button
                onClick={() => setAdminOpen(true)}
                style={gearBtn}
                title={t("announce.settings")}
                aria-label={t("announce.settings")}
              >
                <GearIcon />
              </button>
            )}
            {/* Rê chuột vào là hiện ba ngôn ngữ, bấm một cái là in luôn — không
                hỏi thêm bước nào. Bấm vào chính nút thì mở/đóng menu, vì màn cảm
                ứng không rê chuột được. */}
            <div
              style={{ position: "relative" }}
              onMouseEnter={() => pdfHover.current.enter()}
              onMouseLeave={() => pdfHover.current.leave()}
            >
              <button
                onClick={() => setPdfOpen((v) => !v)}
                style={pdfBtn}
                title={t("guide.exportPdfTitle")}
                aria-haspopup="menu"
                aria-expanded={pdfOpen}
              >
                <DownloadIcon />
                {t("guide.exportPdf")}
              </button>
              {pdfOpen && (
                // Lớp bọc TRONG SUỐT ôm cả khe hở dưới nút: khoảng cách là
                // `padding` của nó chứ không phải `margin` của menu, nên chuột đi
                // từ nút xuống menu không bao giờ rơi ra ngoài vùng hover.
                <div style={hoverMenuWrap}>
                  <div style={pdfMenu} role="menu">
                    {GUIDE_LANGS.map((code) => (
                      <button
                        key={code}
                        role="menuitem"
                        onClick={() => exportPdf(code)}
                        style={pdfMenuItem}
                        className="guide-pdf-lang"
                      >
                        {GUIDE_LANG_LABEL[code]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <button
              onClick={close}
              style={locked ? closeBtnLocked : closeBtn}
              disabled={locked}
              title={locked ? t("announce.closeLocked", { n: lockLeft ?? 0 }) : undefined}
              aria-label={t("common.close")}
            >
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
                // Đang bị giữ ở bài thông báo thì mục lục nghỉ: bấm sang bài khác
                // giữa lúc đếm giờ là đọc bài khác, chứ không phải bài đang được
                // thông báo.
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setGuide(g)}
                    disabled={locked}
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
                    <Step
                      key={i}
                      step={step}
                      index={i + 1}
                      zoomHint={t("guide.zoomHint")}
                      feeInput={
                        // Chưa biết giá thật thì bước ví dụ đã bị bỏ khỏi bài rồi;
                        // còn hiện được ô nhập thì phải có mốc để bấm quay về.
                        step.feeInput && walletFee !== null ? (
                          <FeeInput
                            value={feeDraft ?? String(walletFee)}
                            onChange={setFeeDraft}
                            onReset={
                              feeDraft !== null && feeDraft !== String(walletFee)
                                ? () => setFeeDraft(null)
                                : null
                            }
                          />
                        ) : null
                      }
                    />
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
          {forced ? (
            // Ô tick "không hiện lại hôm nay" biến mất khi ép đọc: đợt thông báo
            // không phải thứ tự tắt được, mà hứa hẹn ngược lại thì thành nút hỏng.
            <span style={forcedNote}>
              {locked
                ? t("announce.lockedNote", { n: lockLeft ?? 0 })
                : t("announce.unlockedNote")}
            </span>
          ) : (
            <label style={muteLabel}>
              <input
                type="checkbox"
                checked={mute}
                onChange={(e) => setMute(e.target.checked)}
                style={{ width: 15, height: 15, accentColor: "var(--ink)", cursor: "pointer" }}
              />
              {t("guide.dontShowToday")}
            </label>
          )}
          <button
            onClick={close}
            style={locked ? primaryBtnLocked : primaryBtn}
            disabled={locked}
          >
            {/* Đếm ngược ngay trên nút: người đọc thấy còn bao lâu thì thôi bấm
                loạn, và biết đây là chờ có hạn chứ không phải trang treo. */}
            {locked ? `${t("guide.gotIt")} (${lockLeft})` : t("guide.gotIt")}
          </button>
        </div>

        {/* Bảng cấu hình đợt thông báo — chỉ super-admin mở được (nút ⚙ ở trên).
            Đặt TRONG khung popup (khung này đã chặn click lan ra ngoài) nên bấm ra
            ngoài bảng chỉ đóng bảng, không đóng luôn bài đang đọc. */}
        {adminOpen && (
          <AnnouncementSettingsModal
            onClose={() => setAdminOpen(false)}
            onPreview={previewNow}
          />
        )}
      </div>
    </div>
  );
}

function Step({
  step,
  index,
  zoomHint,
  feeInput,
}: {
  step: GuideStep;
  index: number;
  zoomHint: string;
  /** Ô gõ đơn giá, đã dựng sẵn ở trên — `null` khi bước này không có. */
  feeInput?: React.ReactNode;
}) {
  return (
    <div className="guide-step">
      <span className="guide-step-num">{String(index).padStart(2, "0")}</span>
      <div className="guide-step-main">
        <div className="guide-step-title guide-measure">{step.title}</div>
        <p className="guide-step-text guide-measure">{renderMarkup(step.body)}</p>
        {/* Ô nhập đứng GIỮA câu văn và bảng: đọc xong câu "đơn giá của bạn là…"
            là thấy ngay chỗ đổi giá, rồi mới tới bảng số đổi theo. */}
        {feeInput}
        {step.table && <GuideTableView table={step.table} />}
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

/** Bảng của một bước.
 *
 *  Bảng so sánh (`layout: "compare"`) tô nền cột được khuyên — `highlight`, mặc
 *  định cột cuối. Quá 3 cột (vd 6 gói ChatGPT) thì thành bảng RỘNG: thoát khỏi
 *  trần bề ngang của cột chữ, chữ nhỏ hơn, màn hẹp cuộn ngang trong khung chứ
 *  không ép 7 cột vỡ vụn. */
function GuideTableView({ table }: { table: GuideTable }) {
  const compare = table.layout === "compare";
  const wide = table.head.length > 3;
  const hi = compare ? (table.highlight ?? table.head.length - 1) : -1;
  const cls = [
    "data-table",
    "guide-table",
    compare && "guide-table-compare",
    wide && "guide-table-wide",
  ]
    .filter(Boolean)
    .join(" ");
  const cellCls = (i: number) => (i === hi ? "is-hi" : undefined);
  return (
    <div className={wide ? "guide-table-wrap guide-table-wrap-wide" : "guide-table-wrap guide-measure"}>
      <table className={cls}>
        <thead>
          <tr>
            {table.head.map((cell, i) => (
              <th key={i} className={cellCls(i)}>
                {renderMarkup(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} className={cellCls(c)}>
                  {renderMarkup(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Ô gõ thử một ĐƠN GIÁ khác cho bài đang đọc.
 *
 *  Đại lý hay phải báo giá cho khách theo mức khác mức của chính mình — gõ vào
 *  đây là mọi con số trong bài (và bản PDF xuất ra) tính lại theo giá đó.
 *
 *  Số này KHÔNG được lưu: đóng popup hay sang bài khác là về giá thật. Giá bán
 *  thật vẫn chỉ đổi được ở trang giá, nên không ai lỡ tay đổi giá khi đọc bài.
 *
 *  Mượn `MoneyInput` của phần sửa giá cho ô số giống hệt mọi chỗ nhập tiền khác
 *  (chỉ ăn chữ số, tự chấm phần nghìn). */
function FeeInput({
  value,
  onChange,
  onReset,
}: {
  value: string;
  onChange: (next: string) => void;
  /** `null` khi đang là giá thật của họ — lúc đó nút quay về không có việc gì. */
  onReset: (() => void) | null;
}) {
  const { t } = useI18n();
  return (
    <div className="guide-fee guide-measure">
      <span className="guide-fee-label">{t("guide.feeTry")}</span>
      <MoneyInput value={value} onChange={onChange} width={148} />
      {onReset && (
        <button type="button" className="guide-fee-reset" onClick={onReset}>
          {t("guide.feeReset")}
        </button>
      )}
      <span className="guide-fee-hint">{t("guide.feeTryHint")}</span>
    </div>
  );
}

/** Bánh răng — dấu "cài đặt" quen mắt, vẽ tay cho khỏi kéo thêm bộ icon. */
function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="2.3" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1.6v1.5M8 12.9v1.5M14.4 8h-1.5M3.1 8H1.6M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1M12.5 12.5l-1.1-1.1M4.6 4.6 3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
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
// Thông báo hệ thống mang màu cảnh báo, khác hẳn màu xanh của bài đọc thường.
const forcedEyebrow: React.CSSProperties = { ...eyebrow, color: "var(--warning)", fontWeight: 700 };
const titleStyle: React.CSSProperties = { ...cardTitle, fontSize: 22, marginBottom: 0, lineHeight: 1.3 };
/** Tên ngôn ngữ viết bằng CHÍNH ngôn ngữ đó — người cần bản tiếng Trung nhận ra
 *  chữ 中文 nhanh hơn là đọc dòng "Tiếng Trung" trong giao diện tiếng Việt. */
const GUIDE_LANG_LABEL: Record<GuideLang, string> = {
  vi: "Tiếng Việt",
  "zh-CN": "中文",
  en: "English",
};

const headerActions: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 };
const pdfBtn: React.CSSProperties = { ...secondaryBtn, padding: "6px 11px", fontSize: 12.5, display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", flexShrink: 0 };
// Hình dáng hộp menu. Phần định vị và khe hở nằm ở `hoverMenuWrap` trong
// `hoverMenu.ts` — chỗ đó có test khoá, đừng chuyển khoảng cách về đây.
const pdfMenu: React.CSSProperties = { minWidth: 132, padding: 4, borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--surface)", boxShadow: "0 10px 28px -8px rgba(28,26,23,0.28)", display: "flex", flexDirection: "column", gap: 2 };
const pdfMenuItem: React.CSSProperties = { padding: "7px 10px", borderRadius: 7, border: "none", background: "transparent", color: "var(--ink)", fontSize: 12.5, fontFamily: "inherit", textAlign: "left", cursor: "pointer", whiteSpace: "nowrap" };
const closeBtn: React.CSSProperties = { width: 30, height: 30, borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--ink-3)", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 };
// Nút vẫn ĐỨNG NGUYÊN CHỖ lúc còn khoá, chỉ mờ đi: giấu rồi hiện lại thì hàng nút
// nhảy một cái đúng lúc người ta đang định bấm.
const closeBtnLocked: React.CSSProperties = { ...closeBtn, opacity: 0.4, cursor: "not-allowed" };
const gearBtn: React.CSSProperties = { ...closeBtn, color: "var(--ink-2)" };
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
const forcedNote: React.CSSProperties = { fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 };
const primaryBtn: React.CSSProperties = sharedPrimaryBtn;
const primaryBtnLocked: React.CSSProperties = { ...sharedPrimaryBtn, opacity: 0.45, cursor: "not-allowed" };
