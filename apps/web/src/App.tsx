import { Navigate, Route, Routes } from "react-router-dom";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Queue from "./pages/Queue";
import AuditLogs from "./pages/AuditLogs";
import Users from "./pages/Users";
import Settings from "./pages/Settings";
import Workspaces from "./pages/Workspaces";
import Members from "./pages/Members";
import InviteMembers from "./pages/InviteMembers";
import AddedEmails from "./pages/AddedEmails";
import Renewals from "./pages/Renewals";
import Notifications from "./pages/Notifications";
import Wallet from "./pages/Wallet";
import WalletAdmin from "./pages/WalletAdmin";
import WalletAdminUser from "./pages/WalletAdminUser";
import FinancialReport from "./pages/FinancialReport";
import WorkspaceQueue from "./pages/WorkspaceQueue";
import WorkspaceBilling from "./pages/WorkspaceBilling";
import WorkspaceExtension from "./pages/WorkspaceExtension";
import WorkspaceSettings from "./pages/WorkspaceSettings";
import Layout from "./components/Layout";
import WorkspaceLayout from "./components/WorkspaceLayout";
import ProtectedRoute from "./components/ProtectedRoute";

// "Tổng quan" là trang chủ chung cho mọi vai trò, kể cả super-admin (trước đây
// admin rơi vào "Không gian làm việc"). Ai cần danh sách workspace vẫn bấm mục
// đó ở thanh bên.
function HomeRedirect() {
  return <Navigate to="/dashboard" replace />;
}

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
        <Route index element={<HomeRedirect />} />
        {/* "Tổng quan" — mở cho MỌI người dùng; backend luôn chốt số của chính
            tài khoản đang đăng nhập nên không cần quyền riêng. */}
        <Route path="dashboard" element={<Dashboard />} />
        {/* Trang "Mời thành viên" phía người dùng — mở cho user có quyền MEMBER_INVITE
            (super-admin luôn có). Không cần workspace trên URL: hệ thống tự chọn
            workspace đích theo cấu hình (nút ⚙️, super-admin đặt). */}
        <Route
          path="invite"
          element={
            <ProtectedRoute requirePermission="MEMBER_INVITE">
              <InviteMembers />
            </ProtectedRoute>
          }
        />
        <Route
          path="workspaces"
          element={
            <ProtectedRoute requireSuperAdmin>
              <Workspaces />
            </ProtectedRoute>
          }
        />
        <Route
          path="workspaces/:workspaceId"
          element={
            <ProtectedRoute requireSuperAdmin>
              <WorkspaceLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="members" replace />} />
          <Route path="members" element={<Members />} />
          <Route
            path="billing"
            element={
              <ProtectedRoute requirePermission="BILLING_VIEW">
                <WorkspaceBilling />
              </ProtectedRoute>
            }
          />
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
          path="added-emails"
          element={
            <ProtectedRoute requirePermission="MEMBER_VIEW">
              <AddedEmails />
            </ProtectedRoute>
          }
        />
        <Route
          path="renewals"
          element={
            <ProtectedRoute requirePermission="MEMBER_VIEW">
              <Renewals />
            </ProtectedRoute>
          }
        />
        {/* "Thông báo" (feature 004) — mở cho MỌI người dùng đã đăng nhập: kết nối
            Telegram, người nhận, mẫu nội dung + trạng thái thông báo từng email. */}
        <Route path="notifications" element={<Notifications />} />
        {/* Ví (feature 003) — bảo vệ ở FE bằng ProtectedRoute; backend chặn thật
            bằng require_wallet_enabled (403 nếu chưa bật cờ). */}
        <Route path="wallet" element={<Wallet />} />
        <Route
          path="admin/wallet"
          element={
            <ProtectedRoute requireSuperAdmin>
              <WalletAdmin />
            </ProtectedRoute>
          }
        />
        {/* Ví của MỘT tài khoản — cùng giao diện trang Ví, xem components/WalletHistory. */}
        <Route
          path="admin/wallet/:userId"
          element={
            <ProtectedRoute requireSuperAdmin>
              <WalletAdminUser />
            </ProtectedRoute>
          }
        />
        <Route
          path="admin/report"
          element={
            <ProtectedRoute requireSuperAdmin>
              <FinancialReport />
            </ProtectedRoute>
          }
        />
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
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
