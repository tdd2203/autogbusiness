/**
 * Modal "Chuyển hạn sử dụng đến" cho 1 member — đường DUY NHẤT để một khách đổi
 * sang email khác (nút "Đổi email" cũ đã gỡ ngày 4/9/2026: hai chức năng làm đúng
 * một việc — gỡ email cũ, chuyển hạn, mời email mới nếu chưa tham gia).
 *
 * Nghiệp vụ (user 2026-08-21): khách muốn dùng tiếp bằng email khác → nhập email
 * nhận → modal hiện PHÉP TÍNH đầy đủ (hạn email cho · phần còn lại · hạn email
 * nhận sau khi cộng) → xác nhận thì backend gỡ email cho khỏi workspace và dồn
 * hạn sang email nhận.
 *
 * LUẬT: mỗi email chỉ được chuyển hạn 1 LẦN — nói thẳng trong modal TRƯỚC khi bấm
 * gửi, và backend trả `blocked_reason` cho lần thứ 2 nên nút bị khoá kèm lý do.
 *
 * Phép tính do BACKEND trả (`useTransferPreview`) chứ KHÔNG tự tính ở web: con số
 * admin nhìn thấy chính là con số sẽ được ghi. Xem hooks/useTransferSubscription.md.
 */
import { useEffect, useMemo, useState } from "react";
import { useFormatDateTime, useT } from "../i18n";
import type { Member, TransferPreview } from "../types";
import {
  useTransferPreview,
  useTransferSubscription,
} from "../hooks/useTransferSubscription";

// Chỉ chặn nhập rõ ràng sai; backend (EmailStr) là nguồn validate cuối cùng.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Chờ admin gõ xong rồi mới gọi preview (tránh 1 request mỗi ký tự). */
const DEBOUNCE_MS = 450;

/** "18 ngày 6 giờ" / "6 giờ 12 phút" — bỏ đơn vị 0 ở đầu cho gọn. */
function useFormatDuration() {
  const t = useT();
  return (totalSeconds: number): string => {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const parts: string[] = [];
    if (days > 0) parts.push(t("transfer.unitDays", { n: days }));
    if (hours > 0) parts.push(t("transfer.unitHours", { n: hours }));
    // Chỉ hiện phút khi phần còn lại ngắn — dài rồi thì phút là nhiễu.
    if (days === 0 && minutes > 0) parts.push(t("transfer.unitMinutes", { n: minutes }));
    return parts.length > 0 ? parts.join(" ") : t("transfer.unitLessThanMinute");
  };
}

/** 1 dòng của bảng phép tính. `strong` = dòng kết quả. */
function CalcRow({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 12,
        padding: "6px 0",
      }}
    >
      <div style={{ fontSize: 12.5 }} className={strong ? undefined : "cell-muted"}>
        {label}
        {hint && (
          <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 1 }}>
            {hint}
          </div>
        )}
      </div>
      <div
        style={{
          fontSize: strong ? 14 : 13,
          fontWeight: strong ? 700 : 500,
          textAlign: "right",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function CalcPanel({ preview }: { preview: TransferPreview }) {
  const t = useT();
  const fmt = useFormatDateTime();
  const dur = useFormatDuration();
  const { source, target, mode } = preview;

  const sourceEnd = source.unlimited
    ? t("transfer.unlimited")
    : source.subscription_end_at
      ? fmt(source.subscription_end_at)
      : "—";
  const remaining = source.unlimited
    ? t("transfer.unlimited")
    : dur(source.remaining_seconds);
  const newEnd = preview.new_end_at
    ? fmt(preview.new_end_at)
    : t("transfer.unlimited");

  return (
    <div
      style={{
        background: "var(--surface-2)",
        borderRadius: 8,
        padding: "10px 12px",
      }}
    >
      <CalcRow
        label={t("transfer.rowSourceEnd", { email: source.email })}
        value={sourceEnd}
      />
      <CalcRow label={t("transfer.rowRemaining")} value={remaining} />

      {mode === "accumulate" && (
        <CalcRow
          label={t("transfer.rowTargetEnd", { email: target.email })}
          value={
            target.subscription_end_at ? fmt(target.subscription_end_at) : "—"
          }
          hint={target.expired ? t("transfer.targetExpiredHint") : undefined}
        />
      )}

      <div
        style={{
          borderTop: "1px solid var(--border)",
          margin: "6px 0 2px",
        }}
      />
      <CalcRow label={t("transfer.rowNewEnd")} value={newEnd} strong />

      <div
        className="cell-muted"
        style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.5 }}
      >
        {t("transfer.noteRemoval", { email: source.email })}
        <div style={{ marginTop: 4 }}>{t("transfer.noteInviteIfNeeded")}</div>
      </div>
    </div>
  );
}

export function TransferSubscriptionModal({
  workspaceId,
  member,
  onClose,
}: {
  workspaceId: string;
  member: Member;
  onClose: () => void;
}) {
  const t = useT();
  const [email, setEmail] = useState("");
  const [debounced, setDebounced] = useState("");
  const transfer = useTransferSubscription(workspaceId);

  const trimmed = email.trim().toLowerCase();
  const sameAsSource = trimmed === member.email.toLowerCase();
  const emailOk = EMAIL_RE.test(trimmed) && !sameAsSource;

  // Gõ xong mới hỏi backend (preview là 1 POST thật, đừng bắn mỗi ký tự).
  useEffect(() => {
    if (!emailOk) {
      setDebounced("");
      return;
    }
    const id = setTimeout(() => setDebounced(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [trimmed, emailOk]);

  const preview = useTransferPreview(
    workspaceId,
    member.id,
    debounced,
    debounced !== "",
  );

  const blocked = preview.data?.blocked_reason ?? null;
  const canSubmit = useMemo(
    () =>
      Boolean(preview.data) &&
      !blocked &&
      debounced === trimmed &&
      !transfer.isPending,
    [preview.data, blocked, debounced, trimmed, transfer.isPending],
  );

  const submit = () => {
    if (!canSubmit) return;
    transfer.mutate(
      { memberId: member.id, targetEmail: trimmed },
      { onSuccess: () => onClose() },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        className="bg-white rounded-lg shadow-xl"
        style={{ width: "100%", maxWidth: 500 }}
      >
        <div
          style={{
            padding: "16px 20px 12px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {t("transfer.title")}
          </h3>
          <div className="cell-muted" style={{ fontSize: 12.5, marginTop: 4 }}>
            {t("transfer.subtitle", { email: member.email })}
          </div>
        </div>

        <div style={{ padding: "16px 20px", display: "grid", gap: 12 }}>
          <div>
            <label
              htmlFor="transfer-target-email"
              className="cell-muted"
              style={{ fontSize: 13, display: "block", marginBottom: 4 }}
            >
              {t("transfer.targetLabel")}
            </label>
            <input
              id="transfer-target-email"
              type="email"
              className="form-input"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="nhan@example.com"
            />
            {sameAsSource && trimmed !== "" && (
              <div
                style={{ color: "var(--danger)", fontSize: 12, marginTop: 4 }}
              >
                {t("transfer.sameEmailError")}
              </div>
            )}
            {/* Luật phải đọc được TRƯỚC khi bấm gửi, không đợi backend từ chối. */}
            <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 4 }}>
              {t("transfer.onceOnlyRule")}
            </div>
          </div>

          {/* Phép tính — chỉ hiện khi đã nhập xong email nhận. */}
          {debounced === "" ? (
            <div
              className="cell-muted"
              style={{
                fontSize: 12.5,
                background: "var(--surface-2)",
                borderRadius: 8,
                padding: "12px",
              }}
            >
              {t("transfer.enterEmailHint")}
            </div>
          ) : preview.isPending ? (
            <div
              className="cell-muted"
              style={{
                fontSize: 12.5,
                background: "var(--surface-2)",
                borderRadius: 8,
                padding: "12px",
              }}
            >
              {t("transfer.calculating")}
            </div>
          ) : preview.isError ? (
            <div
              style={{
                fontSize: 12.5,
                background: "var(--surface-2)",
                borderRadius: 8,
                padding: "12px",
                color: "var(--danger)",
              }}
            >
              {preview.error instanceof Error
                ? preview.error.message
                : String(preview.error)}
            </div>
          ) : preview.data ? (
            <>
              <CalcPanel preview={preview.data} />
              {blocked && (
                <div
                  style={{
                    fontSize: 12.5,
                    color: "var(--danger)",
                    lineHeight: 1.5,
                  }}
                >
                  {blocked}
                </div>
              )}
            </>
          ) : null}
        </div>

        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            disabled={transfer.isPending}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={!canSubmit}
          >
            {transfer.isPending ? t("common.loading") : t("transfer.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
