/**
 * Panel HÀNG ĐỢI TÁC VỤ — nằm NGANG bên trên bảng danh sách thành viên (trước đây
 * là cột phải). Chỉ bản web máy tính.
 *
 * CHỈ hiển thị task ĐANG CHẠY / ĐANG CHỜ (IN_PROGRESS + PENDING) của workspace để
 * mọi admin (chính + phụ) theo dõi đúng thứ tự chạy tuần tự — task đã xong
 * (COMPLETED/FAILED) KHÔNG hiện ở đây (xem tab Queue cho lịch sử). Xếp theo
 * created_at TĂNG dần (đúng thứ tự FIFO extension pick), đánh số 1·2·3…, các card
 * xếp ngang (flex-wrap). Mỗi item có <TaskTimingCell> (đồng hồ đếm live) + dòng
 * tiến trình (phase + current/total). KHÔNG có task đang chạy/chờ → hiện empty-state
 * (panel vẫn hiển thị, không biến mất).
 *
 * Quyền hiển thị / huỷ (backend quyết định, xem routers/queue/admin.md):
 *   - Danh tính người tạo (`created_by_username`): CHỈ super-admin thấy → dòng
 *     "Bởi <tên>". Sub-admin thấy task nhưng KHÔNG biết của ai.
 *   - Nút Huỷ: chỉ hiện khi `task.can_cancel` (super OR người tạo) và task chưa
 *     terminal. POST /api/v1/queue/{id}/cancel.
 *
 * Dữ liệu lấy từ prop `tasks` (WorkspaceLayout đã poll ["recent-tasks", wsId] mỗi
 * 2s) → KHÔNG fetch thêm, không tự poll. Desktop-only: ẩn (<1024px) để layout
 * mobile không vỡ — bản mobile dùng tab Queue như cũ.
 */

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { confirm, toast } from "./Toast";
import { useT, useTranslateEnum } from "../i18n";
import { useAuth } from "../hooks/useAuth";
import type { QueueItem } from "../types";
import { TaskTimingCell, PhaseBreakdown } from "./TaskTimingCell";

const STATUS_BADGE: Record<string, string> = {
  PENDING: "badge badge-neutral",
  IN_PROGRESS: "badge badge-warning",
  COMPLETED: "badge badge-success",
  FAILED: "badge badge-danger",
};

/** true khi viewport ≥ 1024px (bản web máy tính). Tick theo resize.
 * Export để WorkspaceLayout biết rail có render hay không → dựng layout 2 cột
 * (đặt spacer giữ chỗ cột phải) khớp với việc rail tự ẩn <1024px. */
export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= 1024,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setDesktop(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return desktop;
}

function byCreatedAsc(a: QueueItem, b: QueueItem) {
  return a.created_at.localeCompare(b.created_at);
}

export function WorkspaceTaskRail({
  workspaceId,
  tasks,
}: {
  workspaceId: string;
  tasks: QueueItem[];
}) {
  const t = useT();
  const tStatus = useTranslateEnum("status");
  const tTaskType = useTranslateEnum("taskType");
  const { user } = useAuth();
  const isSuper = !!user?.is_super_admin;
  const qc = useQueryClient();
  const isDesktop = useIsDesktop();

  const cancelTask = useMutation({
    mutationFn: async (task: QueueItem) => {
      const ok = await confirm(
        t("queue.cancelConfirm", { type: tTaskType(task.type) }),
        {
          title: t("queue.cancelConfirmTitle"),
          okText: t("queue.cancelOk"),
          cancelText: t("common.cancel"),
          danger: true,
        },
      );
      if (!ok) throw new Error("__user_cancel__");
      return api<{ id: string; status: string }>(
        `/api/v1/queue/${task.id}/cancel`,
        { method: "POST" },
      );
    },
    onSuccess: () => {
      toast.success(t("queue.cancelOkToast"));
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
      qc.invalidateQueries({ queryKey: ["queue", workspaceId] });
    },
    onError: (e) => {
      if (e instanceof Error && e.message === "__user_cancel__") return;
      toast.error(
        t("queue.cancelError", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    },
  });

  // Bản mobile: ẩn panel (dùng tab Queue thay thế).
  if (!isDesktop) return null;

  const active = tasks
    .filter((it) => it.status === "PENDING" || it.status === "IN_PROGRESS")
    .sort(byCreatedAsc);

  return (
    <div
      className="table-card"
      style={{ marginBottom: 24 }}
      aria-label={t("queue.rail.title")}
    >
      <div className="table-head">
        <div className="table-title">{t("queue.rail.title")}</div>
        {active.length > 0 && (
          <span className="badge badge-warning">{active.length}</span>
        )}
      </div>

      {/* Mỗi task = 1 dòng full-width, nội dung xếp ngang (xem TaskRailItem). */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12 }}>
        {active.length === 0 ? (
          <div
            className="cell-muted"
            style={{ textAlign: "center", padding: "16px 8px", fontSize: 13, width: "100%" }}
          >
            {t("queue.rail.empty")}
          </div>
        ) : (
          active.map((task, i) => (
            <TaskRailItem
              key={task.id}
              task={task}
              order={i + 1}
              isSuper={isSuper}
              statusBadge={STATUS_BADGE[task.status] ?? "badge badge-neutral"}
              typeLabel={tTaskType(task.type)}
              statusLabel={tStatus(task.status)}
              onCancel={() => cancelTask.mutate(task)}
              canceling={cancelTask.isPending}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TaskRailItem({
  task,
  order,
  isSuper,
  statusBadge,
  typeLabel,
  statusLabel,
  onCancel,
  canceling,
}: {
  task: QueueItem;
  order?: number;
  isSuper: boolean;
  statusBadge: string;
  typeLabel: string;
  statusLabel: string;
  onCancel?: () => void;
  canceling?: boolean;
}) {
  const t = useT();
  const progress = task.progress;
  const progressText =
    task.status === "IN_PROGRESS" && progress
      ? (progress.message as string | undefined) ??
        t(`progress.${progress.phase ?? "IN_PROGRESS"}`)
      : null;
  const canCancel =
    !!task.can_cancel &&
    (task.status === "PENDING" || task.status === "IN_PROGRESS");

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "5px 10px",
        background: "var(--surface)",
        // Dòng ngang full-width: nội dung xếp ngang, wrap khi hẹp.
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
      }}
    >
      <span
        className="action-name"
        style={{ fontSize: 12, fontWeight: 600, flexShrink: 0 }}
      >
        {order != null && (
          <span style={{ color: "var(--ink-3)", marginRight: 3 }}>{order}.</span>
        )}
        {typeLabel}
      </span>

      <span className={statusBadge} style={{ flexShrink: 0 }}>
        {statusLabel}
      </span>

      <div style={{ fontSize: 11, flexShrink: 0 }}>
        <TaskTimingCell task={task} />
      </div>

      {progressText && (
        <div style={{ color: "var(--info)", fontSize: 11, minWidth: 0 }}>
          {progressText}
          {typeof progress?.current === "number" && (
            <>
              {" "}
              ({String(progress.current)}
              {typeof progress?.total === "number"
                ? `/${progress.total}`
                : ""}
              )
            </>
          )}
        </div>
      )}

      {/* Phân rã thời lượng từng giai đoạn (live) — admin xem bước nào chậm. */}
      <div style={{ flexShrink: 0 }}>
        <PhaseBreakdown task={task} compact />
      </div>

      {isSuper && task.created_by_username && (
        <div style={{ fontSize: 10.5, color: "var(--ink-3)", flexShrink: 0 }}>
          {t("queue.rail.requestedBy", { name: task.created_by_username })}
        </div>
      )}

      {canCancel && onCancel && (
        <button
          onClick={onCancel}
          disabled={canceling}
          className="btn btn-ghost btn-sm"
          style={{ marginLeft: "auto", color: "var(--danger)", flexShrink: 0 }}
        >
          {canceling ? t("queue.cancelOkBusy") : t("queue.cancel")}
        </button>
      )}
    </div>
  );
}
