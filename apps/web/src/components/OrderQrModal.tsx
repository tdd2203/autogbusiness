/**
 * OrderQrModal — hiển thị QR hoá đơn MỜI/GIA HẠN/TRẢ KỲ khi ví không đủ (feature 003,
 * user 2026-07-13: "ví trước, QR sau"). Hoá đơn đã được BE tạo (mã ORDER); modal
 * chỉ hiện QR + nội dung CK và POLL trạng thái tới khi "đã thanh toán" → BE tự thực
 * thi mời/gia hạn. Khớp giao diện `TopupModal` (VietQR/napas).
 *
 * Nạp THÀNH CÔNG → invalidate danh sách member/ví để UI đọc bản sống + gọi onPaid.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useOrderStatus } from "../hooks/useWallet";
import { formatVnd, type OrderQr } from "../lib/wallet";
import { toast } from "./Toast";
import QrBrandRow from "./QrBrandRow";

export default function OrderQrModal({
  order,
  onClose,
  onPaid,
}: {
  order: OrderQr;
  onClose: () => void;
  /** Gọi sau khi thanh toán thành công (BE đã thực thi mời/gia hạn). */
  onPaid?: () => void;
}) {
  const qc = useQueryClient();
  const { data: status } = useOrderStatus(order.id);
  const paid = status?.status === "paid";

  // Tiêu đề + động từ theo loại hoá đơn.
  const title =
    order.kind === "invite"
      ? "Thanh toán mời thành viên"
      : order.kind === "subscription"
        ? "Thanh toán đổi hạn"
        : order.kind === "cycle"
          ? "Thanh toán kỳ còn nợ"
          : "Thanh toán gia hạn";
  const actionWord =
    order.kind === "invite"
      ? "mời"
      : order.kind === "subscription"
        ? "đổi hạn"
        : order.kind === "cycle"
          ? "ghi nhận đã thanh toán"
          : "gia hạn";

  // ── Đếm ngược 10 phút: mã QR chỉ tồn tại 10 phút (user 2026-07-14) ─────────
  const EXPIRE_MS = 10 * 60 * 1000;
  const [mountedAt] = useState(() => Date.now());
  const createdMs = order.created_at ? new Date(order.created_at).getTime() : mountedAt;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const remainingMs = Math.max(0, createdMs + EXPIRE_MS - nowMs);
  const expired =
    !paid &&
    (remainingMs <= 0 || status?.status === "expired" || status?.status === "cancelled");
  const totalSec = Math.ceil(remainingMs / 1000);
  const countdown = `${String(Math.floor(totalSec / 60)).padStart(2, "0")}:${String(totalSec % 60).padStart(2, "0")}`;
  const urgent = remainingMs <= 60_000;

  // Tick 1s khi còn chờ; dừng khi đã trả tiền / hết hạn.
  useEffect(() => {
    if (paid || expired) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [paid, expired]);

  useEffect(() => {
    if (!paid) return;
    // Làm mới bản sống (không reload tay): member/ví/lịch sử.
    qc.invalidateQueries({ queryKey: ["members"] });
    qc.invalidateQueries({ queryKey: ["added-members"] });
    qc.invalidateQueries({ queryKey: ["member-logs"] });
    qc.invalidateQueries({ queryKey: ["wallet"] });
    toast.success(`Đã thanh toán — hệ thống đang xử lý ${actionWord}.`);
    onPaid?.();
    const timer = setTimeout(onClose, 2500);
    return () => clearTimeout(timer);
  }, [paid, actionWord, qc, onPaid, onClose]);

  return (
    <div style={backdrop} onClick={onClose}>
      <div className="qr-modal-scroll" style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em", color: "var(--ink)" }}>
              {title}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 1 }}>
              Số dư Ví không đủ — quét QR để thanh toán, xong tự động xử lý
            </div>
          </div>
          <button onClick={onClose} style={closeBtn} aria-label="Đóng">✕</button>
        </div>

        <div style={{ padding: "0 24px 24px" }}>
          {paid ? (
            <div style={{ textAlign: "center", padding: "20px 0 8px" }}>
              <div style={paidCheck}>✓</div>
              <p style={{ fontSize: 17, fontWeight: 700, color: "var(--ink)", marginTop: 14 }}>
                Đã nhận {formatVnd(order.amount_vnd)}
              </p>
              <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 4 }}>
                Đang xử lý {actionWord}…
              </p>
              <button onClick={onClose} style={{ ...primaryBtn, marginTop: 20 }}>Xong</button>
            </div>
          ) : expired ? (
            <div style={{ textAlign: "center", padding: "20px 0 8px" }}>
              <div style={expiredIcon}>⌛</div>
              <p style={{ fontSize: 17, fontWeight: 700, color: "var(--ink)", marginTop: 14 }}>
                Mã QR đã hết hạn
              </p>
              <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 4, maxWidth: 320, marginInline: "auto", lineHeight: 1.5 }}>
                Mã thanh toán chỉ có hiệu lực 10 phút. Đóng lại và {actionWord} lại để lấy mã mới.
                Nếu bạn đã chuyển khoản, tiền sẽ tự cộng vào Ví.
              </p>
              <button onClick={onClose} style={{ ...primaryBtn, marginTop: 20 }}>Đóng</button>
            </div>
          ) : (
            <>
              <div style={amountCard}>
                <div>
                  <div style={cardLabel}>Số tiền cần chuyển</div>
                  <div style={cardValue}>
                    {order.amount_vnd.toLocaleString("vi-VN")} <span style={{ fontSize: 13, color: "var(--ink-3)" }}>đ</span>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={cardLabel}>Hết hạn sau</div>
                  <div style={{ ...cardValue, color: urgent ? "var(--danger)" : "var(--ink)" }}>{countdown}</div>
                </div>
              </div>

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
                <div style={qrWarn}>
                  ⚠️ Mỗi mã QR thanh toán là <b>khác nhau</b> — vui lòng <b>KHÔNG lưu lại</b> mã QR này.
                </div>
              </div>

              <div style={detailBox}>
                <DetailRow k="Ngân hàng" v={order.bank_name ?? "-"} />
                <DetailRow k="Số tài khoản" v={order.account_number ?? "-"} mono copyField />
                <DetailRow k="Chủ tài khoản" v={order.account_name ?? "-"} last />

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
                    <CopyButton value={order.note} danger />
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center" }}>
                <div style={statusPill}>
                  <span style={pulseDot} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--warning)" }}>Đang chờ chuyển khoản… tự động cập nhật</span>
                </div>
                <div style={{ fontSize: 12, color: "var(--ink-3)", maxWidth: 340, lineHeight: 1.5 }}>
                  Chuyển <b style={{ color: "var(--ink)" }}>đúng số tiền</b> và <b style={{ color: "var(--ink)" }}>đúng nội dung</b>.
                  Nhận đủ tiền, hệ thống {actionWord} tự động trong vài giây.
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ k, v, mono, copyField, last }: { k: string; v: string; mono?: boolean; copyField?: boolean; last?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "13px 16px", borderBottom: last ? "none" : "1px solid var(--border)" }}>
      <span style={{ fontSize: 13, color: "var(--ink-2)", flexShrink: 0 }}>{k}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)", fontFamily: mono ? "var(--font-mono)" : "inherit", wordBreak: "break-all", textAlign: "right" }}>
          {v}
        </span>
        {copyField && <CopyButton value={v} />}
      </div>
    </div>
  );
}

function CopyButton({ value, danger }: { value: string; danger?: boolean }) {
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
      aria-label="Sao chép"
    >
      {copied ? "✓ Đã chép" : "Chép"}
    </button>
  );
}

const backdrop: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 110, padding: 16 };
const modal: React.CSSProperties = { background: "var(--bg)", borderRadius: 22, width: 428, maxWidth: "100%", maxHeight: "92vh", overflowY: "auto", boxShadow: "0 24px 70px -18px rgba(28,26,23,0.4), 0 2px 8px rgba(28,26,23,0.08)", overflowX: "hidden" };
const header: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "22px 24px 18px", gap: 12 };
const closeBtn: React.CSSProperties = { width: 32, height: 32, borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--ink-3)", fontSize: 15, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1, flexShrink: 0 };
const amountCard: React.CSSProperties = { padding: "10px 15px", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 12, marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 };
const cardLabel: React.CSSProperties = { fontSize: 10.5, letterSpacing: "0.05em", color: "var(--ink-3)", fontWeight: 600, textTransform: "uppercase" };
const cardValue: React.CSSProperties = { fontSize: 20, fontWeight: 700, color: "var(--ink)", fontFamily: "var(--font-mono)", letterSpacing: "-0.01em", marginTop: 2 };
const expiredIcon: React.CSSProperties = { width: 56, height: 56, borderRadius: "50%", background: "var(--warning-bg)", border: "1px solid var(--warning-border)", color: "var(--warning)", fontSize: 28, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto" };
const qrCard: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 16, padding: 18, background: "var(--surface)", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, marginBottom: 18 };
const qrBox: React.CSSProperties = { width: 245, maxWidth: "100%", aspectRatio: "1 / 1", borderRadius: 12, overflow: "hidden", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", padding: 6 };
const qrWarn: React.CSSProperties = { fontSize: 11.5, lineHeight: 1.45, color: "var(--warning)", background: "var(--warning-bg)", border: "1px solid var(--warning-border)", borderRadius: 9, padding: "7px 11px", textAlign: "center", width: "100%" };
const detailBox: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 16, overflow: "hidden", marginBottom: 18, background: "var(--surface)" };
const noteSection: React.CSSProperties = { padding: "13px 16px", background: "var(--danger-bg)", borderTop: "1px solid var(--border)" };
const noteCode: React.CSSProperties = { flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, fontFamily: "var(--font-mono)", color: "var(--danger)", background: "var(--surface)", border: "1px solid var(--danger)", borderRadius: 9, padding: "9px 11px", wordBreak: "break-all", lineHeight: 1.4 };
const statusPill: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 9, padding: "8px 16px", background: "var(--warning-bg)", border: "1px solid var(--warning-border)", borderRadius: 20 };
const pulseDot: React.CSSProperties = { width: 9, height: 9, borderRadius: "50%", background: "var(--warning)", display: "inline-block", animation: "nap-pulse 1.3s ease-in-out infinite" };
const paidCheck: React.CSSProperties = { width: 56, height: 56, borderRadius: "50%", background: "var(--success-bg)", border: "1px solid var(--success-border)", color: "var(--success)", fontSize: 30, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto" };
const primaryBtn: React.CSSProperties = { width: "100%", padding: "12px", background: "var(--ink)", color: "var(--surface)", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer" };
const copyBtnBase: React.CSSProperties = { flexShrink: 0, fontSize: 12, fontWeight: 600, borderRadius: 8, padding: "7px 13px", cursor: "pointer", border: "1px solid", transition: "all .15s", whiteSpace: "nowrap" };
const copyBtnIdle: React.CSSProperties = { borderColor: "var(--border-strong)", background: "var(--bg)", color: "var(--ink-2)" };
const copyBtnDanger: React.CSSProperties = { borderColor: "var(--danger)", background: "var(--surface)", color: "var(--danger)" };
const copyBtnDone: React.CSSProperties = { borderColor: "var(--success)", background: "var(--success-bg)", color: "var(--success)" };
