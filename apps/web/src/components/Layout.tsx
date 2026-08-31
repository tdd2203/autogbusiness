import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { RunningTaskBubble } from "./RunningTaskBubble";
import DailyGuideModal from "./DailyGuideModal";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import {
  useAddedEmails,
  usePendingPaymentCount,
  usePendingPaymentRequests,
  useRenewalDueCount,
} from "../hooks/useAddedEmails";
import { usePendingSubscriptionCount } from "../hooks/useSubscriptionApprovals";
import { useIsMobile } from "../hooks/useIsMobile";
import { SubscriptionNotificationBell } from "./SubscriptionNotificationBell";
import { useFormatDate, useI18n, useT, type Lang } from "../i18n";
import type { ReactNode } from "react";
import type { PaymentRequestNotice } from "../types";

type NavEntry = {
  to: string;
  labelKey: string;
  perm?: string;
  icon: ReactNode;
  section: "manage" | "org" | "canva";
  // Ví (feature 003): mục chỉ hiện với user bật cờ wallet_beta.
  requireWalletBeta?: boolean;
  // Quản trị Ví: chỉ super-admin.
  requireSuperAdmin?: boolean;
};

const ICONS = {
  workspaces: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M3 7h18M3 12h18M3 17h18" />
    </svg>
  ),
  invite: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M19 8v6M22 11h-6" />
    </svg>
  ),
  queue: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <rect x="3" y="10" width="18" height="4" rx="1" />
      <rect x="3" y="16" width="18" height="4" rx="1" />
    </svg>
  ),
  addedEmails: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M3 8l7.89 4.26a2 2 0 0 0 2.22 0L21 8" />
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M16 16l2 2 3-3" />
    </svg>
  ),
  renewals: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M23 4v6h-6" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  ),
  audit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="M9 12h6M9 16h4" />
    </svg>
  ),
  billing: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M2 10h20" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  wallet: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2" />
      <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2z" />
      <circle cx="16" cy="13" r="1.4" />
    </svg>
  ),
  report: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M3 3v18h18" />
      <rect x="7" y="12" width="3" height="5" rx="0.5" />
      <rect x="12" y="8" width="3" height="9" rx="0.5" />
      <rect x="17" y="5" width="3" height="12" rx="0.5" />
    </svg>
  ),
  dashboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="5" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="10" width="8" height="11" rx="1.5" />
    </svg>
  ),
  notifications: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  ),
  canvaTeams: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 9.5a3.5 3.5 0 1 0 0 5" />
    </svg>
  ),
  canvaPricing: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </svg>
  ),
};

const NAV: NavEntry[] = [
  // "Tổng quan" — trang chủ của đại lý, không gắn quyền: nó chỉ hiện số của chính
  // người đang đăng nhập.
  { to: "/dashboard", labelKey: "nav.dashboard", icon: ICONS.dashboard, section: "manage" },
  // Trang "Mời thành viên" phía người dùng — hiện cho user có quyền MEMBER_INVITE
  // (super-admin luôn có). Đích workspace do super-admin cấu hình qua nút ⚙️.
  { to: "/invite", labelKey: "nav.inviteMembers", perm: "MEMBER_INVITE", icon: ICONS.invite, section: "manage" },
  { to: "/added-emails", labelKey: "nav.addedEmails", perm: "MEMBER_VIEW", icon: ICONS.addedEmails, section: "manage" },
  // "Gia hạn" tách khỏi sub-tab trong "Email đã add" → mục riêng ở sidebar.
  { to: "/renewals", labelKey: "nav.renewals", perm: "MEMBER_VIEW", icon: ICONS.renewals, section: "manage" },
  // "Thông báo" (feature 004): kết nối Telegram, người nhận, mẫu nội dung, và trạng
  // thái thông báo của TỪNG email. Mở cho MỌI người dùng — ai add email cũng cần gửi
  // link nhắc gia hạn cho khách của mình.
  { to: "/notifications", labelKey: "nav.notifications", icon: ICONS.notifications, section: "manage" },
  // Ví (feature 003) — chỉ hiện với user bật cờ thử nghiệm wallet_beta.
  { to: "/wallet", labelKey: "nav.wallet", icon: ICONS.wallet, section: "manage", requireWalletBeta: true },
  // Queue toàn cục đã BỎ khỏi sidebar (2026-06-17): dư thừa vì mỗi workspace đã có
  // tab "Hàng đợi" riêng. Route /queue + page Queue.tsx vẫn còn nhưng không còn nav.
  { to: "/audit-logs", labelKey: "nav.auditLog", perm: "AUDIT_LOG_VIEW", icon: ICONS.audit, section: "manage" },
  // "Không gian làm việc" chuyển xuống ĐẦU nhóm Tổ chức + CHỈ super-admin thấy
  // (sub-admin quản lý qua "Email đã thêm", không thao tác trực tiếp workspace).
  { to: "/workspaces", labelKey: "nav.workspaces", icon: ICONS.workspaces, section: "org", requireSuperAdmin: true },
  { to: "/users", labelKey: "nav.users", perm: "USER_MANAGE", icon: ICONS.users, section: "org" },
  // Quản trị Ví (feature 003) — chỉ super-admin: cấu hình phí/bank, cờ beta, duyệt rút.
  { to: "/admin/wallet", labelKey: "nav.walletAdmin", icon: ICONS.wallet, section: "org", requireSuperAdmin: true },
  // Báo cáo tài chính (feature 003) — chỉ super-admin: THU/CHI/lợi nhuận + theo đại lý.
  { to: "/admin/report", labelKey: "nav.report", icon: ICONS.report, section: "org", requireSuperAdmin: true },
  { to: "/settings", labelKey: "nav.settings", icon: ICONS.settings, section: "org" },
  // ── Nhánh CANVA: nhóm RIÊNG ở thanh bên (user 2026-09-01: "làm riêng 1 nhánh
  // canva riêng, không chung với chatgpt"). Trang mời thì dùng chung một trang, có
  // công tắc nhánh, mặc định luôn là ChatGPT.
  { to: "/canva/teams", labelKey: "nav.canvaTeams", icon: ICONS.canvaTeams, section: "canva", requireSuperAdmin: true },
  { to: "/canva/pricing", labelKey: "nav.canvaPricing", icon: ICONS.canvaPricing, section: "canva", requireSuperAdmin: true },
];

export default function Layout() {
  const { user, logout, hasPermission } = useAuth();
  const { lang, setLang, t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  // Thu gọn sidebar (desktop): tự ẩn khi màn hình hẹp (≤1200px) để nội dung đủ chỗ;
  // nút mũi tên cho phép tự bật/tắt. Mobile (≤768) dùng drawer riêng, không tính ở đây.
  const isMobile = useIsMobile(768);
  const isNarrowDesktop = useIsMobile(1200);
  const [collapsed, setCollapsed] = useState<boolean>(isNarrowDesktop);
  // Tự thu/mở khi VƯỢT ngưỡng 1200 (đổi isNarrowDesktop) — vẫn cho toggle tay giữa 2 lần.
  useEffect(() => {
    if (!isMobile) setCollapsed(isNarrowDesktop);
  }, [isNarrowDesktop, isMobile]);
  const sidebarCollapsed = !isMobile && collapsed;
  // Số email đang "Chờ xác nhận" → badge thông báo cho super-admin (0 với sub-admin).
  const pendingPayments = usePendingPaymentCount();
  // Số yêu cầu đổi hạn dùng đang chờ duyệt → badge chuông thứ 2 (0 với sub-admin).
  const pendingSubscriptions = usePendingSubscriptionCount();
  // Số thành viên sắp/đã hết hạn → badge trên mục "Gia hạn" ở sidebar.
  const renewalDueCount = useRenewalDueCount();

  // Đóng drawer mỗi khi chuyển trang (mobile).
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  // Đổi ngôn ngữ HIỂN THỊ dashboard (per-user, localStorage). CHỈ ảnh hưởng giao
  // diện — KHÔNG liên quan "ngôn ngữ hệ thống" (locale ChatGPT của workspace, do
  // super-admin đặt ở Cài đặt). Trước đây đổi hiển thị còn bắn toast nhắc đổi
  // ChatGPT → gây hiểu nhầm 2 thứ dính nhau; nay đã tách hẳn.
  function onDashboardLangChange(next: Lang) {
    if (next === lang) return;
    setLang(next);
  }

  function onLogout() {
    logout();
    navigate("/login");
  }

  const initial = (user?.username ?? user?.email ?? "?").charAt(0).toUpperCase();
  const sidebarLabel = user?.username ?? user?.email ?? "";
  const navVisible = (n: NavEntry): boolean => {
    if (n.requireWalletBeta && !(user?.wallet_beta || user?.is_super_admin)) return false;
    if (n.requireSuperAdmin && !user?.is_super_admin) return false;
    if (n.perm && !hasPermission(n.perm)) return false;
    return true;
  };
  const manageItems = NAV.filter((n) => n.section === "manage" && navVisible(n));
  const orgItems = NAV.filter((n) => n.section === "org" && navVisible(n));
  const canvaItems = NAV.filter((n) => n.section === "canva" && navVisible(n));

  return (
    <div
      className={`app-shell min-h-screen${sidebarCollapsed ? " sidebar-collapsed" : ""}`}
    >
      {/* Nút mũi tên thu/mở sidebar (chỉ desktop; mobile dùng hamburger ở topbar). */}
      {!isMobile && (
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? t("nav.showMenu") : t("nav.hideMenu")}
          title={collapsed ? t("nav.showMenu") : t("nav.hideMenu")}
          style={{
            position: "fixed",
            top: 96,
            left: collapsed ? 10 : 227,
            zIndex: 60,
            width: 26,
            height: 26,
            borderRadius: "50%",
            border: "1px solid var(--border)",
            background: "var(--surface)",
            color: "var(--ink-2)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            boxShadow: "var(--shadow-card)",
            transition: "left 0.2s ease",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            style={{
              width: 15,
              height: 15,
              transform: collapsed ? "none" : "rotate(180deg)",
            }}
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      )}

      <header className="app-topbar">
        <button
          type="button"
          className="app-hamburger"
          aria-label={t("nav.openMenu")}
          aria-expanded={navOpen}
          onClick={() => setNavOpen(true)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        {/* Logo về trang chủ "/" → HomeRedirect định tuyến theo vai trò
            (super → Không gian làm việc, sub-admin → Email đã thêm). */}
        <Link to="/" className="app-topbar-title">
          {t("app.name")}
        </Link>
        <span
          style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}
        >
          <SubscriptionNotificationBell
            count={pendingSubscriptions}
            label={t("subscription.notifTitle")}
          />
          <NotificationBell
            count={pendingPayments}
            label={t("nav.pendingPayments")}
            onViewAll={() => navigate("/added-emails?filter=requested")}
          />
        </span>
      </header>

      {navOpen && (
        <div
          className="app-backdrop"
          aria-hidden
          onClick={() => setNavOpen(false)}
        />
      )}

      <aside
        className={`app-sidebar flex flex-col${navOpen ? " open" : ""}`}
        style={{
          background: "var(--sidebar)",
          borderRight: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            padding: "24px 24px 32px",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <Link
            to="/"
            aria-label="AutoGPT home"
            style={{
              display: "inline-block",
              textDecoration: "none",
              color: "inherit",
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-display)",
                fontSize: 18,
                fontWeight: 600,
                letterSpacing: "-0.01em",
                color: "var(--ink)",
              }}
            >
              {t("app.name")}
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                color: "var(--ink-3)",
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.02em",
                textTransform: "uppercase",
              }}
            >
              {t("app.adminBadge")}
            </div>
          </Link>
          <span style={{ display: "inline-flex", gap: 8 }}>
            <SubscriptionNotificationBell
              count={pendingSubscriptions}
              label={t("subscription.notifTitle")}
            />
            <NotificationBell
              count={pendingPayments}
              label={t("nav.pendingPayments")}
              onViewAll={() => navigate("/added-emails?filter=requested")}
            />
          </span>
        </div>

        <nav className="flex-1" style={{ padding: "0 12px" }}>
          <SidebarSection label={t("nav.sectionManage")}>
            {manageItems.map((n) => (
              <SidebarItem
                key={n.to}
                to={n.to}
                icon={n.icon}
                badge={n.to === "/renewals" ? renewalDueCount : 0}
              >
                {t(n.labelKey)}
              </SidebarItem>
            ))}
          </SidebarSection>
          {canvaItems.length > 0 && (
            <SidebarSection label={t("nav.sectionCanva")}>
              {canvaItems.map((n) => (
                <SidebarItem key={n.to} to={n.to} icon={n.icon}>
                  {t(n.labelKey)}
                </SidebarItem>
              ))}
            </SidebarSection>
          )}
          {orgItems.length > 0 && (
            <SidebarSection label={t("nav.sectionOrg")}>
              {orgItems.map((n) => (
                <SidebarItem key={n.to} to={n.to} icon={n.icon}>
                  {t(n.labelKey)}
                </SidebarItem>
              ))}
            </SidebarSection>
          )}
        </nav>

        <div
          className="app-sidebar-footer"
          style={{
            padding: 16,
            borderTop: "1px solid var(--border)",
            background: "var(--sidebar)",
          }}
        >
          <div className="flex items-center" style={{ gap: 10 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: "var(--ink)",
                color: "var(--surface)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                fontWeight: 500,
                flexShrink: 0,
              }}
            >
              {initial}
            </div>
            <div className="flex-1 min-w-0">
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--ink)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={sidebarLabel}
              >
                {sidebarLabel}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--ink-3)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {user?.is_super_admin ? t("role.super") : t("role.sub")}
              </div>
            </div>
          </div>
          <div
            style={{
              marginTop: 12,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {/* Ngôn ngữ HIỂN THỊ: nút mã chữ VI / 中, bấm đổi qua lại (chỉ 2 ngôn
                ngữ). Thuần giao diện — không dính "ngôn ngữ hệ thống". */}
            <button
              type="button"
              onClick={() =>
                onDashboardLangChange(lang === "vi" ? "zh-CN" : "vi")
              }
              aria-label={t("lang.switch")}
              title={`${t("lang.switch")}: ${
                lang === "vi" ? t("lang.viOption") : t("lang.zhOption")
              }`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                flex: 1,
                height: 36,
                fontSize: 12.5,
                fontWeight: 600,
                color: "var(--ink-2)",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                cursor: "pointer",
                fontFamily: "inherit",
                transition: "color 0.12s, border-color 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--ink)";
                e.currentTarget.style.borderColor = "var(--ink-2)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--ink-2)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                style={{ width: 16, height: 16, flexShrink: 0 }}
                aria-hidden
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" />
              </svg>
              {lang === "vi" ? "VI" : "中"}
            </button>
            {/* Đăng xuất: nút icon SVG (cửa + mũi tên ra), đồng bộ style icon app. */}
            <button
              type="button"
              onClick={onLogout}
              aria-label={t("auth.logout")}
              title={t("auth.logout")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 36,
                height: 36,
                flexShrink: 0,
                color: "var(--ink-2)",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                cursor: "pointer",
                transition: "color 0.12s, border-color 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--danger)";
                e.currentTarget.style.borderColor = "var(--danger)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--ink-2)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                style={{ width: 17, height: 17 }}
                aria-hidden
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="M16 17l5-5-5-5" />
                <path d="M21 12H9" />
              </svg>
            </button>
          </div>
        </div>
      </aside>

      <main className="app-main">
        <Outlet />
      </main>

      {/* Bong bóng "đang có lệnh chạy" — nổi ở góc, hiện trên MỌI trang (kể cả điện
          thoại) khi có task đang chờ/chạy. Tự ẩn khi panel hàng đợi cột phải đã hiện.
          Xem RunningTaskBubble.md. */}
      <RunningTaskBubble />

      {/* Popup hướng dẫn đầu ngày — mỗi ngày một bài, bốc ngẫu nhiên. Đặt ở Layout để
          hiện trên MỌI trang sau khi đăng nhập, không phải chỉ trang Tổng quan.
          Xem DailyGuideModal.md. */}
      <DailyGuideModal />
    </div>
  );
}

/**
 * Chuông thông báo cho super-admin: badge đỏ = số email đang "Chờ xác nhận".
 * Bấm chuông → dropdown danh sách TIN NHẮN (ai gửi yêu cầu, email gì, khi nào)
 * kèm nút "Xác nhận" duyệt nhanh từng email. Ẩn hoàn toàn khi count = 0
 * (sub-admin luôn 0). "Xem tất cả" → tab Email đã add lọc "Chờ xác nhận".
 */
function NotificationBell({
  count,
  label,
  onViewAll,
}: {
  count: number;
  label: string;
  onViewAll: () => void;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { data: notices, isLoading } = usePendingPaymentRequests(open);
  const { markPaid } = useAddedEmails();

  // Gom theo người gửi để duyệt hàng loạt ("Xác nhận tất cả của {người này}").
  // notices đã sắp mới-nhất-trước → giữ thứ tự xuất hiện đầu tiên của mỗi nhóm.
  const groups = useMemo(() => {
    const byUser = new Map<
      string,
      { name: string; ids: string[]; items: PaymentRequestNotice[] }
    >();
    for (const n of notices ?? []) {
      const name = n.requested_by_username ?? t("notif.unknownUser");
      // Key theo username (null gộp chung dưới nhãn unknownUser).
      const key = n.requested_by_username ?? " unknown";
      let g = byUser.get(key);
      if (!g) {
        g = { name, ids: [], items: [] };
        byUser.set(key, g);
      }
      g.ids.push(n.member_id);
      g.items.push(n);
    }
    return [...byUser.values()];
  }, [notices, t]);

  // Đóng dropdown khi bấm ra ngoài hoặc nhấn Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (count <= 0) return null;

  return (
    <div ref={wrapRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`${label} (${count})`}
        aria-expanded={open}
        title={`${label} (${count})`}
        style={{
          position: "relative",
          width: 36,
          height: 36,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          background: open ? "var(--surface-2)" : "var(--surface)",
          color: open ? "var(--ink)" : "var(--ink-2)",
          cursor: "pointer",
          transition: "background 0.12s, color 0.12s",
        }}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          style={{ width: 18, height: 18 }}
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: -6,
            right: -6,
            minWidth: 18,
            height: 18,
            padding: "0 5px",
            borderRadius: 9,
            background: "var(--danger)",
            color: "#fff",
            fontSize: 11,
            fontWeight: 600,
            lineHeight: "18px",
            textAlign: "center",
            boxShadow: "0 0 0 2px var(--surface)",
          }}
        >
          {count > 99 ? "99+" : count}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: 0,
            zIndex: 60,
            width: 340,
            maxWidth: "calc(100vw - 32px)",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 12px 40px rgba(0,0,0,0.18)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "12px 14px",
              borderBottom: "1px solid var(--border)",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ink)",
            }}
          >
            {t("notif.title")} · {count}
          </div>

          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            {isLoading && (
              <div
                style={{ padding: "16px 14px", fontSize: 12.5, color: "var(--ink-3)" }}
              >
                {t("common.loading")}
              </div>
            )}
            {!isLoading && (notices?.length ?? 0) === 0 && (
              <div
                style={{ padding: "16px 14px", fontSize: 12.5, color: "var(--ink-3)" }}
              >
                {t("notif.empty")}
              </div>
            )}
            {groups.map((g) => (
              <div
                key={g.name}
                style={{ borderBottom: "1px solid var(--border)" }}
              >
                {/* Header nhóm: tên người gửi + đếm + nút duyệt hàng loạt. */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "10px 14px 8px",
                  }}
                >
                  <div style={{ fontSize: 12.5, color: "var(--ink)", minWidth: 0 }}>
                    <strong>{g.name}</strong>{" "}
                    <span style={{ color: "var(--ink-3)" }}>
                      · {t("notif.groupCount", { n: g.ids.length })}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={markPaid.isPending}
                    title={t("notif.confirmAll", { name: g.name })}
                    onClick={() =>
                      markPaid.mutate({ ids: g.ids, paid: true })
                    }
                    style={{
                      flexShrink: 0,
                      fontSize: 11.5,
                      fontWeight: 500,
                      padding: "4px 10px",
                      borderRadius: "var(--radius)",
                      border: "1px solid var(--border)",
                      background: "var(--ink)",
                      color: "var(--surface)",
                      cursor: markPaid.isPending ? "default" : "pointer",
                      opacity: markPaid.isPending ? 0.6 : 1,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t("notif.confirmAllShort")}
                  </button>
                </div>
                {/* Từng email trong nhóm + nút xác nhận riêng. */}
                {g.items.map((n) => (
                  <div
                    key={n.member_id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "6px 14px 10px",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontFamily: "var(--font-mono)",
                          color: "var(--ink-2)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {n.email}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                        {n.workspace_name ? `${n.workspace_name} · ` : ""}
                        {n.requested_at ? formatDate(n.requested_at) : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={markPaid.isPending}
                      title={t("notif.confirm")}
                      aria-label={t("notif.confirm")}
                      onClick={() =>
                        markPaid.mutate({ ids: [n.member_id], paid: true })
                      }
                      style={{
                        flexShrink: 0,
                        width: 28,
                        height: 28,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: "var(--radius)",
                        border: "1px solid var(--border)",
                        background: "var(--surface)",
                        color: "var(--ink-2)",
                        cursor: markPaid.isPending ? "default" : "pointer",
                        opacity: markPaid.isPending ? 0.6 : 1,
                      }}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        style={{ width: 14, height: 14 }}
                      >
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onViewAll();
            }}
            style={{
              display: "block",
              width: "100%",
              padding: "10px 14px",
              border: "none",
              borderTop: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--ink-2)",
              fontSize: 12.5,
              fontWeight: 500,
              cursor: "pointer",
              textAlign: "center",
            }}
          >
            {t("notif.viewAll")}
          </button>
        </div>
      )}
    </div>
  );
}

function SidebarSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--ink-3)",
          padding: "0 12px 8px",
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function SidebarItem({
  to,
  icon,
  children,
  badge = 0,
}: {
  to: string;
  icon: ReactNode;
  children: ReactNode;
  badge?: number;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
      style={({ isActive }) => ({
        display: "flex",
        alignItems: "center",
        gap: 11,
        padding: "9px 11px",
        borderRadius: "var(--radius)",
        // Mục đang chọn = pill tối (chữ trắng) — dấu ấn của giao diện mới.
        color: isActive ? "var(--surface)" : "var(--ink-2)",
        background: isActive ? "var(--ink)" : "transparent",
        textDecoration: "none",
        fontSize: 14,
        marginBottom: 2,
        fontWeight: 500,
        transition: "background 0.12s ease, color 0.12s ease",
      })}
    >
      <span
        aria-hidden
        style={{
          width: 16,
          height: 16,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {icon}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {/* Badge số lượng cần gia hạn — nền đỏ để nổi bật, ẩn khi = 0. */}
      {badge > 0 && (
        <span
          aria-hidden
          style={{
            flexShrink: 0,
            minWidth: 18,
            height: 18,
            padding: "0 5px",
            borderRadius: 9,
            background: "var(--danger)",
            color: "#fff",
            fontSize: 11,
            fontWeight: 600,
            lineHeight: "18px",
            textAlign: "center",
          }}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </NavLink>
  );
}
