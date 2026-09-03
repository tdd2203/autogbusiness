/**
 * NGUỒN SUẤT (seat) DÙNG CHUNG cho toàn dashboard.
 *
 * ⚠️ ĐỌC `useWorkspaceSeats.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
 *
 * Mọi chỗ hiển thị "còn bao nhiêu suất" phải đọc qua hook này, không tự lấy
 * `workspace.seat_used` từ query danh sách (bản chụp lúc mở trang) hay từ
 * `/auto-invite/targets` (cache 5′ vì cấu hình đích ít đổi). Một biến, một nhịp
 * làm mới — hai trang mở cạnh nhau không thể nói hai con số khác nhau.
 *
 * Backend `GET /api/v1/workspaces/seats` đếm LẠI trong DB mỗi lần đọc
 * (`app/services/seats.py`), nên số trả về luôn là thời gian thực chứ không phải
 * số scrape từ trang billing ChatGPT.
 */
import { useMemo } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Platform } from "../types";

export type WorkspaceSeats = {
  workspace_id: string;
  name: string;
  /** Nhánh sản phẩm — trang mời dùng chung cho cả hai nhánh nên lọc đích theo đây. */
  platform: Platform;
  /** Tổng suất. Nhánh GPT: scrape qua SYNC_BILLING, null = chưa từng sync. Nhánh
   *  Canva: 50 suất có sẵn của gói, đặt lúc tạo team — ĐÃ KỂ CẢ chủ đội. */
  seat_total: number | null;
  /** Đang chiếm = thành viên + lời mời đang chờ, đếm lại trong DB mỗi lần đọc.
   *  Nhánh Canva cộng thêm suất giữ chỗ cho chủ đội khi bảng thành viên chưa quét
   *  được họ, nên có thể lớn hơn số dòng trong danh sách đúng 1. */
  seat_used: number;
  /** Còn trống. null = CHƯA BIẾT (chưa sync tổng) — khác hẳn 0 = hết suất. */
  seat_left: number | null;
  /** TRẦN THÀNH VIÊN do super-admin đặt. null = không chặn. */
  invite_member_cap?: number | null;
  /** Đã chạm trần (`seat_used >= invite_member_cap`) ⇒ backend chặn mọi lệnh mời
   *  vào không gian này. Chỉ admin nới trần hoặc gỡ bớt thành viên mới mời tiếp
   *  được — không có chuyện tự hết giờ. */
  invite_cap_reached?: boolean;
  /** Còn bao nhiêu suất nữa mới chạm trần. null/undefined = không đặt trần. */
  invite_cap_left?: number | null;
  /** Câu thông báo admin soạn, backend đã thay sẵn {ten}/{conlai}/{ngay}. In thẳng,
   *  đừng tự ghép chữ ở FE — luật thay chỗ chỉ sống ở `services/seats.py`. */
  invite_cap_message?: string | null;
};

export const WORKSPACE_SEATS_KEY = ["workspace-seats"] as const;

/** Nhịp tim làm mới suất. Payload rất nhẹ (1 dòng/workspace) nên poll thẳng được;
 * cần thiết vì suất còn đổi do extension mời/xoá, admin khác thao tác, hay job nền
 * chạy — những thứ tab này không invalidate được. */
const SEATS_POLL_MS = 15_000;

export function useWorkspaceSeats(enabled = true) {
  return useQuery<WorkspaceSeats[]>({
    queryKey: WORKSPACE_SEATS_KEY,
    queryFn: () => api<WorkspaceSeats[]>("/api/v1/workspaces/seats"),
    enabled,
    refetchInterval: SEATS_POLL_MS,
    refetchOnWindowFocus: true,
    // Suất là con số phải TƯƠI: quay lại tab thì đọc lại ngay, không dùng bản cache.
    staleTime: 0,
    retry: false,
  });
}

/** Tra suất theo workspace_id. Trả `undefined` khi chưa tải xong hoặc workspace
 * nằm ngoài tầm nhìn của người dùng. */
export function useSeatMap(enabled = true) {
  const q = useWorkspaceSeats(enabled);
  const map = useMemo(() => {
    const m = new Map<string, WorkspaceSeats>();
    for (const s of q.data ?? []) m.set(s.workspace_id, s);
    return m;
  }, [q.data]);
  return { seatMap: map, isLoading: q.isLoading, error: q.error };
}

/**
 * Gọi SAU MỌI hành động làm đổi số suất (mời, mời lại, xoá, đổi email, đồng bộ
 * thành viên, đồng bộ billing, mua thêm suất) để con số nhảy ngay thay vì chờ hết
 * nhịp tim 15s. Thiếu lời gọi này thì UI vẫn đúng, chỉ chậm tối đa một nhịp.
 */
export function invalidateWorkspaceSeats(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: WORKSPACE_SEATS_KEY });
}

/** Bản hook của `invalidateWorkspaceSeats` cho component không sẵn `qc`. */
export function useInvalidateWorkspaceSeats(): () => void {
  const qc = useQueryClient();
  return () => invalidateWorkspaceSeats(qc);
}
