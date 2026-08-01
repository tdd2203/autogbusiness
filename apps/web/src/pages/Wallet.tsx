/**
 * Trang Ví (feature 003-wallet-invite-payment) — số dư, nạp tiền (QR), lịch sử
 * giao dịch, gửi & theo dõi yêu cầu rút. Chỉ user có cờ wallet_beta (hoặc
 * super-admin) mới vào được (route bảo vệ + sidebar ẩn với người khác).
 */
import { useState } from "react";
import {
  useCreateWithdrawal,
  useWallet,
  useWalletTransactions,
} from "../hooks/useWallet";
import { formatVnd, TXN_KIND_LABEL } from "../lib/wallet";
import type { WalletTxn, WalletTxnKind } from "../lib/wallet";
import { ApiError } from "../lib/api";
import { toast } from "../components/Toast";
import TopupModal from "../components/TopupModal";
import { useAuth } from "../hooks/useAuth";

/** Cấu hình rút tiền lưu cục bộ theo từng user (STK mặc định + số tiền gợi ý). */
type WithdrawConfig = { bank_account: string; default_amount: number };

function withdrawConfigKey(userId: string): string {
  return `wallet.withdrawConfig.${userId}`;
}

function loadWithdrawConfig(userId: string | undefined): WithdrawConfig | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(withdrawConfigKey(userId));
    return raw ? (JSON.parse(raw) as WithdrawConfig) : null;
  } catch {
    return null;
  }
}

function saveWithdrawConfig(userId: string, cfg: WithdrawConfig): void {
  localStorage.setItem(withdrawConfigKey(userId), JSON.stringify(cfg));
}

export default function Wallet() {
  const { data: wallet, isLoading } = useWallet();
  const { data: txns } = useWalletTransactions();
  const [showTopup, setShowTopup] = useState(false);

  // Số dư tách phần số (bỏ ký hiệu tiền ₫ mà formatVnd thêm) để hiện cỡ lớn kèm
  // hậu tố "đ" gạch chân riêng (mockup). Giữ chữ số + dấu phân cách + dấu âm.
  const balanceNumber = isLoading
    ? "…"
    : formatVnd(wallet?.balance ?? 0).replace(/[^\d.,-]/g, "").trim();

  return (
    <div className="page-fade" style={{ maxWidth: 1040, padding: "8px 4px 40px" }}>
      <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-.02em", color: "var(--ink)", marginBottom: 6 }}>Ví</h1>
      <p style={{ fontSize: 14, lineHeight: 1.5, color: "var(--ink-3)", marginBottom: 22 }}>
        Nạp tiền để mời thành viên. Mỗi lời mời trừ phí cố định từ số dư.
      </p>

      {/* Desktop: 2 cột — trái (số dư + rút tiền) rộng cố định, phải (lịch sử) co
          giãn. Dưới 860px (tablet/mobile) .wallet-grid xếp dọc 1 cột (index.css)
          nên vẫn đẹp trên điện thoại; trước đây cả trang bị kẹp maxWidth 560 →
          desktop trông như giao diện mobile. */}
      <div
        className="wallet-grid"
        style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(0,380px) minmax(0,1fr)", alignItems: "start" }}
      >
        <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
          {/* Thẻ số dư */}
          <div style={balanceCard}>
            <div style={cardKicker}>Số dư khả dụng</div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 6, margin: "8px 0 4px" }}>
              <span style={{ fontSize: 44, fontWeight: 800, lineHeight: 1, letterSpacing: "-.03em", color: "var(--ink)" }}>
                {balanceNumber}
              </span>
              <span style={{ fontSize: 22, fontWeight: 700, textDecoration: "underline", textUnderlineOffset: 4, paddingBottom: 4, color: "var(--ink)" }}>
                đ
              </span>
            </div>
            {!!wallet?.invite_fee_vnd && (
              <div style={{ fontSize: 13, color: "var(--ink-3)" }}>
                Phí mỗi lời mời: {formatVnd(wallet.invite_fee_vnd)}
              </div>
            )}
            {!!wallet?.held && (
              <div style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 2 }}>
                Đang giữ (chờ rút): {formatVnd(wallet.held)}
              </div>
            )}
            <button onClick={() => setShowTopup(true)} style={{ ...primaryBtn, width: "100%", marginTop: 18, padding: "15px" }}>
              + Nạp tiền
            </button>
          </div>

          <WithdrawSection available={wallet?.balance ?? 0} />
        </div>

        <TxnHistory txns={txns?.items ?? []} />
      </div>

      {showTopup && <TopupModal onClose={() => setShowTopup(false)} />}
    </div>
  );
}

function WithdrawSection({ available }: { available: number }) {
  const { user } = useAuth();
  const savedCfg = loadWithdrawConfig(user?.id);
  const [amount, setAmount] = useState<number>(savedCfg?.default_amount ?? 0);
  const [bank, setBank] = useState(savedCfg?.bank_account ?? "");
  const createWithdrawal = useCreateWithdrawal();

  const [showSettings, setShowSettings] = useState(false);
  const [cfgBank, setCfgBank] = useState(savedCfg?.bank_account ?? "");
  const [cfgAmount, setCfgAmount] = useState<number>(savedCfg?.default_amount ?? 0);

  function saveSettings() {
    if (!user?.id) return;
    const cfg: WithdrawConfig = { bank_account: cfgBank.trim(), default_amount: cfgAmount > 0 ? cfgAmount : 0 };
    saveWithdrawConfig(user.id, cfg);
    // Áp cấu hình vào form ngay để dùng lần rút này luôn.
    setBank(cfg.bank_account);
    setAmount(cfg.default_amount);
    setShowSettings(false);
    toast.success("Đã lưu cấu hình rút tiền.");
  }

  async function submit() {
    if (amount <= 0 || bank.trim().length < 3) {
      toast.error("Nhập số tiền và số tài khoản ngân hàng nhận.");
      return;
    }
    try {
      await createWithdrawal.mutateAsync({ amount_vnd: amount, bank_account: bank.trim() });
      toast.success("Đã gửi yêu cầu rút. Chờ super-admin duyệt.");
      setAmount(0);
      setBank("");
    } catch (e) {
      const detail = e instanceof ApiError ? (e.detail as { message?: string; shortfall?: number }) : null;
      toast.error(detail?.message ?? "Không gửi được yêu cầu rút");
    }
  }

  return (
    <section style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 12 }}>
        <h2 style={{ ...cardTitle, marginBottom: 0 }}>Rút tiền</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setShowSettings((s) => !s)}
            style={{ ...secondaryBtn, ...(showSettings ? activeBtn : null) }}
          >
            Cài đặt
          </button>
        </div>
      </div>

      {showSettings && (
        <div style={settingsPanel}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>Cấu hình rút tiền</div>
          <p style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--ink-3)", margin: "5px 0 14px" }}>
            Lưu STK và số tiền mặc định để tự điền sẵn cho những lần rút sau.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input
              placeholder="Ngân hàng · STK · Chủ TK"
              value={cfgBank}
              onChange={(e) => setCfgBank(e.target.value)}
              style={input}
            />
            <input
              type="number"
              placeholder="Số tiền mặc định (tuỳ chọn)"
              value={cfgAmount || ""}
              onChange={(e) => setCfgAmount(Number(e.target.value))}
              style={input}
            />
            <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
              <button onClick={() => setShowSettings(false)} style={{ ...secondaryBtn, flex: 1 }}>Huỷ</button>
              <button onClick={saveSettings} style={{ ...primaryBtn, flex: 1 }}>Lưu cấu hình</button>
            </div>
          </div>
        </div>
      )}
      <p style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--ink-3)", margin: "4px 0 14px" }}>
        Khả dụng: {formatVnd(available)}. Yêu cầu rút sẽ giữ số dư tới khi super-admin duyệt.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <input
          type="number"
          placeholder="Số tiền"
          value={amount || ""}
          onChange={(e) => setAmount(Number(e.target.value))}
          style={input}
        />
        <input
          placeholder="Ngân hàng · STK · Chủ TK"
          value={bank}
          onChange={(e) => setBank(e.target.value)}
          style={input}
        />
        <button onClick={submit} disabled={createWithdrawal.isPending} style={{ ...secondaryBtn, width: "100%", padding: "14px", fontWeight: 700 }}>
          {createWithdrawal.isPending ? "Đang gửi…" : "Gửi yêu cầu"}
        </button>
      </div>
    </section>
  );
}

function TxnHistory({ txns }: { txns: WalletTxn[] }) {
  const rows = buildTxnRows(txns);
  return (
    <section id="txn-history" style={card}>
      <h2 style={cardTitle}>Lịch sử giao dịch</h2>
      {rows.length === 0 && <p style={{ fontSize: 13, color: "var(--ink-3)" }}>Chưa có giao dịch nào.</p>}
      <div style={{ overflowX: "auto" }}>
        {rows.map((r) => {
          if (r.type === "withdraw") return <WithdrawTxnRow key={r.id} txns={r.txns} />;
          // Nhóm cùng thời điểm: 1 bút toán → dòng thường; nhiều bút toán có phí
          // mời/gia hạn → gộp 1 dòng (giống admin); nhiều bút toán khác (hiếm) →
          // tách từng dòng.
          if (r.txns.length === 1) return <PlainTxnRow key={r.txns[0].id} t={r.txns[0]} />;
          const hasFee = r.txns.some((t) => t.kind === "invite_fee" || t.kind === "renew_fee");
          if (hasFee) return <GroupTxnRow key={r.key} txns={r.txns} />;
          return r.txns.map((t) => <PlainTxnRow key={t.id} t={t} />);
        })}
      </div>
    </section>
  );
}

/* (③) Nguồn phát sinh khoản tiền — phân biệt TỰ ĐỘNG (hệ thống trừ/hoàn theo lượt
   mời·gia hạn, nạp qua hoá đơn) với THỦ CÔNG (quản trị điều chỉnh). Nạp chuyển
   khoản (topup) do chính chủ ví thực hiện → không ghi nguồn (ngầm hiểu). */
const TXN_SOURCE: Partial<Record<WalletTxnKind, string>> = {
  invite_fee: "Tự động · trừ khi mời thành viên",
  renew_fee: "Tự động · trừ khi gia hạn",
  invite_refund: "Tự động · hoàn khi mời thất bại",
  order_topup: "Tự động · nạp qua hoá đơn",
  adjust: "Thủ công · quản trị điều chỉnh",
};

/** Một dòng giao dịch thường (nạp/phí mời/điều chỉnh…) — trả lời: ① cái gì (loại
 *  giao dịch) ② thành-bại (✓ đã ghi nhận) ③ phạm vi (nguồn tự động/thủ công +
 *  thành viên liên quan + số tiền tác động). */
function PlainTxnRow({ t }: { t: WalletTxn }) {
  // Thanh toán TRÙNG hoá đơn: khoản này ghi là `topup` (cộng vào số dư khả dụng) kèm
  // cờ meta.duplicate_invoice. Hiện nhãn + giải thích RIÊNG để user biết tiền đã vào
  // ví (không phải nạp thường, không bị mất) — xem sepay_integration.handle_order.
  const isDupInvoice =
    t.kind === "topup" && Boolean(t.meta?.duplicate_invoice);
  const dupRef =
    isDupInvoice && t.meta?.order_ref ? String(t.meta.order_ref) : null;
  const kindLabel = isDupInvoice
    ? "Hoàn trả tiền thanh toán trùng hoá đơn"
    : (TXN_KIND_LABEL[t.kind as keyof typeof TXN_KIND_LABEL] ?? t.kind);
  const source = isDupInvoice
    ? `${dupRef ? `Hoá đơn ${dupRef}. ` : ""}Số tiền đã được cộng vào ví.`
    : TXN_SOURCE[t.kind];
  const email = t.meta?.email ? String(t.meta.email) : null;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "9px 0", borderTop: "1px solid var(--border)" }}>
      <div style={{ minWidth: 0 }}>
        {/* ① cái gì + ② kết quả */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 15.5, color: "var(--ink)", fontWeight: 700 }}>{kindLabel}</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "var(--success)", background: "var(--success-bg)", padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap" }}>
            ✓ Thành công
          </span>
        </div>
        {/* ③ phạm vi: nguồn (tự động/thủ công) + thành viên liên quan + thời gian */}
        {source && <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 3 }}>{source}</div>}
        {email && <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 2 }}>Thành viên: {email}</div>}
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 3, fontFamily: "var(--font-mono)" }}>{new Date(t.created_at).toLocaleString("vi-VN")}</div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: t.amount >= 0 ? "var(--success)" : "var(--danger)", whiteSpace: "nowrap" }}>
          {t.amount >= 0 ? "+" : ""}{formatVnd(t.amount)}
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Còn {formatVnd(t.balance_after)}</div>
      </div>
    </div>
  );
}

/**
 * Một THAO TÁC mời/gia hạn hàng loạt (nhiều bút toán cùng created_at: 1 order_topup
 * "nạp qua hoá đơn" + N phí, hoặc N phí trừ thẳng số dư) gộp thành 1 DÒNG — thay vì
 * hiện "Nạp qua hoá đơn +X" rồi "Phí mời −X" rối mắt như trước. Bấm để bung chi tiết
 * từng email. Logic giống modal chi tiết phía admin (WalletAdmin › TxnGroupRow).
 */
function GroupTxnRow({ txns }: { txns: WalletTxn[] }) {
  const [open, setOpen] = useState(false);
  const fees = txns.filter((t) => t.kind === "invite_fee" || t.kind === "renew_fee");
  const paidViaOrder = txns.some((t) => t.kind === "order_topup");
  const isRenew = fees.every((t) => t.kind === "renew_fee");
  const spend = fees.reduce((s, t) => s + t.amount, 0); // âm
  const finalBalance = Math.min(...txns.map((t) => t.balance_after));
  const title = isRenew ? "Gia hạn thành viên" : "Mời thành viên";
  return (
    <div style={{ borderTop: "1px solid var(--border)" }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "9px 0", cursor: "pointer" }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15.5, color: "var(--ink)", fontWeight: 700 }}>
              {title} · {fees.length} email
              <span style={{ color: "var(--ink-3)", fontSize: 11, marginLeft: 6, display: "inline-block", transform: open ? "rotate(180deg)" : "none" }}>▾</span>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "var(--success)", background: "var(--success-bg)", padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap" }}>
              ✓ Thành công
            </span>
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 3 }}>
            {paidViaOrder ? "Thanh toán qua hoá đơn" : "Trừ từ số dư ví"}
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 3, fontFamily: "var(--font-mono)" }}>{new Date(txns[0].created_at).toLocaleString("vi-VN")}</div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--danger)", whiteSpace: "nowrap" }}>
            {formatVnd(spend)}
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Còn {formatVnd(finalBalance)}</div>
        </div>
      </div>
      {open && (
        <div style={{ margin: "0 0 8px 4px", borderLeft: "2px solid var(--border)", paddingLeft: 14, display: "grid", gap: 6 }}>
          {fees.map((t) => (
            <div key={t.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5 }}>
              <span style={{ color: "var(--ink-2)", minWidth: 0, overflowWrap: "anywhere" }}>
                {t.meta?.email ? String(t.meta.email) : t.kind}
              </span>
              <span style={{ color: "var(--danger)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
                {formatVnd(t.amount)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Một yêu cầu rút gộp thành 1 DÒNG duy nhất (dù sinh nhiều bút toán
 * withdraw_hold/settle/refund) — thay vì hiện "Giữ rút tiền" + "Rút tiền (đã chi)"
 * tách rời. Kèm thanh tiến trình 3 bước giống nhật ký kiểm tra.
 */
function WithdrawTxnRow({ txns }: { txns: WalletTxn[] }) {
  const hold = txns.find((t) => t.kind === "withdraw_hold");
  const settled = txns.some((t) => t.kind === "withdraw_settle");
  const rejected = txns.some((t) => t.kind === "withdraw_refund") && !settled;
  const latest = txns[0]; // API trả mới→cũ, txns[0] là bút toán gần nhất
  const amountVnd = Math.abs(hold?.amount ?? latest.amount);
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "9px 0", borderTop: "1px solid var(--border)" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 15.5, color: "var(--ink)", fontWeight: 700 }}>Rút tiền</div>
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 3, fontFamily: "var(--font-mono)" }}>
          {new Date((hold ?? latest).created_at).toLocaleString("vi-VN")}
        </div>
        <WithdrawSteps settled={settled} rejected={rejected} />
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: "var(--danger)", whiteSpace: "nowrap" }}>
          -{formatVnd(amountVnd)}
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Còn {formatVnd(latest.balance_after)}</div>
      </div>
    </div>
  );
}

/** Thanh tiến trình rút tiền: Đã gửi yêu cầu → Chờ admin thanh toán → Thành công. */
function WithdrawSteps({ settled, rejected }: { settled: boolean; rejected: boolean }) {
  const steps = [
    { label: "Đã gửi yêu cầu", reached: true, kind: "n" as const },
    { label: "Chờ admin thanh toán", reached: true, kind: settled || rejected ? ("n" as const) : ("cur" as const) },
    rejected
      ? { label: "Bị từ chối", reached: true, kind: "fail" as const }
      : { label: "Thành công", reached: settled, kind: "done" as const },
  ];
  const color = (s: (typeof steps)[number]) => {
    if (!s.reached) return "var(--ink-4)";
    if (s.kind === "fail") return "var(--danger)";
    if (s.kind === "done") return "var(--success)";
    if (s.kind === "cur") return "var(--warning)";
    return "var(--ink-2)";
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
      {steps.map((s, i) => (
        <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, opacity: s.reached ? 1 : 0.65 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: s.reached ? color(s) : "transparent",
                border: s.reached ? "none" : "1.5px solid var(--ink-4)",
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 11, fontWeight: s.reached ? 600 : 500, color: s.reached ? color(s) : "var(--ink-3)", whiteSpace: "nowrap" }}>
              {s.label}
            </span>
          </span>
          {i < steps.length - 1 && (
            <span style={{ width: 18, height: 2, borderRadius: 2, background: steps[i + 1].reached ? "var(--border-strong)" : "var(--border)" }} />
          )}
        </div>
      ))}
    </div>
  );
}

type TxnRow =
  | { type: "group"; key: string; txns: WalletTxn[] }
  | { type: "withdraw"; id: string; txns: WalletTxn[] };

/** Gộp bút toán để bớt rối (giống logic phía admin):
 *   • Rút tiền (ref_type=withdrawal): gộp theo ref_id → 1 dòng + thanh tiến trình.
 *   • Còn lại: gộp theo created_at — mỗi thao tác ví (mời/gia hạn hàng loạt, kèm
 *     order_topup hay trừ thẳng số dư) dùng chung 1 timestamp (now() là hằng trong
 *     1 transaction) → 1 dòng theo action thay vì "nạp qua hoá đơn" rồi trừ N phí.
 *  Giữ nguyên thứ tự mới→cũ. */
function buildTxnRows(txns: WalletTxn[]): TxnRow[] {
  const rows: TxnRow[] = [];
  const wIndex = new Map<string, number>();
  const tIndex = new Map<string, number>();
  for (const t of txns) {
    if (t.ref_type === "withdrawal" && t.ref_id) {
      const at = wIndex.get(t.ref_id);
      if (at != null) {
        (rows[at] as { txns: WalletTxn[] }).txns.push(t);
      } else {
        wIndex.set(t.ref_id, rows.length);
        rows.push({ type: "withdraw", id: t.ref_id, txns: [t] });
      }
    } else {
      const at = tIndex.get(t.created_at);
      if (at != null) {
        (rows[at] as { txns: WalletTxn[] }).txns.push(t);
      } else {
        tIndex.set(t.created_at, rows.length);
        rows.push({ type: "group", key: t.created_at, txns: [t] });
      }
    }
  }
  return rows;
}

const balanceCard: React.CSSProperties = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 20, padding: 20, boxShadow: "var(--shadow-card)" };
const cardKicker: React.CSSProperties = { fontSize: 12, letterSpacing: ".04em", color: "var(--ink-3)", fontFamily: "var(--font-mono)", textTransform: "uppercase" };
const card: React.CSSProperties = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 20, padding: 20, boxShadow: "var(--shadow-card)" };
const cardTitle: React.CSSProperties = { fontSize: 19, fontWeight: 700, letterSpacing: "-.01em", color: "var(--ink)", marginBottom: 10 };
const input: React.CSSProperties = { width: "100%", padding: "14px", border: "1px solid var(--border-strong)", borderRadius: 12, fontSize: 15, background: "var(--surface)", color: "var(--ink)" };
const primaryBtn: React.CSSProperties = { padding: "10px 18px", background: "var(--ink)", color: "var(--surface)", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: "pointer", flexShrink: 0 };
const secondaryBtn: React.CSSProperties = { padding: "10px 16px", background: "var(--surface)", color: "var(--ink)", border: "1px solid var(--border-strong)", borderRadius: 12, fontSize: 14, fontWeight: 600, cursor: "pointer" };
const activeBtn: React.CSSProperties = { borderColor: "var(--ink)", color: "var(--ink)", fontWeight: 700 };
const settingsPanel: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 16, padding: 16, background: "var(--surface-2)", marginBottom: 16 };
