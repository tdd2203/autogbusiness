/**
 * Ô "Dữ liệu" (payload) cho bảng Queue.
 *
 * Trước đây render thẳng `JSON.stringify(payload)` trong class `.payload`
 * (max-width 320px + white-space:nowrap + text-overflow:ellipsis) → payload dài
 * bị CẮT CỤT trên 1 dòng, không xem được hết; payload rỗng `{}` thì hiện "{}"
 * trông như có data trong khi thực chất TRỐNG. Đây là lỗi "cột Dữ liệu trống/cụt".
 *
 * Sửa:
 *   - payload rỗng/null → "—" (cell-muted), không hiện "{}".
 *   - payload có data → hiện gọn 1 dòng (compact JSON); nếu dài thì có nút mở
 *     rộng để xem full pretty-print (wrap nhiều dòng), giống [ErrorCell].
 *
 * Component thuần frontend, không gọi API.
 */

import { useState } from "react";
import { useT } from "../i18n";

/** payload coi như "rỗng" khi null/undefined hoặc object không có key nào. */
function isEmptyPayload(p: unknown): boolean {
  if (p == null) return true;
  if (typeof p === "object") return Object.keys(p as object).length === 0;
  return false;
}

// Dưới ngưỡng này hiện thẳng 1 dòng, không cần nút mở rộng.
const INLINE_MAX = 48;

export function PayloadCell({
  payload,
  variant,
}: {
  payload: Record<string, unknown> | null | undefined;
  /** "success" → tô màu xanh cho cột Kết quả khi task COMPLETED. */
  variant?: "success";
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  if (isEmptyPayload(payload)) {
    return <span className="cell-muted">—</span>;
  }

  const compact = JSON.stringify(payload);
  const needsToggle = compact.length > INLINE_MAX;

  return (
    <div style={{ maxWidth: 360 }}>
      <span
        className={variant === "success" ? "payload payload-success" : "payload"}
        style={
          expanded
            ? {
                whiteSpace: "pre-wrap",
                maxWidth: "none",
                overflow: "visible",
                textOverflow: "clip",
              }
            : undefined
        }
      >
        {expanded ? JSON.stringify(payload, null, 2) : compact}
      </span>
      {needsToggle && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            display: "block",
            marginTop: 4,
            background: "none",
            border: "none",
            color: "var(--accent)",
            cursor: "pointer",
            padding: 0,
            fontSize: 12,
            textDecoration: "underline",
          }}
        >
          {expanded ? t("queue.payloadCollapse") : t("queue.payloadExpand")}
        </button>
      )}
    </div>
  );
}
