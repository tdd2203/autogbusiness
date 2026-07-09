/**
 * Chức năng: Change Email (đổi email member) — phía web/dashboard.
 *
 * ⚠️ ĐỌC `useChangeEmail.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
 *
 * Đổi email = backend enqueue REMOVE_MEMBER (email cũ) + INVITE_MEMBER (email mới),
 * GIỮ NGUYÊN hạn dùng cũ. Hook chỉ gọi 1 endpoint; backend lo phần tách 2 task.
 *
 * onSuccess PHẢI invalidate ["recent-tasks"] để khởi động lại poll queue (giống
 * useRemoveMembers) → watcher trong Members.tsx bắt được khi 2 task COMPLETED →
 * tự refresh ["members"] mà không cần F5. triggerExtensionRun() đánh thức extension.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { handleCommandBan } from "../lib/commandBan";
import { useT } from "../i18n";
import { toast } from "../components/Toast";
import { triggerExtensionRun } from "./useExtensionTrigger";
import type { Member } from "../types";

export function useChangeEmail(workspaceId: string | undefined) {
  const t = useT();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({
      memberId,
      newEmail,
    }: {
      memberId: string;
      newEmail: string;
    }) =>
      api<Member>(
        `/api/v1/workspaces/${workspaceId}/members/${memberId}/change-email`,
        { method: "POST", body: JSON.stringify({ new_email: newEmail }) },
      ),
    onSuccess: (m) => {
      toast.success(t("member.changeEmailOk", { email: m.email }));
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
      triggerExtensionRun();
    },
    onError: (e) => {
      if (handleCommandBan(e)) return;
      toast.error(e instanceof Error ? e.message : String(e));
    },
  });
}
