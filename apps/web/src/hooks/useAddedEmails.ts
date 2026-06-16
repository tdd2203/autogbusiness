/**
 * Chức năng: Added Emails (email đã thêm) — phía web/dashboard.
 *
 * ⚠️ ĐỌC `useAddedEmails.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
 *
 * Gom 2 mutation gọi API (trước đây nằm inline trong `pages/AddedEmails.tsx`):
 *   - markPaid       → POST /added-members/mark-paid    (duyệt / huỷ thanh toán)
 *   - transferOwner  → POST /added-members/transfer-owner (chuyển / thu hồi sở hữu)
 *
 * Cả hai onSuccess đều bỏ chọn checkbox (clear selection) → component truyền
 * callback `onCleared` thay cho `setSelected(new Set())` inline.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n";
import { toast } from "../components/Toast";

export function useAddedEmails(opts?: { onCleared?: () => void }) {
  const t = useT();
  const qc = useQueryClient();

  const markPaid = useMutation({
    mutationFn: (vars: { ids: string[]; paid: boolean }) =>
      api<{ count: number; paid: boolean }>(
        "/api/v1/added-members/mark-paid",
        {
          method: "POST",
          body: JSON.stringify({ member_ids: vars.ids, paid: vars.paid }),
        },
      ),
    onSuccess: (resp) => {
      toast.success(
        resp.paid
          ? t("addedEmails.markPaidOk", { n: resp.count })
          : t("addedEmails.markUnpaidOk", { n: resp.count }),
      );
      opts?.onCleared?.();
      qc.invalidateQueries({ queryKey: ["added-members"] });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : String(e));
    },
  });

  // Super-admin: chuyển/thu hồi quyền sở hữu. Thu hồi = chuyển về chính admin.
  const transferOwner = useMutation({
    mutationFn: (vars: { ids: string[]; targetUserId: string }) =>
      api<{ count: number; target_username: string }>(
        "/api/v1/added-members/transfer-owner",
        {
          method: "POST",
          body: JSON.stringify({
            member_ids: vars.ids,
            target_user_id: vars.targetUserId,
          }),
        },
      ),
    onSuccess: (resp) => {
      toast.success(`Đã chuyển ${resp.count} email cho ${resp.target_username}`);
      opts?.onCleared?.();
      qc.invalidateQueries({ queryKey: ["added-members"] });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : String(e));
    },
  });

  return { markPaid, transferOwner };
}
