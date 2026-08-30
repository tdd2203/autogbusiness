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

/**
 * Trần thời gian cho MỘT lượt gọi API.
 *
 * `fetch` không bao giờ tự bỏ cuộc. Server ngậm kết nối (deploy đúng lúc, mạng rớt
 * nửa chừng, câu truy vấn vướng khoá) là promise treo vĩnh viễn: không thành công,
 * không lỗi, không retry. react-query lại KHÔNG mở lượt gọi mới khi lượt cũ còn
 * bay, nên `refetchInterval` cũng vô hiệu và màn hình đứng ở "…" tới khi F5
 * (user 2026-08-30). nginx không cứu được: `location /api/` đang để
 * `proxy_read_timeout 3600s` cho SSE nên áp cho cả endpoint thường.
 *
 * 20s là trần rộng rãi — endpoint nặng nhất đo được vẫn dưới 10s. Chỗ nào biết
 * mình lâu hơn thì truyền `timeoutMs` riêng (xem `useSepaySync`), `null` = tắt hẳn.
 */
export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Hết giờ chờ — KHÁC hẳn lỗi server trả về.
 *
 * Với GET thì cứ gọi lại là xong. Với lệnh GHI (mời, nạp, điều chỉnh số dư) thì
 * KHÔNG BIẾT việc đã chạy hay chưa: request có thể đã tới nơi và chạy xong, chỉ là
 * câu trả lời không về kịp. Nên câu chữ phải bảo user kiểm chứng trước khi bấm lại,
 * đừng xui làm lại một lệnh trừ tiền.
 *
 * Vẫn là `ApiError` để mọi chỗ đang bắt `e instanceof ApiError` giữ nguyên; `detail`
 * để dạng chuỗi nên `String(e.detail)` ra đúng câu tiếng Việt.
 */
export class ApiTimeoutError extends ApiError {
  constructor(public timeoutMs: number, readOnly = true) {
    super(
      0,
      `Máy chủ không trả lời sau ${Math.round(timeoutMs / 1000)} giây. ` +
        (readOnly
          ? "Kiểm tra mạng rồi thử lại."
          : "Chưa rõ việc đã chạy hay chưa — tải lại trang xem kết quả trước khi làm lại."),
    );
  }
}

export type ApiInit = RequestInit & { timeoutMs?: number | null };

export async function api<T = unknown>(
  path: string,
  init: ApiInit = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (!headers.has("Content-Type") && rest.body) {
    headers.set("Content-Type", "application/json");
  }
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  // Một controller gộp cả hai nguồn huỷ: hết giờ và người gọi tự huỷ.
  const ctl = new AbortController();
  let expired = false;
  const timer =
    timeoutMs == null
      ? null
      : setTimeout(() => {
          expired = true;
          ctl.abort();
        }, timeoutMs);
  const onCallerAbort = () => ctl.abort();
  if (callerSignal) {
    if (callerSignal.aborted) ctl.abort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  let res: Response;
  let text: string;
  try {
    res = await fetch(`${BASE}${path}`, { ...rest, headers, signal: ctl.signal });
    if (res.status === 204) return undefined as T;
    // Đọc body VẪN nằm trong hạn giờ: header về sớm mà thân treo cũng là treo.
    text = await res.text();
  } catch (e) {
    if (expired) {
      const method = (rest.method ?? "GET").toUpperCase();
      throw new ApiTimeoutError(timeoutMs as number, method === "GET");
    }
    // Mất mạng / server không dựng nổi kết nối: `fetch` ném TypeError trần, hiện
    // thẳng ra UI là câu tiếng Anh khó hiểu. Gói lại để mọi nơi xử lý một kiểu.
    // (Người gọi tự huỷ thì ném AbortError, không phải TypeError — để nguyên.)
    if (e instanceof TypeError) {
      throw new ApiError(0, "Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.");
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
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
    if (data === undefined && (res.status === 429 || res.status >= 500)) {
      // Không có JSON để bóc: nginx tự sinh trang cho 429/502/504, và uvicorn trả
      // "Internal Server Error" trần cho 500. Dựng lại đúng shape detail mà tầng
      // API trả về ({code, message, retry_after_sec}) để UI xử lý một kiểu duy
      // nhất — bằng không câu tiếng Anh của proxy hiện thẳng lên màn hình user.
      const retry = Number(res.headers.get("Retry-After")) || 5;
      const code =
        res.status === 429 ? "RATE_LIMITED" : res.status === 503 ? "SERVER_BUSY" : "SERVER_ERROR";
      const message =
        code === "RATE_LIMITED"
          ? "Bạn thao tác quá nhanh. Vui lòng chờ một chút rồi thử lại."
          : code === "SERVER_BUSY"
            ? "Máy chủ đang bận. Vui lòng thử lại sau giây lát."
            : `Máy chủ đang lỗi (mã ${res.status}). Vui lòng thử lại sau giây lát.`;
      throw new ApiError(res.status, { code, message, retry_after_sec: retry });
    }
    throw new ApiError(res.status, data?.detail ?? data ?? res.statusText);
  }
  return data as T;
}

/**
 * Câu chữ hiện thẳng lên UI cho một lỗi bất kỳ do `api()` ném ra.
 *
 * Backend trả `detail` khi thì chuỗi, khi thì `{code, message}` (429/503 ở nginx,
 * lỗi ví có mã), nên mỗi nơi tự bóc một kiểu là sớm muộn có chỗ in ra
 * `[object Object]`. Gom về một chỗ.
 */
export function apiErrorText(e: unknown, fallback = "Không tải được dữ liệu."): string {
  if (e instanceof ApiError) {
    const d = e.detail as { message?: unknown } | string | null | undefined;
    if (typeof d === "string" && d) return d;
    if (d && typeof d === "object" && typeof d.message === "string" && d.message) {
      return d.message;
    }
    return e.message || fallback;
  }
  return e instanceof Error && e.message ? e.message : fallback;
}
