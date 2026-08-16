import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  api,
  getToken,
  setToken,
  AUTH_UNAUTHORIZED_EVENT,
} from "../lib/api";

export type UserProfile = {
  id: string;
  email: string;
  username: string;
  is_super_admin: boolean;
  is_active: boolean;
  // Cờ thử nghiệm Ví (feature 003) — bật menu Ví + enforcement mời. Optional để
  // tương thích ngược nếu backend cũ chưa trả field này.
  wallet_beta?: boolean;
  permissions: string[];
  created_at: string;
  updated_at: string;
};

type AuthContextValue = {
  user: UserProfile | null;
  loading: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => void;
  hasPermission: (perm: string) => boolean;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(!!getToken());
  const qc = useQueryClient();

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const me = await api<UserProfile>("/api/v1/auth/me");
      setUser(me);
    } catch {
      setToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Phiên hết hạn giữa chừng: api() phát AUTH_UNAUTHORIZED_EVENT khi gặp 401
  // lúc đang có token. Xóa user → ProtectedRoute điều hướng về /login và các
  // trang protected unmount (dừng mọi query poll). Xem lib/api.ts.
  useEffect(() => {
    function onUnauthorized() {
      setToken(null);
      setUser(null);
      qc.clear();
    }
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);
    return () =>
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);
  }, [qc]);

  const login = useCallback(
    async (identifier: string, password: string) => {
      const res = await api<{ access_token: string }>("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ identifier, password }),
      });
      setToken(res.access_token);
      // ĐỔI TÀI KHOẢN TRÊN CÙNG MỘT TAB: SPA không reload nên cache react-query
      // vẫn còn NGUYÊN dữ liệu của người trước. Trang Mời lấy workspace đích từ
      // cache `/auto-invite/targets` → người vừa đăng nhập bắn thẳng request vào
      // workspace của người cũ, ăn 404 hàng loạt (sự cố 2026-08-16: cả 2 lần bấm
      // gửi lời mời đều 404). Chưa kể người mới thoáng thấy dữ liệu người cũ.
      // Xoá sạch cache NGAY sau khi đổi token: lúc này mới chỉ có trang /login
      // đang mounted nên không cắt ngang query nào đang chạy.
      qc.clear();
      await refresh();
    },
    [refresh, qc],
  );

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    // Dọn luôn khi đăng xuất — không để dữ liệu người vừa thoát nằm lại trong bộ
    // nhớ tab chờ người kế tiếp (máy dùng chung).
    qc.clear();
  }, [qc]);

  const hasPermission = useCallback(
    (perm: string) => {
      if (!user) return false;
      if (user.is_super_admin) return true;
      return user.permissions.includes(perm);
    },
    [user],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, login, logout, hasPermission, refresh }),
    [user, loading, login, logout, hasPermission, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
