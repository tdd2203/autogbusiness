/**
 * Hook cho trang "Mời thành viên" (phía người dùng, tính năng TEST).
 *
 * Mô hình: mỗi người dùng được cấp cố định 1 workspace. Hook này chỉ RESOLVE workspace
 * đó (id + tên + ghế) qua endpoint riêng `/api/v1/auto-invite/target`. Việc mời thật +
 * tính phí TÁI SỬ DỤNG hook/endpoint sẵn có (`useBulkInvite`, `/members/invite-preview`).
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export type AutoInviteTarget = {
  workspace_id: string;
  name: string;
  seat_used: number;
  seat_total: number | null;
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

export function useAutoInviteTargets() {
  return useQuery<AutoInviteTargets>({
    queryKey: ["auto-invite-targets"],
    queryFn: () => api<AutoInviteTargets>("/api/v1/auto-invite/targets"),
    retry: false,
    // Cấu hình đích ít đổi → cache 5′, chỉ gọi lại DB khi hết hạn hoặc sau khi
    // lưu cấu hình (invalidate ở modal ⚙️). Tránh gọi thừa mỗi lần vào lại trang.
    staleTime: 5 * 60_000,
  });
}

/** 1 workspace mà email ĐÃ TỪNG tham gia (do chính user này mời) đủ lâu để hiện lại. */
export type EmailWorkspaceUsage = {
  workspace_id: string;
  name: string;
  usage_days: number;
};
export type EmailHistoryEntry = {
  default_workspace_id: string;
  workspaces: EmailWorkspaceUsage[];
};
/** Map email (đã lowercase) → lịch sử workspace. Email không đủ điều kiện thì vắng mặt. */
export type EmailHistory = Record<string, EmailHistoryEntry>;

/**
 * Với danh sách email dán vào, hỏi backend những workspace mà mỗi email đã từng
 * tham gia (≥30 ngày, do chính tài khoản này mời) để hiện cột chọn lại workspace cũ.
 * Chỉ chạy khi có email; key theo tập email đã sắp xếp (ổn định giữa các lần gõ).
 */
export function useEmailHistory(emails: string[]) {
  const sorted = [...emails].map((e) => e.toLowerCase()).sort();
  return useQuery<EmailHistory>({
    queryKey: ["auto-invite-email-history", sorted],
    queryFn: async () => {
      const resp = await api<{ emails: EmailHistory }>(
        "/api/v1/auto-invite/email-history",
        { method: "POST", body: JSON.stringify({ emails: sorted }) },
      );
      return resp.emails ?? {};
    },
    enabled: sorted.length > 0,
    retry: false,
    staleTime: 30_000,
  });
}
