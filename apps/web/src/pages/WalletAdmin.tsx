/**
 * Quản trị Ví (feature 003) — super-admin: theo dõi số dư + lịch sử giao dịch,
 * cấu hình phí/ngân hàng SePay, và duyệt yêu cầu rút.
 *
 * Giao diện: import từ Claude Design "Sửa lại giao diện" — biến thể "Soft &
 * friendly" (nền ấm, bo tròn mềm, accent teal, chữ Nunito Sans). Bảng tài khoản
 * gọn theo mockup (Tài khoản · Số dư · Trạng thái · Thao tác). Toggle Ví (beta)
 * và ô sửa nhanh Phí mời được CHUYỂN vào modal chi tiết (không mất chức năng).
 * Bảng màu scope cục bộ qua biến --w-* nên không ảnh hưởng phần còn lại của app.
 */
import { useEffect, useMemo, useState } from "react";
import {
  useAdjustBalance,
  useAdminWithdrawals,
  usePaymentSettings,
  useReviewWithdrawal,
  useSetUserFee,
  useToggleBeta,
  useUpdatePaymentSettings,
  useWalletAdminUsers,
  useWalletAdminUserTransactions,
} from "../hooks/useWallet";
import { formatVnd, TXN_KIND_LABEL, type PaymentSettings, type SepayAuthMethod, type WalletAdminUser, type WalletTxn, type WalletTxnKind, type WithdrawalAdmin } from "../lib/wallet";
import { toast } from "../components/Toast";
import InputModal from "../components/InputModal";
import { ApiError } from "../lib/api";

// Phương thức xác thực webhook SePay (bỏ OAuth 2.0 theo yêu cầu).
const AUTH_METHODS: { value: SepayAuthMethod; label: string; env: string }[] = [
  { value: "none", label: "Không xác thực", env: "" },
  { value: "apikey", label: "API Key (header Apikey)", env: "SEPAY_APIKEY" },
  { value: "hmac", label: "HMAC-SHA256 (X-Sepay-Signature)", env: "SEPAY_WEBHOOK_SECRET" },
];

// Nhãn ngắn cho dòng "Xác thực" trong thẻ tóm tắt SePay.
const AUTH_SHORT: Record<SepayAuthMethod, string> = {
  none: "Không xác thực",
  apikey: "API Key",
  hmac: "HMAC-SHA256",
};

// Bảng màu biến thể "Soft & friendly" — scope cục bộ vào cây trang này.
const softVars = {
  "--w-accent": "#0d9488",
  "--w-accent-soft": "#e3f4f1",
  "--w-accent-ink": "#ffffff",
  "--w-bg": "#f6f2ea",
  "--w-card": "#fffdf9",
  "--w-line": "#ece3d6",
  "--w-ink": "#2c2823",
  "--w-muted": "#847a6d",
  "--w-radius": "20px",
  "--w-radius-sm": "14px",
  "--w-pos": "#2f9e6f",
  "--w-pos-soft": "#e6f4ec",
  "--w-neg": "#cf5b4b",
  "--w-neg-soft": "#fbeae6",
  "--w-shadow": "0 2px 6px rgba(90,70,40,.05), 0 14px 34px rgba(90,70,40,.07)",
  fontFamily: "'Nunito Sans', var(--font-sans)",
  color: "var(--w-ink)",
} as React.CSSProperties;

export default function WalletAdmin() {
  return (
    <div className="page-fade" style={{ ...softVars, padding: "8px 4px 48px" }}>
      <div style={{ fontSize: 13, color: "var(--w-muted)", fontWeight: 500 }}>
        Tổ chức <span style={{ opacity: 0.55, margin: "0 4px" }}>/</span>
        <span style={{ color: "var(--w-ink)", fontWeight: 600 }}>Quản trị Ví</span>
      </div>
      <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.02em", color: "var(--w-ink)", margin: "8px 0 4px" }}>Quản trị Ví</h1>
      <p style={{ margin: "0 0 24px", fontSize: 14, color: "var(--w-muted)", maxWidth: 520 }}>
        Theo dõi số dư và lịch sử giao dịch ví của mọi tài khoản trong tổ chức.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 360px", gap: 22, alignItems: "start" }} className="wallet-admin-grid">
        <UsersCard />
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <SettingsCard />
          <WithdrawalsCard />
        </div>
      </div>
    </div>
  );
}

// ── Bảng: Tài khoản & số dư ───────────────────────────────────────────────────

function UsersCard() {
  const { data } = useWalletAdminUsers();
  const adjust = useAdjustBalance();
  // Popup 'adjust' = nạp tiền (điều chỉnh số dư).
  const [modal, setModal] = useState<{ kind: "adjust"; user: WalletAdminUser } | null>(null);
  // Modal chi tiết: lịch sử giao dịch + điều khiển Ví beta / phí mời của 1 user.
  const [detail, setDetail] = useState<WalletAdminUser | null>(null);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data ?? [];
    return (data ?? []).filter(
      (u) => u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
    );
  }, [data, query]);

  async function submitAdjust(userId: string, raw: string) {
    const amount = Number(raw);
    if (!raw || !Number.isFinite(amount) || amount === 0) {
      throw new Error("Nhập số tiền khác 0 (số âm để trừ).");
    }
    await adjust.mutateAsync({ userId, amount_vnd: amount, reason: "nạp (admin)" });
    toast.success(`Đã điều chỉnh ${formatVnd(amount)}.`);
  }

  return (
    <section style={card}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 14, padding: "20px 22px 16px" }}>
        <div>
          <div style={cardTitle}>Tài khoản &amp; số dư</div>
          <div style={{ fontSize: 13, color: "var(--w-muted)", marginTop: 2 }}>
            {data ? `${data.length} tài khoản` : "Đang tải…"}
          </div>
        </div>
        <label style={searchBox}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tìm tài khoản…"
            style={searchInput}
          />
        </label>
      </div>

      {/* Header cột */}
      <div style={{ ...rowGrid, padding: "10px 22px", background: "var(--w-bg)", borderTop: "1px solid var(--w-line)", borderBottom: "1px solid var(--w-line)" }}>
        <div style={colHead}>TÀI KHOẢN</div>
        <div style={{ ...colHead, textAlign: "right" }}>SỐ DƯ</div>
        <div style={colHead}>TRẠNG THÁI</div>
        <div style={{ ...colHead, textAlign: "right" }}>THAO TÁC</div>
      </div>

      {filtered.map((u, i) => (
        <div
          key={u.user_id}
          className="wallet-admin-row"
          onClick={() => setDetail(u)}
          title="Xem thông tin & lịch sử giao dịch"
          style={{ ...rowGrid, padding: "15px 22px", borderBottom: "1px solid var(--w-line)", cursor: "pointer" }}
        >
          {/* Tài khoản */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            <Avatar name={u.username} tintIndex={i} />
            <div style={{ minWidth: 0, lineHeight: 1.35 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--w-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.username}</div>
              <div style={{ fontSize: 12, color: "var(--w-muted)" }}>{u.is_super_admin ? "super admin" : "thành viên"}</div>
            </div>
          </div>

          {/* Số dư */}
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600, color: u.balance > 0 ? "var(--w-ink)" : "var(--w-muted)", fontVariantNumeric: "tabular-nums" }}>{formatVnd(u.balance)}</div>
            {u.held > 0 && <div style={{ fontSize: 11, color: "var(--w-muted)" }}>giữ {formatVnd(u.held)}</div>}
          </div>

          {/* Trạng thái */}
          <div>
            <span style={statusBadge}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }} />
              Hoạt động
            </span>
          </div>

          {/* Thao tác — chặn nổi bọt để bấm "Nạp" không mở modal chi tiết của dòng */}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }} onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => setModal({ kind: "adjust", user: u })} style={softBtn}>Nạp</button>
          </div>
        </div>
      ))}

      {data && filtered.length === 0 && (
        <div style={{ padding: "22px", fontSize: 13.5, color: "var(--w-muted)", textAlign: "center" }}>Không tìm thấy tài khoản khớp “{query}”.</div>
      )}

      {modal?.kind === "adjust" && (
        <InputModal
          title={`Nạp — ${modal.user.username}`}
          label="Số tiền (VND)"
          type="number"
          placeholder="vd 500000 hoặc -100000"
          submitLabel="Điều chỉnh"
          onSubmit={(v) => submitAdjust(modal.user.user_id, v)}
          onClose={() => setModal(null)}
        />
      )}

      {detail && <DetailModal user={detail} onClose={() => setDetail(null)} />}
    </section>
  );
}

// ── Modal chi tiết: điều khiển + lịch sử giao dịch ví của 1 user ──────────────

// Nguồn phát sinh (giống trang Ví người dùng): phân biệt TỰ ĐỘNG (hệ thống) và
// THỦ CÔNG (quản trị điều chỉnh). topup do chính chủ ví → không ghi nguồn.
const TXN_SOURCE: Partial<Record<WalletTxnKind, string>> = {
  invite_fee: "Tự động · trừ khi mời thành viên",
  renew_fee: "Tự động · trừ khi gia hạn",
  invite_refund: "Tự động · hoàn khi gỡ/huỷ mời",
  order_topup: "Tự động · nạp qua hoá đơn",
  withdraw_hold: "Tự động · giữ khi gửi yêu cầu rút",
  withdraw_settle: "Thủ công · quản trị đã chi rút",
  withdraw_refund: "Tự động · hoàn khi từ chối rút",
  adjust: "Thủ công · quản trị điều chỉnh",
};

// Nhóm giao dịch cho bộ lọc chip: nạp / phí / hoàn / khác.
type TxnCategory = "topup" | "fee" | "refund" | "other";
function txnCategory(kind: WalletTxnKind): TxnCategory {
  if (kind === "topup" || kind === "order_topup") return "topup";
  if (kind === "invite_fee" || kind === "renew_fee" || kind === "withdraw_hold") return "fee";
  if (kind === "invite_refund" || kind === "withdraw_refund") return "refund";
  return "other";
}

// Biểu tượng + màu cho từng dòng giao dịch (khớp mockup: nạp xanh, phí đỏ, hoàn accent).
function txnVisual(t: WalletTxn): { icon: string; bg: string; color: string } {
  switch (txnCategory(t.kind)) {
    case "topup":
      return { icon: "↓", bg: "var(--w-pos-soft)", color: "var(--w-pos)" };
    case "fee":
      return { icon: "↑", bg: "var(--w-neg-soft)", color: "var(--w-neg)" };
    case "refund":
      return { icon: "↩", bg: "var(--w-accent-soft)", color: "var(--w-accent)" };
    default:
      return t.amount >= 0
        ? { icon: "⇄", bg: "var(--w-pos-soft)", color: "var(--w-pos)" }
        : { icon: "⇄", bg: "var(--w-neg-soft)", color: "var(--w-neg)" };
  }
}

const CHIPS: { key: TxnCategory | "all"; label: string }[] = [
  { key: "all", label: "Tất cả" },
  { key: "topup", label: "Nạp" },
  { key: "fee", label: "Phí mời" },
  { key: "refund", label: "Hoàn" },
];

function DetailModal({ user, onClose }: { user: WalletAdminUser; onClose: () => void }) {
  const { data, isLoading } = useWalletAdminUserTransactions(user.user_id);
  const { data: settings } = usePaymentSettings();
  const toggle = useToggleBeta();
  const setFee = useSetUserFee();
  const [filter, setFilter] = useState<TxnCategory | "all">("all");

  const all = data?.items ?? [];
  const shown = filter === "all" ? all : all.filter((t) => txnCategory(t.kind) === filter);
  const totIn = all.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const totOut = all.filter((t) => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);

  async function onToggle(enabled: boolean) {
    try {
      await toggle.mutateAsync({ userId: user.user_id, enabled });
      toast.success(enabled ? "Đã bật Ví." : "Đã tắt Ví.");
    } catch {
      toast.error("Đổi cờ thất bại.");
    }
  }
  async function saveFee(fee: number | null) {
    await setFee.mutateAsync({ userId: user.user_id, invite_fee_vnd: fee });
    toast.success(fee == null ? "Đã về phí mặc định." : `Đã đặt phí ${formatVnd(fee)}.`);
  }

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={{ ...modalPanel, width: 660 }} onClick={(e) => e.stopPropagation()}>
        <div style={modalHeader}>
          <Avatar name={user.username} highlight={user.is_super_admin} size={40} />
          <div style={{ flex: 1, minWidth: 0, lineHeight: 1.35 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--w-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              Lịch sử giao dịch — {user.username}
            </div>
            <div style={{ fontSize: 13, color: "var(--w-muted)" }}>
              Số dư hiện tại <b style={{ color: "var(--w-ink)", fontFamily: "var(--font-mono)" }}>{formatVnd(user.balance)}</b>
              {user.held > 0 ? ` · giữ ${formatVnd(user.held)}` : ""}
            </div>
          </div>
          <button type="button" onClick={onClose} style={closeBtn} aria-label="Đóng">×</button>
        </div>

        {/* Điều khiển quản trị (chuyển từ bảng vào đây) — ẩn với super-admin */}
        {!user.is_super_admin && (
          <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", padding: "14px 24px", borderBottom: "1px solid var(--w-line)", background: "var(--w-bg)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--w-ink)" }}>Ví</span>
              <Toggle on={user.wallet_beta} onChange={onToggle} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--w-ink)" }}>Phí mời</span>
              <FeeCell user={user} defaultFee={settings?.invite_fee_vnd ?? null} onSave={saveFee} />
            </div>
          </div>
        )}

        {/* Tóm tắt */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, padding: "16px 24px" }}>
          <SummaryTile label="TỔNG NẠP" value={`+${formatVnd(totIn)}`} bg="var(--w-pos-soft)" color="var(--w-pos)" />
          <SummaryTile label="TỔNG PHÍ" value={`−${formatVnd(totOut)}`} bg="var(--w-neg-soft)" color="var(--w-neg)" />
          <SummaryTile label="GIAO DỊCH" value={String(all.length)} bg="var(--w-bg)" color="var(--w-ink)" />
        </div>

        {/* Bộ lọc chip */}
        <div style={{ display: "flex", gap: 8, padding: "0 24px 14px", borderBottom: "1px solid var(--w-line)", flexWrap: "wrap" }}>
          {CHIPS.map((c) => {
            const on = filter === c.key;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setFilter(c.key)}
                style={{
                  padding: "7px 14px", borderRadius: 999, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer",
                  border: `1px solid ${on ? "transparent" : "var(--w-line)"}`,
                  background: on ? "var(--w-accent)" : "transparent",
                  color: on ? "var(--w-accent-ink)" : "var(--w-muted)",
                }}
              >
                {c.label}
              </button>
            );
          })}
        </div>

        {/* Danh sách giao dịch */}
        <div style={{ overflowY: "auto", padding: "6px 12px 12px" }}>
          {isLoading ? (
            <p style={{ fontSize: 13, color: "var(--w-muted)", padding: "14px 12px" }}>Đang tải…</p>
          ) : shown.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--w-muted)", padding: "14px 12px" }}>Chưa có giao dịch nào.</p>
          ) : (
            shown.map((t) => <TxnRow key={t.id} t={t} />)
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryTile({ label, value, bg, color }: { label: string; value: string; bg: string; color: string }) {
  return (
    <div style={{ background: bg, borderRadius: "var(--w-radius-sm)", padding: "12px 14px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "var(--font-mono)", color, marginTop: 3 }}>{value}</div>
    </div>
  );
}

/** Một dòng giao dịch: ① loại ② nguồn/thành viên/thời gian ③ số tiền + số dư sau. */
function TxnRow({ t }: { t: WalletTxn }) {
  const kindLabel = TXN_KIND_LABEL[t.kind] ?? t.kind;
  const source = TXN_SOURCE[t.kind];
  const email = t.meta?.email ? String(t.meta.email) : null;
  const v = txnVisual(t);
  const pos = t.amount >= 0;
  return (
    <div className="wallet-admin-row" style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "14px 12px", borderRadius: "var(--w-radius-sm)" }}>
      <div style={{ width: 34, height: 34, flexShrink: 0, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 700, background: v.bg, color: v.color }}>{v.icon}</div>
      <div style={{ flex: 1, minWidth: 0, lineHeight: 1.45 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--w-ink)" }}>{kindLabel}</div>
        {source && <div style={{ fontSize: 12.5, color: "var(--w-muted)" }}>{source}</div>}
        {email && <div style={{ fontSize: 12.5, color: "var(--w-muted)", marginTop: 1 }}>Thành viên: <span style={{ color: "var(--w-ink)", fontWeight: 500 }}>{email}</span></div>}
        <div style={{ fontSize: 11.5, color: "var(--w-muted)", fontFamily: "var(--font-mono)", marginTop: 3, opacity: 0.85 }}>{new Date(t.created_at).toLocaleString("vi-VN")}</div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 800, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", color: pos ? "var(--w-pos)" : "var(--w-neg)" }}>
          {pos ? "+" : "−"}{formatVnd(Math.abs(t.amount)).replace("-", "")}
        </div>
        <div style={{ fontSize: 12, color: "var(--w-muted)", fontFamily: "var(--font-mono)", marginTop: 2 }}>Còn {formatVnd(t.balance_after)}</div>
      </div>
    </div>
  );
}

// Avatar tròn — chữ cái đầu username. Tint theo vị trí (khớp mockup); super-admin nền đậm.
const TINTS: [string, string][] = [
  ["#eef2ff", "#4f46e5"], ["#e8f6ee", "#0f8a4f"], ["#fff3e6", "#c77a1a"], ["#fde8ef", "#c0397a"],
  ["#e7f0ff", "#2563eb"], ["#f2e8ff", "#7c3aed"], ["#e3f4f1", "#0d9488"], ["#fdeee5", "#c0562b"],
];
function Avatar({ name, highlight, size = 36, tintIndex }: { name: string; highlight?: boolean; size?: number; tintIndex?: number }) {
  const [bg, color] = highlight
    ? ["#2c2823", "#fffdf9"]
    : tintIndex != null
      ? TINTS[tintIndex % TINTS.length]
      : ["var(--w-accent-soft)", "var(--w-accent)"];
  return (
    <div style={{ width: size, height: size, flexShrink: 0, borderRadius: "50%", background: bg, color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.4, fontWeight: 700 }}>
      {(name?.[0] ?? "?").toUpperCase()}
    </div>
  );
}

// Toggle switch cho cờ Ví beta.
function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Bật/tắt Ví"
      onClick={() => onChange(!on)}
      style={{ position: "relative", width: 42, height: 24, borderRadius: 20, border: "none", cursor: "pointer", transition: "background .18s", background: on ? "var(--w-accent)" : "var(--w-line)", padding: 0, flexShrink: 0 }}
    >
      <span style={{ position: "absolute", top: 3, left: on ? 21 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left .18s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
    </button>
  );
}

// Ô PHÍ MỜI — sửa nhanh INLINE. Phí MẶC ĐỊNH (hệ thống) hiện MỜ ở placeholder; ô rỗng
// = dùng mặc định. Gõ số KHÁC mặc định → nút "Lưu" hiện; Enter cũng lưu.
function FeeCell({
  user,
  defaultFee,
  onSave,
}: {
  user: WalletAdminUser;
  defaultFee: number | null;
  onSave: (fee: number | null) => Promise<void>;
}) {
  const savedOverride = user.invite_fee_vnd; // null = dùng phí mặc định
  const [val, setVal] = useState(savedOverride == null ? "" : String(savedOverride));
  const [saving, setSaving] = useState(false);

  const trimmed = val.trim();
  const parsed = trimmed === "" ? null : Number(trimmed);
  const valid = parsed == null || (Number.isFinite(parsed) && parsed >= 0);
  const normalized = parsed != null && defaultFee != null && parsed === defaultFee ? null : parsed;
  const dirty = valid && normalized !== savedOverride;

  const doSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await onSave(normalized);
    } catch {
      toast.error("Lưu phí thất bại.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ position: "relative" }}>
        <input
          type="number"
          min={0}
          step={1000}
          inputMode="numeric"
          placeholder={defaultFee != null ? formatVnd(defaultFee).replace(" ₫", "") : "Mặc định"}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void doSave();
            }
          }}
          disabled={saving}
          style={feeInput}
        />
        <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: "var(--w-muted)", pointerEvents: "none" }}>đ</span>
      </span>
      {dirty && (
        <button type="button" onClick={() => void doSave()} disabled={saving} style={{ ...primaryBtn, padding: "6px 11px", fontSize: 12, whiteSpace: "nowrap" }}>
          {saving ? "…" : "Lưu"}
        </button>
      )}
    </span>
  );
}

// ── Cấu hình thanh toán (SePay) ───────────────────────────────────────────────

function SettingsCard() {
  const { data } = usePaymentSettings();
  const update = useUpdatePaymentSettings();
  const [form, setForm] = useState<Partial<PaymentSettings>>({});
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  function openModal() {
    if (data) setForm(data);
    setOpen(true);
  }

  function updateFlow(idx: number, patch: Partial<PaymentSettings["payment_codes"][number]>) {
    const codes = [...(form.payment_codes ?? [])];
    codes[idx] = { ...codes[idx], ...patch };
    setForm({ ...form, payment_codes: codes });
  }

  async function save() {
    const codes = form.payment_codes ?? [];
    const bad = codes.find((c) => !/^[A-Z]{2,6}$/.test(c.prefix));
    if (bad) {
      toast.error(`Tiền tố "${bad.prefix || "(trống)"}" không hợp lệ — cần 2–6 chữ cái.`);
      return;
    }
    if (codes.some((c) => c.suffix_min > c.suffix_max)) {
      toast.error("Hậu tố: 'Từ' phải ≤ 'Đến'.");
      return;
    }
    try {
      await update.mutateAsync({
        invite_fee_vnd: Number(form.invite_fee_vnd) || 0,
        bank_name: form.bank_name ?? null,
        account_number: form.account_number ?? null,
        account_name: form.account_name ?? null,
        payment_codes: codes,
        sepay_auth_method: form.sepay_auth_method ?? "apikey",
      });
      toast.success("Đã lưu cấu hình.");
      setOpen(false);
    } catch {
      toast.error("Lưu cấu hình thất bại.");
    }
  }

  async function copyWebhook() {
    if (!data?.webhook_url) return;
    try {
      await navigator.clipboard.writeText(data.webhook_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Không copy được — hãy chọn và copy thủ công.");
    }
  }

  const authMethod = data?.sepay_auth_method ?? "apikey";
  const activeCodes = (data?.payment_codes ?? []).filter((c) => c.enabled).length;
  const authOk = authMethod === "none" || (authMethod === "apikey" ? data?.sepay_apikey_configured : data?.sepay_hmac_secret_configured);
  const connected = !!data?.account_number && !!authOk;

  return (
    <section style={{ ...card, padding: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "20px 22px 4px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: "var(--w-ink)" }}>Cấu hình thanh toán</span>
          <span style={{ background: "var(--w-accent-soft)", color: "var(--w-accent)", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 6 }}>SePay</span>
        </div>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: connected ? "var(--w-pos)" : "var(--w-muted)" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "currentColor" }} />
          {connected ? "Đã kết nối" : "Chưa cấu hình"}
        </span>
      </div>

      <div style={{ padding: "8px 22px 4px" }}>
        <InfoRow label="Ngân hàng" value={data?.bank_name || "—"} />
        <InfoRow label="Chủ tài khoản" value={data?.account_name || "—"} />
        <InfoRow label="Số tài khoản" value={data?.account_number || "—"} mono />
        <InfoRow label="Xác thực" value={AUTH_SHORT[authMethod]} mono />
        <InfoRow label="Mẫu mã đang bật" value={`${activeCodes} mẫu`} last />
      </div>

      <div style={{ padding: "8px 22px 20px" }}>
        <button type="button" onClick={openModal} style={{ ...darkBtn, width: "100%" }}>Cấu hình thanh toán</button>
      </div>

      {open && (
        <div style={backdrop} onClick={() => setOpen(false)}>
          <div style={modalPanel} onClick={(e) => e.stopPropagation()}>
            <div style={modalHeader}>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--w-ink)", margin: 0 }}>Cấu hình thanh toán (SePay)</h2>
              <button type="button" onClick={() => setOpen(false)} style={closeBtn} aria-label="Đóng">×</button>
            </div>
            <div style={modalBody}>

      {/* Ngân hàng liên kết */}
      <div style={{ ...sectionLabel, marginTop: 0 }}>Tài khoản ngân hàng liên kết</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        <Field label="Tên ngân hàng (vd BIDV, ACB)">
          <input value={form.bank_name ?? ""} onChange={(e) => setForm({ ...form, bank_name: e.target.value })} style={input} />
        </Field>
        <Field label="Tên chủ tài khoản">
          <input value={form.account_name ?? ""} onChange={(e) => setForm({ ...form, account_name: e.target.value })} style={input} />
        </Field>
        <Field label="Số tài khoản nhận">
          <input value={form.account_number ?? ""} onChange={(e) => setForm({ ...form, account_number: e.target.value })} style={input} />
        </Field>
        <Field label="Phí mời mặc định (VND)">
          <input type="number" value={form.invite_fee_vnd ?? ""} onChange={(e) => setForm({ ...form, invite_fee_vnd: Number(e.target.value) })} style={input} />
        </Field>
      </div>

      {/* Phương thức xác thực webhook: Không xác thực / API Key / HMAC-SHA256 */}
      <div style={sectionLabel}>Phương thức xác thực webhook</div>
      <div style={{ display: "grid", gap: 6 }}>
        {AUTH_METHODS.map((m) => {
          const selected = (form.sepay_auth_method ?? "apikey") === m.value;
          return (
            <label key={m.value} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "var(--w-ink)" }}>
              <input
                type="radio"
                name="sepay_auth_method"
                checked={selected}
                onChange={() => setForm({ ...form, sepay_auth_method: m.value })}
              />
              <span style={{ fontWeight: selected ? 600 : 400 }}>{m.label}</span>
            </label>
          );
        })}
      </div>
      {/* Trạng thái secret của method đang chọn */}
      {(() => {
        const method = form.sepay_auth_method ?? "apikey";
        if (method === "none") return <div style={{ fontSize: 12.5, marginTop: 8, color: "var(--w-muted)" }}>Webhook không xác thực — chỉ dùng khi test.</div>;
        const okConfigured = method === "apikey" ? data?.sepay_apikey_configured : data?.sepay_hmac_secret_configured;
        const envName = method === "apikey" ? "SEPAY_APIKEY" : "SEPAY_WEBHOOK_SECRET";
        return (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 500, color: okConfigured ? "var(--w-pos)" : "var(--w-neg)" }}>
              {okConfigured ? `✓ Đã cấu hình ${envName} tại .env` : `✗ Chưa cấu hình ${envName} tại .env`}
            </div>
          </div>
        );
      })()}

      {/* Cấu trúc mã thanh toán đa luồng — thêm/xoá mẫu mã, hậu tố Từ–Đến */}
      <div style={sectionLabel}>Cấu trúc mã thanh toán trên SePay</div>
      <div style={{ display: "grid", gap: 10 }}>
        {(form.payment_codes ?? []).map((flow, idx) => {
          const isTopup = flow.key === "topup";
          return (
            <div key={flow.key} style={flowCard}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={flow.enabled} onChange={(e) => updateFlow(idx, { enabled: e.target.checked })} />
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: flow.enabled ? "var(--w-pos)" : "var(--w-muted)" }}>
                    {flow.enabled ? "Đang hoạt động" : "Tắt"}
                  </span>
                  <span style={{ fontSize: 12.5, color: "var(--w-ink)" }}>
                    · {isTopup ? "Nạp tiền (cộng ví)" : flow.label || flow.key}
                  </span>
                </label>
              </div>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
                <Field label="Tiền tố (2–5 chữ cái)">
                  <input value={flow.prefix} onChange={(e) => updateFlow(idx, { prefix: e.target.value.toUpperCase().replace(/[^A-Z]/g, "") })} style={{ ...input, width: 110, textTransform: "uppercase" }} />
                </Field>
                <Field label="Hậu tố từ (ký tự)">
                  <input type="number" min={1} max={64} value={flow.suffix_min} onChange={(e) => updateFlow(idx, { suffix_min: Math.max(1, Number(e.target.value)) })} style={{ ...input, width: 90 }} />
                </Field>
                <Field label="Đến (ký tự)">
                  <input type="number" min={1} max={64} value={flow.suffix_max} onChange={(e) => updateFlow(idx, { suffix_max: Math.max(flow.suffix_min, Number(e.target.value)) })} style={{ ...input, width: 90 }} />
                </Field>
                <Field label="Là">
                  <select
                    value={flow.suffix_type ?? "alphanumeric"}
                    onChange={(e) => updateFlow(idx, { suffix_type: e.target.value as "numeric" | "alphanumeric" })}
                    style={{ ...input, width: 130, cursor: "pointer" }}
                  >
                    <option value="numeric">Số nguyên</option>
                    <option value="alphanumeric">Số và chữ</option>
                  </select>
                </Field>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--w-muted)", marginTop: 8, fontFamily: "var(--font-mono)", background: "var(--w-bg)", padding: "5px 8px", borderRadius: 6, wordBreak: "break-all" }}>
                Ví dụ: {codeExample(flow.prefix, flow.suffix_max, flow.suffix_type)}
              </div>
            </div>
          );
        })}
      </div>

      {/* Webhook URL + Copy */}
      <div style={sectionLabel}>Đăng ký Webhook trên SePay dashboard</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input readOnly value={data?.webhook_url ?? ""} style={{ ...input, flex: 1, minWidth: 240, fontFamily: "var(--font-mono)", fontSize: 12.5 }} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" onClick={copyWebhook} style={secondaryBtn}>{copied ? "Đã copy ✓" : "Copy"}</button>
      </div>
      <p style={{ fontSize: 11.5, color: "var(--w-muted)", marginTop: 6, lineHeight: 1.5 }}>
        Dán URL nhận webhook này vào SePay dashboard
      </p>

            </div>
            <div style={modalFooter}>
              <button type="button" onClick={() => setOpen(false)} disabled={update.isPending} style={secondaryBtn}>Huỷ</button>
              <button onClick={save} disabled={update.isPending} style={darkBtn}>
                {update.isPending ? "Đang lưu…" : "Lưu cấu hình"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// Dòng key–value trong thẻ tóm tắt SePay.
function InfoRow({ label, value, mono, last }: { label: string; value: string; mono?: boolean; last?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "11px 0", borderBottom: last ? "none" : "1px solid var(--w-line)" }}>
      <span style={{ fontSize: 13, color: "var(--w-muted)" }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--w-ink)", fontFamily: mono ? "var(--font-mono)" : undefined, textAlign: "right", wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}

// ── Yêu cầu rút chờ duyệt ─────────────────────────────────────────────────────

function WithdrawalsCard() {
  const { data } = useAdminWithdrawals("pending");
  const review = useReviewWithdrawal();
  const [reject, setReject] = useState<WithdrawalAdmin | null>(null);

  async function settle(id: string) {
    try {
      await review.mutateAsync({ id, action: "settle" });
      toast.success("Đã đánh dấu đã chi.");
    } catch (e) {
      const detail = e instanceof ApiError ? String(e.detail) : "";
      toast.error(`Xử lý thất bại. ${detail}`);
    }
  }

  async function submitReject(id: string, reason: string) {
    await review.mutateAsync({ id, action: "reject", reason: reason || undefined });
    toast.success("Đã từ chối.");
  }

  const count = data?.length ?? 0;

  return (
    <section style={{ ...card, padding: "20px 22px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: "var(--w-ink)" }}>Yêu cầu rút chờ duyệt</span>
        <span style={{ background: count ? "var(--w-neg-soft)" : "var(--w-bg)", border: count ? "none" : "1px solid var(--w-line)", color: count ? "var(--w-neg)" : "var(--w-muted)", fontSize: 12, fontWeight: 700, minWidth: 24, textAlign: "center", padding: "1px 8px", borderRadius: 999 }}>
          {count}
        </span>
      </div>

      {count === 0 ? (
        <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "flex-start", background: "var(--w-bg)", border: "1px dashed var(--w-line)", borderRadius: "var(--w-radius-sm)", padding: 16 }}>
          <span style={{ width: 32, height: 32, flexShrink: 0, borderRadius: "50%", background: "var(--w-pos-soft)", color: "var(--w-pos)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>✓</span>
          <span style={{ fontSize: 13, color: "var(--w-muted)", lineHeight: 1.5 }}>Không có yêu cầu rút nào đang chờ. Yêu cầu mới sẽ xuất hiện ở đây để bạn duyệt.</span>
        </div>
      ) : (
        <div style={{ marginTop: 4 }}>
          {data?.map((w) => (
            <div key={w.id} style={{ padding: "16px 0", borderBottom: "1px solid var(--w-line)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <Avatar name={w.username || "?"} size={34} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--w-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.username || w.user_email || "—"}</div>
                    <div style={{ fontSize: 11, color: "var(--w-muted)", fontFamily: "var(--font-mono)", marginTop: 1 }}>{formatDate(w.created_at)}</div>
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--w-ink)" }}>{formatVnd(w.amount_vnd)}</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "9px 12px", background: "var(--w-bg)", borderRadius: "var(--w-radius-sm)", marginBottom: 12 }}>
                <span style={{ fontSize: 12, color: "var(--w-muted)" }}>Tài khoản nhận</span>
                <span style={{ fontSize: 12.5, fontWeight: 600, fontFamily: "var(--font-mono)", color: "var(--w-ink)", wordBreak: "break-all", textAlign: "right" }}>{w.bank_account}</span>
              </div>
              {w.note && <div style={{ fontSize: 12, color: "var(--w-muted)", marginBottom: 12, lineHeight: 1.5 }}>Ghi chú: {w.note}</div>}
              <div style={{ display: "flex", gap: 9 }}>
                <button type="button" onClick={() => settle(w.id)} disabled={review.isPending} style={approveBtn}>Duyệt rút</button>
                <button type="button" onClick={() => setReject(w)} disabled={review.isPending} style={rejectBtn}>Từ chối</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {reject && (
        <InputModal
          title={`Từ chối yêu cầu rút — ${reject.username || reject.user_email || ""}`}
          description={`Số tiền ${formatVnd(reject.amount_vnd)}. Nhập lý do từ chối (không bắt buộc).`}
          label="Lý do"
          placeholder="vd: sai số tài khoản"
          submitLabel="Từ chối"
          onSubmit={(v) => submitReject(reject.id, v)}
          onClose={() => setReject(null)}
        />
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ display: "block", fontSize: 12, color: "var(--w-ink)", marginBottom: 5, fontWeight: 500 }}>{label}</span>
      {children}
    </label>
  );
}

/** Định dạng thời gian ngắn (vi-VN) cho dòng yêu cầu rút. */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

// ── Styles (biến thể soft) ─────────────────────────────────────────────────────

// Grid cột bảng tài khoản (khớp header + row): Tài khoản · Số dư · Trạng thái · Thao tác.
const rowGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "minmax(0,1.7fr) 1fr 0.9fr auto", alignItems: "center", gap: 12 };
const colHead: React.CSSProperties = { fontSize: 11, letterSpacing: "0.08em", color: "var(--w-muted)", fontWeight: 700 };

const card: React.CSSProperties = { background: "var(--w-card)", border: "1px solid var(--w-line)", borderRadius: "var(--w-radius)", boxShadow: "var(--w-shadow)", overflow: "hidden" };
const cardTitle: React.CSSProperties = { fontSize: 16, fontWeight: 700, color: "var(--w-ink)" };
const sectionLabel: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--w-muted)", margin: "18px 0 8px" };
const flowCard: React.CSSProperties = { padding: "12px 14px", border: "1px solid var(--w-line)", borderRadius: 10, background: "var(--w-bg)" };

const searchBox: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, background: "var(--w-bg)", border: "1px solid var(--w-line)", borderRadius: "var(--w-radius-sm)", padding: "7px 12px", color: "var(--w-muted)", cursor: "text" };
const searchInput: React.CSSProperties = { border: "none", outline: "none", background: "transparent", fontFamily: "inherit", fontSize: 13, fontWeight: 600, color: "var(--w-ink)", width: 130 };

const statusBadge: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, background: "var(--w-pos-soft)", color: "var(--w-pos)", fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 999 };

const feeInput: React.CSSProperties = { width: 120, padding: "8px 26px 8px 11px", border: "1px solid var(--w-line)", borderRadius: "var(--w-radius-sm)", background: "var(--w-card)", fontSize: 13, fontFamily: "var(--font-mono)", outline: "none", color: "var(--w-ink)", textAlign: "right" };
const input: React.CSSProperties = { width: "100%", padding: "9px 12px", border: "1px solid var(--w-line)", borderRadius: "var(--w-radius-sm)", fontSize: 13.5, background: "var(--w-card)", color: "var(--w-ink)", fontFamily: "inherit" };

const primaryBtn: React.CSSProperties = { padding: "9px 16px", background: "var(--w-accent)", color: "var(--w-accent-ink)", border: "none", borderRadius: "var(--w-radius-sm)", fontSize: 13.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" };
const darkBtn: React.CSSProperties = { padding: "13px 16px", background: "var(--w-ink)", color: "#fff", border: "none", borderRadius: "var(--w-radius-sm)", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" };
const secondaryBtn: React.CSSProperties = { padding: "9px 16px", background: "var(--w-card)", color: "var(--w-ink)", border: "1px solid var(--w-line)", borderRadius: "var(--w-radius-sm)", fontSize: 13.5, fontWeight: 600, cursor: "pointer", flexShrink: 0, fontFamily: "inherit" };
const softBtn: React.CSSProperties = { border: "1px solid transparent", background: "var(--w-accent-soft)", color: "var(--w-accent)", fontFamily: "inherit", fontSize: 13, fontWeight: 600, padding: "8px 12px", borderRadius: "var(--w-radius-sm)", cursor: "pointer" };
const approveBtn: React.CSSProperties = { flex: 1, background: "var(--w-pos)", color: "#fff", border: "none", borderRadius: "var(--w-radius-sm)", padding: 9, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" };
const rejectBtn: React.CSSProperties = { flex: 1, background: "transparent", color: "var(--w-neg)", border: "1px solid var(--w-neg)", borderRadius: "var(--w-radius-sm)", padding: 9, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" };

// Modal — panel cuộn, header/footer cố định.
const backdrop: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(20,22,34,0.34)", backdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120, padding: 24, ...softVars };
const modalPanel: React.CSSProperties = { background: "var(--w-card)", borderRadius: "calc(var(--w-radius) + 4px)", width: 640, maxWidth: "100%", maxHeight: "90vh", boxShadow: "0 24px 60px rgba(16,24,40,0.28)", display: "flex", flexDirection: "column", overflow: "hidden" };
const modalHeader: React.CSSProperties = { display: "flex", alignItems: "center", gap: 14, padding: "20px 24px", borderBottom: "1px solid var(--w-line)", flexShrink: 0 };
const modalBody: React.CSSProperties = { padding: "4px 24px 20px", overflowY: "auto" };
const modalFooter: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, padding: "14px 24px", borderTop: "1px solid var(--w-line)", flexShrink: 0 };
const closeBtn: React.CSSProperties = { width: 34, height: 34, borderRadius: "50%", border: "1px solid var(--w-line)", background: "var(--w-card)", color: "var(--w-muted)", fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 };

/** Ví dụ mã CK động: tiền tố + hậu tố mẫu cắt theo độ dài tối đa. numeric = chỉ số. */
function codeExample(prefix: string, suffixMax: number, suffixType?: "numeric" | "alphanumeric"): string {
  const p = (prefix || "??").toUpperCase();
  const len = Math.min(Math.max(suffixMax || 4, 4), 24);
  const unit = suffixType === "numeric" ? "12" : "A1";
  let suffix = "";
  while (suffix.length < len) suffix += unit;
  return p + suffix.slice(0, len);
}
