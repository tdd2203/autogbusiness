/**
 * Bong bóng "đang có lệnh chạy" — nổi ở góc màn hình trên MỌI trang.
 *
 * Vì sao có (user 2026-08-04): panel hàng đợi (`WorkspaceTaskRail`) chỉ tồn tại ở
 * cột phải màn hình workspace trên máy tính. Bấm một lệnh từ trang khác — "Email đã
 * thêm", "Gia hạn", đồng bộ email đã tham gia… — thì không còn chỗ nào cho biết lệnh
 * đang chạy tới đâu, phải tự mở tab Hàng đợi mà xem. Trên điện thoại thì không có
 * panel nào cả. Bong bóng này lấp đúng khoảng trống đó: có lệnh đang chạy thì hiện,
 * bấm vào xem chi tiết, hết lệnh thì tự biến mất.
 *
 * Dữ liệu: `GET /api/v1/queue?limit=30` KHÔNG kèm workspace_id — backend trả
 * (super-admin) mọi task, (tài khoản phụ) chỉ task do CHÍNH MÌNH tạo. Đúng ngữ nghĩa
 * "lệnh của tôi đang chạy", và không rò task chéo workspace. Xem `queue/admin.py`.
 *
 * KHÔNG hiện khi `WorkspaceTaskRail` đang hiện (máy tính ≥1024px + đang ở trong 1
 * workspace) — hai thứ cùng nói một chuyện, hiện cả hai là thừa.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { useT, useTranslateEnum } from "../i18n";
import { useAuth } from "../hooks/useAuth";
import { useIsMobile } from "../hooks/useIsMobile";
import { queuePollInterval } from "../lib/queuePolling";
import { TaskTimingCell } from "./TaskTimingCell";
import { progressLine } from "../lib/taskProgress";
import type { QueueItem } from "../types";

const ACTIVE = new Set(["PENDING", "IN_PROGRESS"]);

/** Email trong payload (mỗi loại lệnh đặt một kiểu) — để biết lệnh đang làm cho ai. */
function payloadEmail(task: QueueItem): string | null {
  const p = (task.payload ?? {}) as Record<string, unknown>;
  if (typeof p.email === "string") return p.email;
  if (Array.isArray(p.emails) && typeof p.emails[0] === "string") {
    const n = p.emails.length;
    return n > 1 ? `${p.emails[0]} +${n - 1}` : (p.emails[0] as string);
  }
  const entries = p.entries;
  if (Array.isArray(entries) && entries.length > 0) {
    const first = entries[0] as { email?: unknown };
    if (typeof first?.email === "string") {
      return entries.length > 1
        ? `${first.email} +${entries.length - 1}`
        : first.email;
    }
  }
  return null;
}

export function RunningTaskBubble() {
  const { user, hasPermission } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  // Rail cột phải đã lo phần này ở màn hình workspace trên máy tính (≥1024px).
  // Dùng hook có listener để xoay/thu cửa sổ là cập nhật ngay, không kẹt trạng thái
  // lúc mount.
  const narrow = useIsMobile(1023);
  const railVisible =
    !narrow && /^\/workspaces\/[^/]+/.test(location.pathname);

  const canView = !!user && hasPermission("QUEUE_VIEW");
  const { data: tasks = [] } = useQuery({
    queryKey: ["active-tasks-global"],
    queryFn: () => api<QueueItem[]>("/api/v1/queue?limit=30"),
    enabled: canView && !railVisible,
    // Cùng nhịp với rail: 2s khi có lệnh chạy, 10s lúc rảnh (để thấy cả lệnh do
    // người/phiên khác tạo). Xem lib/queuePolling.
    refetchInterval: queuePollInterval(2000, 10000),
    // Thiếu quyền/hết phiên → im lặng ẩn, không nhảy toast lỗi ở mọi trang.
    retry: false,
  });

  const active = tasks.filter((x) => ACTIVE.has(x.status));

  // Hết lệnh thì đóng luôn bảng chi tiết (nếu đang mở) để không còn khung rỗng.
  useEffect(() => {
    if (active.length === 0 && open) setOpen(false);
  }, [active.length, open]);

  if (!canView || railVisible || active.length === 0) return null;

  return <TaskBubbleView active={active} open={open} onToggle={setOpen} />;
}

/**
 * Phần HIỂN THỊ thuần — không tự fetch, nhận thẳng danh sách task đang chạy.
 * Tách ra để dựng preview/test khối này mà không cần đăng nhập cả dashboard.
 */
export function TaskBubbleView({
  active,
  open,
  onToggle,
}: {
  active: QueueItem[];
  open: boolean;
  onToggle: (fn: (v: boolean) => boolean) => void;
}) {
  const t = useT();
  const taskTypeLabel = useTranslateEnum("taskType");
  const statusLabel = useTranslateEnum("status");
  const running = active.filter((x) => x.status === "IN_PROGRESS").length;

  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: "calc(16px + env(safe-area-inset-bottom, 0px))",
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 10,
        maxWidth: "min(360px, calc(100vw - 32px))",
      }}
    >
      {open && (
        <div
          className="table-card"
          style={{
            width: "min(360px, calc(100vw - 32px))",
            maxHeight: "min(60vh, 420px)",
            overflowY: "auto",
            padding: 12,
            display: "grid",
            gap: 8,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
              {t("taskBubble.title")}
            </span>
            <button
              type="button"
              onClick={() => onToggle(() => false)}
              aria-label={t("common.close")}
              style={{
                border: "1px solid var(--border)",
                background: "var(--surface)",
                borderRadius: 8,
                width: 24,
                height: 24,
                cursor: "pointer",
                color: "var(--ink-3)",
                fontSize: 12,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>

          {active.map((task) => {
            const email = payloadEmail(task);
            const line = progressLine(t, task);
            return (
              <div
                key={task.id}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "9px 11px",
                  background: "var(--bg)",
                  display: "grid",
                  gap: 3,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <span
                    style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}
                  >
                    {taskTypeLabel(task.type)}
                  </span>
                  <span
                    className={
                      task.status === "IN_PROGRESS"
                        ? "badge badge-warning badge-plain"
                        : "badge badge-neutral badge-plain"
                    }
                  >
                    {statusLabel(task.status)}
                  </span>
                </div>
                {email && (
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      color: "var(--ink-2)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={email}
                  >
                    {email}
                  </div>
                )}
                {line && (
                  <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{line}</div>
                )}
                <TaskTimingCell task={task} />
              </div>
            );
          })}
        </div>
      )}

      <button
        type="button"
        onClick={() => onToggle((v) => !v)}
        aria-label={t("taskBubble.aria", { n: active.length })}
        title={t("taskBubble.aria", { n: active.length })}
        style={{
          width: 52,
          height: 52,
          borderRadius: "50%",
          border: "1px solid var(--border)",
          background: "var(--surface)",
          boxShadow: "0 10px 24px -12px rgba(0,0,0,.45)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          padding: 0,
        }}
      >
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: running > 0 ? "var(--warning)" : "var(--ink-3)",
            animation: running > 0 ? "taskBubblePulse 1.4s ease-in-out infinite" : undefined,
          }}
        />
        <span
          style={{
            position: "absolute",
            top: -4,
            right: -4,
            minWidth: 20,
            height: 20,
            padding: "0 5px",
            borderRadius: 999,
            background: "var(--ink)",
            color: "var(--surface)",
            fontSize: 11,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {active.length}
        </span>
      </button>
    </div>
  );
}
