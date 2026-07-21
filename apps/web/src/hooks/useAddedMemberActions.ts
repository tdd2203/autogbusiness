/**
 * Chức năng: thao tác theo DÒNG cho trang "Email đã thêm" (AddedEmails) — enqueue
 * task extension cho 1 email cụ thể (Đồng bộ / Thu hồi / Xoá).
 *
 * Khác useMemberMutations / useRemoveMembers (khoá 1 workspaceId lúc khởi tạo):
 * trang "Email đã thêm" gom email XUYÊN NHIỀU workspace, mỗi dòng có workspace_id
 * riêng → workspaceId phải truyền theo TỪNG lời gọi mutation (trong vars), không
 * cố định ở hook. Vì vậy onSuccess invalidate ["added-members"] (list trang này)
 * thay vì ["members", wsId]. Vẫn invalidate ["members"]/["recent-tasks"] để bảng
 * Thành viên cấp workspace (nếu đang mở) cũng làm mới, và triggerExtensionRun()
 * đánh thức extension chạy ngay (giống các hook cùng loại).
 *
 * Lưu ý: sync/revoke/remove chỉ ENQUEUE task; extension mới thực thi trên ChatGPT.
 * AddedEmails.tsx có watcher poll ["recent-tasks-global"] (mô phỏng Members.tsx):
 * khi task chuyển sang terminal (COMPLETED/FAILED) → invalidate ["added-members"]
 * lần 2 lúc DB đã đổi → dòng tự biến mất/cập nhật mà KHÔNG cần F5. refresh() ở đây
 * invalidate ["recent-tasks-global"] để poll đó bật lại ngay sau enqueue.
 *
 * Endpoint dùng lại y hệt tab Thành viên:
 *   - sync   → POST   /workspaces/{wsId}/sync-member      { email }
 *   - revoke → POST   /workspaces/{wsId}/revoke-invites   { emails: [email] }
 *   - remove → DELETE /workspaces/{wsId}/members/{memberId}
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { getQrOrder, type OrderQr } from "../lib/wallet";
import { handleCommandBan } from "../lib/commandBan";
import { useT } from "../i18n";
import { toast } from "../components/Toast";
import { triggerExtensionRun } from "./useExtensionTrigger";

export function useAddedMemberActions(opts?: {
  /** Mời lại email HẾT HẠN + ví thiếu → 402 kèm QR. Có callback → mở modal QR. */
  onPaymentRequired?: (order: OrderQr) => void;
}) {
  const t = useT();
  const qc = useQueryClient();

  // Làm mới sau khi enqueue: list trang này + bảng member workspace (nếu mở) +
  // poll queue (để watcher bắt task terminal). Đánh thức extension.
  //
  // Lưu ý: invalidate ["added-members"] Ở ĐÂY chỉ refetch NGAY lúc task vừa được
  // ENQUEUE — DB chưa đổi (member còn pending) nên dòng chưa biến mất. Việc dòng
  // TỰ cập nhật khi extension làm xong do watcher poll ["recent-tasks-global"] trong
  // AddedEmails.tsx đảm nhiệm (invalidate ["added-members"] lần 2 lúc task terminal).
  // Vì vậy invalidate CẢ ["recent-tasks-global"] (poll trang này) LẪN ["recent-tasks"]
  // (poll của Members/WorkspaceLayout nếu đang mở) để poll bật lại tức thì.
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["added-members"] });
    qc.invalidateQueries({ queryKey: ["members"] });
    qc.invalidateQueries({ queryKey: ["recent-tasks"] });
    qc.invalidateQueries({ queryKey: ["recent-tasks-global"] });
    triggerExtensionRun();
  };

  // Đồng bộ 1 tài khoản pending — kiểm tra đã tham gia chưa. Chống spam ở BE:
  // lặp cùng email >3 lần → 403 COMMAND_BANNED → handleCommandBan logout.
  const sync = useMutation({
    mutationFn: ({ workspaceId, email }: { workspaceId: string; email: string }) =>
      api<{ queue_item_id: string; status: string; deduplicated?: boolean }>(
        `/api/v1/workspaces/${workspaceId}/sync-member`,
        { method: "POST", body: JSON.stringify({ email }) },
      ),
    onSuccess: () => {
      toast.success(t("member.syncMemberQueued"));
      refresh();
    },
    onError: (e) => {
      if (handleCommandBan(e)) return;
      toast.error(e instanceof Error ? e.message : String(e));
    },
  });

  // Thu hồi lời mời pending của 1 email.
  const revoke = useMutation({
    mutationFn: ({ workspaceId, email }: { workspaceId: string; email: string }) =>
      api<{ queue_item_id: string; count: number }>(
        `/api/v1/workspaces/${workspaceId}/revoke-invites`,
        { method: "POST", body: JSON.stringify({ emails: [email] }) },
      ),
    onSuccess: (resp) => {
      toast.success(t("member.revokeToastOk", { n: resp.count }));
      refresh();
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

  // Đồng bộ HÀNG LOẠT (kiểm tra đã tham gia) xuyên nhiều workspace: gom email theo
  // workspace rồi gửi 1 task SYNC_MEMBERS_BATCH cho MỖI workspace (endpoint chỉ nhận
  // email cùng 1 workspace). Khớp nút "Đồng bộ (kiểm tra đã tham gia)" của tab
  // "Chờ tham gia" trong workspace, nhưng ở đây quét ở TẤT CẢ không gian.
  const bulkSync = useMutation({
    mutationFn: async (rows: { workspaceId: string; email: string }[]) => {
      const byWs = new Map<string, string[]>();
      for (const r of rows) {
        const arr = byWs.get(r.workspaceId) ?? [];
        arr.push(r.email);
        byWs.set(r.workspaceId, arr);
      }
      await Promise.all(
        Array.from(byWs, ([wsId, emails]) =>
          api(`/api/v1/workspaces/${wsId}/sync-members-batch`, {
            method: "POST",
            body: JSON.stringify({ emails }),
          }),
        ),
      );
      return rows.length;
    },
    onSuccess: (n) => {
      toast.success(t("bulkSync.resultQueued", { n }));
      refresh();
    },
    onError: (e) => {
      if (handleCommandBan(e)) return;
      toast.error(e instanceof Error ? e.message : String(e));
    },
  });

  // Thu hồi lời mời HÀNG LOẠT xuyên nhiều workspace: gom email theo workspace rồi
  // gọi revoke-invites cho MỖI workspace. Tổng số thu hồi được cộng dồn để báo toast.
  const bulkRevoke = useMutation({
    mutationFn: async (rows: { workspaceId: string; email: string }[]) => {
      const byWs = new Map<string, string[]>();
      for (const r of rows) {
        const arr = byWs.get(r.workspaceId) ?? [];
        arr.push(r.email);
        byWs.set(r.workspaceId, arr);
      }
      const results = await Promise.all(
        Array.from(byWs, ([wsId, emails]) =>
          api<{ queue_item_id: string; count: number }>(
            `/api/v1/workspaces/${wsId}/revoke-invites`,
            { method: "POST", body: JSON.stringify({ emails }) },
          ),
        ),
      );
      return results.reduce((sum, r) => sum + r.count, 0);
    },
    onSuccess: (n) => {
      toast.success(t("member.revokeToastOk", { n }));
      refresh();
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

  // Xoá 1 thành viên đã tham gia (active) khỏi workspace.
  const remove = useMutation({
    mutationFn: ({
      workspaceId,
      memberId,
    }: {
      workspaceId: string;
      memberId: string;
    }) =>
      api(`/api/v1/workspaces/${workspaceId}/members/${memberId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success(t("member.removeQueued"));
      refresh();
    },
    onError: (e) => {
      if (handleCommandBan(e)) return;
      toast.error(e instanceof Error ? e.message : String(e));
    },
  });

  // Mời lại (re-invite) email pending khi lời mời lỗi. Còn hạn → miễn phí; hết hạn →
  // tính phí (ví trước, QR sau — 402 mở modal QR nếu ví thiếu).
  const reinvite = useMutation({
    mutationFn: ({
      workspaceId,
      memberId,
    }: {
      workspaceId: string;
      memberId: string;
    }) =>
      api(`/api/v1/workspaces/${workspaceId}/members/${memberId}/re-invite`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast.success(t("member.reinviteQueuedShort"));
      refresh();
    },
    onError: (e) => {
      const order = getQrOrder(e);
      if (order && opts?.onPaymentRequired) {
        opts.onPaymentRequired(order);
        return;
      }
      if (handleCommandBan(e)) return;
      const msg =
        e instanceof ApiError
          ? typeof e.detail === "object" && e.detail
            ? String(
                (e.detail as { message?: string }).message ??
                  JSON.stringify(e.detail),
              )
            : String(e.detail)
          : e instanceof Error
            ? e.message
            : String(e);
      toast.error(msg);
    },
  });

  return { sync, revoke, remove, reinvite, bulkSync, bulkRevoke };
}
