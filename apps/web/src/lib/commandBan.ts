import { ApiError, AUTH_UNAUTHORIZED_EVENT, setToken } from "./api";
import { toast } from "../components/Toast";

/**
 * Xử lý lỗi 403 COMMAND_BANNED (chống spam: lặp CÙNG lệnh+email >3 lần liên tiếp
 * → cấm tài khoản 10 phút). Backend đã bump token_version (token cũ vô hiệu) nên
 * đá session NGAY: toast cảnh báo + xoá token + dispatch AUTH_UNAUTHORIZED_EVENT
 * để AuthProvider logout về /login (login sẽ bị chặn tới hết 10 phút).
 *
 * Trả `true` nếu đã xử lý ban (caller nên return sớm, không toast lỗi generic).
 */
export function handleCommandBan(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 403) return false;
  const detail =
    e.detail && typeof e.detail === "object"
      ? (e.detail as { code?: string; message?: string })
      : undefined;
  if (detail?.code !== "COMMAND_BANNED") return false;
  toast.error(
    detail.message ??
      "Tài khoản tạm khoá do thao tác lặp lại quá nhiều. Vui lòng đăng nhập lại sau.",
  );
  setToken(null);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
  }
  return true;
}
