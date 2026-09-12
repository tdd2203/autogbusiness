/**
 * Hook cho trang "Mời thành viên" (phía người dùng, tính năng TEST).
 *
 * Mô hình: mỗi người dùng được cấp cố định 1 workspace. Hook này chỉ RESOLVE workspace
 * đó (id + tên + ghế) qua endpoint riêng `/api/v1/auto-invite/target`. Việc mời thật +
 * tính phí TÁI SỬ DỤNG hook/endpoint sẵn có (`useBulkInvite`, `/members/invite-preview`).
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Platform } from "../types";

export type AutoInviteTarget = {
  workspace_id: string;
  name: string;
  /** ⚠️ Ba trường suất này chỉ dùng cho lần vẽ ĐẦU TIÊN. Danh sách đích được cache
   * 5′ (cấu hình ít đổi) nên suất ở đây thiu rất nhanh — chỗ nào hiển thị suất phải
   * đọc `useWorkspaceSeats` (nguồn dùng chung, poll 15s + invalidate theo hành động). */
  seat_used: number;
  seat_total: number | null;
  seat_left: number | null;
};

export function useAutoInviteTarget() {
  return useQuery<AutoInviteTarget>({
    queryKey: ["auto-invite-target"],
    queryFn: () => api<AutoInviteTarget>("/api/v1/auto-invite/target"),
    retry: false,
  });
}

/** Danh sách workspace ĐÍCH cho email MỚI + cờ Toàn bộ (do super-admin cấu hình ⚙️).
 * Trang Mời chọn ngẫu nhiên 1 phần tử cho mỗi email mới; email cũ/gia hạn không qua đây. */
export type AutoInviteTargets = {
  all_workspaces: boolean;
  workspaces: AutoInviteTarget[];
};

export function useAutoInviteTargets(platform: Platform = "gpt") {
  return useQuery<AutoInviteTargets>({
    // Nhánh nằm TRONG queryKey: đổi công tắc ChatGPT/Canva là đổi hẳn danh sách đích,
    // dùng chung một cache là mời nhầm nhánh.
    queryKey: ["auto-invite-targets", platform],
    queryFn: () =>
      api<AutoInviteTargets>(`/api/v1/auto-invite/targets?platform=${platform}`),
    retry: false,
    // Cấu hình đích ít đổi → cache 5′, chỉ gọi lại DB khi hết hạn hoặc sau khi
    // lưu cấu hình (invalidate ở modal ⚙️). Tránh gọi thừa mỗi lần vào lại trang.
    staleTime: 5 * 60_000,
  });
}

/** 1 workspace mà email ĐÃ CÓ MẶT (do chính user này mời) và được phép mời lại vào. */
export type EmailWorkspaceUsage = {
  workspace_id: string;
  name: string;
  /** null = chưa từng vào được workspace này (lời mời hỏng / vừa chuyển hạn sang). */
  usage_days: number | null;
  /** Workspace ĐANG GIỮ HẠN của email — backend xếp lên đầu để làm mặc định. */
  holds_subscription?: boolean;
  /** Email ĐANG NGỒI ở workspace này (`active`/`pending`) ⇒ chỉ mời lại được vào
   *  đúng đây, kéo sang không gian khác là backend từ chối cả lô. */
  holds_seat?: boolean;
};
export type EmailHistoryEntry = {
  default_workspace_id: string;
  workspaces: EmailWorkspaceUsage[];
};
/** Map email (đã lowercase) → lịch sử workspace. Email không đủ điều kiện thì vắng mặt. */
export type EmailHistory = Record<string, EmailHistoryEntry>;

/**
 * ĐỔI VAI TỪ 2026-09-12: cả mẻ email đi chung một không gian chọn ở dải suất, nên
 * trang Mời không còn dùng hook này để "chọn lại workspace cũ" nữa. Việc còn lại của
 * nó là cờ `holds_seat` — chỉ ra email nào đang ngồi ở không gian NGOÀI danh sách
 * đích, thứ mà danh sách member không đọc được (`assert_workspace_access` chặn).
 *
 * Với danh sách email dán vào, hỏi backend những workspace mà mỗi email đã có mặt
 * (do chính tài khoản này mời) để hiện cột chọn lại workspace cũ. Bản ghi có hạn sử
 * dụng luôn được kể, kể cả khi email chưa vào được lần nào — mời lại phải trỏ về
 * đúng nơi đang giữ hạn thay vì bốc ngẫu nhiên một workspace được gán. Chỉ chạy khi
 * có email; key theo tập email đã sắp xếp (ổn định giữa các lần gõ).
 */
export function useEmailHistory(emails: string[], platform: Platform = "gpt") {
  const sorted = [...emails].map((e) => e.toLowerCase()).sort();
  return useQuery<EmailHistory>({
    // Lịch sử chỉ tính TRONG nhánh đang mời — email từng dùng workspace ChatGPT không
    // được kéo lệnh mời Canva về workspace đó.
    queryKey: ["auto-invite-email-history", platform, sorted],
    queryFn: async () => {
      const resp = await api<{ emails: EmailHistory }>(
        "/api/v1/auto-invite/email-history",
        { method: "POST", body: JSON.stringify({ emails: sorted, platform }) },
      );
      return resp.emails ?? {};
    },
    enabled: sorted.length > 0,
    retry: false,
    staleTime: 30_000,
  });
}
