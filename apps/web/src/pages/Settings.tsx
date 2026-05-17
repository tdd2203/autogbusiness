import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError, setToken } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { useT } from "../i18n";

export default function Settings() {
  const t = useT();
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
      setMsg({ ok: true, text: t("auth.changePasswordOk") });
      setOldPw("");
      setNewPw("");
    },
    onError: (e) => {
      setMsg({
        ok: false,
        text:
          e instanceof ApiError ? String(e.detail) : t("auth.changePasswordError"),
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
      <h1 className="text-2xl font-semibold mb-6">{t("settings.title")}</h1>

      <div className="bg-white rounded shadow p-5 mb-6">
        <h2 className="font-medium mb-2">{t("settings.accountInfo")}</h2>
        <div className="text-sm text-slate-700 space-y-1">
          <div>
            {t("settings.email")}: {user?.email}
          </div>
          <div>
            {t("settings.username")}: {user?.username}
          </div>
          <div>
            {t("settings.role")}:{" "}
            {user?.is_super_admin ? t("role.super") : t("role.sub")}
          </div>
        </div>
      </div>

      <form onSubmit={onSubmit} className="bg-white rounded shadow p-5 space-y-3">
        <h2 className="font-medium">{t("settings.changePasswordHeader")}</h2>
        <input
          required
          type="password"
          placeholder={t("auth.oldPassword")}
          value={oldPw}
          onChange={(e) => setOldPw(e.target.value)}
          className="w-full border rounded px-3 py-2"
        />
        <input
          required
          type="password"
          placeholder={t("auth.newPassword")}
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
          {mut.isPending
            ? t("auth.changePasswordBusy")
            : t("auth.changePassword")}
        </button>
      </form>
    </div>
  );
}
