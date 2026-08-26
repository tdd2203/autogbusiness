/**
 * TopupModal — nhập số tiền → tạo lệnh nạp → hiện QR VietQR + nội dung CK, poll
 * trạng thái tới khi "đã nhận tiền". Feature 003-wallet-invite-payment.
 *
 * Giao diện áp theo bản thiết kế Claude Design "Nạp tiền vào Ví": header có badge,
 * thẻ số tiền nền tối, thẻ QR gắn thương hiệu VietQR/napas, khối nội dung CK nổi bật
 * kèm nút Chép, và pill trạng thái "đang chờ" tự cập nhật.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCreateTopup, useTopupStatus } from "../hooks/useWallet";
import { formatVnd, type TopupCreated } from "../lib/wallet";
import { ApiError } from "../lib/api";
import { toast } from "./Toast";
import QrBrandRow from "./QrBrandRow";

const PRESETS = [100_000, 200_000, 500_000, 1_000_000];

/** `initialAmount` — số tiền user đã gõ ở khối Nạp/Rút trang Ví, mở modal là có sẵn. */
export default function TopupModal({ onClose, initialAmount }: { onClose: () => void; initialAmount?: number }) {
  const [amount, setAmount] = useState<number>(initialAmount && initialAmount > 0 ? initialAmount : 200_000);
  const [order, setOrder] = useState<TopupCreated | null>(null);
  const createTopup = useCreateTopup();
  const qc = useQueryClient();
  const { data: status } = useTopupStatus(order?.id ?? null);

  const paid = status?.status === "paid";

  useEffect(() => {
    if (paid) {
      qc.invalidateQueries({ queryKey: ["wallet"] });
      toast.success("Đã nhận tiền — số dư đã được cộng.");
      // Nạp thành công → tự đóng modal sau 3s.
      const t = setTimeout(onClose, 3000);
      return () => clearTimeout(t);
    }
  }, [paid, qc, onClose]);

  async function onCreate() {
    try {
      const created = await createTopup.mutateAsync(amount);
      setOrder(created);
    } catch (e) {
      const msg =
        e instanceof ApiError && typeof e.detail === "object" && e.detail
          ? (e.detail as { message?: string }).message ?? "Không tạo được lệnh nạp"
          : "Không tạo được lệnh nạp";
      toast.error(msg);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} style={backdrop}>
      <div className="modal qr-modal-scroll" onClick={(e) => e.stopPropagation()} style={modal}>
        {/* Header */}
        <div style={header}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em", color: "var(--ink)" }}>
                Nạp tiền vào Ví
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 1 }}>
                {order ? "Quét mã QR bằng app ngân hàng để chuyển khoản" : "Chọn số tiền để tạo mã QR chuyển khoản"}
              </div>
            </div>
          </div>
          <button onClick={onClose} style={closeBtn} aria-label="Đóng">✕</button>
        </div>

        <div style={{ padding: "0 24px 24px" }}>
          {!order && (
            <>
              <label style={label}>Số tiền muốn nạp (VND)</label>
              <input
                type="number"
                min={10000}
                step={10000}
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !createTopup.isPending && amount >= 10000) {
                    e.preventDefault();
                    onCreate();
                  }
                }}
                autoFocus
                style={input}
              />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0 20px" }}>
                {PRESETS.map((p) => (
                  <button key={p} onClick={() => setAmount(p)} style={presetBtn(amount === p)}>
                    {formatVnd(p)}
                  </button>
                ))}
              </div>
              <button onClick={onCreate} disabled={createTopup.isPending || amount < 10000} style={primaryBtn}>
                {createTopup.isPending ? "Đang tạo…" : "Tạo mã QR nạp tiền"}
              </button>
            </>
          )}

          {order && paid && (
            <div style={{ textAlign: "center", padding: "20px 0 8px" }}>
              <div style={paidCheck}>✓</div>
              <p style={{ fontSize: 17, fontWeight: 700, color: "var(--ink)", marginTop: 14 }}>
                Đã nhận {formatVnd(order.amount_vnd)}
              </p>
              <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 4 }}>Số dư đã được cộng vào Ví.</p>
              <button onClick={onClose} style={{ ...primaryBtn, marginTop: 20 }}>Xong</button>
            </div>
          )}

          {order && !paid && (
            <>
              {/* Số tiền cần chuyển */}
              <div style={amountCard}>
                <div style={{ fontSize: 10.5, letterSpacing: "0.05em", color: "var(--ink-3)", fontWeight: 600, textTransform: "uppercase" }}>
                  Số tiền cần chuyển
                </div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--ink)", fontFamily: "var(--font-mono)", letterSpacing: "-0.01em", marginTop: 2 }}>
                  {order.amount_vnd.toLocaleString("vi-VN")} <span style={{ fontSize: 13, color: "var(--ink-3)" }}>đ</span>
                </div>
              </div>

              {/* Thẻ QR */}
              <div style={qrCard}>
                <QrBrandRow bankName={order.bank_name} />
                <div style={qrBox}>
                  {order.qr_url ? (
                    <img src={order.qr_url} alt="Mã QR VietQR" style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
                  ) : (
                    <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Không tải được mã QR</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "var(--ink-3)", textAlign: "center" }}>
                  Mở app ngân hàng → Quét mã QR → Xác nhận
                </div>
                <div style={qrFixedNote}>
                  ✓ Mã QR nạp tiền này <b>cố định theo tài khoản của bạn</b> — có thể <b>lưu lại</b> để nạp lần sau. Chuyển đúng nội dung, số tiền nào cũng được cộng tự động.
                </div>
              </div>

              {/* Chi tiết */}
              <div style={detailBox}>
                <DetailRow k="Ngân hàng" v={order.bank_name ?? "-"} />
                <DetailRow k="Số tài khoản" v={order.account_number ?? "-"} mono copyField="account" />
                <DetailRow k="Chủ tài khoản" v={order.account_name ?? "-"} last />

                {/* Nội dung CK — bắt buộc */}
                <div style={noteSection}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, gap: 8 }}>
                    <span style={{ fontSize: 13, color: "var(--danger)", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--danger)", display: "inline-block" }} />
                      Nội dung chuyển khoản
                    </span>
                    <span style={{ fontSize: 11, color: "var(--danger)", fontWeight: 600, whiteSpace: "nowrap" }}>BẮT BUỘC · CHÉP CHÍNH XÁC</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <code style={noteCode}>{order.note}</code>
                    <CopyButton value={order.note} field="content" danger />
                  </div>
                </div>
              </div>

              {/* Trạng thái */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center" }}>
                <div style={statusPill}>
                  <span style={pulseDot} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--warning)" }}>Đang chờ chuyển khoản… tự động cập nhật</span>
                </div>
                <div style={{ fontSize: 12, color: "var(--ink-3)", maxWidth: 340, lineHeight: 1.5 }}>
                  Chuyển <b style={{ color: "var(--ink)" }}>đúng số tiền</b> và <b style={{ color: "var(--ink)" }}>đúng nội dung</b> để hệ thống cộng tiền tự động trong vài giây.
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ k, v, mono, copyField, last }: { k: string; v: string; mono?: boolean; copyField?: "account"; last?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "13px 16px", borderBottom: last ? "none" : "1px solid var(--border)" }}>
      <span style={{ fontSize: 13, color: "var(--ink-2)", flexShrink: 0 }}>{k}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)", fontFamily: mono ? "var(--font-mono)" : "inherit", wordBreak: "break-all", textAlign: "right" }}>
          {v}
        </span>
        {copyField && <CopyButton value={v} field={copyField} />}
      </div>
    </div>
  );
}

function CopyButton({ value, field, danger }: { value: string; field: string; danger?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Không sao chép được");
    }
  }
  return (
    <button
      onClick={onCopy}
      style={{ ...copyBtnBase, ...(copied ? copyBtnDone : danger ? copyBtnDanger : copyBtnIdle) }}
      title={`Sao chép ${field === "account" ? "số tài khoản" : "nội dung"}`}
      aria-label="Sao chép"
    >
      {copied ? "✓ Đã chép" : "Chép"}
    </button>
  );
}

const backdrop: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 16 };
const modal: React.CSSProperties = { background: "var(--bg)", borderRadius: 22, width: 475, maxWidth: "100%", maxHeight: "92vh", overflowY: "auto", boxShadow: "0 24px 70px -18px rgba(28,26,23,0.4), 0 2px 8px rgba(28,26,23,0.08)", overflowX: "hidden" };
const header: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "22px 24px 18px", gap: 12 };
const closeBtn: React.CSSProperties = { width: 32, height: 32, borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--ink-3)", fontSize: 15, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1, flexShrink: 0 };

const label: React.CSSProperties = { display: "block", fontSize: 12.5, color: "var(--ink-2)", marginBottom: 6, fontWeight: 500 };
const input: React.CSSProperties = { width: "100%", padding: "11px 12px", border: "1px solid var(--border)", borderRadius: 10, fontSize: 16, background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-mono)" };

const amountCard: React.CSSProperties = { padding: "10px 15px", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 12, marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 };
const qrCard: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 16, padding: 18, background: "var(--surface)", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, marginBottom: 18 };
const qrBox: React.CSSProperties = { width: 272, maxWidth: "100%", aspectRatio: "1 / 1", borderRadius: 12, overflow: "hidden", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", padding: 6 };
const qrFixedNote: React.CSSProperties = { fontSize: 11.5, lineHeight: 1.45, color: "var(--success)", background: "var(--success-bg)", border: "1px solid var(--success-border)", borderRadius: 9, padding: "7px 11px", textAlign: "center", width: "100%" };

const detailBox: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 16, overflow: "hidden", marginBottom: 18, background: "var(--surface)" };
const noteSection: React.CSSProperties = { padding: "13px 16px", background: "var(--danger-bg)", borderTop: "1px solid var(--border)" };
const noteCode: React.CSSProperties = { flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, fontFamily: "var(--font-mono)", color: "var(--danger)", background: "var(--surface)", border: "1px solid var(--danger)", borderRadius: 9, padding: "9px 11px", wordBreak: "break-all", lineHeight: 1.4 };

const statusPill: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 9, padding: "8px 16px", background: "var(--warning-bg)", border: "1px solid var(--warning-border)", borderRadius: 20 };
const pulseDot: React.CSSProperties = { width: 9, height: 9, borderRadius: "50%", background: "var(--warning)", display: "inline-block", animation: "nap-pulse 1.3s ease-in-out infinite" };

const paidCheck: React.CSSProperties = { width: 56, height: 56, borderRadius: "50%", background: "var(--success-bg)", border: "1px solid var(--success-border)", color: "var(--success)", fontSize: 30, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto" };

const primaryBtn: React.CSSProperties = { width: "100%", padding: "12px", background: "var(--ink)", color: "var(--surface)", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer" };

function presetBtn(active: boolean): React.CSSProperties {
  return { flex: "1 1 calc(50% - 4px)", padding: "9px 12px", border: `1px solid ${active ? "var(--ink)" : "var(--border)"}`, background: active ? "var(--ink)" : "var(--surface)", color: active ? "var(--surface)" : "var(--ink-2)", borderRadius: 10, fontSize: 13, cursor: "pointer", fontWeight: 600 };
}

const copyBtnBase: React.CSSProperties = { flexShrink: 0, fontSize: 12, fontWeight: 600, borderRadius: 8, padding: "7px 13px", cursor: "pointer", border: "1px solid", transition: "all .15s", whiteSpace: "nowrap" };
const copyBtnIdle: React.CSSProperties = { borderColor: "var(--border-strong)", background: "var(--bg)", color: "var(--ink-2)" };
const copyBtnDanger: React.CSSProperties = { borderColor: "var(--danger)", background: "var(--surface)", color: "var(--danger)" };
const copyBtnDone: React.CSSProperties = { borderColor: "var(--success)", background: "var(--success-bg)", color: "var(--success)" };
