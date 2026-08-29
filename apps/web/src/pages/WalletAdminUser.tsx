/**
 * Quản trị Ví — xem ví của MỘT tài khoản (super-admin).
 *
 * Dùng LẠI nguyên giao diện trang Ví (thẻ tổng kết ngày, thanh chọn ngày, lịch sử
 * gom theo ngày) qua `components/WalletHistory`, chỉ đổi phạm vi sang `userId`.
 * Trước đây trang quản trị tự vẽ một danh sách phẳng trong modal — khác hẳn cái chủ
 * ví nhìn thấy, vừa khó đọc vừa dễ lệch số (user 2026-08-29: "cần giao diện trực
 * quan y như ví của người dùng").
 *
 * Cột phải thay chỗ ô nạp/rút của chủ ví bằng ĐIỀU KHIỂN QUẢN TRỊ: cờ Ví, phí mời
 * riêng, và nạp/điều chỉnh số dư.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  useAdjustBalance,
  usePaymentSettings,
  useSetUserFee,
  useToggleBeta,
  useWalletAdminUsers,
} from "../hooks/useWallet";
import { formatVnd, type WalletAdminUser } from "../lib/wallet";
import { buildTxnCsv } from "../lib/wallet-history";
import { toast } from "../components/Toast";
import InputModal from "../components/InputModal";
import SepayReconcileModal from "../components/SepayReconcileModal";
import {
  useWalletHistoryState,
  WalletDaySummary,
  WalletHistoryCard,
  WalletScopeCtx,
} from "../components/WalletHistory";
import {
  bigVnd,
  card,
  cardKicker,
  cardTitle,
  input,
  primaryBtn,
  secondaryBtn,
  vnToday,
} from "../components/walletUi";

export default function WalletAdminUser() {
  const { userId = "" } = useParams();
  const { data: users } = useWalletAdminUsers();
  const { data: settings } = usePaymentSettings();
  const user = useMemo(
    () => (users ?? []).find((u) => u.user_id === userId) ?? null,
    [users, userId],
  );

  const today = vnToday();
  const [day, setDay] = useState<string | null>(today);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const hist = useWalletHistoryState(day, userId);

  function exportCsv() {
    const csv = buildTxnCsv(hist.groups);
    const stamp = day ?? `den-${today}`;
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `vi-${user?.username ?? "tai-khoan"}-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <WalletScopeCtx.Provider value={userId}>
      <div className="page-fade" style={{ padding: "8px 4px 40px" }}>
        <header style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, flexWrap: "wrap", marginBottom: 18 }}>
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            <div style={{ fontSize: 13, color: "var(--ink-3)", fontWeight: 500, marginBottom: 6 }}>
              <Link to="/admin/wallet" style={{ color: "var(--ink-3)", textDecoration: "none" }}>
                Quản trị Ví
              </Link>
              <span style={{ opacity: 0.55, margin: "0 6px" }}>/</span>
              <span style={{ color: "var(--ink)", fontWeight: 600 }}>{user?.username ?? "…"}</span>
            </div>
            <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-.025em", color: "var(--ink)", marginBottom: 6 }}>
              Ví của {user?.username ?? "…"}
            </h1>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: "var(--ink-2)", maxWidth: 560 }}>
              {user?.email ?? ""}
              {user ? " · đúng những gì chủ ví nhìn thấy ở trang Ví của họ." : ""}
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button onClick={() => setReconcileOpen(true)} style={secondaryBtn}>
              Đối soát ngân hàng
            </button>
            <button
              onClick={exportCsv}
              disabled={hist.groups.length === 0}
              style={{ ...secondaryBtn, opacity: hist.groups.length === 0 ? 0.5 : 1 }}
            >
              Xuất báo cáo
            </button>
          </div>
        </header>

        <WalletDaySummary date={day ?? today} isToday={(day ?? today) === today} />

        <section style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start", marginTop: 14 }}>
          <WalletHistoryCard s={hist} day={day} setDay={setDay} />

          <div style={{ flex: "1 1 318px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
            {user && <AdminBalancePanel user={user} defaultFee={settings?.invite_fee_vnd ?? null} />}
          </div>
        </section>

        {reconcileOpen && (
          <SepayReconcileModal
            initialDate={day ?? today}
            userId={userId}
            scopeName={user?.username ?? null}
            onClose={() => setReconcileOpen(false)}
          />
        )}
      </div>
    </WalletScopeCtx.Provider>
  );
}

/**
 * Cột phải của trang quản trị: số dư + ba việc chỉ super-admin làm được (bật/tắt Ví,
 * đặt phí mời riêng, nạp/điều chỉnh số dư). Chủ ví thấy ô nạp/rút ở đúng chỗ này.
 */
function AdminBalancePanel({ user, defaultFee }: { user: WalletAdminUser; defaultFee: number | null }) {
  const toggle = useToggleBeta();
  const setFee = useSetUserFee();
  const adjust = useAdjustBalance();
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [feeText, setFeeText] = useState(user.invite_fee_vnd == null ? "" : String(user.invite_fee_vnd));
  const [savingFee, setSavingFee] = useState(false);

  const trimmed = feeText.trim();
  const parsed = trimmed === "" ? null : Number(trimmed);
  const validFee = parsed == null || (Number.isFinite(parsed) && parsed >= 0);
  // Gõ đúng bằng phí mặc định = về dùng mặc định, đừng lưu một bản sao cứng sẽ không
  // đổi theo khi hệ thống chỉnh phí.
  const normalized = parsed != null && defaultFee != null && parsed === defaultFee ? null : parsed;
  const feeDirty = validFee && normalized !== user.invite_fee_vnd;

  async function onToggle() {
    try {
      await toggle.mutateAsync({ userId: user.user_id, enabled: !user.wallet_beta });
      toast.success(user.wallet_beta ? "Đã tắt Ví." : "Đã bật Ví.");
    } catch {
      toast.error("Đổi cờ thất bại.");
    }
  }

  async function saveFee() {
    if (!feeDirty || savingFee) return;
    setSavingFee(true);
    try {
      await setFee.mutateAsync({ userId: user.user_id, invite_fee_vnd: normalized });
      toast.success(normalized == null ? "Đã về phí mặc định." : `Đã đặt phí ${formatVnd(normalized)}.`);
    } catch {
      toast.error("Lưu phí thất bại.");
    } finally {
      setSavingFee(false);
    }
  }

  // Lý do BẮT BUỘC (user 2026-08-14): mọi lần nạp/điều chỉnh phải ghi vì sao, để dòng
  // giao dịch tự giải thích khi đối soát về sau.
  async function submitAdjust(raw: string, reason: string) {
    const amount = Number(raw);
    if (!raw || !Number.isFinite(amount) || amount === 0) {
      throw new Error("Nhập số tiền khác 0 (số âm để trừ).");
    }
    if (!reason.trim()) throw new Error("Nhập lý do nạp/điều chỉnh.");
    await adjust.mutateAsync({ userId: user.user_id, amount_vnd: amount, reason: reason.trim() });
    toast.success(`Đã điều chỉnh ${formatVnd(amount)}.`);
  }

  return (
    <>
      <div style={card}>
        <div style={cardKicker}>SỐ DƯ HIỆN TẠI</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 2 }}>
          <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-.03em", lineHeight: 1, color: "var(--ink)" }}>
            {bigVnd(user.balance)}
          </div>
          <div style={{ fontSize: 18, color: "var(--ink-4)" }}>đ</div>
        </div>
        {user.held > 0 && (
          <div style={{ marginTop: 8, fontSize: 12.5, color: "var(--ink-2)" }}>
            Đang giữ chờ duyệt rút: <strong style={{ color: "var(--ink)" }}>{formatVnd(user.held)}</strong>
          </div>
        )}
        <button onClick={() => setAdjustOpen(true)} style={{ ...primaryBtn, width: "100%", marginTop: 16 }}>
          Nạp / điều chỉnh số dư
        </button>
      </div>

      <div style={card}>
        <h2 style={cardTitle}>Điều khiển quản trị</h2>
        {user.is_super_admin ? (
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55 }}>
            Đây là tài khoản super-admin — không áp cờ Ví hay phí mời riêng.
          </p>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, paddingBottom: 14, borderBottom: "1px solid var(--border)" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>Ví</div>
                <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>
                  {user.wallet_beta ? "Đang bật · mời sẽ trừ phí" : "Đang tắt · mời không trừ phí"}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={user.wallet_beta}
                aria-label="Bật/tắt Ví"
                onClick={onToggle}
                style={{ position: "relative", width: 42, height: 24, borderRadius: 20, border: "none", cursor: "pointer", flexShrink: 0, background: user.wallet_beta ? "var(--ink)" : "var(--border-strong)", padding: 0 }}
              >
                <span style={{ position: "absolute", top: 3, left: user.wallet_beta ? 21 : 3, width: 18, height: 18, borderRadius: "50%", background: "var(--surface)", transition: "left .18s", boxShadow: "var(--shadow-sm)" }} />
              </button>
            </div>

            <div style={{ paddingTop: 14 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>Phí mời riêng</div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", margin: "2px 0 8px" }}>
                Bỏ trống = dùng phí mặc định{defaultFee != null ? ` (${formatVnd(defaultFee)})` : ""}.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={feeText}
                  onChange={(e) => setFeeText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void saveFee()}
                  inputMode="numeric"
                  placeholder={defaultFee != null ? String(defaultFee) : "mặc định"}
                  style={{ ...input, padding: "9px 12px", fontSize: 13 }}
                />
                {feeDirty && (
                  <button onClick={saveFee} disabled={savingFee} style={{ ...primaryBtn, padding: "9px 14px" }}>
                    {savingFee ? "…" : "Lưu"}
                  </button>
                )}
              </div>
              {!validFee && (
                <div style={{ marginTop: 6, fontSize: 12, color: "var(--danger)" }}>Phí phải là số không âm.</div>
              )}
            </div>
          </>
        )}
      </div>

      {adjustOpen && (
        <InputModal
          title={`Nạp / điều chỉnh — ${user.username}`}
          description="Số dương là nạp thêm, số âm là trừ bớt."
          label="Số tiền (đ)"
          type="number"
          submitLabel="Xác nhận"
          extra={{ label: "Lý do", placeholder: "vd: bù khoản chuyển thiếu 29/8", required: true }}
          onSubmit={submitAdjust}
          onClose={() => setAdjustOpen(false)}
        />
      )}
    </>
  );
}
