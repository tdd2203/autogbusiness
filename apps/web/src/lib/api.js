const BASE = import.meta.env.VITE_API_BASE ?? "";
const TOKEN_KEY = "autogpt.token";
export function getToken() {
    return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token) {
    if (token)
        localStorage.setItem(TOKEN_KEY, token);
    else
        localStorage.removeItem(TOKEN_KEY);
}
export class ApiError extends Error {
    status;
    detail;
    constructor(status, detail) {
        super(typeof detail === "string" ? detail : JSON.stringify(detail));
        this.status = status;
        this.detail = detail;
    }
}
export async function api(path, init = {}) {
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type") && init.body) {
        headers.set("Content-Type", "application/json");
    }
    const token = getToken();
    if (token)
        headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch(`${BASE}${path}`, { ...init, headers });
    if (res.status === 204)
        return undefined;
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
        throw new ApiError(res.status, data?.detail ?? data ?? res.statusText);
    }
    return data;
}
