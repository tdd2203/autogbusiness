const BASE = import.meta.env.VITE_API_BASE ?? "";

const TOKEN_KEY = "autogpt.token";

/**
 * Event phát ra khi backend trả 401 TRONG LÚC đang có token = phiên dashboard
 * hết hạn (mặc định 12h, JWT_EXPIRE_MINUTES) hoặc token bị vô hiệu qua
 * token_version. `AuthProvider` lắng nghe → xóa user → ProtectedRoute tự điều
 * hướng về /login (các trang protected unmount nên mọi query poll tự dừng).
 *
 * CHỈ phát khi token tồn tại. 401 lúc CHƯA login (sai mật khẩu ở /login, hay
 * gọi API khi chưa đăng nhập) là bình thường — không coi là "hết phiên".
 */
export const AUTH_UNAUTHORIZED_EVENT = "auth:unauthorized";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(public status: number, public detail: unknown) {
    super(readableDetail(detail));
  }
}

/**
 * `message` của một `ApiError` phải là câu ĐỌC ĐƯỢC, vì cả chục chỗ trong app
 * toast thẳng `e.message`.
 *
 * Backend trả `detail` khi thì chuỗi, khi thì `{code, message, ...}` (hạn mức
 * thao tác, ví thiếu tiền, phiên bị khoá). Trước 2026-08-30 nhánh object bị
 * `JSON.stringify` nên người dùng đọc được nguyên cục JSON trên toast — câu
 * tiếng Việt viết sẵn ở backend không ai thấy. Bóc `detail.message` ngay tại
 * đây thì mọi chỗ dùng `e.message` tự đúng, khỏi phải sửa từng hook.
 */
function readableDetail(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    const msg = (detail as { message?: unknown }).message;
    if (typeof msg === "string" && msg) return msg;
  }
  return JSON.stringify(detail);
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  // Không phải lỗi nào cũng là JSON: nginx tự sinh trang HTML cho 429/413/502
  // (rate-limit chặn TRƯỚC khi request tới FastAPI — xem apps/web/nginx.conf).
  // JSON.parse ném ở đây sẽ nuốt mất status thật và biến thành lỗi khó hiểu.
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    if (res.status === 401 && token) {
      // Phiên hết hạn giữa chừng: dọn token + báo AuthProvider đá về /login.
      // Làm trước khi throw để vòng poll 401 (queue 2s, extension-status 5s)
      // bị cắt ngay ở lần lỗi đầu tiên thay vì nã localhost vô hạn.
      setToken(null);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
      }
    }
    if (data === undefined && (res.status === 429 || res.status === 503)) {
      // Bị chặn ở tầng nginx: dựng lại đúng shape detail mà tầng API trả về
      // ({code, message, retry_after_sec}) để UI xử lý một kiểu duy nhất.
      const retry = Number(res.headers.get("Retry-After")) || 5;
      throw new ApiError(res.status, {
        code: res.status === 429 ? "RATE_LIMITED" : "SERVER_BUSY",
        message:
          res.status === 429
            ? "Bạn thao tác quá nhanh. Vui lòng chờ một chút rồi thử lại."
            : "Máy chủ đang bận. Vui lòng thử lại sau giây lát.",
        retry_after_sec: retry,
      });
    }
    throw new ApiError(res.status, data?.detail ?? data ?? res.statusText);
  }
  return data as T;
}
