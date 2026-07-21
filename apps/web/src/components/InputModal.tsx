/**
 * InputModal — popup nhập liệu 1 ô DÙNG CHUNG (thay window.prompt của trình duyệt).
 *
 * Chuẩn cho MỌI thao tác chỉnh sửa nhanh (user 2026-07-13: "show pop up chứ không
 * http phản hồi"): giao diện đồng bộ app, xử lý loading, và HIỆN LỖI NGAY trong popup
 * (không đẩy phản hồi thô ra ngoài). onSubmit trả Promise; throw → hiện message lỗi
 * đỏ trong modal + giữ mở; thành công → tự đóng.
 */
import { useState } from "react";
import { ApiError } from "../lib/api";

export default function InputModal({
  title,
  description,
  label,
  initialValue = "",
  placeholder,
  type = "text",
  submitLabel = "Lưu",
  onSubmit,
  onClose,
}: {
  title: string;
  description?: string;
  label?: string;
  initialValue?: string;
  placeholder?: string;
  type?: "text" | "number";
  submitLabel?: string;
  /** Xử lý giá trị nhập. Throw (vd ApiError) → hiện lỗi trong modal, giữ mở. */
  onSubmit: (value: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value.trim());
      onClose();
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? typeof e.detail === "object" && e.detail
            ? String((e.detail as { message?: string }).message ?? JSON.stringify(e.detail))
            : String(e.detail)
          : e instanceof Error
            ? e.message
            : String(e);
      setError(msg);
      setBusy(false);
    }
  }

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ink)" }}>{title}</div>
            {description && (
              <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 4, lineHeight: 1.5 }}>{description}</div>
            )}
          </div>
          <button onClick={onClose} style={closeBtn} aria-label="Đóng">✕</button>
        </div>

        <div style={{ padding: "18px 20px 20px" }}>
          {label && <label style={labelStyle}>{label}</label>}
          <input
            type={type}
            value={value}
            placeholder={placeholder}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            style={input}
          />
          {error && (
            <div style={errorBox}>{error}</div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
            <button onClick={onClose} disabled={busy} style={secondaryBtn}>Huỷ</button>
            <button onClick={submit} disabled={busy} style={primaryBtn}>
              {busy ? "Đang lưu…" : submitLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const backdrop: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120, padding: 16 };
const modal: React.CSSProperties = { background: "var(--surface)", borderRadius: 18, width: 440, maxWidth: "100%", border: "1px solid var(--border)", boxShadow: "0 24px 70px -18px rgba(28,26,23,0.4), 0 2px 8px rgba(28,26,23,0.08)", overflow: "hidden" };
const header: React.CSSProperties = { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "18px 20px 14px", borderBottom: "1px solid var(--border)" };
const closeBtn: React.CSSProperties = { width: 30, height: 30, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--ink-3)", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 };
const labelStyle: React.CSSProperties = { display: "block", fontSize: 12.5, color: "var(--ink-2)", marginBottom: 6, fontWeight: 500 };
const input: React.CSSProperties = { width: "100%", padding: "11px 12px", border: "1px solid var(--border)", borderRadius: 10, fontSize: 15, background: "var(--bg)", color: "var(--ink)", fontFamily: "var(--font-mono)" };
const errorBox: React.CSSProperties = { marginTop: 10, padding: "9px 11px", background: "var(--danger-bg)", border: "1px solid var(--danger)", borderRadius: 9, fontSize: 12.5, color: "var(--danger)", lineHeight: 1.45 };
const primaryBtn: React.CSSProperties = { padding: "9px 18px", background: "var(--ink)", color: "var(--surface)", border: "none", borderRadius: 9, fontSize: 13.5, fontWeight: 600, cursor: "pointer" };
const secondaryBtn: React.CSSProperties = { padding: "9px 16px", background: "var(--surface)", color: "var(--ink-2)", border: "1px solid var(--border)", borderRadius: 9, fontSize: 13.5, fontWeight: 600, cursor: "pointer" };
