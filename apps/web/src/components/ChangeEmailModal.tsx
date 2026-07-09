/**
 * Modal "Đổi email" cho 1 member.
 *
 * Nghiệp vụ: khách đổi email → xoá email cũ + mời email mới, GIỮ NGUYÊN hạn dùng
 * cũ (backend tự copy subscription_end_at, không cấp hạn mới). Modal chỉ nhập
 * email mới + xác nhận; gọi useChangeEmail. Xem hooks/useChangeEmail.md.
 */
import { useState } from "react";
import { useFormatDate, useT } from "../i18n";
import type { Member } from "../types";
import { useChangeEmail } from "../hooks/useChangeEmail";

// Đồng bộ với regex cơ bản phía web khác — chỉ chặn nhập rõ ràng sai; backend
// (EmailStr) là nguồn validate cuối cùng.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ChangeEmailModal({
  workspaceId,
  member,
  onClose,
}: {
  workspaceId: string;
  member: Member;
  onClose: () => void;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const [newEmail, setNewEmail] = useState("");
  const changeEmail = useChangeEmail(workspaceId);

  const trimmed = newEmail.trim().toLowerCase();
  const sameAsOld = trimmed === member.email.toLowerCase();
  const valid = EMAIL_RE.test(trimmed) && !sameAsOld;

  const submit = () => {
    if (!valid || changeEmail.isPending) return;
    changeEmail.mutate(
      { memberId: member.id, newEmail: trimmed },
      { onSuccess: () => onClose() },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        className="bg-white rounded-lg shadow-xl"
        style={{ width: "100%", maxWidth: 460 }}
      >
        <div
          style={{
            padding: "16px 20px 12px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {t("member.changeEmailTitle")}
          </h3>
        </div>

        <div style={{ padding: "16px 20px", display: "grid", gap: 12 }}>
          <div style={{ fontSize: 13 }}>
            <div className="cell-muted" style={{ marginBottom: 2 }}>
              {t("member.changeEmailOldLabel")}
            </div>
            <div style={{ fontWeight: 500 }}>{member.email}</div>
          </div>

          <div>
            <label
              htmlFor="change-email-new"
              className="cell-muted"
              style={{ fontSize: 13, display: "block", marginBottom: 4 }}
            >
              {t("member.changeEmailNewLabel")}
            </label>
            <input
              id="change-email-new"
              type="email"
              className="form-input"
              autoFocus
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="new@example.com"
            />
            {sameAsOld && trimmed !== "" && (
              <div
                style={{ color: "var(--danger)", fontSize: 12, marginTop: 4 }}
              >
                {t("member.changeEmailSameError")}
              </div>
            )}
          </div>

          {/* Hạn dùng GIỮ NGUYÊN — nói rõ cho admin biết không cấp hạn mới. */}
          <div
            style={{
              fontSize: 12.5,
              background: "var(--surface-2)",
              borderRadius: 6,
              padding: "10px 12px",
              color: "var(--ink-2)",
            }}
          >
            {member.subscription_end_at
              ? t("member.changeEmailKeepExpiry", {
                  date: formatDate(member.subscription_end_at),
                })
              : t("member.changeEmailKeepUnlimited")}
          </div>
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
            disabled={changeEmail.isPending}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={!valid || changeEmail.isPending}
          >
            {changeEmail.isPending
              ? t("common.loading")
              : t("member.changeEmailConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
