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
 *   - bulkSetOwner        → POST  …/members/bulk-set-owner (chuyển chủ nhanh, super-admin)
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
    onBulkSetOwnerCleared?: () => void;
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

  // Đồng bộ HÀNG LOẠT các tài khoản pending đã chọn — gom vào ĐÚNG MỘT task
  // SYNC_MEMBERS_BATCH (POST …/sync-members-batch). Extension vào tab "Người dùng"
  // (Users) trên ChatGPT ĐÚNG 1 lần rồi tìm TỪNG email trong danh sách → thấy =
  // đã tham gia (promote active), không = giữ pending (logic mới 2026-07-15, không
  // còn quét tab "Lời mời"). Thay cho cách fan-out N task SYNC_MEMBER cũ (user
  // report 2026-07-06). Bản `bulkSyncMembers` này gửi các email ĐÃ CHỌN ở tab
  // "Chờ tham gia"; nút "Đồng bộ lời mời" ở header gửi all_pending=true (toàn bộ).
  const bulkSyncMembers = useMutation({
    mutationFn: (emails: string[]) =>
      api<{ queue_item_id: string; status: string; count: number }>(
        `/api/v1/workspaces/${workspaceId}/sync-members-batch`,
        { method: "POST", body: JSON.stringify({ emails }) },
      ),
    onSuccess: (_resp, emails) => {
      toast.success(t("bulkSync.resultQueued", { n: emails.length }));
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

  // Chuyển chủ NHANH (super-admin): gán/thu hồi chủ sở hữu cho các member đã chọn.
  // Đây là thay đổi THUẦN DỮ LIỆU (chỉ đổi invited_by_user_id trong DB) — KHÔNG
  // enqueue task extension → không cần triggerExtensionRun / poll recent-tasks.
  // targetUserId = null → thu hồi (member về "chưa có chủ"). targetName chỉ dùng
  // cho toast (hook không tự tra tên từ id).
  const bulkSetOwner = useMutation({
    mutationFn: ({
      memberIds,
      targetUserId,
    }: {
      memberIds: string[];
      targetUserId: string | null;
      targetName: string;
    }) =>
      api<{ assigned: number; skipped_owner: number; requested: number }>(
        `/api/v1/workspaces/${workspaceId}/members/bulk-set-owner`,
        {
          method: "POST",
          body: JSON.stringify({
            member_ids: memberIds,
            invited_by_user_id: targetUserId,
          }),
        },
      ),
    onSuccess: (resp, vars) => {
      toast.success(
        t("bulkTransferOwner.resultOk", {
          n: resp.assigned,
          name: vars.targetName,
        }),
      );
      opts?.onBulkSetOwnerCleared?.();
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      qc.invalidateQueries({ queryKey: ["member-stats", workspaceId] });
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
    bulkSetOwner,
    revokeInvites,
    syncMember,
    bulkSyncMembers,
    cancelTask,
  };
}
