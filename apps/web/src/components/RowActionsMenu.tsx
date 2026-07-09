/**
 * Kebab menu (nút "⋯" 3 chấm) → dropdown các thao tác theo dòng.
 *
 * Repo chưa có UI library (radix/headless) nên tự dựng: nút toggle + menu định vị
 * qua portal, đóng khi click ra ngoài hoặc nhấn Escape. Dùng cho cột thao tác bảng
 * member (gom "Xoá" + "Đổi email" thay vì rải nhiều button).
 *
 * Vì sao portal + position:fixed (không phải absolute): menu nằm trong bảng có
 * ancestor cắt nội dung — `.table-card{overflow:hidden}` và div bọc bảng
 * `overflow-x:auto`. Menu absolute sẽ bị 2 lớp này che mất ở dòng sát mép. Portal
 * ra <body> + toạ độ tính từ getBoundingClientRect của nút → không ancestor nào cắt
 * được. Lật lên trên nếu tràn đáy viewport.
 *
 * Mỗi item: { key, label, onClick, danger?, disabled? }. Click item → đóng menu
 * rồi chạy onClick (để modal/confirm mở sau khi menu đã đóng, tránh chồng overlay).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type RowActionItem = {
  key: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
};

export function RowActionsMenu({
  items,
  ariaLabel = "Thao tác",
}: {
  items: RowActionItem[];
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Tính toạ độ fixed từ rect của nút: neo phải mép phải nút, mở xuống dưới;
  // nếu không đủ chỗ dưới đáy viewport thì lật lên trên.
  const place = () => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const menuH = menuRef.current?.offsetHeight ?? 0;
    const below = window.innerHeight - r.bottom;
    const top =
      menuH > 0 && below < menuH + 8 ? r.top - menuH - 4 : r.bottom + 4;
    setPos({ top, right: window.innerWidth - r.right });
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Cuộn/resize → menu fixed không đi theo nút, nên đóng lại cho gọn.
    const onReflow = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        ref={btnRef}
        type="button"
        className="row-action neutral"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ fontSize: 16, lineHeight: 1, padding: "4px 8px" }}
      >
        ⋯
      </button>
      {open && pos &&
        createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{
            position: "fixed",
            top: pos.top,
            right: pos.right,
            minWidth: 140,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            zIndex: 1000,
            padding: 4,
            textAlign: "left",
          }}
        >
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
              className={`row-action${it.danger ? "" : " neutral"}`}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "6px 10px",
                borderRadius: 4,
                opacity: it.disabled ? 0.5 : 1,
              }}
            >
              {it.label}
            </button>
          ))}
        </div>,
          document.body,
        )}
    </div>
  );
}
