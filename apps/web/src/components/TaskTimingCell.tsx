/**
 * Ô "Thời gian" cho bảng Queue: hiện mốc tạo (created_at) như cũ, kèm 1 thẻ
 * (popover) chi tiết khi hover/click — vỡ ra timeline đầy đủ của 1 task:
 *
 *   Tạo lúc      created_at
 *   Bắt đầu chạy picked_at      (chờ = picked_at − created_at)
 *   Hoàn tất     completed_at   (chạy = completed_at − picked_at)
 *   Tổng         completed_at − created_at
 *
 * Với task đang chạy (IN_PROGRESS) / đang chờ (PENDING): có đồng hồ **đếm live**
 * theo giây — hiện ngay trong ô (không cần hover) và cập nhật trong popover.
 *
 * Mọi dữ liệu lấy từ QueueItem (created_at / picked_at / completed_at) — backend
 * đã expose sẵn, component thuần frontend, không gọi API.
 *
 * Định vị popover bằng `position: fixed` + portal ra document.body để KHÔNG bị
 * cắt bởi `overflow-x:auto` của khung bảng (table-card).
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { QueueItem } from "../types";
import { useI18n, useT, localeTag } from "../i18n";

const LIVE_STATUSES = new Set(["PENDING", "IN_PROGRESS"]);

/** ms → "1h 2m 3s" (đơn vị h/m/s, trung tính ngôn ngữ). Ẩn cấp 0 ở đầu. */
function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (h || m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

export function TaskTimingCell({ task }: { task: QueueItem }) {
  const t = useT();
  const { lang } = useI18n();
  const tag = localeTag(lang);

  const created = new Date(task.created_at);
  const picked = task.picked_at ? new Date(task.picked_at) : null;
  const completed = task.completed_at ? new Date(task.completed_at) : null;
  const isLive = LIVE_STATUSES.has(task.status);

  // Đồng hồ live: chỉ tick mỗi giây khi task đang chờ/chạy.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isLive]);

  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  function place() {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: r.left });
  }

  // Mốc tham chiếu cho đồng hồ live ở ô (đang chạy: từ picked; đang chờ: từ tạo).
  const liveBase =
    task.status === "IN_PROGRESS" ? (picked ?? created) : created;
  const liveLabel =
    task.status === "IN_PROGRESS"
      ? t("queue.timing.runningLive", { d: fmtDur(now - liveBase.getTime()) })
      : t("queue.timing.waitingLive", { d: fmtDur(now - liveBase.getTime()) });

  const fmtTime = (d: Date) => d.toLocaleTimeString(tag);
  const fmtFull = (d: Date) =>
    `${d.toLocaleDateString(tag)} ${d.toLocaleTimeString(tag)}`;

  return (
    <>
      <span
        ref={triggerRef}
        className="timestamp"
        style={{ cursor: "pointer" }}
        onMouseEnter={() => {
          if (!pinned) {
            place();
            setOpen(true);
          }
        }}
        onMouseLeave={() => {
          if (!pinned) setOpen(false);
        }}
        onClick={() => {
          place();
          setPinned((p) => {
            const next = !p;
            setOpen(next);
            return next;
          });
        }}
      >
        {fmtTime(created)}
        <span className="date">{created.toLocaleDateString(tag)}</span>
        {isLive && (
          <span
            style={{
              display: "block",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: "var(--warning)",
              marginTop: 2,
            }}
          >
            ⏱ {liveLabel}
          </span>
        )}
      </span>

      {open &&
        pos &&
        createPortal(
          <>
            {/* Backdrop trong suốt: click ra ngoài để đóng khi đã pin. */}
            {pinned && (
              <div
                onClick={() => {
                  setPinned(false);
                  setOpen(false);
                }}
                style={{ position: "fixed", inset: 0, zIndex: 1000 }}
              />
            )}
            <div
              role="tooltip"
              style={{
                position: "fixed",
                top: pos.top,
                left: pos.left,
                zIndex: 1001,
                minWidth: 260,
                maxWidth: 340,
                background: "var(--surface, #fff)",
                border: "1px solid var(--border, #e5e7eb)",
                borderRadius: 8,
                boxShadow: "0 8px 28px rgba(0,0,0,0.16)",
                padding: "12px 14px",
                fontSize: 12.5,
                lineHeight: 1.5,
                color: "var(--text, #111)",
              }}
            >
              <div
                style={{
                  fontWeight: 600,
                  marginBottom: 8,
                  fontSize: 12.5,
                  color: "var(--text-muted, #6b7280)",
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                }}
              >
                {t("queue.timing.title")}
              </div>

              <Row label={t("queue.timing.created")} value={fmtFull(created)} />

              <Row
                label={t("queue.timing.started")}
                value={
                  picked
                    ? fmtFull(picked)
                    : t("queue.timing.notStarted")
                }
                hint={
                  picked
                    ? t("queue.timing.waited", {
                        d: fmtDur(picked.getTime() - created.getTime()),
                      })
                    : undefined
                }
              />

              {completed ? (
                <Row
                  label={t("queue.timing.finished")}
                  value={fmtFull(completed)}
                  hint={t("queue.timing.ran", {
                    d: fmtDur(
                      completed.getTime() - (picked ?? created).getTime(),
                    ),
                  })}
                />
              ) : (
                <Row
                  label={t("queue.timing.finished")}
                  value="—"
                  hint={isLive ? liveLabel : undefined}
                />
              )}

              <div
                style={{
                  borderTop: "1px solid var(--border, #e5e7eb)",
                  marginTop: 8,
                  paddingTop: 8,
                  display: "flex",
                  justifyContent: "space-between",
                  fontWeight: 600,
                }}
              >
                <span style={{ color: "var(--text-muted, #6b7280)" }}>
                  {t("queue.timing.totalLabel")}
                </span>
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  {completed
                    ? fmtDur(completed.getTime() - created.getTime())
                    : fmtDur(now - created.getTime())}
                </span>
              </div>

              <PhaseBreakdown task={task} />
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

/**
 * Bảng phân rã THỜI LƯỢNG từng giai đoạn (phase) của 1 task — để admin biết bước
 * nào tốn thời gian nhất mà tối ưu tốc độ. Dữ liệu từ `progress.history` (mốc
 * `{phase, at}` do backend ghi mỗi lần phase đổi, xem update_progress).
 *
 * Thời lượng phase i = at(i+1) − at(i); phase cuối: tới `completed_at` (đã xong)
 * hoặc đếm live tới hiện tại (đang chạy). Tự tick mỗi giây khi task đang chạy.
 *
 * `compact` = bản gọn cho panel cột phải (font nhỏ, không tiêu đề); mặc định bản
 * đầy đủ cho popover bảng Queue (xem được cả task đã kết thúc → hậu kiểm tốc độ).
 */
export function PhaseBreakdown({
  task,
  compact = false,
}: {
  task: QueueItem;
  compact?: boolean;
}) {
  const t = useT();
  const history = task.progress?.history ?? [];
  const isLive = LIVE_STATUSES.has(task.status);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isLive]);

  if (history.length === 0) return null;

  const completedMs = task.completed_at
    ? new Date(task.completed_at).getTime()
    : null;

  const rows = history.map((h, i) => {
    const startMs = new Date(h.at).getTime();
    const next = history[i + 1];
    const endMs = next ? new Date(next.at).getTime() : completedMs ?? now;
    const isCurrent = !next && isLive && completedMs === null;
    return { phase: h.phase, durMs: Math.max(0, endMs - startMs), isCurrent };
  });

  return (
    <div
      style={{
        // compact (dùng trong WorkspaceTaskRail — hàng NGANG): bỏ viền/đệm trên
        // để phase nằm liền mạch cùng dòng với các cột khác, không trông như
        // xuống dòng mới. Bản đầy đủ (popover) vẫn có viền phân tách.
        marginTop: compact ? 0 : 8,
        paddingTop: compact ? 0 : 8,
        borderTop: compact ? "none" : "1px solid var(--border, #e5e7eb)",
      }}
    >
      {!compact && (
        <div
          style={{
            fontWeight: 600,
            marginBottom: 6,
            fontSize: 11.5,
            color: "var(--text-muted, #6b7280)",
            textTransform: "uppercase",
            letterSpacing: 0.4,
          }}
        >
          {t("queue.timing.phasesTitle")}
        </div>
      )}
      {rows.map((r, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
            fontSize: compact ? 10.5 : 12,
            lineHeight: compact ? 1.4 : 1.7,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              color: r.isCurrent ? "var(--info)" : "var(--ink-2, #374151)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {r.isCurrent ? "▸ " : ""}
            {r.phase}
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              color: r.isCurrent ? "var(--info)" : "var(--ink-3, #9ca3af)",
              flexShrink: 0,
            }}
          >
            {fmtDur(r.durMs)}
            {r.isCurrent ? "…" : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

function Row({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <span style={{ color: "var(--text-muted, #6b7280)" }}>{label}</span>
        <span style={{ fontFamily: "var(--font-mono)", textAlign: "right" }}>
          {value}
        </span>
      </div>
      {hint && (
        <div
          style={{
            textAlign: "right",
            fontSize: 11,
            color: "var(--info)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}
