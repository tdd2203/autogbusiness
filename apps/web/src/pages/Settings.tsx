import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError, setToken } from "../lib/api";
import { useAuth } from "../hooks/useAuth";

export default function Settings() {
  const { user, refresh } = useAuth();
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      api<{ access_token: string }>("/api/v1/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ old_password: oldPw, new_password: newPw }),
      }),
    onSuccess: async (res) => {
      setToken(res.access_token);
      await refresh();
      setMsg({ ok: true, text: "Đã đổi mật khẩu thành công" });
      setOldPw("");
      setNewPw("");
    },
    onError: (e) => {
      setMsg({
        ok: false,
        text: e instanceof ApiError ? String(e.detail) : "Lỗi đổi mật khẩu",
      });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    mut.mutate();
  }

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-semibold mb-6">Cài đặt</h1>

      <div className="bg-white rounded shadow p-5 mb-6">
        <h2 className="font-medium mb-2">Thông tin tài khoản</h2>
        <div className="text-sm text-slate-700 space-y-1">
          <div>Email: {user?.email}</div>
          <div>Username: {user?.username}</div>
          <div>
            Loại: {user?.is_super_admin ? "Super-admin" : "Sub-admin"}
          </div>
        </div>
      </div>

      <form onSubmit={onSubmit} className="bg-white rounded shadow p-5 space-y-3">
        <h2 className="font-medium">Đổi mật khẩu</h2>
        <input
          required
          type="password"
          placeholder="Mật khẩu cũ"
          value={oldPw}
          onChange={(e) => setOldPw(e.target.value)}
          className="w-full border rounded px-3 py-2"
        />
        <input
          required
          type="password"
          placeholder="Mật khẩu mới (≥ 8 ký tự)"
          minLength={8}
          value={newPw}
          onChange={(e) => setNewPw(e.target.value)}
          className="w-full border rounded px-3 py-2"
        />
        {msg && (
          <div
            className={`text-sm ${
              msg.ok ? "text-emerald-700" : "text-rose-600"
            }`}
          >
            {msg.text}
          </div>
        )}
        <button
          disabled={mut.isPending}
          className="bg-slate-900 text-white px-4 py-2 rounded disabled:opacity-60"
        >
          {mut.isPending ? "Đang lưu..." : "Đổi mật khẩu"}
        </button>
      </form>
    </div>
  );
}
