/**
 * Chức năng: Member Mutations (đổi vai trò / giấy phép / thu hồi lời mời / huỷ task)
 * — phía web/dashboard.
 *
 * ⚠️ ĐỌC `useMemberMutations.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
 *
 * Gom các mutation nghiệp vụ còn lại (trước đây nằm inline trong `pages/Members.tsx`,
 * KHÔNG bao gồm remove/bulk-remove/cleanup — những cái đó ở `useRemoveMembers`):
 *   - changeRole          → PATCH …/members/{id}/role
 *   - changeLicenseType   → PATCH …/members/{id}/license-type
 *   - bulkChangeLicense   → POST  …/members/bulk-change-license-type
 *   - revokeInvites       → POST  …/revoke-invites (thu hồi lời mời pending)
 *   - cancelTask          → POST  …/queue/{id}/cancel (huỷ task đang chạy, vd SYNC)
 *
 * Backend chỉ enqueue task; extension mới thực thi trên ChatGPT — vì vậy onSuccess
 * (role/license) gọi triggerExtensionRun() để đánh thức extension chạy ngay.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { handleCommandBan } from "../lib/commandBan";
import { useT } from "../i18n";
import { confirm, toast } from "../components/Toast";
import { triggerExtensionRun } from "./useExtensionTrigger";

type Role = "owner" | "admin" | "member" | "analytics_viewer";
type LicenseType = "ChatGPT" | "Codex";

export function useMemberMutations(
  workspaceId: string | undefined,
  opts?: {
    onBulkChangeLicenseCleared?: () => void;
    getCancelTaskType?: () => string | undefined;
  },
) {
  const t = useT();
  const qc = useQueryClient();

  const cancelTask = useMutation({
    mutationFn: async (taskId: string) => {
      const ok = await confirm(
        t("queue.cancelConfirm", {
          type: opts?.getCancelTaskType?.() ?? "SYNC_DATA",
        }),
        {
          title: t("queue.cancelConfirmTitle"),
          okText: t("queue.cancelOk"),
          cancelText: t("common.cancel"),
          danger: true,
        },
      );
      if (!ok) throw new Error("__user_cancel__");
      return api<{ id: string; status: string }>(
        `/api/v1/queue/${taskId}/cancel`,
        { method: "POST" },
      );
    },
    onSuccess: () => {
      toast.success(t("queue.cancelOkToast"));
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
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

  const revokeInvites = useMutation({
    mutationFn: (emails: string[]) =>
      api<{ queue_item_id: string; count: number }>(
        `/api/v1/workspaces/${workspaceId}/revoke-invites`,
        { method: "POST", body: JSON.stringify({ emails }) },
      ),
    onSuccess: (resp) => {
      toast.success(t("member.revokeToastOk", { n: resp.count }));
      // QUAN TRỌNG (fix 2026-06-18): PHẢI invalidate ["recent-tasks"] để:
      //   (a) task REVOKE_INVITES hiện ngay trên panel theo dõi (WorkspaceTaskRail);
      //   (b) khởi động lại poll recent-tasks (queuePollInterval DỪNG khi idle) →
      //       watcher trong Members.tsx (theo dõi task → terminal) mới bắt được lúc
      //       task COMPLETED và tự invalidate ["members"] → email thu hồi biến mất
      //       khỏi list mà KHÔNG cần reload tay.
      // Thiếu dòng này → task chạy ngầm, rail trống + list không tự cập nhật.
      // triggerExtensionRun(): đánh thức extension chạy ngay (giống role/license/remove).
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
      triggerExtensionRun();
    },
    onError: (e) => {
      if (handleCommandBan(e)) return;
      toast.error(
        t("member.revokeToastError", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    },
  });

  // "Đồng bộ 1 tài khoản lẻ" — kiểm tra 1 email (pending) đã tham gia chưa.
  // Backend chống-spam: lặp CÙNG email >3 lần liên tiếp → 403 COMMAND_BANNED
  // (cấm 10 phút + đá session). onError xử lý ban: toast + logout ngay.
  const syncMember = useMutation({
    mutationFn: (email: string) =>
      api<{ queue_item_id: string; status: string; deduplicated?: boolean }>(
        `/api/v1/workspaces/${workspaceId}/sync-member`,
        { method: "POST", body: JSON.stringify({ email }) },
      ),
    onSuccess: () => {
      toast.success(t("member.syncMemberQueued"));
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      triggerExtensionRun();
    },
    onError: (e) => {
      if (handleCommandBan(e)) return;
      toast.error(e instanceof Error ? e.message : String(e));
    },
  });

  // Đồng bộ HÀNG LOẠT các tài khoản pending đã chọn — không có endpoint bulk
  // riêng, nên fan-out gọi POST …/sync-member cho từng email (Promise.allSettled
  // để 1 email lỗi không huỷ cả mẻ). Mỗi email = 1 task SYNC_MEMBER; backend tự
  // dedupe email đang PENDING/IN_PROGRESS. Khác với SYNC_DATA (full-sync ở header)
  // vốn quét TOÀN workspace — bulk-sync chỉ kiểm tra đúng các email đã chọn.
  // Gộp 1 toast tổng (thay vì N toast như gọi syncMember lặp tay).
  const bulkSyncMembers = useMutation({
    mutationFn: async (emails: string[]) => {
      const results = await Promise.allSettled(
        emails.map((email) =>
          api(`/api/v1/workspaces/${workspaceId}/sync-member`, {
            method: "POST",
            body: JSON.stringify({ email }),
          }),
        ),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      return { ok, failed: results.length - ok };
    },
    onSuccess: ({ ok, failed }) => {
      toast.success(t("bulkSync.resultQueued", { n: ok }));
      if (failed > 0) toast.error(t("bulkSync.resultPartial", { n: failed }));
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      triggerExtensionRun();
    },
    onError: (e) => {
      if (handleCommandBan(e)) return;
      toast.error(e instanceof Error ? e.message : String(e));
    },
  });

  const changeRole = useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: Role }) =>
      api(`/api/v1/workspaces/${workspaceId}/members/${memberId}/role`, {
        method: "PATCH",
        body: JSON.stringify({ new_role: role }),
      }),
    onSuccess: () => {
      // PHẢI invalidate ["recent-tasks"] để KHỞI ĐỘNG LẠI poll queue (dừng khi
      // idle): task CHANGE_ROLE vừa enqueue là PENDING → poll bật lại → watcher
      // trong Members.tsx bắt được lúc task COMPLETED → tự invalidate ["members"]
      // → role mới hiện ngay, KHỎI reload tay. Thiếu dòng này: chỉ refetch members
      // tức thì (DB chưa đổi vì extension chưa chạy) rồi poll im → không tự cập nhật.
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
      triggerExtensionRun();
    },
    onError: (e) => {
      handleCommandBan(e);
    },
  });

  const changeLicenseType = useMutation({
    mutationFn: ({
      memberId,
      licenseType,
    }: {
      memberId: string;
      licenseType: LicenseType;
    }) =>
      api(`/api/v1/workspaces/${workspaceId}/members/${memberId}/license-type`, {
        method: "PATCH",
        body: JSON.stringify({ new_license_type: licenseType }),
      }),
    onSuccess: () => {
      // Xem changeRole: invalidate ["recent-tasks"] để poll bật lại → watcher tự
      // refresh ["members"] khi CHANGE_LICENSE_TYPE COMPLETED (seat type mới hiện
      // ngay không cần F5).
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
      triggerExtensionRun();
    },
    onError: (e) => {
      handleCommandBan(e);
    },
  });

  const bulkChangeLicense = useMutation({
    mutationFn: ({
      memberIds,
      licenseType,
    }: {
      memberIds: string[];
      licenseType: LicenseType;
    }) =>
      api<{ count: number; emails: string[]; already: string[]; skipped: string[] }>(
        `/api/v1/workspaces/${workspaceId}/members/bulk-change-license-type`,
        {
          method: "POST",
          body: JSON.stringify({
            member_ids: memberIds,
            new_license_type: licenseType,
          }),
        },
      ),
    onSuccess: (resp) => {
      toast.success(t("bulkLicense.resultQueued", { n: resp.count }));
      opts?.onBulkChangeLicenseCleared?.();
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      triggerExtensionRun();
    },
    onError: (e) => {
      if (handleCommandBan(e)) return;
      toast.error(e instanceof Error ? e.message : String(e));
    },
  });

  return {
    changeRole,
    changeLicenseType,
    bulkChangeLicense,
    revokeInvites,
    syncMember,
    bulkSyncMembers,
    cancelTask,
  };
}
