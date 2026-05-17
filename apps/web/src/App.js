import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
    return (_jsxs(Routes, { children: [_jsx(Route, { path: "/login", element: _jsx(Login, {}) }), _jsxs(Route, { element: _jsx(ProtectedRoute, { children: _jsx(Layout, {}) }), children: [_jsx(Route, { index: true, element: _jsx(Navigate, { to: "/workspaces", replace: true }) }), _jsx(Route, { path: "workspaces", element: _jsx(ProtectedRoute, { requirePermission: "MEMBER_VIEW", children: _jsx(Workspaces, {}) }) }), _jsxs(Route, { path: "workspaces/:workspaceId", element: _jsx(ProtectedRoute, { requirePermission: "MEMBER_VIEW", children: _jsx(WorkspaceLayout, {}) }), children: [_jsx(Route, { index: true, element: _jsx(Navigate, { to: "members", replace: true }) }), _jsx(Route, { path: "members", element: _jsx(Members, {}) }), _jsx(Route, { path: "queue", element: _jsx(ProtectedRoute, { requirePermission: "QUEUE_VIEW", children: _jsx(WorkspaceQueue, {}) }) }), _jsx(Route, { path: "extension", element: _jsx(ProtectedRoute, { requireSuperAdmin: true, children: _jsx(WorkspaceExtension, {}) }) }), _jsx(Route, { path: "settings", element: _jsx(ProtectedRoute, { requireSuperAdmin: true, children: _jsx(WorkspaceSettings, {}) }) })] }), _jsx(Route, { path: "queue", element: _jsx(ProtectedRoute, { requirePermission: "QUEUE_VIEW", children: _jsx(Queue, {}) }) }), _jsx(Route, { path: "audit-logs", element: _jsx(ProtectedRoute, { requirePermission: "AUDIT_LOG_VIEW", children: _jsx(AuditLogs, {}) }) }), _jsx(Route, { path: "users", element: _jsx(ProtectedRoute, { requirePermission: "USER_MANAGE", children: _jsx(Users, {}) }) }), _jsx(Route, { path: "billing", element: _jsx(ProtectedRoute, { requirePermission: "BILLING_VIEW", children: _jsx(Billing, {}) }) }), _jsx(Route, { path: "settings", element: _jsx(Settings, {}) })] }), _jsx(Route, { path: "*", element: _jsx(Navigate, { to: "/", replace: true }) })] }));
}
