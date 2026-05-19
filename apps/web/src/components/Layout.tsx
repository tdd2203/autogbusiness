import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useI18n, type Lang } from "../i18n";
import { dashboardLangToChatGPTLocale } from "../lib/chatgpt-locale";
import { toast } from "./Toast";
import type { ReactNode } from "react";

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
  { to: "/queue", labelKey: "nav.queue", perm: "QUEUE_VIEW", icon: ICONS.queue, section: "manage" },
  { to: "/audit-logs", labelKey: "nav.auditLog", perm: "AUDIT_LOG_VIEW", icon: ICONS.audit, section: "manage" },
  { to: "/billing", labelKey: "nav.billing", perm: "BILLING_VIEW", icon: ICONS.billing, section: "org" },
  { to: "/users", labelKey: "nav.users", perm: "USER_MANAGE", icon: ICONS.users, section: "org" },
  { to: "/settings", labelKey: "nav.settings", icon: ICONS.settings, section: "org" },
];

export default function Layout() {
  const { user, logout, hasPermission } = useAuth();
  const { lang, setLang, t } = useI18n();
  const navigate = useNavigate();

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
    <div
      className="min-h-screen"
      style={{ display: "grid", gridTemplateColumns: "240px 1fr" }}
    >
      <aside
        className="flex flex-col sticky top-0 h-screen"
        style={{
          background: "var(--surface)",
          borderRight: "1px solid var(--border)",
        }}
      >
        <div style={{ padding: "24px 24px 32px" }}>
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
              AutoGPT
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
              Admin
            </div>
          </Link>
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
          <select
            value={lang}
            onChange={(e) => onDashboardLangChange(e.target.value as Lang)}
            style={{
              marginTop: 12,
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
            <option value="vi">{t("lang.vi")}</option>
            <option value="zh-CN">{t("lang.zh-CN")}</option>
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

      <main
        style={{
          padding: "32px 48px 64px",
          maxWidth: 1440,
          width: "100%",
          overflow: "auto",
        }}
      >
        <Outlet />
      </main>
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
        gap: 10,
        padding: "8px 12px",
        borderRadius: "var(--radius)",
        color: isActive ? "var(--ink)" : "var(--ink-2)",
        background: isActive ? "var(--surface-2)" : "transparent",
        textDecoration: "none",
        fontSize: 13.5,
        marginBottom: 1,
        fontWeight: isActive ? 500 : 400,
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
