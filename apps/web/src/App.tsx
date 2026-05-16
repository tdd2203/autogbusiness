import { Navigate, Route, Routes } from "react-router-dom";
import Login from "./pages/Login";
import Queue from "./pages/Queue";
import AuditLogs from "./pages/AuditLogs";
import Users from "./pages/Users";
import Settings from "./pages/Settings";
import Billing from "./pages/Billing";
import Workspaces from "./pages/Workspaces";
import Members from "./pages/Members";
import WorkspaceQueue from "./pages/WorkspaceQueue";
import WorkspaceExtension from "./pages/WorkspaceExtension";
import WorkspaceSettings from "./pages/WorkspaceSettings";
import Layout from "./components/Layout";
import WorkspaceLayout from "./components/WorkspaceLayout";
import ProtectedRoute from "./components/ProtectedRoute";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/workspaces" replace />} />
        <Route
          path="workspaces"
          element={
            <ProtectedRoute requirePermission="MEMBER_VIEW">
              <Workspaces />
            </ProtectedRoute>
          }
        />
        <Route
          path="workspaces/:workspaceId"
          element={
            <ProtectedRoute requirePermission="MEMBER_VIEW">
              <WorkspaceLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="members" replace />} />
          <Route path="members" element={<Members />} />
          <Route
            path="queue"
            element={
              <ProtectedRoute requirePermission="QUEUE_VIEW">
                <WorkspaceQueue />
              </ProtectedRoute>
            }
          />
          <Route
            path="extension"
            element={
              <ProtectedRoute requireSuperAdmin>
                <WorkspaceExtension />
              </ProtectedRoute>
            }
          />
          <Route
            path="settings"
            element={
              <ProtectedRoute requireSuperAdmin>
                <WorkspaceSettings />
              </ProtectedRoute>
            }
          />
        </Route>
        <Route
          path="queue"
          element={
            <ProtectedRoute requirePermission="QUEUE_VIEW">
              <Queue />
            </ProtectedRoute>
          }
        />
        <Route
          path="audit-logs"
          element={
            <ProtectedRoute requirePermission="AUDIT_LOG_VIEW">
              <AuditLogs />
            </ProtectedRoute>
          }
        />
        <Route
          path="users"
          element={
            <ProtectedRoute requirePermission="USER_MANAGE">
              <Users />
            </ProtectedRoute>
          }
        />
        <Route
          path="billing"
          element={
            <ProtectedRoute requirePermission="BILLING_VIEW">
              <Billing />
            </ProtectedRoute>
          }
        />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
