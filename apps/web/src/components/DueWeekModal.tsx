/**
 * Popup "ghế đến hạn trong một tuần" — mở từ khối *Sắp đến hạn 30 ngày* ở trang
 * Tổng quan, liệt kê từng email và cho GIA HẠN NGAY tại chỗ.
 *
 * Vì sao gia hạn ở đây thay vì đá sang trang Gia hạn: trang đó chỉ gom ghế đã hết
 * hạn hoặc còn ≤7 ngày, nên tuần 21–27/09 với 277 ghế không xuất hiện ở đó. Nhìn
 * thấy cụm mà không làm gì được ngay thì con số chỉ để ngắm.
 *
 * Gia hạn dùng ĐÚNG endpoint của trang Gia hạn (`POST .../members/{id}/renew`,
 * chỉ gửi số tháng, backend cộng dồn hạn + tạo chu kỳ mới) — không có đường thứ
 * hai để hai chỗ lệch nhau.
 *
 * VÍ KHÔNG ĐỦ: backend trả 402 kèm hoá đơn QR, và ở đây mở đúng `OrderQrModal`
 * như trang Mời/Gia hạn/Email đã thêm — quét xong backend tự chạy nốt lượt gia
 * hạn. Chạy TUẦN TỰ và DỪNG ở ghế đầu tiên thiếu tiền: mỗi ghế thiếu tiền sinh
 * một hoá đơn riêng, bắn cả loạt thì người dùng lãnh N mã QR chồng nhau.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { usePlatform } from "../hooks/usePlatform";
import { toast } from "./Toast";
import OrderQrModal from "./OrderQrModal";
import { getQrOrder, type OrderQr } from "../lib/wallet";
import { money, shortDay } from "../lib/dashboard";
import { nextEndAfterRenew } from "./RenewalsPanel";

export type DueMember = {
  member_id: string;
  workspace_id: string;
  workspace_name: string | null;
  email: string;
  end_at: string;
  fee: number;
  payment_status: "unpaid" | "requested" | "paid";
};

/** "2026-09-21T10:00:00+00:00" → "21/09" (theo giờ VN, khớp nhãn của khối gọi nó). */
function dayLabel(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const vn = new Date(d.getTime() + 7 * 3600 * 1000);
  return `${String(vn.getUTCDate()).padStart(2, "0")}/${String(
    vn.getUTCMonth() + 1,
  ).padStart(2, "0")}/${String(vn.getUTCFullYear()).slice(2)}`;
}

export default function DueWeekModal({
  from,
  to,
  onClose,
}: {
  from: string;
  to: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canRenew = hasPermission("MEMBER_INVITE");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [months, setMonths] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [qrOrder, setQrOrder] = useState<OrderQr | null>(null);

  // Danh sách tới hạn của NHÁNH đang mở (mở từ Tổng quan nào thì lấy số nhánh đó).
  const platform = usePlatform();
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["due-members", from, to, platform],
    queryFn: () =>
      api<DueMember[]>(
        `/api/v1/dashboard/due-members?from=${from}&to=${to}&platform=${platform}`,
      ),
  });

  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.member_id)),
    [rows, selected],
  );
  const totalFee = selectedRows.reduce((a, r) => a + r.fee * months, 0);
  const allOn = rows.length > 0 && selected.size === rows.length;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["dashboard-overview"] });
    qc.invalidateQueries({ queryKey: ["due-members"] });
    qc.invalidateQueries({ queryKey: ["added-members"] });
    qc.invalidateQueries({ queryKey: ["members"] });
  };

  const renew = useMutation({
    mutationFn: async () => {
      // TUẦN TỰ, không Promise.all: gặp ghế đầu tiên ví không đủ là dừng để mở
      // đúng MỘT hoá đơn QR. Bắn song song thì mỗi ghế thiếu tiền đẻ một hoá đơn.
      let ok = 0;
      for (const r of selectedRows) {
        try {
          await api(
            `/api/v1/workspaces/${r.workspace_id}/members/${r.member_id}/renew`,
            { method: "POST", body: JSON.stringify({ months }) },
          );
          ok += 1;
        } catch (e) {
          const order = getQrOrder(e);
          if (order) return { ok, order, stoppedAt: r.email, err: null };
          return { ok, order: null, stoppedAt: r.email, err: e };
        }
      }
      return { ok, order: null, stoppedAt: null, err: null };
    },
    onSuccess: ({ ok, order, stoppedAt, err }) => {
      if (ok > 0) toast.success(`Đã gia hạn ${ok} ghế thêm ${months} tháng.`);
      invalidate();
      if (order) {
        // Ví không đủ → thanh toán như mọi chỗ khác trong app.
        setQrOrder(order);
        return;
      }
      if (err) {
        setError(
          `Dừng ở ${stoppedAt}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      setSelected(new Set());
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  if (qrOrder) {
    return (
      <OrderQrModal
        order={qrOrder}
        onClose={() => setQrOrder(null)}
        onPaid={() => {
          // BE đã chạy nốt lượt gia hạn của hoá đơn này. Bỏ ghế vừa xong khỏi ô
          // chọn rồi trả về danh sách để bấm tiếp phần còn lại.
          setQrOrder(null);
          setSelected(new Set());
          invalidate();
        }}
      />
    );
  }

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--ink)" }}>
              Đến hạn {shortDay(from)} – {shortDay(to)}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 4 }}>
              {isLoading ? "Đang tải…" : `${rows.length} ghế`}
              {rows.length > 0 &&
                ` · ${money(rows.reduce((a, r) => a + r.fee, 0))}đ cho 1 tháng`}
            </div>
          </div>
          <button onClick={onClose} style={closeBtn} aria-label="Đóng">
            ✕
          </button>
        </div>

        {/* `zoom` của cỡ chữ KHÔNG chia lại đơn vị viewport: 52vh ở cỡ 125% cao
            thành 65% màn hình thật và modal tràn khỏi đáy. Mọi mốc vh trong app
            đều bọc calc(… / var(--ui-scale)) — xem lib/ui-scale.ts. */}
        <div
          style={{
            maxHeight: "calc(52vh / var(--ui-scale))",
            overflowY: "auto",
          }}
        >
          {rows.length === 0 && !isLoading && (
            <div style={{ padding: 20, fontSize: 13, color: "var(--ink-2)" }}>
              Không có ghế nào đến hạn trong tuần này.
            </div>
          )}
          {rows.length > 0 && (
            <label style={rowStyle}>
              <input
                type="checkbox"
                checked={allOn}
                onChange={() =>
                  setSelected(
                    allOn ? new Set() : new Set(rows.map((r) => r.member_id)),
                  )
                }
              />
              <span style={{ fontSize: 12.5, color: "var(--ink-2)", fontWeight: 600 }}>
                Chọn tất cả
              </span>
            </label>
          )}
          {rows.map((r) => (
            <label key={r.member_id} style={rowStyle}>
              <input
                type="checkbox"
                checked={selected.has(r.member_id)}
                onChange={() =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(r.member_id)) next.delete(r.member_id);
                    else next.add(r.member_id);
                    return next;
                  })
                }
              />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 13,
                  color: "var(--ink)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {r.email}
              </span>
              {r.payment_status === "unpaid" && (
                <span style={unpaidTag}>chưa thanh toán</span>
              )}
              {/* Tích vào là thấy NGAY gia hạn xong hạn nhảy tới đâu — cộng dồn
                  theo đúng hàm của trang Gia hạn, đổi số tháng thì đổi theo. */}
              <span
                style={{
                  fontSize: 11.5,
                  color: "var(--ink-3)",
                  fontFamily: "var(--font-mono)",
                  whiteSpace: "nowrap",
                }}
              >
                {dayLabel(r.end_at)}
                {selected.has(r.member_id) && (
                  <>
                    {" → "}
                    <strong style={{ color: "#059669" }}>
                      {dayLabel(nextEndAfterRenew(r.end_at, months))}
                    </strong>
                  </>
                )}
              </span>
              <span style={{ fontSize: 12.5, color: "var(--ink-2)", minWidth: 66, textAlign: "right" }}>
                {money(r.fee)}đ
              </span>
            </label>
          ))}
        </div>

        <div style={footer}>
          {error && <div style={errorBox}>{error}</div>}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>Gia hạn</span>
            <input
              type="number"
              min={1}
              max={60}
              value={months}
              onChange={(e) =>
                setMonths(Math.max(1, Math.min(60, Number(e.target.value) || 1)))
              }
              style={monthInput}
            />
            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>tháng</span>
            <span style={{ flex: 1 }} />
            {selectedRows.length > 0 && (
              <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
                {selectedRows.length} ghế ·{" "}
                <strong style={{ color: "var(--ink)" }}>{money(totalFee)}đ</strong>
              </span>
            )}
            <button
              disabled={
                !canRenew || selectedRows.length === 0 || renew.isPending
              }
              onClick={() => {
                setError(null);
                renew.mutate();
              }}
              style={{
                ...primaryBtn,
                opacity:
                  !canRenew || selectedRows.length === 0 || renew.isPending
                    ? 0.45
                    : 1,
                cursor:
                  !canRenew || selectedRows.length === 0 ? "default" : "pointer",
              }}
            >
              {renew.isPending ? "Đang gia hạn…" : "Gia hạn ngay"}
            </button>
          </div>
          {!canRenew && (
            <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 8 }}>
              Tài khoản của bạn chưa được cấp quyền mời/gia hạn.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const backdrop: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120, padding: 16 };
const modal: React.CSSProperties = { background: "var(--surface)", borderRadius: 18, width: 560, maxWidth: "100%", border: "1px solid var(--border)", boxShadow: "0 24px 70px -18px rgba(28,26,23,0.4), 0 2px 8px rgba(28,26,23,0.08)", overflow: "hidden", display: "flex", flexDirection: "column" };
const header: React.CSSProperties = { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "18px 20px 14px", borderBottom: "1px solid var(--border)" };
const closeBtn: React.CSSProperties = { width: 30, height: 30, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--ink-3)", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 };
const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "9px 20px", borderBottom: "1px solid var(--border)", cursor: "pointer" };
const unpaidTag: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, color: "#8a6d1f", background: "var(--warning-bg)", padding: "2px 7px", borderRadius: 20, whiteSpace: "nowrap" };
const footer: React.CSSProperties = { padding: "14px 20px 16px", borderTop: "1px solid var(--border)", background: "var(--surface-2)" };
const monthInput: React.CSSProperties = { width: 62, padding: "7px 10px", border: "1px solid var(--border-strong)", borderRadius: 9, fontSize: 13.5, background: "var(--surface)", color: "var(--ink)" };
const primaryBtn: React.CSSProperties = { padding: "9px 18px", background: "var(--ink)", color: "var(--surface)", border: "none", borderRadius: 9, fontSize: 13.5, fontWeight: 700 };
const errorBox: React.CSSProperties = { marginBottom: 10, padding: "9px 11px", background: "var(--danger-bg)", border: "1px solid var(--danger-border)", borderRadius: 9, fontSize: 12.5, color: "var(--danger)", lineHeight: 1.45 };
