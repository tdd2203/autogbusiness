/**
 * Hỏi TRƯỚC: gia hạn xong hạn tới đâu, thu bao nhiêu.
 *
 * VÌ SAO CÓ FILE NÀY: web từng tự tính `hạn cũ + tháng×30` và `đơn giá × số tháng`.
 * Ở không gian chốt theo chu kỳ hoá đơn thì hạn rơi đúng MỐC CHỐT và tiền tính theo
 * số ngày thật từ điểm nối tới mốc đó, nên cả hai con số trên màn hình đều sai — mà
 * sai im lặng: người bán báo giá với khách xong bấm nút mới ra số khác. Server là nơi
 * DUY NHẤT biết mốc chốt của từng không gian, nên nó chốt cả hạn lẫn tiền.
 *
 * Danh sách gia hạn gom XUYÊN không gian (trang Gia hạn, popup đến hạn ở Tổng quan)
 * nên hook gom theo `workspace_id` rồi hỏi mỗi nhóm một lượt — mirror cách ô mời gọi
 * `invite-preview`.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { FeeDetailRow } from "../components/FeeDetailModal";

/** Một dòng xem trước (`renew-preview → items`) — mở rộng của dòng chi tiết phí. */
export type RenewPreviewItem = FeeDetailRow & {
  member_id: string;
  /** Hạn ĐANG có, để hiện "cũ → mới". */
  current_end_at: string | null;
};

export type RenewPreviewTarget = { id: string; workspace_id: string };

type PreviewResponse = {
  total_fee: number;
  chargeable: boolean;
  items: RenewPreviewItem[];
  missing: string[];
};

export type RenewPreview = {
  /** Tra theo member_id — dòng nào server chưa trả thì màn hình tự lo phần dự phòng. */
  byMember: Map<string, RenewPreviewItem>;
  rows: RenewPreviewItem[];
  totalFee: number;
  /** User này có bị trừ tiền không (super-admin / chưa bật Ví → không). */
  chargeable: boolean;
};

export function useRenewPreview(
  targets: RenewPreviewTarget[],
  months: number,
  opts: { enabled?: boolean; purchasedAt?: string | null } = {},
) {
  const enabled = (opts.enabled ?? true) && targets.length > 0 && months >= 1;
  const purchasedAt = opts.purchasedAt ?? null;
  // Khoá theo (không gian, member, số tháng, mốc neo) — đổi số tháng là đổi cả hạn
  // lẫn tiền nên phải hỏi lại.
  const key = targets
    .map((t) => `${t.workspace_id}:${t.id}`)
    .sort()
    .join(",");

  return useQuery<RenewPreview>({
    queryKey: ["renew-preview", key, months, purchasedAt],
    enabled,
    // Đổi số tháng làm khoá query đổi ⇒ dữ liệu về `undefined` một nhịp và bảng nháy
    // sang con số tính tạm. Giữ kết quả cũ trong lúc chờ: nó chỉ lệch đúng phần vừa
    // gõ, còn số tạm thì sai hẳn ở không gian chốt theo chu kỳ.
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const groups = new Map<string, string[]>();
      for (const t of targets) {
        const arr = groups.get(t.workspace_id) ?? [];
        arr.push(t.id);
        groups.set(t.workspace_id, arr);
      }
      const byMember = new Map<string, RenewPreviewItem>();
      const rows: RenewPreviewItem[] = [];
      let totalFee = 0;
      let chargeable = false;
      for (const [ws, memberIds] of groups) {
        const r = await api<PreviewResponse>(
          `/api/v1/workspaces/${ws}/members/renew-preview`,
          {
            method: "POST",
            body: JSON.stringify({
              member_ids: memberIds,
              months,
              ...(purchasedAt ? { purchased_at: purchasedAt } : {}),
            }),
          },
        );
        totalFee += r.total_fee;
        chargeable = chargeable || r.chargeable;
        for (const item of r.items ?? []) {
          byMember.set(item.member_id, item);
          rows.push(item);
        }
      }
      return { byMember, rows, totalFee, chargeable };
    },
  });
}
