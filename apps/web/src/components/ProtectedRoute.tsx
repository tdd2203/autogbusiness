import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "../hooks/useAuth";

export default function ProtectedRoute({
  children,
  requirePermission,
  requireSuperAdmin,
}: {
  children: ReactNode;
  requirePermission?: string;
  requireSuperAdmin?: boolean;
}) {
  const { user, loading, hasPermission } = useAuth();
  const location = useLocation();

  if (loading) return <div className="p-8">Đang tải...</div>;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (requireSuperAdmin && !user.is_super_admin) {
    return (
      <div className="p-8">
        <h1 className="text-xl font-semibold mb-2">403 - Chỉ super-admin</h1>
        <p className="text-slate-600">Trang này chỉ super-admin truy cập được.</p>
      </div>
    );
  }
  if (requirePermission && !hasPermission(requirePermission)) {
    return (
      <div className="p-8">
        <h1 className="text-xl font-semibold mb-2">403 - Không đủ quyền</h1>
        <p className="text-slate-600">
          Bạn không có quyền <code>{requirePermission}</code> để xem trang này.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}
