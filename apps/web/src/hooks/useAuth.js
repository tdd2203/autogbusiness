import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, } from "react";
import { api, getToken, setToken } from "../lib/api";
const AuthContext = createContext(null);
export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(!!getToken());
    const refresh = useCallback(async () => {
        if (!getToken()) {
            setUser(null);
            setLoading(false);
            return;
        }
        try {
            const me = await api("/api/v1/auth/me");
            setUser(me);
        }
        catch {
            setToken(null);
            setUser(null);
        }
        finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => {
        refresh();
    }, [refresh]);
    const login = useCallback(async (identifier, password) => {
        const res = await api("/api/v1/auth/login", {
            method: "POST",
            body: JSON.stringify({ identifier, password }),
        });
        setToken(res.access_token);
        await refresh();
    }, [refresh]);
    const logout = useCallback(() => {
        setToken(null);
        setUser(null);
    }, []);
    const hasPermission = useCallback((perm) => {
        if (!user)
            return false;
        if (user.is_super_admin)
            return true;
        return user.permissions.includes(perm);
    }, [user]);
    const value = useMemo(() => ({ user, loading, login, logout, hasPermission, refresh }), [user, loading, login, logout, hasPermission, refresh]);
    return _jsx(AuthContext.Provider, { value: value, children: children });
}
export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx)
        throw new Error("useAuth must be used inside AuthProvider");
    return ctx;
}
