/**
 * AnnouncementSettingsModal — bảng điều khiển THÔNG BÁO HỆ THỐNG (chỉ super-admin).
 *
 * Mở từ nút ⚙ trong popup hướng dẫn. Một chỗ duy nhất để mở/đóng đợt ép đọc:
 * bài nào, chạy từ ngày nào, mấy ngày, giữ popup mấy giây.
 *
 * Vì sao là bảng cài đặt chứ không phải sửa code: đợt thông báo là chuyện của tuần
 * này. Mỗi lần muốn nhắc một chuyện mà phải sửa hằng số rồi build lại web thì lúc
 * cần nhắc gấp không ai kịp làm — và lúc muốn tắt cũng thế.
 *
 * Danh sách bài lấy thẳng từ `GUIDES` trong bundle, nên thêm bài hướng dẫn mới là
 * ô chọn tự có thêm dòng, backend không phải biết bài nào tồn tại.
 *
 * Backend: `apps/api/app/routers/announcements.py`. Trạng thái "đã đọc" nằm ở
 * server theo TÀI KHOẢN — xem `lib/announcement.ts`.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiErrorText } from "../lib/api";
import { useI18n } from "../i18n";
import { GUIDES } from "../lib/guides";
import {
  ANNOUNCEMENT_ADMIN_KEY,
  ANNOUNCEMENT_KEY,
  fetchAnnouncementAdmin,
  saveAnnouncement,
  type AnnouncementAdmin,
  type AnnouncementDraft,
} from "../lib/announcement";
import { toast } from "./Toast";
import { input, primaryBtn, secondaryBtn } from "./walletUi";

/** "2026-09-08" → "08/09/2026" mà KHÔNG đi qua `new Date`.
 *
 *  Chuỗi ngày không có giờ bị `new Date` hiểu là nửa đêm UTC rồi đổi sang giờ máy,
 *  nên máy lệch múi giờ về phía tây đọc ra ngày hôm trước. Ngày ở đây là ngày lịch
 *  VN của đợt, không phải một mốc thời gian. */
function dayLabel(day: string | null): string {
  if (!day) return "—";
  const [y, m, d] = day.split("-");
  if (!y || !m || !d) return day;
  return `${d}/${m}/${y}`;
}

function toDraft(data: AnnouncementAdmin): AnnouncementDraft {
  return {
    enabled: data.enabled,
    guide_id: data.guide_id,
    start_day: data.start_day,
    days: data.days,
    lock_seconds: data.lock_seconds,
  };
}

export default function AnnouncementSettingsModal({
  onClose,
  onPreview,
}: {
  onClose: () => void;
  /** Mở thử lượt ép đọc (popup hướng dẫn tự lo phần vẽ). Nhận callback từ popup
   *  chứ không gọi ngược vào file đó: hai file import lẫn nhau là vòng tròn, mà
   *  vòng tròn ESM chỉ chạy đúng nhờ may mắn về thứ tự nạp module. */
  onPreview: (guideId: string, seconds: number) => void;
}) {
  const { lang, t } = useI18n();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<AnnouncementDraft | null>(null);

  const q = useQuery({
    queryKey: ANNOUNCEMENT_ADMIN_KEY,
    queryFn: fetchAnnouncementAdmin,
    staleTime: 30_000,
  });

  // Chỉ nạp bản nháp từ server LẦN ĐẦU (và sau mỗi lần lưu, vì lúc đó `draft` đã
  // được đặt lại theo phản hồi): nạp đè mỗi lần query đổi thì đang gõ dở bị nhảy số.
  useEffect(() => {
    if (q.data && draft === null) setDraft(toDraft(q.data));
  }, [q.data, draft]);

  const save = useMutation({
    mutationFn: (body: AnnouncementDraft) => saveAnnouncement(body),
    onSuccess: (next) => {
      qc.setQueryData(ANNOUNCEMENT_ADMIN_KEY, next);
      setDraft(toDraft(next));
      // Popup của CHÍNH admin cũng phải theo cấu hình vừa lưu ở lượt vào sau.
      qc.invalidateQueries({ queryKey: ANNOUNCEMENT_KEY });
      toast.success(t("announce.saved"));
    },
    onError: (e) => toast.error(apiErrorText(e, t("announce.saveError"))),
  });

  const data = q.data;
  const maxDays = data?.max_days ?? 60;
  const maxLock = data?.max_lock_seconds ?? 120;

  function patch(next: Partial<AnnouncementDraft>) {
    setDraft((prev) => (prev ? { ...prev, ...next } : prev));
  }

  function submit() {
    if (!draft || save.isPending) return;
    // Bật đợt mà chưa chọn bài thì chặn NGAY ở đây: backend nhận được cũng chỉ
    // lưu một đợt không bao giờ chạy, còn người bấm thì tưởng đã xong.
    if (draft.enabled && !draft.guide_id) {
      toast.warning(t("announce.needGuide"));
      return;
    }
    save.mutate({
      ...draft,
      days: Math.max(1, Math.min(maxDays, draft.days || 1)),
      lock_seconds: Math.max(0, Math.min(maxLock, draft.lock_seconds || 0)),
    });
  }

  /** Câu trạng thái: đợt đang ở đâu trong vòng đời của nó. */
  function statusLine(): string {
    if (!data) return "";
    if (!data.enabled) return t("announce.statusOff");
    // Bật nhưng chưa có bài: giao diện chặn rồi, nhưng cấu hình cũ hoặc gọi thẳng
    // API vẫn để lại được trạng thái này — nói thẳng ra còn hơn báo "đã kết thúc".
    if (!data.guide_id) return t("announce.statusNoGuide");
    if (data.active && data.day_index) {
      return t("announce.statusRunning", {
        i: data.day_index,
        n: data.days,
        end: dayLabel(data.end_day),
      });
    }
    if (data.start_day && data.start_day > data.day) {
      return t("announce.statusScheduled", { start: dayLabel(data.start_day) });
    }
    return t("announce.statusEnded", { end: dayLabel(data.end_day) });
  }

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div style={header}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--ink)" }}>
              {t("announce.title")}
            </div>
            <div style={sub}>{t("announce.subtitle")}</div>
          </div>
          <button onClick={onClose} style={closeBtn} aria-label={t("common.close")}>
            ✕
          </button>
        </div>

        <div style={body}>
          {q.isPending && <div style={sub}>{t("common.loading")}</div>}
          {q.isError && (
            <div style={{ ...sub, color: "var(--danger)" }}>
              {apiErrorText(q.error, t("announce.loadError"))}
            </div>
          )}

          {draft && data && (
            <>
              <div style={statusBox(data.active)}>
                <div style={{ fontWeight: 600, color: "var(--ink)" }}>{statusLine()}</div>
                {data.campaign && (
                  <div style={{ marginTop: 4 }}>
                    {t("announce.seenCount", {
                      today: data.seen_today_count,
                      total: data.seen_total_count,
                    })}
                  </div>
                )}
              </div>

              <label style={switchRow}>
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => patch({ enabled: e.target.checked })}
                  style={{ width: 16, height: 16, accentColor: "var(--ink)", cursor: "pointer" }}
                />
                <span>
                  <span style={{ fontWeight: 600, color: "var(--ink)" }}>
                    {t("announce.enable")}
                  </span>
                  <span style={hint}>{t("announce.enableHint")}</span>
                </span>
              </label>

              <div style={field}>
                <div style={label}>{t("announce.guide")}</div>
                <select
                  value={draft.guide_id ?? ""}
                  onChange={(e) => patch({ guide_id: e.target.value || null })}
                  style={{ ...input, cursor: "pointer" }}
                >
                  <option value="">{t("announce.guidePlaceholder")}</option>
                  {GUIDES.map((g) => (
                    <option key={g.id} value={g.id}>
                      {(g.content[lang] ?? g.content.vi).title}
                    </option>
                  ))}
                </select>
              </div>

              <div style={row}>
                <div style={field}>
                  <div style={label}>{t("announce.startDay")}</div>
                  <input
                    type="date"
                    value={draft.start_day ?? ""}
                    onChange={(e) => patch({ start_day: e.target.value || null })}
                    style={input}
                  />
                  <div style={hintBlock}>{t("announce.startDayHint")}</div>
                </div>
                <div style={field}>
                  <div style={label}>{t("announce.days")}</div>
                  <input
                    type="number"
                    min={1}
                    max={maxDays}
                    value={draft.days}
                    onChange={(e) => patch({ days: Number(e.target.value) })}
                    style={input}
                  />
                  <div style={hintBlock}>{t("announce.daysHint", { max: maxDays })}</div>
                </div>
                <div style={field}>
                  <div style={label}>{t("announce.lockSeconds")}</div>
                  <input
                    type="number"
                    min={0}
                    max={maxLock}
                    value={draft.lock_seconds}
                    onChange={(e) => patch({ lock_seconds: Number(e.target.value) })}
                    style={input}
                  />
                  <div style={hintBlock}>{t("announce.lockHint", { max: maxLock })}</div>
                </div>
              </div>

              {data.updated_at && (
                <div style={hintBlock}>
                  {t("announce.updatedBy", {
                    when: new Date(data.updated_at).toLocaleString(
                      lang === "zh-CN" ? "zh-CN" : "vi-VN",
                    ),
                    who: data.updated_by ?? "—",
                  })}
                </div>
              )}
            </>
          )}
        </div>

        <div style={footer}>
          {/* Xem thử = đúng thứ người dùng sẽ gặp, nhưng không ghi "đã đọc" lên
              server nên xem lại bao nhiêu lần cũng được. Đóng bảng trước rồi mới
              mở, bằng không bài nằm ngay dưới bảng này thì có nhìn thấy gì đâu. */}
          <button
            onClick={() => {
              if (!draft?.guide_id) {
                toast.warning(t("announce.needGuide"));
                return;
              }
              const { guide_id, lock_seconds } = draft;
              onClose();
              onPreview(guide_id, lock_seconds);
            }}
            style={secondaryBtn}
            disabled={!draft}
          >
            {t("announce.preview")}
          </button>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={secondaryBtn}>
            {t("common.close")}
          </button>
          <button onClick={submit} style={primaryBtn} disabled={!draft || save.isPending}>
            {save.isPending ? t("common.saving") : t("announce.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

// Nằm TRÊN popup hướng dẫn (z-index 130) vì mở từ trong đó ra.
const backdrop: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 140, padding: 16 };
const modal: React.CSSProperties = { fontFamily: "var(--font-sans)", background: "var(--surface)", borderRadius: 16, width: 620, maxWidth: "100%", maxHeight: "calc(90vh / var(--ui-scale))", display: "flex", flexDirection: "column", border: "1px solid var(--border)", boxShadow: "0 24px 70px -18px rgba(28,26,23,0.4)", overflow: "hidden" };
const header: React.CSSProperties = { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "16px 20px 13px", borderBottom: "1px solid var(--border)" };
const sub: React.CSSProperties = { fontSize: 12.5, color: "var(--ink-3)", marginTop: 4, lineHeight: 1.55 };
const closeBtn: React.CSSProperties = { width: 30, height: 30, borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--ink-3)", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 };
const body: React.CSSProperties = { padding: "16px 20px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 16 };
const statusBox = (on: boolean): React.CSSProperties => ({ background: "var(--surface-2)", border: `1px solid ${on ? "var(--warning)" : "var(--border)"}`, borderRadius: "var(--radius)", padding: "11px 13px", fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 });
const switchRow: React.CSSProperties = { display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13.5, color: "var(--ink-2)", cursor: "pointer", userSelect: "none" };
const field: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, minWidth: 0, flex: 1 };
const row: React.CSSProperties = { display: "flex", gap: 12, flexWrap: "wrap" };
const label: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, color: "var(--ink)" };
const hint: React.CSSProperties = { display: "block", fontSize: 12, color: "var(--ink-3)", marginTop: 3, lineHeight: 1.5 };
const hintBlock: React.CSSProperties = { fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.5 };
const footer: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "13px 20px", borderTop: "1px solid var(--border)", background: "var(--surface-2)" };
