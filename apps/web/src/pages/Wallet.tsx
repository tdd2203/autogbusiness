/**
 * Trang Ví của người dùng: hai thẻ chốt số của ngày, lịch sử giao dịch, số dư và
 * nạp/rút.
 *
 * Phần NHÌN của lịch sử (thẻ tổng kết ngày + thẻ lịch sử) nằm ở
 * `components/WalletHistory.tsx` vì trang Quản trị Ví dùng lại y hệt — xem giải
 * thích ở đầu file đó.
 */
import { useState } from "react";
import { useCreateWithdrawal, useWallet, useWalletLive } from "../hooks/useWallet";
import { formatVnd } from "../lib/wallet";
import { ApiError } from "../lib/api";
import LoadError from "../components/LoadError";
import { toast } from "../components/Toast";
import TopupModal from "../components/TopupModal";
import SepayReconcileModal from "../components/SepayReconcileModal";
import WalletExportButton from "../components/WalletExportButton";
import { useAuth } from "../hooks/useAuth";
import {
  useWalletHistoryState,
  WalletDaySummary,
  WalletHistoryCard,
} from "../components/WalletHistory";
import {
  bigVnd,
  card,
  cardKicker,
  input,
  linkBtn,
  panelTab,
  panelTabOn,
  parseVnd,
  pickBtn,
  previewLine,
  primaryBtn,
  secondaryBtn,
  shortVnd,
  vnToday,
} from "../components/walletUi";

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
  const { data: wallet, isLoading, error, isFetching, refetch } = useWallet();
  // Số dư tự nhích 30s/lần; đổi số ⇒ lịch sử + tổng kết ngày nạp lại theo.
  useWalletLive();
  const [topupAmount, setTopupAmount] = useState<number | null>(null);
  const [reconcileOpen, setReconcileOpen] = useState(false);

  const today = vnToday();
  /** Ngày đang xem; null = xem mọi ngày (nút "Tất cả"). Mặc định là HÔM NAY —
   *  mở ví ra là thấy ngay việc của hôm nay, không phải lọc lại (user 2026-08-26).
   *  Hai thẻ trên chốt số của `day ?? hôm nay` nên luôn khớp với danh sách. */
  const [day, setDay] = useState<string | null>(today);
  // Ngày đang chọn được xin THẲNG ở server (không lọc trên trang đầu 100 dòng nữa) —
  // nếu không thì ngày cũ nào nằm ngoài 100 bút toán gần nhất sẽ hiện rỗng như thể
  // lịch sử đã mất (user 2026-08-26).
  const hist = useWalletHistoryState(day, null);
  const { user: me } = useAuth();

  const fee = wallet?.invite_fee_vnd ?? 0;

  return (
    <div className="page-fade" style={{ padding: "8px 4px 40px" }}>
      <header style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, flexWrap: "wrap", marginBottom: 18 }}>
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-.025em", color: "var(--ink)", marginBottom: 6 }}>Ví</h1>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: "var(--ink-2)", maxWidth: 520 }}>
            {fee > 0 ? (
              <>
                Mỗi lời mời có phí cố định <strong style={{ color: "var(--ink)" }}>{formatVnd(fee)}</strong>. Phí được trừ từ số dư ví.
              </>
            ) : (
              "Nạp tiền để mời thành viên. Mỗi lời mời trừ phí cố định từ số dư."
            )}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button onClick={() => setReconcileOpen(true)} style={secondaryBtn}>
            Đối soát ngân hàng
          </button>
          <WalletExportButton s={hist} day={day} owner={me?.username || me?.email || "ví của tôi"} />
          <button onClick={() => setTopupAmount(0)} style={primaryBtn}>+ Nạp tiền</button>
        </div>
      </header>

      <WalletDaySummary date={day ?? today} isToday={(day ?? today) === today} />

      <section style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start", marginTop: 14 }}>
        <WalletHistoryCard s={hist} day={day} setDay={setDay} />

        <div style={{ flex: "1 1 318px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
          <BalancePanel
            balance={wallet?.balance ?? 0}
            held={wallet?.held ?? 0}
            fee={fee}
            isLoading={isLoading}
            // Số dư đọc hỏng mà vẫn in "0 đ · đủ 0 lượt" là câu dễ hiểu nhầm nhất
            // trang này: user tưởng hết tiền chứ không biết là chưa đọc được.
            error={error}
            hasData={!!wallet}
            onRetry={() => void refetch()}
            retrying={isFetching}
            onTopup={setTopupAmount}
          />
          <FeeLegend />
        </div>
      </section>

      {topupAmount !== null && (
        <TopupModal initialAmount={topupAmount || undefined} onClose={() => setTopupAmount(null)} />
      )}
      {reconcileOpen && (
        <SepayReconcileModal initialDate={day ?? today} onClose={() => setReconcileOpen(false)} />
      )}
    </div>
  );
}

/* ── Cột phải: số dư + nạp/rút ─────────────────────────────────────────────── */

/**
 * Số dư và hai việc làm với nó (nạp / rút) gộp vào MỘT thẻ có tab — trước đây là hai
 * thẻ rời nhau, thẻ số dư chỉ có mỗi nút "+ Nạp tiền" nên chiếm chỗ mà không nói
 * thêm được gì.
 */
function BalancePanel({
  balance,
  held,
  fee,
  isLoading,
  error,
  hasData,
  onRetry,
  retrying,
  onTopup,
}: {
  balance: number;
  held: number;
  fee: number;
  isLoading: boolean;
  error: unknown;
  /** Đã từng đọc được số dư chưa — chưa thì KHÔNG được vẽ số 0 nào. */
  hasData: boolean;
  onRetry: () => void;
  retrying: boolean;
  onTopup: (amount: number) => void;
}) {
  const [tab, setTab] = useState<"topup" | "withdraw">("topup");
  const [amountText, setAmountText] = useState("");
  const amount = parseVnd(amountText);
  const seats = fee > 0 ? Math.floor(balance / fee) : null;

  return (
    <div style={{ ...card, padding: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, padding: "14px 12px 12px" }}>
        <div>
          <div style={cardKicker}>SỐ DƯ VÍ</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 5 }}>
            <span style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.02em", lineHeight: 1, color: "var(--ink)" }}>
              {isLoading ? "…" : hasData ? bigVnd(balance) : "—"}
            </span>
            <span style={{ fontSize: 14, color: "var(--ink-3)" }}>đ</span>
          </div>
          {error != null && (
            <LoadError
              error={error}
              onRetry={onRetry}
              retrying={retrying}
              variant="inline"
              fallback="Không đọc được số dư ví."
            />
          )}
          {held > 0 && (
            <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 4 }}>Đang giữ (chờ rút): {formatVnd(held)}</div>
          )}
        </div>
        {hasData && seats !== null && (
          <span style={{ fontSize: 12, color: "var(--ink-2)", whiteSpace: "nowrap" }}>đủ {seats} lượt</span>
        )}
      </div>

      <div style={{ display: "flex", gap: 4, background: "var(--surface-2)", borderRadius: 10, padding: 4 }}>
        <button onClick={() => setTab("topup")} style={{ ...panelTab, ...(tab === "topup" ? panelTabOn : null) }}>Nạp tiền</button>
        <button onClick={() => setTab("withdraw")} style={{ ...panelTab, ...(tab === "withdraw" ? panelTabOn : null) }}>Rút tiền</button>
      </div>

      {tab === "topup" ? (
        <TopupForm
          balance={balance}
          hasBalance={hasData}
          fee={fee}
          amountText={amountText}
          amount={amount}
          onAmountText={setAmountText}
          onSubmit={() => onTopup(amount)}
        />
      ) : (
        <WithdrawForm
          available={balance}
          amountText={amountText}
          amount={amount}
          onAmountText={setAmountText}
        />
      )}
    </div>
  );
}

function TopupForm({
  balance,
  hasBalance,
  fee,
  amountText,
  amount,
  onAmountText,
  onSubmit,
}: {
  balance: number;
  /** Số dư đã đọc được chưa — chưa thì đừng cộng trừ trên số 0 giả. */
  hasBalance: boolean;
  fee: number;
  amountText: string;
  amount: number;
  onAmountText: (v: string) => void;
  onSubmit: () => void;
}) {
  // Gợi ý theo PHÍ MỜI (10/30/100 lượt) chứ không phải con số tròn cố định — nạp
  // xong là biết ngay mời được bao nhiêu người.
  const picks = fee > 0 ? [fee * 10, fee * 30, fee * 100] : [500_000, 1_000_000, 3_000_000];
  const after = balance + amount;
  const seatsAfter = fee > 0 ? Math.floor(after / fee) : null;
  return (
    <div style={{ padding: "20px 14px 14px" }}>
      <div style={{ fontSize: 13, color: "var(--ink-2)", marginBottom: 14, lineHeight: 1.5 }}>
        Nạp thêm để phí mời được trừ từ ví thay vì phải thanh toán trực tiếp mỗi lần.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <input
          value={amount ? amount.toLocaleString("vi-VN") : amountText}
          onChange={(e) => onAmountText(e.target.value)}
          inputMode="numeric"
          placeholder="Số tiền"
          style={input}
        />
        <div style={{ display: "flex", gap: 6 }}>
          {picks.map((p) => (
            <button key={p} onClick={() => onAmountText(String(p))} style={pickBtn}>{shortVnd(p)}</button>
          ))}
        </div>
        <div style={previewLine}>
          {!hasBalance
            ? "Chưa đọc được số dư hiện tại, nên chưa tính được số dư sau khi nạp."
            : amount > 0
              ? `Sau khi nạp: ${formatVnd(after)}${seatsAfter !== null ? ` · đủ ${seatsAfter} lượt mời` : ""}`
              : `Số dư hiện tại ${formatVnd(balance)}${fee > 0 ? ` · đủ ${Math.floor(balance / fee)} lượt mời` : ""}`}
        </div>
        <button onClick={onSubmit} style={{ ...primaryBtn, width: "100%", padding: 13 }}>Tiếp tục nạp tiền</button>
      </div>
    </div>
  );
}

function WithdrawForm({
  available,
  amountText,
  amount,
  onAmountText,
}: {
  available: number;
  amountText: string;
  amount: number;
  onAmountText: (v: string) => void;
}) {
  const { user } = useAuth();
  const savedCfg = loadWithdrawConfig(user?.id);
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
    if (cfg.default_amount > 0) onAmountText(String(cfg.default_amount));
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
      onAmountText("");
      setBank("");
    } catch (e) {
      const detail = e instanceof ApiError ? (e.detail as { message?: string; shortfall?: number }) : null;
      toast.error(detail?.message ?? "Không gửi được yêu cầu rút");
    }
  }

  return (
    <div style={{ padding: "20px 14px 14px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
          Yêu cầu rút sẽ giữ số dư tương ứng cho tới khi super-admin duyệt.
        </div>
        <button onClick={() => setShowSettings((s) => !s)} style={{ ...linkBtn, ...(showSettings ? { color: "var(--ink)" } : null) }}>
          Cài đặt
        </button>
      </div>

      {showSettings && (
        <div style={settingsPanel}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>Cấu hình rút tiền</div>
          <p style={{ fontSize: 12, lineHeight: 1.5, color: "var(--ink-3)", margin: "4px 0 10px" }}>
            Lưu STK và số tiền mặc định để tự điền sẵn cho những lần rút sau.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input placeholder="Ngân hàng · STK · Chủ TK" value={cfgBank} onChange={(e) => setCfgBank(e.target.value)} style={input} />
            <input
              type="number"
              placeholder="Số tiền mặc định (tuỳ chọn)"
              value={cfgAmount || ""}
              onChange={(e) => setCfgAmount(Number(e.target.value))}
              style={input}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
              <button onClick={() => setShowSettings(false)} style={{ ...secondaryBtn, flex: 1 }}>Huỷ</button>
              <button onClick={saveSettings} style={{ ...primaryBtn, flex: 1 }}>Lưu</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <input
          value={amount ? amount.toLocaleString("vi-VN") : amountText}
          onChange={(e) => onAmountText(e.target.value)}
          inputMode="numeric"
          placeholder="Số tiền"
          style={input}
        />
        <input placeholder="Ngân hàng · STK · Chủ TK" value={bank} onChange={(e) => setBank(e.target.value)} style={input} />
        <div style={previewLine}>
          {amount > available
            ? `Vượt quá số dư khả dụng ${formatVnd(available)}.`
            : `Khả dụng ${formatVnd(available)}${amount > 0 ? ` · còn lại ${formatVnd(available - amount)}` : ""}`}
        </div>
        <button onClick={submit} disabled={createWithdrawal.isPending} style={{ ...primaryBtn, width: "100%", padding: 13 }}>
          {createWithdrawal.isPending ? "Đang gửi…" : "Gửi yêu cầu rút"}
        </button>
      </div>
    </div>
  );
}

/** Bảng giải thích 3 đường đi của tiền — khớp màu với chip lọc và thanh tỉ lệ ở trên. */
function FeeLegend() {
  return (
    <div style={{ ...card, padding: 18 }}>
      <div style={{ ...cardKicker, marginBottom: 14 }}>CÁCH TÍNH PHÍ</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
        <div style={{ display: "flex", gap: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--warning-accent)", marginTop: 5, flexShrink: 0 }} />
          <span><strong style={{ color: "var(--ink)" }}>Trừ số dư ví</strong> — mặc định khi ví còn tiền. Trừ ngay lúc mời.</span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--ink)", marginTop: 5, flexShrink: 0 }} />
          <span><strong style={{ color: "var(--ink)" }}>Thanh toán trực tiếp</strong> — khi ví hết tiền. Sẽ sinh QR tự động để thanh toán.</span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--success)", marginTop: 5, flexShrink: 0 }} />
          <span><strong style={{ color: "var(--ink)" }}>Hoàn phí</strong> — lời mời lỗi sẽ tự động hoàn lập tức về ví.</span>
        </div>
      </div>
    </div>
  );
}
const settingsPanel: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 12, padding: 14, background: "var(--surface-2)", marginBottom: 12 };
