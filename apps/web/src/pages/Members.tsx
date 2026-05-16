import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import type { Member } from "../types";

type Role = "owner" | "admin" | "member";

const ROLE_BADGE: Record<string, string> = {
  owner: "bg-purple-100 text-purple-800",
  admin: "bg-blue-100 text-blue-800",
  member: "bg-slate-100 text-slate-700",
};

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800",
  pending: "bg-amber-100 text-amber-800",
  removed: "bg-rose-100 text-rose-800",
};

export default function Members() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { hasPermission, user } = useAuth();
  const qc = useQueryClient();

  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [inviteError, setInviteError] = useState<string | null>(null);

  const { data: members = [], isLoading } = useQuery({
    queryKey: ["members", workspaceId],
    queryFn: () =>
      api<Member[]>(`/api/v1/workspaces/${workspaceId}/members`),
    enabled: !!workspaceId,
  });

  const sync = useMutation({
    mutationFn: () =>
      api<{ queue_item_id: string; status: string }>(
        `/api/v1/workspaces/${workspaceId}/sync`,
        { method: "POST" },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
    },
  });

  const invite = useMutation({
    mutationFn: () =>
      api<Member>(`/api/v1/workspaces/${workspaceId}/members/invite`, {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      }),
    onSuccess: () => {
      setShowInvite(false);
      setInviteEmail("");
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
    },
    onError: (e) => {
      setInviteError(e instanceof ApiError ? String(e.detail) : "Lỗi mời");
    },
  });

  const remove = useMutation({
    mutationFn: (memberId: string) =>
      api(`/api/v1/workspaces/${workspaceId}/members/${memberId}`, {
        method: "DELETE",
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["members", workspaceId] }),
  });

  const changeRole = useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: Role }) =>
      api(`/api/v1/workspaces/${workspaceId}/members/${memberId}/role`, {
        method: "PATCH",
        body: JSON.stringify({ new_role: role }),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["members", workspaceId] }),
  });

  function onInviteSubmit(e: FormEvent) {
    e.preventDefault();
    setInviteError(null);
    invite.mutate();
  }

  const canInvite = hasPermission("MEMBER_INVITE");
  const canRemove = hasPermission("MEMBER_REMOVE");
  const canChangeRole = user?.is_super_admin === true;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-medium">Danh sách thành viên</h2>
        <div className="flex gap-2">
          {hasPermission("WORKSPACE_SYNC_TRIGGER") && (
            <button
              onClick={() => sync.mutate()}
              disabled={sync.isPending}
              className="bg-white border px-4 py-2 rounded text-sm disabled:opacity-60"
              title="Tạo task SYNC_DATA — Extension scrape danh sách member từ chatgpt.com/admin về DB"
            >
              {sync.isPending ? "Đang gửi..." : "↻ Đồng bộ từ ChatGPT"}
            </button>
          )}
          {canInvite && !showInvite && (
            <button
              onClick={() => setShowInvite(true)}
              className="bg-slate-900 text-white px-4 py-2 rounded text-sm"
            >
              + Mời thành viên
            </button>
          )}
        </div>
      </div>
      {sync.isSuccess && (
        <div className="bg-blue-50 border border-blue-300 rounded p-3 mb-4 text-sm text-blue-900">
          Đã queue task SYNC. Đảm bảo Extension đang chạy và tab chatgpt.com/admin
          đang mở → Extension sẽ scrape và bulk-upsert thành viên về DB trong vài
          giây tới. Refresh trang để xem kết quả.
        </div>
      )}

      {showInvite && (
        <form
          onSubmit={onInviteSubmit}
          className="bg-white rounded shadow p-5 mb-6 space-y-3"
        >
          <h2 className="font-medium">Mời thành viên mới</h2>
          <div className="flex gap-3">
            <input
              required
              type="email"
              placeholder="email@example.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              className="flex-1 border rounded px-3 py-2"
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as Role)}
              className="border rounded px-3 py-2"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          {inviteError && (
            <div className="text-rose-600 text-sm">{inviteError}</div>
          )}
          <div className="flex gap-2">
            <button
              disabled={invite.isPending}
              className="bg-slate-900 text-white px-4 py-2 rounded disabled:opacity-60"
            >
              {invite.isPending ? "Đang xếp hàng..." : "Mời"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowInvite(false);
                setInviteError(null);
              }}
              className="px-4 py-2 rounded border"
            >
              Huỷ
            </button>
          </div>
        </form>
      )}

      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-700">
            <tr>
              <th className="p-3 font-medium">Email</th>
              <th className="p-3 font-medium">Tên</th>
              <th className="p-3 font-medium">Role</th>
              <th className="p-3 font-medium">Status</th>
              <th className="p-3 font-medium text-right">Hành động</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-slate-500">
                  Đang tải...
                </td>
              </tr>
            )}
            {!isLoading && members.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-slate-500">
                  {user?.is_super_admin
                    ? "Workspace chưa có thành viên nào — bấm 'Mời' hoặc chờ extension sync."
                    : "Bạn chưa mời thành viên nào vào workspace này."}
                </td>
              </tr>
            )}
            {members.map((m) => (
              <tr key={m.id} className="border-t">
                <td className="p-3 font-medium">{m.email}</td>
                <td className="p-3 text-slate-700">{m.name ?? "—"}</td>
                <td className="p-3">
                  {m.chatgpt_role ? (
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        ROLE_BADGE[m.chatgpt_role] ?? "bg-slate-100"
                      }`}
                    >
                      {m.chatgpt_role}
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="p-3">
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      STATUS_BADGE[m.status] ?? "bg-slate-100"
                    }`}
                  >
                    {m.status}
                  </span>
                </td>
                <td className="p-3 text-right space-x-2">
                  {canChangeRole && m.chatgpt_role && m.status === "active" && (
                    <select
                      value={m.chatgpt_role}
                      onChange={(e) =>
                        changeRole.mutate({
                          memberId: m.id,
                          role: e.target.value as Role,
                        })
                      }
                      className="border rounded px-2 py-1 text-xs"
                    >
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                      <option value="owner">owner</option>
                    </select>
                  )}
                  {canRemove && m.status !== "removed" && (
                    <button
                      onClick={() => {
                        if (
                          window.confirm(
                            `Xác nhận xoá ${m.email} khỏi workspace?`,
                          )
                        ) {
                          remove.mutate(m.id);
                        }
                      }}
                      className="text-rose-600 hover:text-rose-700 text-xs"
                    >
                      Xoá
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
