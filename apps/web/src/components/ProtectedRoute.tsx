import { Navigate, useLocation } from "react-router-dom";
import { useState, type ReactNode } from "react";
import { useAuth } from "../hooks/useAuth";
import { useT } from "../i18n";

export default function ProtectedRoute({
  children,
  requirePermission,
  requireSuperAdmin,
}: {
  children: ReactNode;
  requirePermission?: string;
  requireSuperAdmin?: boolean;
}) {
  const t = useT();
  const { user, loading, authError, hasPermission } = useAuth();
  const location = useLocation();

  if (loading)
    return (
      <div style={{ padding: 32, color: "var(--ink-3)" }}>
        {t("common.loading")}
      </div>
    );
  // Máy chủ không trả lời KHÁC hết phiên: token còn nguyên, đá về /login chỉ khiến
  // user gõ mật khẩu vào một cái server vẫn đang câm. Đứng lại đây, nói thật lý do,
  // cho bấm thử lại — trước đây chỗ này treo ở "Đang tải…" vô thời hạn vì `fetch`
  // không có hạn giờ (user 2026-08-30).
  if (!user && authError) return <AuthOffline message={authError} />;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (requireSuperAdmin && !user.is_super_admin) {
    return (
      <div style={{ padding: 32 }}>
        <h1 className="display-h2" style={{ marginBottom: 8 }}>
          {t("protected.403SuperTitle")}
        </h1>
        <p style={{ color: "var(--ink-2)" }}>{t("protected.403Super")}</p>
      </div>
    );
  }
  if (requirePermission && !hasPermission(requirePermission)) {
    return (
      <div style={{ padding: 32 }}>
        <h1 className="display-h2" style={{ marginBottom: 8 }}>
          {t("protected.403Title")}
        </h1>
        <p style={{ color: "var(--ink-2)" }}>
          {t("protected.403Perm", { perm: requirePermission })}
        </p>
      </div>
    );
  }
  return <>{children}</>;
}

/** Mất liên lạc với máy chủ trong lúc vẫn còn phiên: báo lý do + nút thử lại. */
function AuthOffline({ message }: { message: string }) {
  const t = useT();
  const { refresh, logout } = useAuth();
  const [busy, setBusy] = useState(false);

  async function retry() {
    setBusy(true);
    try {
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 32, maxWidth: 460 }}>
      <h1 className="display-h2" style={{ marginBottom: 8 }}>
        {t("protected.offlineTitle")}
      </h1>
      <p style={{ color: "var(--ink-2)", marginBottom: 6 }}>{message}</p>
      <p style={{ color: "var(--ink-3)", fontSize: 13, marginBottom: 18 }}>
        {t("protected.offlineHint")}
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={retry}
          disabled={busy}
          style={{
            padding: "10px 18px",
            background: "var(--ink)",
            color: "var(--surface)",
            border: "none",
            borderRadius: "var(--radius)",
            fontSize: 13,
            fontWeight: 700,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? t("protected.retrying") : t("protected.retry")}
        </button>
        <button
          onClick={logout}
          style={{
            padding: "10px 16px",
            background: "var(--surface)",
            color: "var(--ink-2)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius)",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {t("protected.signOut")}
        </button>
      </div>
    </div>
  );
}
