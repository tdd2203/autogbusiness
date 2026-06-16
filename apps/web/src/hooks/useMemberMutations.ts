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
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
    },
    onError: (e) => {
      toast.error(
        t("member.revokeToastError", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    },
  });

  const changeRole = useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: Role }) =>
      api(`/api/v1/workspaces/${workspaceId}/members/${memberId}/role`, {
        method: "PATCH",
        body: JSON.stringify({ new_role: role }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      triggerExtensionRun();
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
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      triggerExtensionRun();
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
      toast.error(e instanceof Error ? e.message : String(e));
    },
  });

  return { changeRole, changeLicenseType, bulkChangeLicense, revokeInvites, cancelTask };
}
