/**
 * Modal mời thành viên — paste-driven.
 *
 * UX:
 *   1. Admin paste 1 danh sách email vào textarea (1/dòng hoặc cách nhau comma).
 *   2. Mỗi email hợp lệ tự xuất hiện 1 row trong bảng bên dưới với input "Số tháng"
 *      (default 1, có +/-) và preview "Hết hạn DD/MM/YYYY".
 *   3. Admin có thể chỉnh `months` per-email, hoặc click "Áp cho tất cả: 1th/3th/...".
 *   4. Submit → POST bulk-invite với `invites: [{email, subscription_months}]`.
 *
 * Subscription tracking dashboard-only: khi tới `subscription_end_at` (= now +
 * months × 30 ngày), background scheduler enqueue REMOVE_MEMBER + cảnh báo
 * trên Members page.
 *
 * State model:
 *   - emailsText: string — textarea source of truth cho TẬP email
 *   - monthsByEmail: Map<lowercase_email, months> — overrides per email
 *   - entries (derived): parse emailsText + map months → list để render table
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useFormatDate, useT } from "../i18n";
import { useIsMobile } from "../hooks/useIsMobile";
import { useAuth } from "../hooks/useAuth";
import { useWallet } from "../hooks/useWallet";
import { useBulkInvite } from "../hooks/useBulkInvite";
import { api } from "../lib/api";
import type { Member } from "../types";
import OrderQrModal from "./OrderQrModal";
import { formatVnd, type OrderQr } from "../lib/wallet";
import { parseEmailsFromText } from "../lib/emailParser";

const DEFAULT_MONTHS = 1;
const MIN_MONTHS = 1;
const MAX_MONTHS = 60;
const QUICK_MONTHS = [1, 3, 6, 12] as const;
const DAYS_PER_MONTH = 30;

function clampMonths(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MONTHS;
  return Math.max(MIN_MONTHS, Math.min(MAX_MONTHS, Math.floor(n)));
}

export function InviteMemberModal({
  workspaceId,
  onClose,
  onDone,
}: {
  workspaceId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const isMobile = useIsMobile();
  // Grid cột bảng email: desktop rộng rãi, mobile co lại để không tràn.
  const rowCols = isMobile ? "minmax(0,1fr) 112px 66px 22px" : "1fr 200px 130px 28px";
  const formatExpiresDate = (months: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + months * DAYS_PER_MONTH);
    return formatDate(d, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  };
  const [emailsText, setEmailsText] = useState("");
  // Per-email months override (default applies when not set).
  const [monthsByEmail, setMonthsByEmail] = useState<Record<string, number>>({});

  const { validUnique, validRaw, invalid, duplicates } = useMemo(
    () => parseEmailsFromText(emailsText),
    [emailsText],
  );

  // Derive entries: each valid email + months (override or default).
  const entries = useMemo(
    () =>
      validUnique.map((email, idx) => ({
        email,
        emailRaw: validRaw[idx] ?? email,
        months: monthsByEmail[email] ?? DEFAULT_MONTHS,
      })),
    [validUnique, validRaw, monthsByEmail],
  );

  // ── Phí mời (feature 003) — tổng tiền SẼ trừ khi mời ──────────────────────
  // Phí mời = ĐƠN GIÁ/THÁNG × số tháng, cộng dồn mọi email (user 2026-07-13: "phí
  // × số tháng"). Chỉ user bật Ví & không phải super-admin mới bị tính
  // (is_chargeable_user BE). `wallet.invite_fee_vnd` = đơn giá/tháng hiệu lực cho
  // email mới (member chưa tồn tại nên chưa có override riêng).
  const { user } = useAuth();
  const chargeable = !!user?.wallet_beta && !user?.is_super_admin;
  const { data: wallet } = useWallet();
  const feePerMonth = wallet?.invite_fee_vnd ?? 0;

  // Nhận diện email đã có trong workspace để phân loại từng dòng: MỜI MỚI vs GIA HẠN
  // (email đang active — paste lại = mua thêm tháng, cộng dồn hạn) vs MỜI LẠI miễn phí
  // (removed còn hạn). PHẢI `include_removed=true` (list mặc định lọc bỏ removed —
  // stats.py) để bắt cả email removed còn hạn. Fetch cho MỌI user (không chỉ chargeable):
  // super-admin cũng cần thấy nhãn "Gia hạn" + hạn cộng dồn dù không tính phí. Dùng key
  // RIÊNG để không đè cache list của trang Members. Xem [[reinvite-still-valid-is-free]].
  const { data: members = [] } = useQuery({
    queryKey: ["members", workspaceId, "with-removed"],
    queryFn: () =>
      api<Member[]>(
        `/api/v1/workspaces/${workspaceId}/members?include_removed=true`,
      ),
  });
  const membersByEmail = useMemo(() => {
    const map = new Map<string, Member>();
    for (const m of members) map.set(m.email.toLowerCase(), m);
    return map;
  }, [members]);
  const nowMs = Date.now();

  // Preview phí THẬT từ backend (mirror plan_invite_fees) — bắt được ca MIỄN PHÍ mà FE
  // không tự suy được: CHUYỂN workspace / HỢP NHẤT (gói còn hạn nằm ở workspace KHÁC,
  // không có trong `members` của ws này). Trả `free_emails` → OR vào isFreeEmail để
  // totalFee/badge tự đúng. Chỉ fetch khi user bị tính phí + có email. Xem
  // [[cross-workspace-move-keeps-paid]].
  const previewKey = entries.map((e) => `${e.email}:${e.months}`).join(",");
  const { data: feePreview } = useQuery({
    queryKey: ["invite-fee-preview", workspaceId, previewKey],
    queryFn: () =>
      api<{ total_fee: number; free_emails: string[] }>(
        `/api/v1/workspaces/${workspaceId}/members/invite-preview`,
        {
          method: "POST",
          body: JSON.stringify({
            role: "member",
            invites: entries.map((e) => ({
              email: e.email,
              subscription_months: e.months,
            })),
          }),
        },
      ),
    enabled: chargeable && entries.length > 0,
  });
  const previewFreeSet = useMemo(
    () => new Set((feePreview?.free_emails ?? []).map((e) => e.toLowerCase())),
    [feePreview],
  );

  // Email đang ACTIVE → paste lại = GIA HẠN (cộng dồn + mua thêm N tháng, CÓ phí).
  const isRenewEmail = (email: string) =>
    membersByEmail.get(email.toLowerCase())?.status === "active";
  // Email MIỄN PHÍ: (1) backend preview xác nhận (chuyển ws / hợp nhất / còn hạn cross-
  // ws), HOẶC (2) removed + còn hạn NGAY trong ws này (đủ suy ở FE, dùng khi preview
  // chưa tải). BE là nguồn chân lý; membersByEmail chỉ là fallback lạc quan.
  const isFreeEmail = (email: string) => {
    if (previewFreeSet.has(email.toLowerCase())) return true;
    const m = membersByEmail.get(email.toLowerCase());
    return (
      m?.status === "removed" &&
      !!m.subscription_end_at &&
      new Date(m.subscription_end_at).getTime() > nowMs
    );
  };
  // Hạn sau khi GIA HẠN = cộng dồn N×30 ngày vào hạn hiện tại (hết hạn/vô hạn → từ nay).
  const formatRenewExpiry = (email: string, months: number) => {
    const m = membersByEmail.get(email.toLowerCase());
    const end = m?.subscription_end_at ? new Date(m.subscription_end_at) : null;
    const base = end && end.getTime() > nowMs ? end : new Date();
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + months * DAYS_PER_MONTH);
    return formatDate(d, { day: "numeric", month: "short", year: "numeric" });
  };

  // Phí tính trên email MỜI MỚI + GIA HẠN (mirror plan_invite_fees BE): removed còn hạn
  // (free) bị loại; active = phí gia hạn = đơn giá × số tháng như mời mới.
  const chargeableEntries = entries.filter((e) => !isFreeEmail(e.email));
  const freeCount = entries.length - chargeableEntries.length;
  const renewCount = entries.filter((e) => isRenewEmail(e.email)).length;
  const totalMonths = chargeableEntries.reduce((sum, e) => sum + e.months, 0);
  const showFee = chargeable && feePerMonth > 0 && chargeableEntries.length > 0;
  // Tổng phí: ưu tiên số THẬT từ backend preview (đã tính đúng miễn phí + phí override
  // riêng); fallback ước tính client (đơn giá × tháng) khi preview chưa tải.
  const totalFee = feePreview?.total_fee ?? feePerMonth * totalMonths;
  const balance = wallet?.balance ?? 0;
  const insufficient = showFee && balance < totalFee;

  // Modal cố định: chỉ đóng qua nút Huỷ hoặc submit success.
  // Why: paste nhiều email + chỉnh months tốn công, lỡ click backdrop / Esc
  // sẽ mất hết → không có shortcut nào dismiss modal.

  // Ví không đủ → BE trả hoá đơn QR (feature 003); mở modal QR thay vì báo lỗi.
  const [qrOrder, setQrOrder] = useState<OrderQr | null>(null);

  const bulkInvite = useBulkInvite(workspaceId, {
    entries,
    onSuccess: () => {
      onDone();
      onClose();
    },
    onPaymentRequired: (order) => setQrOrder(order),
  });

  function handleSubmit() {
    if (entries.length === 0) return;
    bulkInvite.mutate();
  }

  function setMonthsFor(email: string, months: number) {
    setMonthsByEmail((m) => ({ ...m, [email]: clampMonths(months) }));
  }

  function applyMonthsToAll(months: number) {
    setMonthsByEmail((prev) => {
      const next = { ...prev };
      for (const email of validUnique) next[email] = clampMonths(months);
      return next;
    });
  }

  /**
   * Remove 1 email khỏi danh sách: xoá đúng dòng tương ứng trong textarea
   * (giữ nguyên các dòng khác + comment/invalid).
   */
  function removeEntry(emailLower: string) {
    setEmailsText((text) => {
      const lines = text.split(/\r?\n/);
      const kept: string[] = [];
      for (const line of lines) {
        // 1 dòng có thể chứa nhiều email (comma) — filter tokens trong dòng.
        const tokens = line.split(/[,;]/).map((s) => s.trim());
        const keptTokens = tokens.filter(
          (tok) => tok.toLowerCase() !== emailLower,
        );
        if (keptTokens.length === tokens.length) {
          // Không có email này trong dòng → giữ nguyên
          kept.push(line);
        } else if (keptTokens.length > 0) {
          // Một số token bị xoá → reconstruct dòng
          kept.push(keptTokens.join(", "));
        }
        // else: cả dòng chỉ có email này → drop
      }
      return kept.join("\n");
    });
    setMonthsByEmail((m) => {
      const next = { ...m };
      delete next[emailLower];
      return next;
    });
  }

  return (
    <>
    {qrOrder && (
      <OrderQrModal
        order={qrOrder}
        onClose={() => setQrOrder(null)}
        onPaid={() => {
          onDone();
          onClose();
        }}
      />
    )}
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      style={{ padding: 24 }}
      role="dialog"
      aria-modal="true"
    >
      <div
        style={{
          width: "min(1040px, 100%)",
          maxHeight: "90vh",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 20,
          boxShadow:
            "0 40px 90px -30px rgba(0,0,0,.45), 0 12px 30px -14px rgba(0,0,0,.3)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header: tiêu đề + mô tả + nút đóng vuông. */}
        <div
          style={{
            padding: "18px 22px",
            display: "flex",
            alignItems: "flex-start",
            gap: 14,
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ink)" }}>
              {t("invite.modalTitle")}
            </div>
            <div
              style={{
                fontSize: 12.5,
                color: "var(--ink-3)",
                marginTop: 4,
                lineHeight: 1.5,
              }}
            >
              {t("invite.modalSubtitlePasteV3")}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={bulkInvite.isPending}
            aria-label={t("common.cancel")}
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--ink-3)",
              fontSize: 14,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>

        {/* Body: 2 cột — paste trái cố định, bảng phải scroll riêng để scale theo
            số lượng email (vài chục → vài trăm vẫn nhìn được paste area). */}
        <div
          style={{
            display: "flex",
            flexDirection: isMobile ? "column" : "row",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          {/* LEFT — paste textarea + counters + apply-to-all + invalid */}
          <div
            style={{
              width: isMobile ? "100%" : 360,
              flexShrink: 0,
              minHeight: 0,
              padding: "20px 20px",
              background: "var(--bg)",
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              borderBottom: isMobile ? "1px solid var(--border)" : "none",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <label
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                color: "var(--ink-3)",
                marginBottom: 8,
              }}
            >
              {t("invite.pasteLabelShort")}
            </label>
            <textarea
              value={emailsText}
              onChange={(e) => setEmailsText(e.target.value)}
              placeholder={"user1@domain.com\nuser2@domain.com, user3@domain.com\n..."}
              disabled={bulkInvite.isPending}
              spellCheck={false}
              autoFocus
              className="form-input"
              style={{
                resize: "vertical",
                minHeight: 220,
                flex: 1,
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                lineHeight: 1.6,
              }}
            />
            <div
              style={{
                marginTop: 10,
                fontSize: 11.5,
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <span
                style={{
                  color: entries.length > 0 ? "var(--success)" : "var(--ink-3)",
                  fontWeight: 600,
                }}
              >
                ✓ {t("invite.parsed", { n: entries.length })}
              </span>
              {renewCount > 0 && (
                <span style={{ color: "var(--accent, var(--ink-2))", fontWeight: 600 }}>
                  ↻ {t("invite.renewCount", { n: renewCount })}
                </span>
              )}
              {invalid.length > 0 && (
                <span style={{ color: "var(--danger)" }}>
                  ⚠ {t("invite.invalidFormat", { n: invalid.length })}
                </span>
              )}
              {duplicates.length > 0 && (
                <span style={{ color: "var(--warning)" }}>
                  ⚠ {t("invite.duplicateSkipped", { n: duplicates.length })}
                </span>
              )}
            </div>

            {entries.length > 0 && (
              <div
                style={{
                  marginTop: 12,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "8px 10px",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  fontSize: 11.5,
                  color: "var(--ink-3)",
                  flexWrap: "wrap",
                }}
              >
                <span>{t("invite.applyToAll")}:</span>
                {QUICK_MONTHS.map((m) => (
                  <button
                    key={m}
                    onClick={() => applyMonthsToAll(m)}
                    disabled={bulkInvite.isPending}
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11.5,
                      padding: "2px 9px",
                      borderRadius: 7,
                      border: "1px solid var(--border)",
                      background: "var(--bg)",
                      color: "var(--ink-2)",
                      cursor: "pointer",
                    }}
                  >
                    {m}
                    {t("invite.monthsShort")}
                  </button>
                ))}
              </div>
            )}

            {/* Email đã ở trong workspace (active) → GIA HẠN thay vì mời mới: hiện cho
                MỌI user để không ai tưởng đang mời trùng. Phí (nếu có) đã gộp vào tổng. */}
            {renewCount > 0 && (
              <div
                style={{
                  marginTop: 12,
                  padding: "10px 12px",
                  background: "var(--surface)",
                  border: "1px solid var(--accent-border, var(--border))",
                  borderRadius: 10,
                  fontSize: 11.5,
                  color: "var(--accent, var(--ink-2))",
                }}
              >
                {t("invite.renewNote", { n: renewCount })}
              </div>
            )}

            {/* Email còn hạn được mời lại miễn phí — trấn an chủ sở hữu là KHÔNG mất phí,
                kể cả khi tất cả email đều miễn phí (lúc đó bảng phí bên dưới ẩn hẳn). */}
            {chargeable && freeCount > 0 && (
              <div
                style={{
                  marginTop: 12,
                  padding: "10px 12px",
                  background: "var(--surface)",
                  border: "1px solid var(--success-border, var(--border))",
                  borderRadius: 10,
                  fontSize: 11.5,
                  color: "var(--success, var(--ink-2))",
                }}
              >
                {t("invite.feeFreeNote", { n: freeCount })}
              </div>
            )}

            {/* Tổng phí mời SẼ trừ khỏi Ví (phí cố định/email, không theo tháng). */}
            {showFee && (
              <div
                style={{
                  marginTop: 12,
                  padding: "10px 12px",
                  background: "var(--surface)",
                  border: `1px solid ${insufficient ? "var(--danger-border, var(--border))" : "var(--border)"}`,
                  borderRadius: 10,
                  display: "grid",
                  gap: 4,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    gap: 8,
                  }}
                >
                  <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                    {t("invite.feeTotalLabel")}
                  </span>
                  <span
                    style={{
                      fontSize: 15,
                      fontWeight: 700,
                      fontFamily: "var(--font-mono)",
                      color: "var(--ink)",
                    }}
                  >
                    {formatVnd(totalFee)}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  {t("invite.feeBreakdown", {
                    fee: formatVnd(feePerMonth),
                    months: totalMonths,
                    n: chargeableEntries.length,
                  })}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: insufficient ? "var(--danger)" : "var(--ink-3)",
                  }}
                >
                  {insufficient
                    ? t("invite.feeBalanceInsufficient", {
                        balance: formatVnd(balance),
                      })
                    : t("invite.feeBalance", { balance: formatVnd(balance) })}
                </div>
              </div>
            )}

            {invalid.length > 0 && (
              <details style={{ marginTop: 12, fontSize: 11.5 }}>
                <summary style={{ cursor: "pointer", color: "var(--danger)" }}>
                  {t("invite.invalidShowList")}
                </summary>
                <ul
                  style={{
                    marginTop: 6,
                    paddingLeft: 16,
                    fontFamily: "var(--font-mono)",
                    color: "var(--danger)",
                  }}
                >
                  {invalid.slice(0, 20).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                  {invalid.length > 20 && <li>... +{invalid.length - 20}</li>}
                </ul>
              </details>
            )}
          </div>

          {/* RIGHT — parsed entries table, scroll riêng */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {entries.length === 0 ? (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 40,
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 600,
                    color: "var(--ink-2)",
                  }}
                >
                  {t("invite.emptyTitle")}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--ink-3)",
                    marginTop: 6,
                    maxWidth: 300,
                    lineHeight: 1.5,
                  }}
                >
                  {t("invite.emptyDesc")}
                </div>
              </div>
            ) : (
              <>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: rowCols,
                    columnGap: 8,
                    fontFamily: "var(--font-mono)",
                    fontSize: 10.5,
                    color: "var(--ink-3)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    padding: "12px 22px 10px",
                    borderBottom: "1px solid var(--border)",
                    background: "var(--bg)",
                  }}
                >
                  <div>{t("invite.colEmail")}</div>
                  <div>{t("invite.colMonths")}</div>
                  <div>{t("invite.colExpires")}</div>
                  <div></div>
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: "0 22px" }}>
                  {entries.map((row) => (
                    <div
                      key={row.email}
                      style={{
                        display: "grid",
                        gridTemplateColumns: rowCols,
                        columnGap: 8,
                        alignItems: "center",
                        padding: "8px 0",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          minWidth: 0,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: 12.5,
                            color: "var(--ink)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            flex: "0 1 auto",
                          }}
                          title={row.emailRaw}
                        >
                          {row.emailRaw}
                        </span>
                        {isRenewEmail(row.email) ? (
                          <span
                            style={{
                              flexShrink: 0,
                              fontSize: 9.5,
                              fontWeight: 700,
                              letterSpacing: "0.04em",
                              textTransform: "uppercase",
                              padding: "1px 6px",
                              borderRadius: 6,
                              color: "var(--accent, var(--ink-2))",
                              background: "var(--accent-soft, var(--bg))",
                              border: "1px solid var(--accent-border, var(--border))",
                            }}
                            title={t("invite.renewTooltip", { months: row.months })}
                          >
                            {t("invite.tagRenew")}
                          </span>
                        ) : isFreeEmail(row.email) ? (
                          <span
                            style={{
                              flexShrink: 0,
                              fontSize: 9.5,
                              fontWeight: 700,
                              letterSpacing: "0.04em",
                              textTransform: "uppercase",
                              padding: "1px 6px",
                              borderRadius: 6,
                              color: "var(--success, var(--ink-2))",
                              background: "var(--bg)",
                              border: "1px solid var(--success-border, var(--border))",
                            }}
                          >
                            {t("invite.tagReinvite")}
                          </span>
                        ) : null}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <button
                          onClick={() => setMonthsFor(row.email, row.months - 1)}
                          disabled={bulkInvite.isPending || row.months <= MIN_MONTHS}
                          title={t("invite.monthsDecrement")}
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: 7,
                            border: "1px solid var(--border)",
                            background: "var(--surface)",
                            color: "var(--ink-2)",
                            cursor: "pointer",
                            fontSize: 14,
                            lineHeight: 1,
                          }}
                        >
                          −
                        </button>
                        <input
                          type="number"
                          value={row.months}
                          onChange={(e) => setMonthsFor(row.email, Number(e.target.value))}
                          min={MIN_MONTHS}
                          max={MAX_MONTHS}
                          disabled={bulkInvite.isPending}
                          className="form-input"
                          style={{
                            width: isMobile ? 44 : 56,
                            textAlign: "center",
                            fontFamily: "var(--font-mono)",
                            padding: "4px 6px",
                          }}
                        />
                        <button
                          onClick={() => setMonthsFor(row.email, row.months + 1)}
                          disabled={bulkInvite.isPending || row.months >= MAX_MONTHS}
                          title={t("invite.monthsIncrement")}
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: 7,
                            border: "1px solid var(--border)",
                            background: "var(--surface)",
                            color: "var(--ink-2)",
                            cursor: "pointer",
                            fontSize: 14,
                            lineHeight: 1,
                          }}
                        >
                          +
                        </button>
                        {!isMobile && (
                          <span style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                            {t("invite.monthsUnit")}
                          </span>
                        )}
                      </div>
                      {isRenewEmail(row.email) ? (
                        // GIA HẠN: cộng dồn N×30 ngày vào hạn hiện tại (mua thêm tháng).
                        // Hiện hạn MỚI sau gia hạn (không phải now+months) để đúng cộng dồn.
                        <div
                          style={{
                            fontSize: 11.5,
                            color: "var(--accent, var(--ink-2))",
                            fontFamily: "var(--font-mono)",
                          }}
                          title={t("invite.renewTooltip", { months: row.months })}
                        >
                          ↻ {formatRenewExpiry(row.email, row.months)}
                        </div>
                      ) : chargeable && isFreeEmail(row.email) ? (
                        // Còn hạn → mời lại miễn phí: BE giữ nguyên cửa sổ hạn cũ, BỎ QUA
                        // số tháng nhập ở đây → không hiện ngày hết hạn suy từ months (gây
                        // hiểu lầm là reset hạn), chỉ báo "miễn phí".
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: "var(--success, var(--ink-2))",
                          }}
                          title={t("invite.feeFreeReinviteTip")}
                        >
                          {t("invite.feeFreeReinvite")}
                        </div>
                      ) : (
                        <div
                          style={{
                            fontSize: 11.5,
                            color: "var(--ink-2)",
                            fontFamily: "var(--font-mono)",
                          }}
                          title={t("invite.expiresTooltip", {
                            months: row.months,
                            days: row.months * DAYS_PER_MONTH,
                          })}
                        >
                          {formatExpiresDate(row.months)}
                        </div>
                      )}
                      <button
                        onClick={() => removeEntry(row.email)}
                        disabled={bulkInvite.isPending}
                        title={t("invite.removeRow")}
                        style={{
                          fontSize: 16,
                          lineHeight: 1,
                          background: "none",
                          border: "none",
                          color: "var(--ink-3)",
                          cursor: "pointer",
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div
          style={{
            padding: "14px 22px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexShrink: 0,
            gap: 12,
          }}
        >
          <div style={{ fontSize: 12.5, color: "var(--ink-3)", minWidth: 0 }}>
            {entries.length > 0 ? (
              <>
                {t("invite.parsed", { n: entries.length })}
                {showFee && (
                  <>
                    {" · "}
                    <span
                      style={{
                        fontWeight: 600,
                        color: insufficient ? "var(--danger)" : "var(--ink)",
                      }}
                    >
                      {t("invite.feeTotalInline", { total: formatVnd(totalFee) })}
                    </span>
                  </>
                )}
              </>
            ) : (
              t("invite.pasteHint")
            )}
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button
              onClick={onClose}
              disabled={bulkInvite.isPending}
              className="btn btn-ghost btn-sm"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={handleSubmit}
              disabled={bulkInvite.isPending || entries.length === 0}
              className="btn btn-primary btn-sm"
            >
              {bulkInvite.isPending
                ? t("invite.submitBusyShort")
                : renewCount > 0
                  ? t("invite.submitMixed", { n: entries.length })
                  : t("invite.submit", { n: entries.length })}
            </button>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
