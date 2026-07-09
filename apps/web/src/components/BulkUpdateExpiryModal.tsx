/**
 * Modal CẬP NHẬT HẠN DÙNG hàng loạt — dán bảng Excel ở tab "Email đã add".
 *
 * ⚠️ ĐỌC `BulkUpdateExpiryModal.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
 *
 * UX:
 *   1. Admin dán bảng từ Excel (cột: Ngày đặt, Ngày hết hạn, Gmail Add, Tình trạng).
 *      Parser tách theo dòng, mỗi dòng tách theo TAB (fallback khoảng trắng), tự nhận
 *      token email + các token ngày (dd/mm/yyyy [hh:mm]). Dòng tiêu đề (không email) bỏ.
 *   2. Chọn "Tính hạn theo": ngày add dự án +30 (mặc định) | ngày đặt Excel +30 |
 *      ngày hết hạn Excel (dùng trực tiếp). Ngày hết hạn Excel có thể sai nên mặc
 *      định quy chiếu theo ngày add thật trong dự án + 30 ngày (hạn dùng 30 ngày).
 *   3. Panel phải hiện DEMO từng email: hạn hiện tại → hạn mới (chốt 23:59 ngày tính
 *      được). Email không khớp member nào / thiếu ngày → mờ + bỏ qua.
 *   4. Tick xác nhận → POST /added-members/bulk-set-expiry với (member_id, end_at).
 *
 * Khớp email với danh sách `members` đã tải sẵn ở trang (xuyên workspace) — 1 email
 * có thể khớp NHIỀU member (nhiều workspace) → mỗi member 1 dòng demo. Chỉ super-admin.
 */

import { useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFormatDate, useFormatDateTime, useT } from "../i18n";
import { useIsMobile } from "../hooks/useIsMobile";
import { api, ApiError } from "../lib/api";
import { toast } from "./Toast";
import type { AddedMember } from "../types";

const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;
// dd/mm/yyyy hoặc dd-mm-yyyy, kèm giờ tuỳ chọn "hh:mm".
const DATE_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/;
const SUBSCRIPTION_DAYS = 30;

// Quy chiếu tính hạn — LUÔN dựa trên dữ liệu người dùng nhập (Excel), không lấy
// ngày đồng bộ từ ChatGPT (created_at/last_invited_at của member có thể là ngày scrape).
//   order : Ngày mua (nhập từ danh sách add) + 30 ngày.
//   expiry: Ngày hết hạn (Excel) — dùng trực tiếp.
//   manual: chỉ dán danh sách EMAIL (không ngày) → tự đặt Ngày mua / Ngày hết hạn
//           áp chung cho mọi email; hiện thêm "Chủ sở hữu" + "Hạn hiện tại" để tham
//           chiếu; vẫn sửa "Hạn mới" từng email được.
type RefMode = "order" | "expiry" | "manual";

type ParsedDate = { y: number; m: number; d: number; hh: number | null; mm: number | null };

function parseDate(token: string): ParsedDate | null {
  const match = DATE_RE.exec(token.trim());
  if (!match) return null;
  const d = Number(match[1]);
  const m = Number(match[2]);
  const y = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const hh = match[4] != null ? Number(match[4]) : null;
  const mm = match[5] != null ? Number(match[5]) : null;
  if (hh != null && (hh > 23 || (mm ?? 0) > 59)) return null;
  return { y, m, d, hh, mm };
}

/** Cộng `days` ngày vào 1 mốc, GIỮ NGUYÊN giờ:phút:giây (Model B — hạn = mốc + 30 ngày chính xác). */
function addDaysKeepTime(base: Date, days: number): Date {
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate() + days,
    base.getHours(),
    base.getMinutes(),
    base.getSeconds(),
    0,
  );
}

type PastedRow = {
  emailRaw: string;
  emailLower: string;
  order: ParsedDate | null;
  expiry: ParsedDate | null;
};

/** Tách text dán thành các dòng có email + ngày. Dòng không có email (tiêu đề) bỏ. */
function parsePasted(raw: string): { rows: PastedRow[]; noEmailLines: number } {
  const lines = raw.split(/\r?\n/);
  const rows: PastedRow[] = [];
  const seen = new Set<string>();
  let noEmailLines = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    // Tab là chuẩn khi copy từ Excel; fallback tách theo khoảng trắng/;/,
    let cells = line.split("\t");
    if (cells.length === 1) cells = line.split(/[\s;,]+/);
    const tokens = cells.map((c) => c.trim()).filter(Boolean);
    let emailRaw: string | null = null;
    const dates: ParsedDate[] = [];
    for (const tok of tokens) {
      if (!emailRaw && EMAIL_RE.test(tok)) {
        emailRaw = tok;
        continue;
      }
      const dt = parseDate(tok);
      if (dt) dates.push(dt);
    }
    if (!emailRaw) {
      noEmailLines += 1;
      continue;
    }
    const lower = emailRaw.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    rows.push({
      emailRaw,
      emailLower: lower,
      order: dates[0] ?? null,
      expiry: dates[1] ?? dates[0] ?? null,
    });
  }
  return { rows, noEmailLines };
}

type DemoRow = {
  key: string;
  emailRaw: string;
  workspaceName: string | null;
  ownerUsername: string | null;
  /** Ngày mua (Excel) — null nếu không có / chế độ không dùng ngày mua. */
  purchase: Date | null;
  /** Hạn hiện tại đang áp (subscription_end_at) — null nếu vô thời hạn / chưa đặt. */
  currentEnd: Date | null;
  /** Member khớp (null = email không có trong danh sách). */
  memberId: string | null;
  /** Hạn mới đã tính (null = không tính được → bỏ qua). */
  newEnd: Date | null;
};

function toDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Ô ngày "bấm để sửa": hiện text; click → input type=date; chọn xong chốt 23:59:59. */
function EditableDateCell({
  date,
  display,
  editable,
  disabled,
  title,
  style,
  onChange,
}: {
  date: Date | null;
  display: string;
  editable: boolean;
  disabled?: boolean;
  title?: string;
  style?: CSSProperties;
  onChange: (d: Date) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing && editable) {
    return (
      <input
        type="date"
        autoFocus
        defaultValue={date ? toDateInputValue(date) : ""}
        disabled={disabled}
        onBlur={() => setEditing(false)}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          const [y, m, d] = v.split("-").map(Number);
          onChange(new Date(y, m - 1, d, 23, 59, 59, 0));
        }}
        className="border border-slate-300 rounded px-1.5 py-1 focus:outline-none focus:border-slate-900"
        style={{ fontSize: 13 }}
      />
    );
  }
  if (!editable) return <span style={style}>{display}</span>;
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={() => setEditing(true)}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        font: "inherit",
        color: "inherit",
        cursor: disabled ? "default" : "pointer",
        textDecoration: "underline dotted",
        textUnderlineOffset: 3,
        ...style,
      }}
    >
      {display}
    </button>
  );
}

export function BulkUpdateExpiryModal({
  members,
  isSuper,
  onClose,
  onDone,
}: {
  members: AddedMember[];
  /** Super-admin → áp ngay; sub-admin → gửi yêu cầu chờ duyệt (đổi nhãn nút/toast). */
  isSuper: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const formatDateTime = useFormatDateTime();
  const isMobile = useIsMobile();
  const qc = useQueryClient();

  const [text, setText] = useState("");
  const [refMode, setRefMode] = useState<RefMode>("order");
  const [confirmed, setConfirmed] = useState(false);
  // Chế độ "manual" (chỉ email): Ngày mua (+ giờ tuỳ chọn) / Ngày hết hạn áp CHUNG.
  //   mExpiryDate="" → hết hạn TỰ TÍNH từ ngày mua + 30 (xem `manualExpiry`):
  //     - Ngày mua CÓ giờ  → + đúng 30 ngày, GIỮ NGUYÊN giờ.
  //     - Ngày mua KHÔNG giờ → (ngày mua + 30) lúc 23:59.
  //   mExpiryDate có giá trị → sửa tay, dùng trực tiếp (chốt 23:59 ngày đó).
  const [mPurchaseDate, setMPurchaseDate] = useState(""); // YYYY-MM-DD
  const [mPurchaseTime, setMPurchaseTime] = useState(""); // "" hoặc HH:mm
  const [mExpiryDate, setMExpiryDate] = useState(""); // "" = tự tính; YYYY-MM-DD = sửa tay
  // Sửa tay trực tiếp ô "Hạn mới" trong bảng (key = row.key) → giá trị sẽ ÁP.
  const [endOverrides, setEndOverrides] = useState<Record<string, Date>>({});
  // Gia hạn (key = row.key → mốc "ngày bắt đầu" chốt lúc tích, là thời điểm nhập
  // liệu). Khi có: hạn mới = ngày bắt đầu + 30 ngày (đúng tròn 30 ngày kể từ lúc đó).
  const [renewals, setRenewals] = useState<Record<string, Date>>({});
  // "Bây giờ" chốt lúc mở modal — dùng để biết dòng nào hạn-tính < hiện tại (đã hết hạn).
  const now = useMemo(() => new Date(), []);

  // Ngày mua (manual) = ngày + giờ (nếu nhập). Không nhập giờ → 00:00 (cờ "có giờ" = mPurchaseTime).
  const manualPurchase = useMemo<Date | null>(() => {
    if (!mPurchaseDate) return null;
    const [y, m, d] = mPurchaseDate.split("-").map(Number);
    if (mPurchaseTime) {
      const [hh, mm] = mPurchaseTime.split(":").map(Number);
      return new Date(y, m - 1, d, hh, mm, 0, 0);
    }
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }, [mPurchaseDate, mPurchaseTime]);

  // Ngày hết hạn (manual). Model B (2026-07-06): GIỮ GIỜ chính xác, KHÔNG chốt 23:59:59.
  //   - Nhập thẳng ngày hết hạn → dùng đúng ngày (00:00 nếu không nhập giờ).
  //   - Tính từ ngày mua → ngày mua + 30 ngày CHÍNH XÁC (giữ giờ của ngày mua).
  const manualExpiry = useMemo<Date | null>(() => {
    if (mExpiryDate) {
      const [y, m, d] = mExpiryDate.split("-").map(Number);
      return new Date(y, m - 1, d, 0, 0, 0, 0);
    }
    if (!manualPurchase) return null;
    return addDaysKeepTime(manualPurchase, SUBSCRIPTION_DAYS);
  }, [mExpiryDate, manualPurchase]);

  // email(lower) → các member khớp (1 email có thể ở nhiều workspace).
  const membersByEmail = useMemo(() => {
    const map = new Map<string, AddedMember[]>();
    for (const m of members) {
      const lower = m.email.toLowerCase();
      const arr = map.get(lower);
      if (arr) arr.push(m);
      else map.set(lower, [m]);
    }
    return map;
  }, [members]);

  const { rows: pastedRows, noEmailLines } = useMemo(
    () => parsePasted(text),
    [text],
  );

  const demoRows = useMemo<DemoRow[]>(() => {
    const out: DemoRow[] = [];
    for (const row of pastedRows) {
      // Ngày mua: chế độ "order" lấy từ cột Excel; "manual" áp chung manualPurchase.
      const purchase =
        refMode === "order" && row.order
          ? new Date(row.order.y, row.order.m - 1, row.order.d)
          : refMode === "manual"
            ? manualPurchase
            : null;
      const matches = membersByEmail.get(row.emailLower) ?? [];
      if (matches.length === 0) {
        out.push({
          key: row.emailLower,
          emailRaw: row.emailRaw,
          workspaceName: null,
          ownerUsername: null,
          purchase,
          currentEnd: null,
          memberId: null,
          newEnd: null,
        });
        continue;
      }
      for (const m of matches) {
        let newEnd: Date | null = null;
        if (refMode === "order" && row.order) {
          // Model B: hạn = ngày mua + 30 ngày CHÍNH XÁC (giữ giờ; 00:00 nếu ngày-only).
          const p = new Date(
            row.order.y,
            row.order.m - 1,
            row.order.d,
            row.order.hh ?? 0,
            row.order.mm ?? 0,
            0,
            0,
          );
          newEnd = addDaysKeepTime(p, SUBSCRIPTION_DAYS);
        } else if (refMode === "expiry" && row.expiry) {
          const e = row.expiry;
          // Dùng đúng ngày/giờ nhập (00:00 nếu không giờ) — không chốt cuối ngày.
          newEnd = new Date(e.y, e.m - 1, e.d, e.hh ?? 0, e.mm ?? 0, 0, 0);
        } else if (refMode === "manual") {
          // Chỉ email — hạn mới = Ngày hết hạn đặt chung (sửa tay từng dòng ở "Hạn mới").
          newEnd = manualExpiry;
        }
        out.push({
          key: `${row.emailLower}:${m.id}`,
          emailRaw: row.emailRaw,
          workspaceName: m.workspace_name,
          ownerUsername: m.invited_by_username,
          purchase,
          currentEnd: m.subscription_end_at
            ? new Date(m.subscription_end_at)
            : null,
          memberId: m.id,
          newEnd,
        });
      }
    }
    return out;
  }, [pastedRows, membersByEmail, refMode, manualPurchase, manualExpiry]);

  // Hạn mới hiệu lực: sửa tay "Hạn mới" (ghim) > gia hạn (start+30) > tính tự động.
  // Sửa "Ngày bắt đầu" sẽ xoá ghim → hạn mới quay về start+30 (xem onChange).
  const effectiveEnd = (r: DemoRow): Date | null => {
    if (endOverrides[r.key]) return endOverrides[r.key];
    const start = renewals[r.key];
    if (start) return addDaysKeepTime(start, SUBSCRIPTION_DAYS);
    return r.newEnd;
  };

  // Item sẽ gửi: chỉ dòng khớp member + có hạn mới (tính / sửa tay / gia hạn).
  const items = useMemo(
    () =>
      demoRows
        .filter((r) => r.memberId)
        .map((r) => ({ id: r.memberId!, end: effectiveEnd(r) }))
        .filter((x) => x.end)
        .map((x) => ({ member_id: x.id, end_at: x.end!.toISOString() })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demoRows, endOverrides, renewals],
  );

  const matchedCount = items.length;
  const unmatchedCount = demoRows.filter((r) => !r.memberId).length;
  const noDateCount = demoRows.filter(
    (r) => r.memberId && !effectiveEnd(r),
  ).length;
  // Chế độ "chỉ email" hiện thêm cột "Chủ sở hữu" + "Hạn hiện tại" để tham chiếu.
  const showCurrent = refMode === "manual";
  // Sub-admin không tự duyệt → mọi thay đổi là YÊU CẦU chờ super-admin duyệt.
  const isRequest = !isSuper;

  const mutation = useMutation({
    mutationFn: () =>
      api<{ count: number; requested?: boolean }>(
        "/api/v1/added-members/bulk-set-expiry",
        {
          method: "POST",
          body: JSON.stringify({ items }),
        },
      ),
    onSuccess: (resp) => {
      toast.success(
        resp.requested
          ? t("bulkExpiry.resultRequested", { n: resp.count })
          : t("bulkExpiry.resultOk", { n: resp.count }),
      );
      qc.invalidateQueries({ queryKey: ["added-members"] });
      // Sub-admin gửi yêu cầu → làm mới badge chuông "duyệt đổi hạn" của super-admin.
      if (resp.requested)
        qc.invalidateQueries({ queryKey: ["subscription-requests"] });
      onDone();
      onClose();
    },
    onError: (e) => {
      const msg =
        e instanceof ApiError
          ? String(e.detail)
          : e instanceof Error
            ? e.message
            : String(e);
      toast.error(msg);
    },
  });

  const canSubmit = matchedCount > 0 && confirmed && !mutation.isPending;

  // Mẫu ví dụ mờ trong ô dán — đổi theo cột THỰC SỰ dùng của từng chế độ:
  //   order  : cần "Ngày mua" (dd/mm/yyyy) → cột ngày mua + email.
  //   expiry : cần "Ngày hết hạn" → cột ngày hết hạn + email.
  const placeholder =
    refMode === "order"
      ? "Ngày mua\tGmail Add\n21/06/2026\tan.nguyen93@gmail.com\n22/06/2026\tminh.tran07@gmail.com\n23/06/2026\tthuy.le256@gmail.com"
      : refMode === "manual"
        ? "an.nguyen93@gmail.com\nminh.tran07@gmail.com\nthuy.le256@gmail.com"
        : "Ngày hết hạn\tGmail Add\n21/07/2026\tan.nguyen93@gmail.com\n22/07/2026\tminh.tran07@gmail.com\n23/07/2026\tthuy.le256@gmail.com";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-lg shadow-xl mx-4"
        style={{
          width: "96vw",
          maxWidth: 1320,
          maxHeight: "92vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "16px 20px 8px", borderBottom: "1px solid var(--border)" }}>
          <div className="text-base font-semibold text-slate-900">
            {t("bulkExpiry.modalTitle")}
          </div>
          <p className="text-xs text-slate-500 mt-1">{t("bulkExpiry.modalSubtitle")}</p>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: isMobile ? "column" : "row",
            flex: 1,
            minHeight: 0,
          }}
        >
          {/* LEFT — chọn quy chiếu + paste */}
          <div
            style={{
              width: isMobile ? "100%" : 456,
              flexShrink: 0,
              padding: "12px 16px",
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              borderBottom: isMobile ? "1px solid var(--border)" : "none",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <label className="block text-xs font-medium text-slate-700 mb-1">
              {t("bulkExpiry.refLabel")}
            </label>
            <select
              value={refMode}
              onChange={(e) => {
                setRefMode(e.target.value as RefMode);
                setConfirmed(false);
                setEndOverrides({});
                setRenewals({});
              }}
              disabled={mutation.isPending}
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm mb-1 focus:outline-none focus:border-slate-900 disabled:opacity-60"
            >
              <option value="order">{t("bulkExpiry.refOrder")}</option>
              <option value="expiry">{t("bulkExpiry.refExpiry")}</option>
              <option value="manual">{t("bulkExpiry.refManual")}</option>
            </select>
            <p style={{ marginBottom: 12, fontSize: 11, color: "var(--ink-3)" }}>
              {refMode === "manual"
                ? t("bulkExpiry.refManualHint")
                : t("bulkExpiry.refHint")}
            </p>

            {/* Chế độ "chỉ email" — Ngày mua (+ giờ tuỳ chọn) / Ngày hết hạn áp CHUNG. */}
            {refMode === "manual" && (
              <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t("bulkExpiry.manualPurchaseLabel")}
                  </label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      type="date"
                      value={mPurchaseDate}
                      disabled={mutation.isPending}
                      onChange={(e) => {
                        setMPurchaseDate(e.target.value);
                        setConfirmed(false);
                      }}
                      className="border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-slate-900 disabled:opacity-60"
                      style={{ flex: 1, minWidth: 0 }}
                    />
                    <input
                      type="time"
                      value={mPurchaseTime}
                      disabled={mutation.isPending}
                      title={t("bulkExpiry.manualTimeHint")}
                      onChange={(e) => {
                        setMPurchaseTime(e.target.value);
                        setConfirmed(false);
                      }}
                      className="border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-slate-900 disabled:opacity-60"
                      style={{ width: 118 }}
                    />
                  </div>
                  <p style={{ marginTop: 4, fontSize: 11, color: "var(--ink-3)" }}>
                    {t("bulkExpiry.manualTimeHint")}
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t("bulkExpiry.manualExpiryLabel")}
                  </label>
                  <input
                    type="date"
                    value={
                      mExpiryDate ||
                      (manualExpiry ? toDateInputValue(manualExpiry) : "")
                    }
                    disabled={mutation.isPending}
                    onChange={(e) => {
                      setMExpiryDate(e.target.value);
                      setConfirmed(false);
                    }}
                    className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-slate-900 disabled:opacity-60"
                  />
                </div>
              </div>
            )}

            <label className="block text-xs font-medium text-slate-700 mb-1">
              {refMode === "manual"
                ? t("bulkExpiry.manualPasteLabel")
                : t("bulkExpiry.pasteLabel")}
            </label>
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setConfirmed(false);
              }}
              placeholder={placeholder}
              disabled={mutation.isPending}
              spellCheck={false}
              autoFocus
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-slate-900 disabled:opacity-60"
              style={{ resize: "vertical", minHeight: 320, flex: 1 }}
            />
            <div
              style={{
                marginTop: 6,
                fontSize: 11,
                color: "var(--ink-3)",
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <span style={{ color: "var(--success, #059669)" }}>
                ✓ {t("bulkExpiry.matched", { n: matchedCount })}
              </span>
              {unmatchedCount > 0 && (
                <span style={{ color: "var(--danger, #dc2626)" }}>
                  ⚠ {t("bulkExpiry.unmatched", { n: unmatchedCount })}
                </span>
              )}
              {noDateCount > 0 && (
                <span style={{ color: "var(--warning, #d97706)" }}>
                  ⚠ {t("bulkExpiry.noDate", { n: noDateCount })}
                </span>
              )}
              {noEmailLines > 0 && (
                <span style={{ color: "var(--ink-3)" }}>
                  {t("bulkExpiry.headerSkipped", { n: noEmailLines })}
                </span>
              )}
            </div>
          </div>

          {/* RIGHT — demo thay đổi */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {demoRows.length === 0 ? (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 24,
                  fontSize: 12,
                  color: "var(--ink-3)",
                  textAlign: "center",
                }}
              >
                {t("bulkExpiry.pasteHint")}
              </div>
            ) : (
              <div style={{ flex: 1, overflow: "auto" }}>
                <table
                  style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
                >
                  <thead>
                    <tr
                      style={{
                        textAlign: "left",
                        color: "var(--ink-3)",
                        borderBottom: "1px solid var(--border)",
                        position: "sticky",
                        top: 0,
                        background: "var(--surface, #fff)",
                      }}
                    >
                      <th
                        style={{
                          padding: "10px 8px 10px 20px",
                          fontWeight: 500,
                          width: 44,
                          textAlign: "right",
                        }}
                      >
                        #
                      </th>
                      <th style={{ padding: "10px 8px", fontWeight: 500 }}>
                        {t("bulkExpiry.colEmail")}
                      </th>
                      <th style={{ padding: "10px 8px", fontWeight: 500 }}>
                        {t("bulkExpiry.colWorkspace")}
                      </th>
                      {showCurrent && (
                        <>
                          <th style={{ padding: "10px 8px", fontWeight: 500 }}>
                            {t("bulkExpiry.colOwner")}
                          </th>
                          <th style={{ padding: "10px 8px", fontWeight: 500 }}>
                            {t("bulkExpiry.colCurrent")}
                          </th>
                        </>
                      )}
                      <th style={{ padding: "10px 8px", fontWeight: 500 }}>
                        {t("bulkExpiry.colPurchase")}
                      </th>
                      <th
                        style={{
                          padding: "10px 8px",
                          fontWeight: 500,
                          textAlign: "center",
                          width: 64,
                        }}
                      >
                        {t("bulkExpiry.colRenew")}
                      </th>
                      <th style={{ padding: "10px 8px", fontWeight: 500 }}>
                        {t("bulkExpiry.colStart")}
                      </th>
                      <th style={{ padding: "10px 20px 10px 8px", fontWeight: 500 }}>
                        {t("bulkExpiry.colNew")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {demoRows.map((r, idx) => {
                      const renewStart = renewals[r.key];
                      const override = endOverrides[r.key] ?? null;
                      const base = r.newEnd; // ngày mua + 30 (chưa override/gia hạn)
                      const effNew =
                        override ??
                        (renewStart
                          ? addDaysKeepTime(renewStart, SUBSCRIPTION_DAYS)
                          : base);
                      // Gia hạn hiện khi hạn-tính-được (ngày mua + 30) đã quá hạn.
                      const baseExpired =
                        !!base && base.getTime() < now.getTime();
                      const showRenew = !!r.memberId && (baseExpired || !!renewStart);
                      // Gạch ngang khi HẠN MỚI đang hiển thị là ngày quá khứ.
                      const effExpired =
                        !!effNew && effNew.getTime() < now.getTime();
                      const skipped = !r.memberId || !effNew;
                      return (
                        <tr
                          key={r.key}
                          style={{
                            borderBottom: "1px solid var(--border)",
                            color: skipped ? "var(--ink-3)" : "var(--ink, #0f172a)",
                            opacity: skipped ? 0.6 : 1,
                          }}
                        >
                          <td
                            style={{
                              padding: "8px 8px 8px 20px",
                              textAlign: "right",
                              color: "var(--ink-3)",
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {idx + 1}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              fontFamily: "var(--font-mono)",
                              maxWidth: 280,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={r.emailRaw}
                          >
                            {r.emailRaw}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              maxWidth: 160,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={r.workspaceName ?? ""}
                          >
                            {r.memberId
                              ? r.workspaceName ?? "—"
                              : t("bulkExpiry.notFound")}
                          </td>
                          {/* Chủ sở hữu (người gia hạn) + Hạn hiện tại — chỉ chế độ "chỉ email". */}
                          {showCurrent && (
                            <>
                              <td
                                style={{
                                  padding: "8px",
                                  maxWidth: 140,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                                title={r.ownerUsername ?? ""}
                              >
                                {r.memberId ? (
                                  r.ownerUsername ?? (
                                    <span
                                      style={{ color: "var(--ink-3)", opacity: 0.5 }}
                                    >
                                      —
                                    </span>
                                  )
                                ) : (
                                  ""
                                )}
                              </td>
                              <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                                {r.currentEnd ? (
                                  formatDate(r.currentEnd)
                                ) : (
                                  <span
                                    style={{ color: "var(--ink-3)", opacity: 0.5 }}
                                  >
                                    {r.memberId ? t("bulkExpiry.unlimited") : ""}
                                  </span>
                                )}
                              </td>
                            </>
                          )}
                          {/* Ngày mua (Excel/manual) — thay cho "hạn hiện tại". */}
                          <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                            {r.purchase ? (
                              refMode === "manual" && mPurchaseTime ? (
                                formatDateTime(r.purchase)
                              ) : (
                                formatDate(r.purchase)
                              )
                            ) : (
                              <span style={{ color: "var(--ink-3)", opacity: 0.5 }}>
                                —
                              </span>
                            )}
                          </td>
                          {/* Gia hạn — chỉ hợp lệ khi hạn tính được đã hết; ngược lại làm mờ. */}
                          <td style={{ padding: "8px", textAlign: "center" }}>
                            {showRenew ? (
                              <input
                                type="checkbox"
                                checked={!!renewStart}
                                disabled={mutation.isPending}
                                title={t("bulkExpiry.renewHint")}
                                onChange={(e) => {
                                  const on = e.target.checked;
                                  setRenewals((o) => {
                                    const next = { ...o };
                                    if (on) next[r.key] = new Date();
                                    else delete next[r.key];
                                    return next;
                                  });
                                  setConfirmed(false);
                                }}
                              />
                            ) : (
                              <span style={{ color: "var(--ink-3)", opacity: 0.5 }}>
                                —
                              </span>
                            )}
                          </td>
                          {/* Ngày bắt đầu — mốc lúc tích gia hạn; sửa được → hạn mới = +30. */}
                          <td
                            style={{
                              padding: "8px",
                              whiteSpace: "nowrap",
                              color: "var(--ink-2, #475569)",
                            }}
                          >
                            {renewStart ? (
                              <EditableDateCell
                                date={renewStart}
                                display={formatDateTime(renewStart)}
                                editable
                                disabled={mutation.isPending}
                                title={t("bulkExpiry.editHint")}
                                onChange={(d) => {
                                  setRenewals((o) => ({ ...o, [r.key]: d }));
                                  // Đổi ngày bắt đầu → bỏ ghim hạn mới để theo start+30.
                                  setEndOverrides((o) => {
                                    const n = { ...o };
                                    delete n[r.key];
                                    return n;
                                  });
                                  setConfirmed(false);
                                }}
                              />
                            ) : (
                              <span style={{ color: "var(--ink-3)", opacity: 0.5 }}>
                                —
                              </span>
                            )}
                          </td>
                          <td
                            style={{
                              padding: "8px 20px 8px 8px",
                              whiteSpace: "nowrap",
                              fontWeight: skipped ? 400 : 600,
                              // Hạn mới đang là ngày quá khứ → đỏ + gạch ngang.
                              color: skipped
                                ? "var(--ink-3)"
                                : effExpired
                                  ? "var(--danger, #dc2626)"
                                  : "var(--success, #059669)",
                            }}
                          >
                            {r.memberId ? (
                              <EditableDateCell
                                date={effNew}
                                display={
                                  effNew
                                    ? formatDateTime(effNew)
                                    : t("bulkExpiry.noDateCell")
                                }
                                editable
                                disabled={mutation.isPending}
                                title={t("bulkExpiry.editHint")}
                                style={
                                  effExpired
                                    ? { textDecoration: "line-through" }
                                    : undefined
                                }
                                onChange={(d) => {
                                  setEndOverrides((o) => ({ ...o, [r.key]: d }));
                                  setConfirmed(false);
                                }}
                              />
                            ) : (
                              ""
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
          }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              color: "var(--ink-2, #475569)",
              cursor: matchedCount > 0 ? "pointer" : "default",
            }}
          >
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={matchedCount === 0 || mutation.isPending}
            />
            {isRequest
              ? t("bulkExpiry.confirmCheckboxRequest", { n: matchedCount })
              : t("bulkExpiry.confirmCheckbox", { n: matchedCount })}
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onClose}
              disabled={mutation.isPending}
              className="px-3 py-1.5 rounded text-sm border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={() => mutation.mutate()}
              disabled={!canSubmit}
              className="px-3 py-1.5 rounded text-sm bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-60"
            >
              {mutation.isPending
                ? isRequest
                  ? t("bulkExpiry.submitRequestBusy")
                  : t("bulkExpiry.submitBusy")
                : isRequest
                  ? t("bulkExpiry.submitRequest", { n: matchedCount })
                  : t("bulkExpiry.submit", { n: matchedCount })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
