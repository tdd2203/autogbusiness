/** Khung modal dùng chung cho hai popup giá (giá chung và giá của một tài khoản). */
import type { ReactNode } from "react";

export function PriceModalShell({
  title,
  subtitle,
  onClose,
  children,
  maxWidth = 700,
}: {
  title: string;
  subtitle: ReactNode;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: number;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="surface-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth,
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--surface)",
        }}
      >
        <div style={{ padding: "18px 22px 14px", borderBottom: "1px solid var(--border)" }}>
          <h3 className="display-h3" style={{ margin: 0 }}>
            {title}
          </h3>
          <div className="form-hint" style={{ marginTop: 4 }}>
            {subtitle}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
