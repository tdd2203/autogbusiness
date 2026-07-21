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
 * Mỗi item: { key, label, onClick, danger?, disabled?, icon? }. Click item → đóng
 * menu rồi chạy onClick (để modal/confirm mở sau khi menu đã đóng, tránh chồng
 * overlay). Icon: tự suy theo `key` (map DEFAULT_ICONS) hoặc truyền `icon` để đè.
 * Item `danger` đầu tiên được ngăn cách bằng 1 đường kẻ mảnh cho dễ nhìn.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type RowActionItem = {
  key: string;
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Ghi đè icon mặc định (suy theo `key`). null = không hiện icon. */
  icon?: ReactNode;
  /** Dòng nhãn nhóm (không bấm được) — vd "Chuyển chủ nhanh". */
  heading?: boolean;
};

// Icon line (Feather, stroke=currentColor) 16px — chỉ để quét nhanh, màu theo item.
const svg = (children: ReactNode): ReactNode => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

// Suy icon theo `key` của action (khớp key dùng ở Members/AddedEmails). Không khớp
// → chấm tròn nhỏ (fallback trung tính).
const DEFAULT_ICONS: Record<string, ReactNode> = {
  sync: svg(
    <>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </>,
  ),
  reinvite: svg(
    <>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </>,
  ),
  "change-email": svg(
    <>
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </>,
  ),
  "change-subscription": svg(
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </>,
  ),
  revoke: svg(
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </>,
  ),
  remove: svg(
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </>,
  ),
};

const FALLBACK_ICON = svg(<circle cx="12" cy="12" r="3" />);

function iconFor(it: RowActionItem): ReactNode {
  if (it.icon !== undefined) return it.icon;
  return DEFAULT_ICONS[it.key] ?? FALLBACK_ICON;
}

export function RowActionsMenu({
  items,
  ariaLabel = "Thao tác",
  trigger,
  triggerClassName,
}: {
  items: RowActionItem[];
  ariaLabel?: string;
  /** Nội dung nút mở menu. Bỏ trống → nút kebab "⋯" mặc định. */
  trigger?: ReactNode;
  /** className của nút mở menu khi dùng `trigger` (mặc định .kebab-btn). */
  triggerClassName?: string;
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
        className={trigger ? (triggerClassName ?? "btn btn-sm") : "kebab-btn"}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger ?? "⋯"}
      </button>
      {open && pos &&
        createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="row-menu"
          style={{
            position: "fixed",
            top: pos.top,
            right: pos.right,
            zIndex: 1000,
          }}
        >
          {items.map((it, i) => {
            // Dòng nhãn nhóm — không bấm được, có kẻ ngăn cách phía trên nếu cần.
            if (it.heading) {
              return (
                <div key={it.key}>
                  {i > 0 && (
                    <div className="row-menu-sep" aria-hidden="true" />
                  )}
                  <div className="row-menu-heading">{it.label}</div>
                </div>
              );
            }
            // Kẻ ngăn cách trước item `danger` ĐẦU TIÊN (nếu phía trên có item
            // không-danger) → tách nhóm phá huỷ cho dễ nhìn, tránh bấm nhầm.
            const showSep =
              !!it.danger &&
              i > 0 &&
              !items[i - 1].danger &&
              !items[i - 1].heading &&
              items.slice(0, i).some((p) => !p.danger && !p.heading);
            return (
              <div key={it.key}>
                {showSep && <div className="row-menu-sep" aria-hidden="true" />}
                <button
                  type="button"
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={() => {
                    setOpen(false);
                    it.onClick?.();
                  }}
                  className={`row-menu-item${it.danger ? " danger" : ""}`}
                >
                  <span className="row-menu-ic">{iconFor(it)}</span>
                  <span>{it.label}</span>
                </button>
              </div>
            );
          })}
        </div>,
          document.body,
        )}
    </div>
  );
}
