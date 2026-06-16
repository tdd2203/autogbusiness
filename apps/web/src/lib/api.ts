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
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
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
  const data = text ? JSON.parse(text) : undefined;
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
    throw new ApiError(res.status, data?.detail ?? data ?? res.statusText);
  }
  return data as T;
}
