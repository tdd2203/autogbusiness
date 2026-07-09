import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import {
  useAddedEmails,
  usePendingPaymentCount,
  usePendingPaymentRequests,
} from "../hooks/useAddedEmails";
import { usePendingSubscriptionCount } from "../hooks/useSubscriptionApprovals";
import { SubscriptionNotificationBell } from "./SubscriptionNotificationBell";
import { useFormatDate, useI18n, useT, type Lang } from "../i18n";
import { dashboardLangToChatGPTLocale } from "../lib/chatgpt-locale";
import { toast } from "./Toast";
import type { ReactNode } from "react";
import type { PaymentRequestNotice } from "../types";

type NavEntry = {
  to: string;
  labelKey: string;
  perm?: string;
  icon: ReactNode;
  section: "manage" | "org";
};

const ICONS = {
  workspaces: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M3 7h18M3 12h18M3 17h18" />
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
};

const NAV: NavEntry[] = [
  { to: "/workspaces", labelKey: "nav.workspaces", perm: "MEMBER_VIEW", icon: ICONS.workspaces, section: "manage" },
  { to: "/added-emails", labelKey: "nav.addedEmails", perm: "MEMBER_VIEW", icon: ICONS.addedEmails, section: "manage" },
  // Queue toàn cục đã BỎ khỏi sidebar (2026-06-17): dư thừa vì mỗi workspace đã có
  // tab "Hàng đợi" riêng. Route /queue + page Queue.tsx vẫn còn nhưng không còn nav.
  { to: "/audit-logs", labelKey: "nav.auditLog", perm: "AUDIT_LOG_VIEW", icon: ICONS.audit, section: "manage" },
  { to: "/billing", labelKey: "nav.billing", perm: "BILLING_VIEW", icon: ICONS.billing, section: "org" },
  { to: "/users", labelKey: "nav.users", perm: "USER_MANAGE", icon: ICONS.users, section: "org" },
  { to: "/settings", labelKey: "nav.settings", icon: ICONS.settings, section: "org" },
];

export default function Layout() {
  const { user, logout, hasPermission } = useAuth();
  const { lang, setLang, t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  // Số email đang "Chờ xác nhận" → badge thông báo cho super-admin (0 với sub-admin).
  const pendingPayments = usePendingPaymentCount();
  // Số yêu cầu đổi hạn dùng đang chờ duyệt → badge chuông thứ 2 (0 với sub-admin).
  const pendingSubscriptions = usePendingSubscriptionCount();

  // Đóng drawer mỗi khi chuyển trang (mobile).
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  function onDashboardLangChange(next: Lang) {
    if (next === lang) return;
    setLang(next);
    const chatgptLangKey =
      dashboardLangToChatGPTLocale(next) === "zh"
        ? "lang.chatgptLangZh"
        : "lang.chatgptLangVi";
    const dashboardLangKey = next === "zh-CN" ? "lang.zh-CN" : "lang.vi";
    toast.info(
      t("lang.switchNotify", {
        dashboardLang: t(dashboardLangKey),
        chatgptLang: t(chatgptLangKey),
      }),
      { durationMs: 12_000 },
    );
  }

  function onLogout() {
    logout();
    navigate("/login");
  }

  const initial = (user?.username ?? user?.email ?? "?").charAt(0).toUpperCase();
  const sidebarLabel = user?.username ?? user?.email ?? "";
  const manageItems = NAV.filter(
    (n) => n.section === "manage" && (!n.perm || hasPermission(n.perm)),
  );
  const orgItems = NAV.filter(
    (n) => n.section === "org" && (!n.perm || hasPermission(n.perm)),
  );

  return (
    <div className="app-shell min-h-screen">
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
        <Link to="/workspaces" className="app-topbar-title">
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
            to="/workspaces"
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
              <SidebarItem key={n.to} to={n.to} icon={n.icon}>
                {t(n.labelKey)}
              </SidebarItem>
            ))}
          </SidebarSection>
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
          style={{ padding: 16, borderTop: "1px solid var(--border)" }}
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
          <label
            style={{
              display: "block",
              marginTop: 12,
              fontSize: 10.5,
              fontWeight: 500,
              color: "var(--ink-3)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            {t("lang.switch")}
          </label>
          <select
            value={lang}
            onChange={(e) => onDashboardLangChange(e.target.value as Lang)}
            style={{
              marginTop: 6,
              width: "100%",
              padding: "7px 10px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              background: "var(--bg)",
              fontFamily: "inherit",
              fontSize: 12.5,
              color: "var(--ink)",
              cursor: "pointer",
            }}
          >
            <option value="vi">{t("lang.viOption")}</option>
            <option value="zh-CN">{t("lang.zhOption")}</option>
          </select>
          <p
            style={{
              marginTop: 6,
              fontSize: 10.5,
              color: "var(--ink-3)",
              lineHeight: 1.45,
            }}
          >
            {t("lang.dashboardOnlyHint")}
          </p>
          <button
            onClick={onLogout}
            style={{
              marginTop: 10,
              display: "block",
              fontSize: 12,
              color: "var(--ink-3)",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
              fontFamily: "inherit",
              textAlign: "left",
              transition: "color 0.12s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--danger)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ink-3)")}
          >
            {t("auth.logout")} →
          </button>
        </div>
      </aside>

      <main className="app-main">
        <Outlet />
      </main>
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
}: {
  to: string;
  icon: ReactNode;
  children: ReactNode;
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
      {children}
    </NavLink>
  );
}
