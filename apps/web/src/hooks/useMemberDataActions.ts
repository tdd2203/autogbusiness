/**
 * Chức năng: Xuất dữ liệu / Xoá dữ liệu 1 thành viên — phía web/dashboard.
 *
 * 2 mục ChatGPT thêm vào menu "..." của member ĐÃ THAM GIA (2026-08). Backend chỉ
 * enqueue task (EXPORT_MEMBER_DATA / DELETE_MEMBER_DATA); extension mới thao tác
 * trên ChatGPT → onSuccess gọi `triggerExtensionRun()` để đánh thức extension.
 *
 * Quyền: `MEMBER_EXPORT_DATA` / `MEMBER_DELETE_DATA` — mặc định TẮT với mọi tài
 * khoản phụ (không nằm trong DEFAULT_SUB_ADMIN_PERMS, không backfill) ⇒ chỉ
 * super-admin dùng được cho tới khi admin cấp tay. UI vẫn HIỆN nút nhưng làm mờ.
 *
 * Backend: `apps/api/app/routers/members/data_actions.py` (+ `data_actions.md`).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { handleCommandBan } from "../lib/commandBan";
import { useT } from "../i18n";
import { toast } from "../components/Toast";
import { triggerExtensionRun } from "./useExtensionTrigger";

type DataActionResp = {
  status: "queued" | "already_queued";
  email: string;
  task_type: string;
};

export function useMemberDataActions(workspaceId: string | undefined) {
  const t = useT();
  const qc = useQueryClient();

  function mutationFor(path: "export-data" | "delete-data") {
    return {
      mutationFn: (memberId: string) =>
        api<DataActionResp>(
          `/api/v1/workspaces/${workspaceId}/members/${memberId}/${path}`,
          { method: "POST" },
        ),
      onSuccess: (resp: DataActionResp) => {
        const key =
          path === "export-data" ? "memberData.exportAction" : "memberData.deleteAction";
        toast.success(
          resp.status === "already_queued"
            ? t("memberData.alreadyQueued", { email: resp.email })
            : t("memberData.queued", { action: t(key), email: resp.email }),
        );
        // Bật lại poll queue để banner hoàn tất/thất bại của task hiện ra.
        qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
        triggerExtensionRun();
      },
      onError: (e: unknown) => {
        handleCommandBan(e);
      },
    };
  }

  const exportData = useMutation(mutationFor("export-data"));
  const deleteData = useMutation(mutationFor("delete-data"));

  return { exportData, deleteData };
}
