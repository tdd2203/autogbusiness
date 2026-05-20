import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { GRANTABLE, type PermissionKey } from "../lib/permissions";
import { useFormatDate, useT } from "../i18n";
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

export default function Users() {
  const t = useT();
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => api<UserItem[]>("/api/v1/users"),
  });

  const [showForm, setShowForm] = useState(false);
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
          <p className="page-sub">{t("users.subtitle")}</p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="btn btn-primary"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M12 5v14M5 12h14" />
          </svg>
          {showForm ? t("users.close") : t("users.create")}
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

      <div className="table-card">
        <div className="table-head">
          <div>
            <div className="table-title">{t("users.title")}</div>
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
                <th>{t("users.email")}</th>
                <th>{t("users.username")}</th>
                <th>{t("users.typeCol")}</th>
                <th>{t("users.permissionsCol")}</th>
                <th>{t("users.statusCol")}</th>
                <th style={{ textAlign: "right" }}>{t("users.actionsCol")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <UserRow key={u.id} user={u} />
              ))}
              {!users.isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="cell-muted" style={{ textAlign: "center", padding: 32 }}>
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

function CreateUserForm({ onCreated }: { onCreated: () => void }) {
  const t = useT();
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
      style={{ padding: 20, marginBottom: 20 }}
    >
      <div className="display-h3" style={{ marginBottom: 12 }}>
        {t("users.create")}
      </div>
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          marginBottom: 16,
        }}
      >
        <input
          placeholder={t("users.email")}
          required
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="form-input"
        />
        <input
          placeholder={t("users.username")}
          required
          minLength={3}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="form-input"
        />
        <input
          placeholder={t("users.password")}
          required
          minLength={8}
          type="text"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="form-input"
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <div
          className="form-label"
          style={{ fontWeight: 500, marginBottom: 8 }}
        >
          {t("users.grantTitle")}
        </div>
        <div
          className="grid"
          style={{
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 8,
          }}
        >
          {GRANTABLE.map((p) => (
            <label
              key={p}
              className="flex items-center"
              style={{ gap: 8, fontSize: 13 }}
            >
              <input
                type="checkbox"
                checked={perms.has(p)}
                onChange={() => toggle(p)}
              />
              <span>
                {t(`perm.${p}`)}{" "}
                <code
                  style={{
                    fontSize: 11,
                    color: "var(--ink-3)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {p}
                </code>
              </span>
            </label>
          ))}
        </div>
      </div>

      {err && (
        <div style={{ color: "var(--danger)", fontSize: 12.5, marginBottom: 10 }}>
          {err}
        </div>
      )}

      <button disabled={mut.isPending} className="btn btn-primary">
        {mut.isPending ? t("users.createBusy") : t("users.createSubmit")}
      </button>
    </form>
  );
}

function UserRow({ user }: { user: UserItem }) {
  const t = useT();
  const formatDate = useFormatDate();
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
    const np = window.prompt(t("users.resetPrompt"));
    if (!np || np.length < 8) return;
    reset.mutate(np);
  }

  const initial = (user.email || user.username || "?").charAt(0).toUpperCase();
  const sinceDate = formatDate(user.created_at);

  return (
    <tr>
      <td>
        <div className="actor">
          <div className="actor-avatar">{initial}</div>
          <div>
            <div className="actor-name">{user.email}</div>
            <div className="actor-sub">
              {t("users.ownerSince", { date: sinceDate })}
            </div>
          </div>
        </div>
      </td>
      <td className="cell-muted mono" style={{ fontSize: 12.5 }}>
        {user.username}
      </td>
      <td>
        {user.is_super_admin ? (
          <span className="badge badge-info">{t("role.super")}</span>
        ) : (
          <span className="role-tag">{t("role.sub")}</span>
        )}
      </td>
      <td style={{ maxWidth: 320 }}>
        {user.is_super_admin ? (
          <span className="cell-muted">{t("users.fullPerms")}</span>
        ) : user.permissions.length === 0 ? (
          <span className="cell-muted">{t("users.noPerms")}</span>
        ) : (
          <div className="flex flex-wrap" style={{ gap: 4 }}>
            {user.permissions.map((p) => (
              <span key={p} className="role-tag" style={{ fontSize: 11 }}>
                {p}
              </span>
            ))}
          </div>
        )}
      </td>
      <td>
        {user.is_active ? (
          <span className="badge badge-success">{t("users.active")}</span>
        ) : (
          <span className="badge badge-danger">{t("users.disabled")}</span>
        )}
      </td>
      <td style={{ textAlign: "right" }}>
        {!user.is_super_admin && (
          <div className="flex items-center justify-end" style={{ gap: 6 }}>
            <button
              onClick={() => toggleActive.mutate()}
              className="row-action neutral"
            >
              {user.is_active ? t("users.disable") : t("users.enable")}
            </button>
            <button onClick={onReset} className="row-action neutral">
              {t("users.resetPassword")}
            </button>
          </div>
        )}
        {user.is_super_admin && (
          <span className="cell-muted" style={{ fontSize: 12 }}>
            {t("users.editAction")}
          </span>
        )}
      </td>
    </tr>
  );
}
