import type { AddedMember } from "../types";
import { useIsMobile } from "../hooks/useIsMobile";
import { useFormatDateTime, useT } from "../i18n";

/** Giờ:phút:giây cho các cột ngày — khớp bảng chính của trang Email đã thêm. */
const PRECISE_TIME: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};

/** Mã lý do (backend models.REMOVED_REASON_*) → class badge. Mã lạ/thiếu rơi về
 *  "Không rõ" (dữ liệu cũ: email bị xoá trước khi có cột removed_reason). */
const REASON_BADGE: Record<string, string> = {
  expired: "badge badge-warning badge-plain",
  removed_by_admin: "badge badge-danger badge-plain",
  invite_revoked: "badge badge-danger badge-plain",
  invite_failed: "badge badge-danger badge-plain",
  sync_missing: "badge badge-neutral badge-plain",
  email_changed: "badge badge-neutral badge-plain",
  subscription_transferred: "badge badge-neutral badge-plain",
};

/**
 * Tab "Đã xoá" của trang Email đã thêm — CHỈ ĐỌC.
 *
 * Vì sao tách riêng khỏi bảng chính: email đã rời team thì mọi thao tác (chọn hàng
 * loạt, thanh toán, đồng bộ, thu hồi, ⋯) đều vô nghĩa; nhồi thêm nhánh điều kiện vào
 * bảng chính chỉ để tắt hết chúng sẽ rối hơn là một bảng riêng. Ở đây chỉ trả lời
 * "email nào đã mất, mất lúc nào, vì sao" + click email để xem lịch sử đầy đủ.
 *
 * Backend chỉ trả email bị xoá trong 30 ngày gần nhất (REMOVED_TAB_WINDOW).
 */
export function RemovedEmailsList({
  rows,
  isLoading,
  isSuper,
  onOpenDetail,
}: {
  rows: AddedMember[];
  isLoading: boolean;
  isSuper: boolean;
  onOpenDetail: (m: AddedMember) => void;
}) {
  const t = useT();
  const isMobile = useIsMobile();
  const formatDateTime = useFormatDateTime();

  const removedAt = (m: AddedMember) =>
    m.removed_at ? formatDateTime(m.removed_at, undefined, PRECISE_TIME) : "—";
  const expiryAt = (m: AddedMember) =>
    m.subscription_end_at
      ? formatDateTime(m.subscription_end_at, undefined, PRECISE_TIME)
      : t("addedEmails.expiryNone");
  const reasonBadge = (m: AddedMember) => {
    const code = m.removed_reason ?? "";
    return (
      <span className={REASON_BADGE[code] ?? "badge badge-neutral badge-plain"}>
        {code
          ? t(`removedReason.${code}`)
          : t("removedReason.unknown")}
      </span>
    );
  };

  const emptyText = (
    <div className="cell-muted" style={{ textAlign: "center", padding: 32 }}>
      {isLoading ? t("common.loading") : t("addedEmails.removedEmpty")}
    </div>
  );

  if (isMobile) {
    return (
      <div className="email-card-list">
        {(isLoading || rows.length === 0) && emptyText}
        {rows.map((m) => (
          <div key={m.id} className="email-card">
            <div className="email-card-top">
              <button
                type="button"
                className="email-card-email"
                onClick={() => onOpenDetail(m)}
                title={t("memberDetail.openHint")}
              >
                {m.email}
              </button>
            </div>
            <div className="email-card-badges">
              {m.workspace_name && (
                <span className="email-card-ws">{m.workspace_name}</span>
              )}
              {reasonBadge(m)}
            </div>
            <div className="email-card-dates">
              <div>
                <div className="email-card-date-label">
                  {t("addedEmails.colExpiry")}
                </div>
                <div className="email-card-date-val">{expiryAt(m)}</div>
              </div>
              <div>
                <div className="email-card-date-label">
                  {t("addedEmails.colRemovedAt")}
                </div>
                <div className="email-card-date-val">{removedAt(m)}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  const colSpan = isSuper ? 7 : 6;
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data-table">
        <thead>
          <tr>
            <th>{t("member.colEmail")}</th>
            <th>{t("member.colName")}</th>
            <th>{t("addedEmails.colWorkspace")}</th>
            {isSuper && <th>{t("addedEmails.colOwner")}</th>}
            <th>{t("addedEmails.colExpiry")}</th>
            <th>{t("addedEmails.colRemovedAt")}</th>
            <th>{t("addedEmails.colRemovedReason")}</th>
          </tr>
        </thead>
        <tbody>
          {(isLoading || rows.length === 0) && (
            <tr>
              <td colSpan={colSpan} style={{ padding: 0 }}>
                {emptyText}
              </td>
            </tr>
          )}
          {rows.map((m) => (
            <tr key={m.id}>
              <td className="cell-email">
                {/* Click email → modal chi tiết + lịch sử: xem được diễn biến
                    dẫn tới lúc bị xoá (mời, gia hạn, thanh toán, gỡ). */}
                <button
                  type="button"
                  className="cell-email-link"
                  onClick={() => onOpenDetail(m)}
                  title={t("memberDetail.openHint")}
                >
                  {m.email}
                </button>
              </td>
              <td className="cell-muted">{m.name ?? "—"}</td>
              <td className="cell-muted" style={{ fontSize: 12 }}>
                {m.workspace_name ?? "—"}
              </td>
              {isSuper && (
                <td className="cell-muted" style={{ fontSize: 12 }}>
                  {m.invited_by_username ?? "—"}
                </td>
              )}
              <td className="cell-muted" style={{ fontSize: 12 }}>
                {expiryAt(m)}
              </td>
              <td className="cell-muted" style={{ fontSize: 12 }}>
                {removedAt(m)}
              </td>
              <td>{reasonBadge(m)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
