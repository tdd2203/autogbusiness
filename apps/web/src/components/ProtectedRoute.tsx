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

  if (loading) return <div className="p-8">{t("common.loading")}</div>;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (requireSuperAdmin && !user.is_super_admin) {
    return (
      <div className="p-8">
        <h1 className="text-xl font-semibold mb-2">
          {t("protected.403SuperTitle")}
        </h1>
        <p className="text-slate-600">{t("protected.403Super")}</p>
      </div>
    );
  }
  if (requirePermission && !hasPermission(requirePermission)) {
    return (
      <div className="p-8">
        <h1 className="text-xl font-semibold mb-2">
          {t("protected.403Title")}
        </h1>
        <p className="text-slate-600">
          {t("protected.403Perm", { perm: requirePermission })}
        </p>
      </div>
    );
  }
  return <>{children}</>;
}
