/**
 * SepayReconcileModal — ĐỐI SOÁT NGÂN HÀNG: mọi giao dịch SePay báo về trong một ngày,
 * đặt cạnh phần đã vào ví.
 *
 * Vì sao tách khỏi lịch sử ví: lịch sử ví chỉ có tiền ĐÃ THÀNH SỐ DƯ. Khoản khách chuyển
 * sai nội dung hoặc lệch số tiền bị webhook từ chối — tiền nằm trong tài khoản ngân hàng
 * nhưng không có dòng nào trong ví, nhìn vào đâu cũng không thấy (user 2026-08-26). Bảng
 * này lấy từ sổ nhận tiền thô nên phần KẸT hiện ra thành danh sách cụ thể.
 *
 * Ba con số trên đầu đọc theo thứ tự: ngân hàng NHẬN bao nhiêu → VÀO VÍ bao nhiêu →
 * CHÊNH bao nhiêu. Chênh = 0 là khớp sổ.
 *
 * Super-admin thấy toàn bộ tiền vào (và có nút kéo sao kê từ API SePay để dựng lại ngày
 * cũ); user thường chỉ thấy giao dịch khớp đúng mã của mình.
 *
 * Mở từ trang ví của MỘT tài khoản (`userId`) thì bảng bó về đúng người đó — bảng toàn
 * bộ tiền vào nằm ở trang Quản trị Ví (user 2026-08-29: đang xem ví của tuan mà hiện
 * cả 40 giao dịch của mọi người).
 */
import { useEffect, useRef, useState } from "react";
import { useSepayDay, useSepaySync } from "../hooks/useWallet";
import { formatVnd, SEPAY_RESULT_LABEL } from "../lib/wallet";
import type { SepayEvent } from "../lib/wallet";
import { ApiError } from "../lib/api";
import { toast } from "./Toast";

/** Hôm nay theo giờ VN (YYYY-MM-DD) — khớp cách trang Ví cắt ngày. */
function vnToday(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

function shiftDay(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function vnDateLabel(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** Giờ:phút của giao dịch — ưu tiên giờ NGÂN HÀNG ghi nhận, không thì giờ mình nhận. */
function timeOf(e: SepayEvent): string {
  const at = new Date(e.bank_time ?? e.received_at);
  return at.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
}

/** Màu theo kết luận: xanh = tiền đã yên vị, đỏ = đang kẹt, xám = không phải chuyện tiền. */
function tone(result: string): { fg: string; bg: string; border: string } {
  if (result === "credited" || result === "dup_invoice")
    return { fg: "var(--success)", bg: "var(--success-bg)", border: "var(--success-border)" };
  if (result === "duplicate" || result === "ignored")
    return { fg: "var(--ink-3)", bg: "var(--surface-2)", border: "var(--border)" };
  return { fg: "var(--danger)", bg: "var(--danger-bg)", border: "var(--danger)" };
}

export default function SepayReconcileModal({
  initialDate,
  highlightTxnId,
  userId,
  scopeName,
  onClose,
}: {
  initialDate?: string;
  /** Mã giao dịch ngân hàng cần soi — mở từ một dòng ví bên Quản trị Ví: cuộn tới
   *  đúng khoản đó và viền lại, khỏi phải dò trong ngày mấy chục giao dịch. */
  highlightTxnId?: string | null;
  /** Bó bảng về tiền vào của đúng một tài khoản (super-admin). */
  userId?: string | null;
  /** Tên hiện ở dòng phụ khi đang bó theo `userId`. */
  scopeName?: string | null;
  onClose: () => void;
}) {
  const today = vnToday();
  const [date, setDate] = useState(initialDate ?? today);
  const { data, isLoading } = useSepayDay(date, userId ?? null);
  const sync = useSepaySync();
  // Đổi ngày thì cuộn danh sách về đầu: khung cao cố định nên nếu giữ nguyên vị trí
  // cuộn cũ, ngày mới ít giao dịch hơn sẽ mở ra ở giữa chừng (có khi trống trơn).
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [date]);
  // Khoản được chỉ đích danh có thể nằm tận cuối ngày → tự cuộn tới sau khi có dữ liệu.
  const hitRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlightTxnId) hitRef.current?.scrollIntoView({ block: "center" });
  }, [highlightTxnId, data]);

  const events = data?.events ?? [];
  const gap = (data?.received_total ?? 0) - (data?.credited_total ?? 0);

  async function onSync() {
    try {
      const r = await sync.mutateAsync({ date_from: date, date_to: date });
      toast.success(
        `Sao kê ${vnDateLabel(date)}: lấy ${r.fetched} giao dịch, ` +
          `khớp lại ${r.matched_to_wallet}, còn ${r.bank_only} khoản chưa thấy trong ví.`,
      );
    } catch (e) {
      const msg =
        e instanceof ApiError ? String(e.detail ?? "Không kéo được sao kê") : "Không kéo được sao kê";
      toast.error(msg);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} style={backdrop}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={modal}>
        <div style={header}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em", color: "var(--ink)" }}>
              Đối soát ngân hàng
            </div>
            <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 1 }}>
              Dữ liệu SePay báo về
              {userId
                ? ` — phần của ${scopeName || "tài khoản này"}`
                : data?.is_admin_view
                  ? " — toàn bộ tiền vào"
                  : " — phần của bạn"}
            </div>
          </div>
          <button onClick={onClose} style={closeBtn} aria-label="Đóng">✕</button>
        </div>

        {/* Thanh chọn ngày */}
        <div style={dayBar}>
          <button onClick={() => setDate(shiftDay(date, -1))} aria-label="Ngày trước" style={iconBtn}>←</button>
          <button
            onClick={() => setDate(shiftDay(date, 1))}
            aria-label="Ngày sau"
            disabled={date >= today}
            style={{ ...iconBtn, opacity: date >= today ? 0.4 : 1 }}
          >
            →
          </button>
          <label style={datePick}>
            <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", color: "var(--ink)" }}>
              {date === today ? `Hôm nay · ${vnDateLabel(date)}` : vnDateLabel(date)}
            </span>
            <input
              type="date"
              value={date}
              max={today}
              onChange={(e) => e.target.value && setDate(e.target.value)}
              style={{ width: 20, border: "none", background: "transparent", fontSize: 13, color: "var(--ink-3)", cursor: "pointer", padding: 0 }}
            />
          </label>
          {data?.can_sync && (
            <button onClick={onSync} disabled={sync.isPending} style={{ ...syncBtn, opacity: sync.isPending ? 0.6 : 1 }}>
              {sync.isPending ? "Đang kéo…" : "Kéo sao kê SePay"}
            </button>
          )}
        </div>

        {/* Ba con số chốt ngày */}
        <div style={statRow}>
          <Stat label="Ngân hàng nhận" value={formatVnd(data?.received_total ?? 0)} sub={`${data?.received_count ?? 0} giao dịch`} />
          <Stat label="Đã vào ví" value={formatVnd(data?.credited_total ?? 0)} sub={`${data?.credited_count ?? 0} giao dịch`} fg="var(--success)" />
          <Stat
            label="Chênh lệch"
            value={formatVnd(gap)}
            sub={gap === 0 ? "khớp sổ" : `${data?.pending_count ?? 0} khoản đang kẹt`}
            fg={gap === 0 ? "var(--ink)" : "var(--danger)"}
          />
        </div>

        <div ref={listRef} style={list}>
          {isLoading && <div style={emptyBox}>Đang tải…</div>}

          {!isLoading && events.length === 0 && data && (
            <div style={emptyBox}>
              <div style={{ fontSize: 13.5, color: "var(--ink-2)" }}>
                Không có giao dịch nào ngày {vnDateLabel(date)}.
              </div>
              {/* Trống vì SAO mới là thứ cần nói. Ba lý do khác hẳn nhau: ngày đó
                  thật sự không ai chuyển tiền / ngày đó nằm TRƯỚC lúc sổ bắt đầu ghi /
                  server chưa có token nên không kéo sao kê về được. Chỉ hiện một câu
                  "không có giao dịch nào" thì trông y như hỏng (user 2026-08-27). */}
              <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.55, maxWidth: 460, marginInline: "auto" }}>
                {data.ledger_first_date === null ? (
                  <>
                    Sổ đối soát vừa bắt đầu ghi và <b>chưa nhận giao dịch nào</b> — nó chỉ ghi
                    từ lúc bản cập nhật này chạy trở đi. Giao dịch trước đó phải kéo sao kê từ
                    SePay về.
                  </>
                ) : date < data.ledger_first_date ? (
                  <>
                    Sổ mới ghi từ <b>{vnDateLabel(data.ledger_first_date)}</b>, nên ngày này trống
                    là đúng — không phải mất dữ liệu.
                  </>
                ) : userId ? (
                  <>Ngày này không có khoản nào vào ví tài khoản này.</>
                ) : (
                  <>Ngày này ngân hàng không nhận khoản nào.</>
                )}
                {data.sync_needs_token && (
                  <div style={{ marginTop: 6, color: "var(--warning)" }}>
                    Muốn lấy lại ngày cũ: đặt <code>SEPAY_USER_API_TOKEN</code> trong{" "}
                    <code>.env</code> trên server rồi khởi động lại API — nút{" "}
                    <b>Kéo sao kê SePay</b> sẽ hiện ra ở đây.
                  </div>
                )}
                {data.can_sync && (
                  <div style={{ marginTop: 6 }}>
                    Bấm <b>Kéo sao kê SePay</b> ở trên để lấy lại từ ngân hàng.
                  </div>
                )}
              </div>
            </div>
          )}

          {events.map((e) => {
            const t = tone(e.result);
            const hit = !!highlightTxnId && e.provider_txn_id === highlightTxnId;
            return (
              <div
                key={e.id}
                ref={hit ? hitRef : undefined}
                style={hit ? { ...row, padding: "12px 10px", borderRadius: 12, background: "rgba(13,148,136,.08)", boxShadow: "inset 0 0 0 2px rgba(13,148,136,.35)" } : row}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-3)" }}>{timeOf(e)}</span>
                  <strong style={{ fontSize: 14, fontWeight: 700, color: e.transfer_type === "out" ? "var(--ink-3)" : "var(--ink)" }}>
                    {e.transfer_type === "out" ? "−" : "+"}{formatVnd(e.amount)}
                  </strong>
                  <span style={{ ...badge, color: t.fg, background: t.bg, borderColor: t.border }}>
                    {SEPAY_RESULT_LABEL[e.result] ?? e.result}
                  </span>
                  {e.source === "userapi" && <span style={{ ...badge, color: "var(--ink-3)", background: "var(--surface-2)", borderColor: "var(--border)" }}>sao kê</span>}
                </div>
                <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 4, wordBreak: "break-word" }}>
                  {e.content || <span style={{ color: "var(--ink-3)" }}>(không có nội dung chuyển khoản)</span>}
                </div>
                {e.note && (
                  <div style={{ fontSize: 12, color: t.fg, marginTop: 3 }}>{e.note}</div>
                )}
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 3, fontFamily: "var(--font-mono)" }}>
                  {e.bank ? `${e.bank} · ` : ""}{e.provider_txn_id ?? "—"}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, fg = "var(--ink)" }: { label: string; value: string; sub: string; fg?: string }) {
  return (
    <div style={{ flex: "1 1 130px", minWidth: 0 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, letterSpacing: ".07em", textTransform: "uppercase", color: "var(--ink-3)" }}>
        {label}
      </div>
      <div style={{ fontSize: 17, fontWeight: 800, color: fg, marginTop: 3, letterSpacing: "-.02em" }}>{value}</div>
      <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 1 }}>{sub}</div>
    </div>
  );
}

const backdrop: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 16 };
// Khung CAO CỐ ĐỊNH, không co theo số dòng: ngày 30 giao dịch và ngày 2 giao dịch
// phải cho ra đúng một khung. Trước đây modal tự cao theo nội dung nên bấm sang
// ngày khác là cả hộp nhảy kích thước, nút mũi tên chạy khỏi chỗ vừa bấm
// (user 2026-08-27: "rất khó chịu"). Chỉ danh sách bên trong cuộn.
const modal: React.CSSProperties = { background: "var(--bg)", borderRadius: 22, width: 620, maxWidth: "100%", height: "min(760px, 92vh)", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 70px -18px rgba(28,26,23,0.4), 0 2px 8px rgba(28,26,23,0.08)" };
const header: React.CSSProperties = { flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "22px 24px 14px", gap: 12 };
const closeBtn: React.CSSProperties = { width: 32, height: 32, borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--ink-3)", fontSize: 15, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1, flexShrink: 0 };

const dayBar: React.CSSProperties = { flexShrink: 0, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "0 20px 12px" };
const iconBtn: React.CSSProperties = { width: 32, height: 32, borderRadius: 8, border: "1px solid var(--border-strong)", background: "var(--surface)", color: "var(--ink-2)", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" };
const datePick: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, border: "1px solid var(--border-strong)", background: "var(--surface)", borderRadius: 8, padding: "0 10px", height: 32, cursor: "pointer" };
const syncBtn: React.CSSProperties = { marginLeft: "auto", padding: "0 14px", height: 32, borderRadius: 8, border: "1px solid var(--border-strong)", background: "var(--surface)", color: "var(--ink)", fontSize: 13, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" };

const statRow: React.CSSProperties = { flexShrink: 0, display: "flex", gap: 14, flexWrap: "wrap", margin: "0 20px 14px", padding: "14px 16px", border: "1px solid var(--border)", borderRadius: 14, background: "var(--surface-2)" };
// Chiếm hết chỗ trống còn lại của khung và tự cuộn — nhờ vậy chiều cao modal do
// khung quyết định chứ không phải số dòng.
const list: React.CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", padding: "0 20px 20px" };
const row: React.CSSProperties = { padding: "12px 0", borderTop: "1px solid var(--border)" };
const badge: React.CSSProperties = { fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20, border: "1px solid", whiteSpace: "nowrap" };
const emptyBox: React.CSSProperties = { padding: "28px 12px", textAlign: "center", fontSize: 13, color: "var(--ink-3)" };
