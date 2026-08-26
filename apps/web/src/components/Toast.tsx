/**
 * Toast notification system thay cho window.alert().
 *
 * API: imperative singleton `toast.info(msg) | toast.success | toast.warning |
 * toast.error` (và `confirm`) dùng từ event handler, non-React code
 * (vd useExtensionTrigger.ts).
 *
 * ToastProvider phải wrap app (xem main.tsx). Provider sẽ register handler
 * cho singleton; nếu chưa wrap thì singleton calls thành no-op (an toàn).
 */

import {
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useT } from "../i18n";

export type ToastKind = "info" | "success" | "warning" | "error";

export type ToastOptions = {
  /** ms tự đóng. 0 = không auto-dismiss. Default: 2000 (success), 5000 (info), 8000 (warning/error). */
  durationMs?: number;
};

type ToastItem = {
  id: number;
  kind: ToastKind;
  message: string;
  durationMs: number;
  /** true khi đang chạy animation fade-out trước lúc bị gỡ khỏi DOM. */
  exiting?: boolean;
};

/** Thời lượng animation fade-out (ms) — phải khớp keyframes `toast-out` trong index.css. */
const EXIT_MS = 200;

type EnqueueFn = (kind: ToastKind, message: string, opts?: ToastOptions) => number;
type DismissFn = (id: number) => void;

export type ConfirmOptions = {
  okText?: string;
  cancelText?: string;
  /** true → nút OK màu đỏ (destructive action). */
  danger?: boolean;
  title?: string;
  /**
   * Nếu set, dialog yêu cầu user gõ đúng chuỗi này (case-insensitive) trước
   * khi nút OK enable. Dùng cho destructive irreversible action.
   * Vd: requireType: "delete" → user phải gõ "delete".
   */
  requireType?: string;
};

type ConfirmFn = (message: string, opts?: ConfirmOptions) => Promise<boolean>;

let _enqueue: EnqueueFn | null = null;
let _dismiss: DismissFn | null = null;
let _confirm: ConfirmFn | null = null;

function defaultDuration(kind: ToastKind): number {
  if (kind === "warning" || kind === "error") return 8000;
  if (kind === "success") return 2000;
  return 5000;
}

/** Imperative singleton API — gọi từ non-React code. */
export const toast = {
  info: (message: string, opts?: ToastOptions) =>
    _enqueue?.("info", message, opts) ?? -1,
  success: (message: string, opts?: ToastOptions) =>
    _enqueue?.("success", message, opts) ?? -1,
  warning: (message: string, opts?: ToastOptions) =>
    _enqueue?.("warning", message, opts) ?? -1,
  error: (message: string, opts?: ToastOptions) =>
    _enqueue?.("error", message, opts) ?? -1,
  dismiss: (id: number) => _dismiss?.(id),
};

/**
 * Custom confirm thay window.confirm — return Promise<boolean>.
 * Nếu ToastProvider chưa mount thì fallback về window.confirm (an toàn cho test).
 */
export function confirm(
  message: string,
  opts?: ConfirmOptions,
): Promise<boolean> {
  if (_confirm) return _confirm(message, opts);
  return Promise.resolve(window.confirm(message));
}

type ToastCtx = {
  show: (kind: ToastKind, message: string, opts?: ToastOptions) => number;
  dismiss: (id: number) => void;
  confirm: ConfirmFn;
};

type ConfirmState = {
  id: number;
  message: string;
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
};

const Ctx = createContext<ToastCtx | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const nextIdRef = useRef(1);

  // Gỡ hẳn khỏi DOM (sau khi fade-out xong).
  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Bắt đầu fade-out: đánh dấu exiting để chạy animation `toast-out`, rồi gỡ
  // sau EXIT_MS. Gọi lại trên cùng id (vd auto-dismiss trùng user-click) là no-op.
  const dismiss = useCallback(
    (id: number) => {
      let alreadyExiting = false;
      setItems((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t;
          if (t.exiting) alreadyExiting = true;
          return { ...t, exiting: true };
        }),
      );
      if (!alreadyExiting) setTimeout(() => remove(id), EXIT_MS);
    },
    [remove],
  );

  const show = useCallback<EnqueueFn>(
    (kind, message, opts) => {
      const id = nextIdRef.current++;
      const durationMs = opts?.durationMs ?? defaultDuration(kind);
      setItems((prev) => [...prev, { id, kind, message, durationMs }]);
      if (durationMs > 0) {
        setTimeout(() => dismiss(id), durationMs);
      }
      return id;
    },
    [dismiss],
  );

  // Confirm modal — 1 tại 1 thời điểm. Confirm thứ 2 sẽ override confirm 1
  // (resolve confirm cũ với false để promise không bị bỏ rơi).
  const confirmFn = useCallback<ConfirmFn>((message, opts) => {
    return new Promise<boolean>((resolve) => {
      const id = nextIdRef.current++;
      setConfirmState((prev) => {
        if (prev) prev.resolve(false);
        return { id, message, opts: opts ?? {}, resolve };
      });
    });
  }, []);

  const handleConfirmAnswer = useCallback((ok: boolean) => {
    setConfirmState((prev) => {
      if (prev) prev.resolve(ok);
      return null;
    });
  }, []);

  // Register singleton handlers — non-React code (vd useExtensionTrigger.ts)
  // gọi `toast.warning(...)` hoặc `confirm(...)` sẽ route qua đây.
  useEffect(() => {
    _enqueue = show;
    _dismiss = dismiss;
    _confirm = confirmFn;
    return () => {
      _enqueue = null;
      _dismiss = null;
      _confirm = null;
    };
  }, [show, dismiss, confirmFn]);

  return (
    <Ctx.Provider value={{ show, dismiss, confirm: confirmFn }}>
      {children}
      {/* Success → toast nổi chính giữa trên đầu trang (auto-ẩn 2s, fade-out).
          Các kind khác → góc dưới phải như cũ. */}
      <ToastContainer
        items={items.filter((t) => t.kind === "success")}
        onDismiss={dismiss}
        position="top-center"
      />
      <ToastContainer
        items={items.filter((t) => t.kind !== "success")}
        onDismiss={dismiss}
        position="bottom-right"
      />
      <ConfirmDialog state={confirmState} onAnswer={handleConfirmAnswer} />
    </Ctx.Provider>
  );
}

const KIND_STYLE: Record<ToastKind, string> = {
  info: "bg-slate-800 text-slate-100 border-slate-600",
  success: "bg-emerald-700 text-emerald-50 border-emerald-500",
  warning: "bg-amber-700 text-amber-50 border-amber-500",
  error: "bg-rose-700 text-rose-50 border-rose-500",
};

const KIND_ICON: Record<ToastKind, string> = {
  info: "i",
  success: "✓",
  warning: "!",
  error: "×",
};

function ConfirmDialog({
  state,
  onAnswer,
}: {
  state: ConfirmState | null;
  onAnswer: (ok: boolean) => void;
}) {
  const t = useT();
  const [typed, setTyped] = useState("");

  // Reset input mỗi lần mở dialog mới
  useEffect(() => {
    setTyped("");
  }, [state?.id]);

  const requireType = state?.opts.requireType;
  const isMatched =
    !requireType ||
    typed.trim().toLowerCase() === requireType.trim().toLowerCase();

  // ESC = cancel, Enter = OK (chỉ khi typed-confirm pass). Focus nút OK khi mở.
  useEffect(() => {
    if (!state) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onAnswer(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (isMatched) onAnswer(true);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [state, onAnswer, isMatched]);

  if (!state) return null;
  const { message, opts } = state;
  const okText = opts.okText ?? t("common.confirm");
  const cancelText = opts.cancelText ?? t("common.cancel");
  const danger = opts.danger ?? false;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 animate-[toast-in_140ms_ease-out]"
      onClick={() => onAnswer(false)}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        {opts.title && (
          <div className="text-base font-semibold mb-2 text-slate-900">
            {opts.title}
          </div>
        )}
        {message && (
          <div className="text-sm text-slate-700 whitespace-pre-line leading-6">
            {message}
          </div>
        )}
        {requireType && (
          <div className="mt-3">
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {t("toast.confirmTypeLabel", { text: "" })
                .split("{text}")[0]
                .trimEnd()}{" "}
              <span className="font-mono font-bold text-rose-600">
                {requireType}
              </span>{" "}
              {t("toast.confirmTypeLabel", { text: "" }).split("{text}")[1] ??
                ""}
            </label>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-rose-500"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={() => onAnswer(false)}
            className="px-3 py-1.5 rounded text-sm border border-slate-300 text-slate-700 hover:bg-slate-50"
          >
            {cancelText}
          </button>
          <button
            onClick={() => onAnswer(true)}
            autoFocus={!requireType}
            disabled={!isMatched}
            className={`px-3 py-1.5 rounded text-sm text-white disabled:opacity-50 disabled:cursor-not-allowed ${
              danger
                ? "bg-rose-600 hover:bg-rose-700"
                : "bg-slate-800 hover:bg-slate-900"
            }`}
          >
            {okText}
          </button>
        </div>
      </div>
    </div>
  );
}

function ToastContainer({
  items,
  onDismiss,
  position,
}: {
  items: ToastItem[];
  onDismiss: (id: number) => void;
  position: "top-center" | "bottom-right";
}) {
  const tt = useT();
  const ariaDismissLabel = tt("common.dismiss");
  const containerCls =
    position === "top-center"
      ? "fixed top-4 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 max-w-[90vw] pointer-events-none"
      : "fixed bottom-4 right-4 left-4 sm:left-auto z-50 flex flex-col gap-2 max-w-[90vw] sm:max-w-sm sm:ml-auto pointer-events-none";
  const enterAnim =
    position === "top-center"
      ? "animate-[toast-in-down_180ms_ease-out]"
      : "animate-[toast-in_180ms_ease-out]";
  return (
    <div className={containerCls}>
      {items.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto rounded-md border shadow-lg px-3 py-2 text-sm flex items-start gap-2 ${
            t.exiting ? "animate-[toast-out_200ms_ease-in_forwards]" : enterAnim
          } ${KIND_STYLE[t.kind]}`}
          role="status"
        >
          <span
            className="font-bold leading-5 select-none"
            aria-hidden="true"
          >
            {KIND_ICON[t.kind]}
          </span>
          <div className="flex-1 whitespace-pre-line break-words leading-5">
            {t.message}
          </div>
          <button
            onClick={() => onDismiss(t.id)}
            className="opacity-70 hover:opacity-100 ml-1 leading-5"
            aria-label={ariaDismissLabel}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
