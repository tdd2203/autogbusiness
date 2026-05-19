/**
 * Extension status detection via BACKEND POLL (cross-browser).
 *
 * Lịch sử: trước đây dashboard ↔ extension giao tiếp qua postMessage bridge
 * (content script `dashboard-bridge.ts`). Nhược điểm: chỉ work khi extension
 * + dashboard ở CÙNG browser. Khi user chạy dashboard ở trình duyệt khác
 * (vd MoreLogin chứa extension, Edge thường chứa dashboard) → bridge fail.
 *
 * Giải pháp mới: dashboard poll backend `/extension-status` mỗi 5s. Backend
 * biết extension nào đang subscribe SSE (per-workspace) → trả `online: bool`.
 * Hoạt động ở mọi browser vì chỉ cần HTTP tới localhost:18000.
 *
 * Task auto-execute đã được backend SSE handle từ v0.3.0 — KHÔNG cần dashboard
 * gửi tín hiệu "run-now" qua bridge nữa. `triggerExtensionRun` giờ là no-op
 * giữ lại cho callsite (Members/Workspaces) không phải sửa.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

type ExtensionStatusResp = {
  online: boolean;
  subscribers: number;
};

/**
 * No-op compat: SSE đã handle auto-execute. Callsite hiện tại gọi sau khi
 * task được tạo qua API; task đã được publish_task_event → extension nhận
 * trong <1s không cần thêm gì.
 */
export async function triggerExtensionRun(): Promise<boolean> {
  return true;
}

/**
 * Báo extension refresh ngay UI labels bundle (chrome.storage.local cache).
 *
 * Bối cảnh: sau khi save 1 row UI label qua Settings, DB đã update nhưng
 * extension cache 2 phút mới refresh tự động → action vẫn dùng label cũ.
 * Hàm này post message qua dashboard-bridge content script (cùng browser) →
 * background SW gọi `refreshLabelBundle()` → fetch /ui-labels/bundle mới →
 * content script listen `storage.onChanged` → reload cache. Thường <500ms.
 *
 * Cross-browser caveat: nếu extension chạy ở browser khác dashboard (vd
 * MoreLogin chứa extension), bridge không tồn tại trên page → message bị
 * drop, fallback alarm 2 phút sau extension sẽ tự refresh.
 *
 * Best-effort: KHÔNG await response, KHÔNG throw. Caller chỉ cần fire sau
 * save thành công.
 */
export function requestExtensionRefreshLabels(): void {
  if (typeof window === "undefined") return;
  try {
    window.postMessage(
      { source: "autogpt-dashboard", type: "refresh-labels" },
      window.origin,
    );
  } catch (e) {
    console.warn("[autogpt-dashboard] refresh-labels post failed", e);
  }
}

/**
 * Hook trả về extension status cho một workspace cụ thể.
 * Poll backend mỗi 5s — extension subscribe SSE thì online=true.
 *
 * Pass workspaceId=null khi không có context workspace (vd /workspaces list)
 * → hook return online=null (unknown).
 */
export function useExtensionStatus(workspaceId: string | null | undefined): {
  online: boolean | null;
  subscribers: number;
} {
  const { data } = useQuery({
    queryKey: ["extension-status", workspaceId],
    queryFn: () =>
      api<ExtensionStatusResp>(
        `/api/v1/workspaces/${workspaceId}/extension-status`,
      ),
    enabled: !!workspaceId,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });

  if (!workspaceId) return { online: null, subscribers: 0 };
  if (!data) return { online: null, subscribers: 0 };
  return { online: data.online, subscribers: data.subscribers };
}
