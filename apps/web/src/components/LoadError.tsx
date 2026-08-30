/**
 * Khối "không tải được, thử lại" dùng chung cho các query đọc dữ liệu.
 *
 * Vì sao cần: khắp UI đang viết `isLoading ? "…" : giá_trị`. Query lỗi thì
 * `isLoading` về false còn `data` là undefined, nên màn hình rơi về `0 đ` / danh
 * sách rỗng — LỖI và KHÔNG CÓ GÌ trông y hệt nhau, và user không có cách nào gọi
 * lại ngoài F5 (user 2026-08-30).
 *
 * Hai dáng:
 *   • `block` (mặc định) — thay chỗ nội dung rỗng: giữa thẻ, có nút.
 *   • `inline` — một dòng gọn nằm dưới con số vẫn đang hiện (số cũ còn đó, chỉ là
 *     lần làm mới vừa rồi hỏng), nút là chữ gạch chân.
 */
import { apiErrorText } from "../lib/api";

export default function LoadError({
  error,
  onRetry,
  retrying = false,
  variant = "block",
  fallback,
}: {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  variant?: "block" | "inline";
  /** Câu thay thế khi lỗi không nói được gì (mặc định "Không tải được dữ liệu."). */
  fallback?: string;
}) {
  const text = apiErrorText(error, fallback);

  if (variant === "inline") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 6,
          flexWrap: "wrap",
          fontSize: 12,
          color: "var(--danger)",
          marginTop: 4,
        }}
      >
        <span>{text}</span>
        {onRetry && (
          <button
            onClick={onRetry}
            disabled={retrying}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              fontSize: 12,
              fontWeight: 700,
              color: "var(--danger)",
              textDecoration: "underline",
              cursor: retrying ? "default" : "pointer",
              opacity: retrying ? 0.6 : 1,
            }}
          >
            {retrying ? "Đang thử lại…" : "Thử lại"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: "34px 20px", textAlign: "center" }}>
      <div style={{ fontSize: 13, color: "var(--danger)", marginBottom: 4 }}>{text}</div>
      <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
        Đây là lỗi tải dữ liệu, không phải "không có gì".
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          disabled={retrying}
          style={{
            marginTop: 12,
            padding: "10px 16px",
            background: "var(--surface)",
            color: "var(--ink)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius)",
            fontSize: 13,
            fontWeight: 600,
            cursor: retrying ? "default" : "pointer",
            opacity: retrying ? 0.6 : 1,
          }}
        >
          {retrying ? "Đang thử lại…" : "Thử lại"}
        </button>
      )}
    </div>
  );
}
