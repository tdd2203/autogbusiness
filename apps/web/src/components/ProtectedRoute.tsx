import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
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
  const { user, loading, hasPermission } = useAuth();
  const location = useLocation();

  if (loading)
    return (
      <div style={{ padding: 32, color: "var(--ink-3)" }}>
        {t("common.loading")}
      </div>
    );
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
