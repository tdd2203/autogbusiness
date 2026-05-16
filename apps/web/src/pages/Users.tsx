import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { GRANTABLE, PERMISSION_LABEL, type PermissionKey } from "../lib/permissions";

type UserItem = {
  id: string;
  email: string;
  username: string;
  is_super_admin: boolean;
  is_active: boolean;
  permissions: string[];
  created_at: string;
};

export default function Users() {
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => api<UserItem[]>("/api/v1/users"),
  });

  const [showForm, setShowForm] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Tài khoản phụ</h1>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="bg-slate-900 text-white px-4 py-2 rounded"
        >
          {showForm ? "Đóng" : "+ Tạo tài khoản"}
        </button>
      </div>

      {showForm && (
        <CreateUserForm
          onCreated={() => {
            setShowForm(false);
            qc.invalidateQueries({ queryKey: ["users"] });
          }}
        />
      )}

      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-4 py-2">Email</th>
              <th className="text-left px-4 py-2">Username</th>
              <th className="text-left px-4 py-2">Loại</th>
              <th className="text-left px-4 py-2">Permissions</th>
              <th className="text-left px-4 py-2">Trạng thái</th>
              <th className="text-left px-4 py-2">Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => (
              <UserRow key={u.id} user={u} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CreateUserForm({ onCreated }: { onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [perms, setPerms] = useState<Set<PermissionKey>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      api("/api/v1/users", {
        method: "POST",
        body: JSON.stringify({
          email,
          username,
          password,
          permissions: Array.from(perms),
        }),
      }),
    onSuccess: () => {
      setErr(null);
      onCreated();
    },
    onError: (e) => {
      setErr(e instanceof ApiError ? JSON.stringify(e.detail) : "Lỗi tạo user");
    },
  });

  function toggle(p: PermissionKey) {
    setPerms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    mut.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="bg-white rounded shadow p-5 mb-6">
      <div className="grid grid-cols-3 gap-3 mb-4">
        <input
          placeholder="Email"
          required
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="border rounded px-3 py-2"
        />
        <input
          placeholder="Username"
          required
          minLength={3}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="border rounded px-3 py-2"
        />
        <input
          placeholder="Password (≥8 ký tự)"
          required
          minLength={8}
          type="text"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="border rounded px-3 py-2"
        />
      </div>

      <div className="mb-4">
        <div className="text-sm font-medium mb-2">Cấp permissions:</div>
        <div className="grid grid-cols-2 gap-2">
          {GRANTABLE.map((p) => (
            <label key={p} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={perms.has(p)}
                onChange={() => toggle(p)}
              />
              <span>
                {PERMISSION_LABEL[p]}{" "}
                <code className="text-xs text-slate-500">{p}</code>
              </span>
            </label>
          ))}
        </div>
      </div>

      {err && <div className="text-rose-600 text-sm mb-3">{err}</div>}

      <button
        disabled={mut.isPending}
        className="bg-slate-900 text-white px-4 py-2 rounded disabled:opacity-60"
      >
        {mut.isPending ? "Đang tạo..." : "Tạo tài khoản"}
      </button>
    </form>
  );
}

function UserRow({ user }: { user: UserItem }) {
  const qc = useQueryClient();
  const toggleActive = useMutation({
    mutationFn: () =>
      api(`/api/v1/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: !user.is_active }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });

  const reset = useMutation({
    mutationFn: (newPassword: string) =>
      api(`/api/v1/users/${user.id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ new_password: newPassword }),
      }),
  });

  function onReset() {
    const np = window.prompt("Nhập password mới (≥ 8 ký tự):");
    if (!np || np.length < 8) return;
    reset.mutate(np);
  }

  return (
    <tr className="border-t">
      <td className="px-4 py-2">{user.email}</td>
      <td className="px-4 py-2">{user.username}</td>
      <td className="px-4 py-2">
        {user.is_super_admin ? (
          <span className="text-indigo-700 font-medium">Super-admin</span>
        ) : (
          "Sub-admin"
        )}
      </td>
      <td className="px-4 py-2 text-xs">
        {user.is_super_admin ? (
          <span className="text-slate-500">Toàn quyền</span>
        ) : user.permissions.length === 0 ? (
          <span className="text-slate-400">(không có)</span>
        ) : (
          user.permissions.map((p) => (
            <span
              key={p}
              className="inline-block bg-slate-100 px-2 py-0.5 rounded mr-1 mb-1"
            >
              {p}
            </span>
          ))
        )}
      </td>
      <td className="px-4 py-2">
        {user.is_active ? (
          <span className="text-emerald-700">Active</span>
        ) : (
          <span className="text-rose-700">Disabled</span>
        )}
      </td>
      <td className="px-4 py-2 space-x-2">
        {!user.is_super_admin && (
          <>
            <button
              onClick={() => toggleActive.mutate()}
              className="text-sm text-slate-700 underline"
            >
              {user.is_active ? "Vô hiệu hoá" : "Kích hoạt"}
            </button>
            <button
              onClick={onReset}
              className="text-sm text-slate-700 underline"
            >
              Reset password
            </button>
          </>
        )}
      </td>
    </tr>
  );
}
