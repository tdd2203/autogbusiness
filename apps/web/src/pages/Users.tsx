import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import {
  DEFAULT_SUB_ADMIN_PERMS,
  PERM_GROUPS,
  SENSITIVE_PERMS,
  type PermissionKey,
} from "../lib/permissions";
import { useFormatDate, useT } from "../i18n";
import { useAuth } from "../hooks/useAuth";
import PlatformPricingModal from "../components/PlatformPricingModal";
import UserPriceModal from "../components/UserPriceModal";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { SearchInput } from "./Members";

type UserItem = {
  id: string;
  email: string;
  username: string;
  is_super_admin: boolean;
  is_active: boolean;
  permissions: string[];
  created_at: string;
};

/**
 * Bộ chọn quyền theo nhóm — chip có ô tick, nhãn tiếng Việt + mã, và dấu
 * "Nhạy cảm" cho các quyền phá hoại. Dùng chung cho form tạo mới và modal sửa
 * quyền để hai chỗ luôn đồng bộ.
 */
function PermGroupPicker({
  selected,
  onToggle,
}: {
  selected: Set<PermissionKey>;
  onToggle: (p: PermissionKey) => void;
}) {
  const t = useT();
  return (
    <>
      {PERM_GROUPS.map((g) => (
        <div key={g.id} className={`perm-group ${g.id}`}>
          <div className="perm-group-label">
            <span className="dot" />
            {t(`permGroup.${g.id}`)}
          </div>
          <div className="perm-chips">
            {g.codes.map((p) => {
              const on = selected.has(p);
              const sensitive = SENSITIVE_PERMS.has(p);
              return (
                <label key={p} className={`perm-chip${on ? " on" : ""}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => onToggle(p)}
                  />
                  <span className="perm-chip-box">{on ? "✓" : ""}</span>
                  <span>
                    <span className="perm-chip-text">
                      {t(`permShort.${p}`)}
                      {sensitive && (
                        <span className="perm-chip-sensitive">
                          {t("users.sensitiveTag")}
                        </span>
                      )}
                    </span>
                    <span className="perm-chip-code">{p}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

export default function Users() {
  const t = useT();
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => api<UserItem[]>("/api/v1/users"),
  });

  const { user: me } = useAuth();
  const [showForm, setShowForm] = useState(false);
  const [showPricing, setShowPricing] = useState(false);
  const [search, setSearch] = useState("");

  const data = users.data ?? [];
  const filtered = useMemo(() => {
    if (!search.trim()) return data;
    const s = search.trim().toLowerCase();
    return data.filter(
      (u) =>
        u.email.toLowerCase().includes(s) ||
        u.username.toLowerCase().includes(s),
    );
  }, [data, search]);

  const onlyOne = data.length <= 1;

  return (
    <div className="page-fade">
      <div
        className="flex items-start justify-between"
        style={{ gap: 24, marginBottom: 32, flexWrap: "wrap" }}
      >
        <div>
          <div className="breadcrumb">
            {t("breadcrumb.organization")}
            <span className="breadcrumb-sep">/</span>
            {t("nav.users")}
          </div>
          <h1 className="display-h1">{t("users.title")}</h1>
        </div>
        <div className="flex items-center" style={{ gap: 8 }}>
          {me?.is_super_admin && (
            <button onClick={() => setShowPricing(true)} className="btn btn-ghost">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
              {t("pricing.button")}
            </button>
          )}
          <button
            onClick={() => setShowForm((v) => !v)}
            className="btn btn-primary"
          >
            {showForm ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M12 5v14M5 12h14" />
              </svg>
            )}
            {showForm ? t("users.close") : t("users.create")}
          </button>
        </div>
      </div>

      {showPricing && <PlatformPricingModal onClose={() => setShowPricing(false)} />}

      {showForm && (
        <CreateUserForm
          onCancel={() => setShowForm(false)}
          onCreated={() => {
            setShowForm(false);
            qc.invalidateQueries({ queryKey: ["users"] });
          }}
        />
      )}

      <div className="table-card">
        <div className="table-head">
          <div>
            <div className="table-title">{t("users.listTitle")}</div>
            <div className="table-meta" style={{ marginTop: 2 }}>
              {t("users.countLabel", { n: data.length })}
            </div>
          </div>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={t("users.searchPlaceholder")}
          />
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("users.accountCol")}</th>
                <th>{t("users.typeCol")}</th>
                <th>{t("users.statusCol")}</th>
                <th>{t("users.permissionsCol")}</th>
                <th style={{ textAlign: "right" }}>{t("users.actionsCol")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <UserRow key={u.id} user={u} />
              ))}
              {!users.isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="cell-muted" style={{ textAlign: "center", padding: 32 }}>
                    {t("common.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {onlyOne && (
        <div
          style={{
            marginTop: 24,
            padding: 20,
            background: "var(--surface)",
            border: "1px dashed var(--border-strong)",
            borderRadius: "var(--radius)",
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              background: "var(--surface-2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontWeight: 500, marginBottom: 2 }}>
              {t("users.hintTitle")}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
              {t("users.hintBody")}
            </div>
          </div>
          <button
            onClick={() => setShowForm(true)}
            className="btn btn-ghost"
          >
            {t("users.create")}
          </button>
        </div>
      )}
    </div>
  );
}

function CreateUserForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [perms, setPerms] = useState<Set<PermissionKey>>(
    () => new Set(DEFAULT_SUB_ADMIN_PERMS),
  );
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      api("/api/v1/users", {
        method: "POST",
        body: JSON.stringify({
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
      setErr(
        e instanceof ApiError ? JSON.stringify(e.detail) : t("users.createError"),
      );
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
    <form
      onSubmit={onSubmit}
      className="surface-card"
      style={{ padding: 24, marginBottom: 26 }}
    >
      <div className="display-h3" style={{ marginBottom: 16 }}>
        {t("users.createFormTitle")}
      </div>
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          marginBottom: 22,
        }}
      >
        <div>
          <label className="form-label" style={{ marginBottom: 6, display: "block" }}>
            {t("users.username")}
          </label>
          <input
            placeholder="username"
            required
            minLength={3}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="form-input mono"
          />
        </div>
        <div>
          <label className="form-label" style={{ marginBottom: 6, display: "block" }}>
            {t("users.password")}
          </label>
          <input
            placeholder="••••••••"
            required
            minLength={8}
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="form-input mono"
          />
        </div>
      </div>

      <div className="form-label" style={{ fontWeight: 500, marginBottom: 12 }}>
        {t("users.grantTitle")}
      </div>
      <PermGroupPicker selected={perms} onToggle={toggle} />

      {err && (
        <div style={{ color: "var(--danger)", fontSize: 12.5, marginTop: 14 }}>
          {err}
        </div>
      )}

      <div className="perm-picker-foot">
        <button disabled={mut.isPending} className="btn btn-primary">
          {mut.isPending ? t("users.createBusy") : t("users.createSubmit")}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onCancel}
          disabled={mut.isPending}
        >
          {t("common.cancel")}
        </button>
        <span className="perm-picker-count">
          {t("users.selectedCount", { n: perms.size })}
        </span>
      </div>
    </form>
  );
}

function UserRow({ user }: { user: UserItem }) {
  const t = useT();
  const formatDate = useFormatDate();
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const [pricing, setPricing] = useState(false);
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
    const np = window.prompt(t("users.resetPrompt"));
    if (!np || np.length < 8) return;
    reset.mutate(np);
  }

  // Sửa quyền tài khoản phụ đã tạo — PATCH /users/{id} { permissions } (BE đã hỗ
  // trợ validate_grantable). Mở modal tick lại theo nhóm, lưu → invalidate ["users"].
  const [editing, setEditing] = useState(false);
  const [editPerms, setEditPerms] = useState<Set<PermissionKey>>(new Set());
  const savePerms = useMutation({
    mutationFn: () =>
      api(`/api/v1/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ permissions: Array.from(editPerms) }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      setEditing(false);
    },
  });
  function openEdit() {
    setEditPerms(new Set(user.permissions as PermissionKey[]));
    setEditing(true);
  }
  function toggleEdit(p: PermissionKey) {
    setEditPerms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  const initial = (user.email || user.username || "?").charAt(0).toUpperCase();
  const sinceDate = formatDate(user.created_at);

  return (
    <>
    <tr style={user.is_super_admin ? { background: "var(--surface-2)" } : undefined}>
      <td>
        <div className="actor">
          <div
            className="actor-avatar"
            style={
              user.is_super_admin
                ? { background: "var(--ink)", color: "var(--surface)" }
                : undefined
            }
          >
            {initial}
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="actor-name">{user.email}</div>
            <div className="actor-sub">
              {t("users.accountSub", { username: user.username, date: sinceDate })}
            </div>
          </div>
        </div>
      </td>
      <td>
        {user.is_super_admin ? (
          <span className="role-super">{t("role.super")}</span>
        ) : (
          <span className="role-tag">{t("role.sub")}</span>
        )}
      </td>
      <td>
        {user.is_active ? (
          <span className="badge badge-success">{t("users.active")}</span>
        ) : (
          <span className="badge badge-danger">{t("users.disabled")}</span>
        )}
      </td>
      <td style={{ maxWidth: 380 }}>
        {user.is_super_admin ? (
          <span className="perm-full">{t("users.fullPerms")}</span>
        ) : user.permissions.length === 0 ? (
          <span className="cell-muted">{t("users.noPerms")}</span>
        ) : (
          <div className="flex flex-wrap" style={{ gap: 6 }}>
            {user.permissions.map((p) => {
              const sensitive = SENSITIVE_PERMS.has(p as PermissionKey);
              return (
                <span
                  key={p}
                  className={`perm-pill${sensitive ? " sensitive" : ""}`}
                >
                  {t(`permShort.${p}`)}
                </span>
              );
            })}
          </div>
        )}
      </td>
      <td style={{ textAlign: "right" }}>
        {!user.is_super_admin && (
          <div className="flex items-center justify-end" style={{ gap: 6 }}>
            <button onClick={openEdit} className="row-action neutral">
              {t("users.editPerms")}
            </button>
            {me?.is_super_admin && (
              <button onClick={() => setPricing(true)} className="row-action neutral">
                {t("pricing.rowAction")}
              </button>
            )}
            {/* Vô hiệu hoá + reset password nằm trong kebab: hai việc ít dùng mà lại
                nặng tay, để trần ngoài dòng dễ bấm nhầm. */}
            <RowActionsMenu
              ariaLabel={t("users.actionsCol")}
              items={[
                {
                  key: "toggle-active",
                  label: user.is_active ? t("users.disable") : t("users.enable"),
                  danger: user.is_active,
                  onClick: () => toggleActive.mutate(),
                },
                {
                  key: "reset-password",
                  label: t("users.resetPassword"),
                  onClick: onReset,
                },
              ]}
            />
          </div>
        )}
        {user.is_super_admin && (
          <span className="cell-muted" style={{ fontSize: 12 }}>
            {t("users.editAction")}
          </span>
        )}
      </td>
    </tr>

    {pricing && (
      <tr>
        <td colSpan={5} style={{ padding: 0 }}>
          <UserPriceModal
            userId={user.id}
            username={user.username}
            email={user.email}
            onClose={() => setPricing(false)}
          />
        </td>
      </tr>
    )}

    {/* Modal sửa quyền tài khoản phụ. */}
    {editing && (
      <tr>
        <td colSpan={5} style={{ padding: 0 }}>
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
            <div
              className="surface-card"
              style={{ width: "100%", maxWidth: 560, background: "var(--surface)" }}
            >
              <div style={{ padding: "18px 22px 14px", borderBottom: "1px solid var(--border)" }}>
                <h3 className="display-h3" style={{ margin: 0 }}>
                  {t("users.editPermsTitle", { name: user.username })}
                </h3>
              </div>
              <div style={{ padding: "20px 22px" }}>
                <PermGroupPicker selected={editPerms} onToggle={toggleEdit} />
              </div>
              <div
                style={{
                  padding: "14px 22px",
                  borderTop: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span className="perm-picker-count" style={{ marginLeft: 0, marginRight: "auto" }}>
                  {t("users.selectedCount", { n: editPerms.size })}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setEditing(false)}
                  disabled={savePerms.isPending}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => savePerms.mutate()}
                  disabled={savePerms.isPending}
                >
                  {savePerms.isPending ? t("common.loading") : t("users.save")}
                </button>
              </div>
            </div>
          </div>
        </td>
      </tr>
    )}
    </>
  );
}
