import { useState, type FormEvent } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { ApiError } from "../lib/api";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: { pathname?: string } } };
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(identifier.trim(), password);
      const to = location.state?.from?.pathname ?? "/queue";
      navigate(to, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(typeof err.detail === "string" ? err.detail : "Đăng nhập thất bại");
      } else {
        setError("Lỗi kết nối tới server");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-white p-8 rounded-lg shadow"
      >
        <h1 className="text-xl font-semibold mb-1">AutoGPT Dashboard</h1>
        <p className="text-sm text-slate-500 mb-6">Đăng nhập để điều khiển Extension</p>

        <label className="block text-sm font-medium mb-1">Email hoặc Username</label>
        <input
          autoFocus
          required
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          className="w-full border border-slate-300 rounded px-3 py-2 mb-4 outline-none focus:border-slate-500"
        />

        <label className="block text-sm font-medium mb-1">Mật khẩu</label>
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full border border-slate-300 rounded px-3 py-2 mb-4 outline-none focus:border-slate-500"
        />

        {error && (
          <div className="text-rose-600 text-sm mb-3 bg-rose-50 border border-rose-200 rounded px-3 py-2">
            {error}
          </div>
        )}

        <button
          disabled={busy}
          className="w-full bg-slate-900 text-white rounded py-2 hover:bg-slate-800 disabled:opacity-60"
        >
          {busy ? "Đang đăng nhập..." : "Đăng nhập"}
        </button>
      </form>
    </div>
  );
}
