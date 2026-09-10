/**
 * Rào chắn lỗi: một trang vẽ hỏng thì CHỈ trang đó thay bằng thẻ báo lỗi, khung app
 * (thanh bên, thanh trên, thanh tab đáy) vẫn đứng để người dùng chuyển sang trang
 * khác. Trước đây (user 2026-09-10) một `undefined.seats` trong Tổng quan là React
 * gỡ cả cây, màn hình trắng tinh, chỉ còn cách F5.
 *
 * Hai lớp:
 *   • `<ErrorBoundary resetKey={pathname}>` quanh <Outlet/> của Layout và
 *     WorkspaceLayout — đổi trang là tự gỡ lỗi đang giữ. Dùng resetKey chứ không
 *     `key={pathname}` vì key làm remount cả cây con mỗi lần đổi trang (mất trạng
 *     thái WorkspaceLayout, modal, polling) dù chẳng có lỗi gì.
 *   • `<ErrorBoundary fallback={RootCrash}>` ở gốc main.tsx — bắt cả lỗi của chính
 *     Layout hay provider; nằm ngoài I18nProvider nên câu chữ viết cứng tiếng Việt.
 *
 * Phải là class: React 18 chỉ cho class bắt lỗi render (getDerivedStateFromError).
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useT } from "../i18n";

type Props = {
  children: ReactNode;
  /** Đổi giá trị (thường là pathname) là rào chắn tự xoá lỗi đang giữ. */
  resetKey?: string;
  /** Giao diện thay thế; mặc định là thẻ báo lỗi có i18n (PageCrash). */
  fallback?: (error: Error, reset: () => void) => ReactNode;
};

type State = { error: Error | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: toError(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // React đã in lỗi; in thêm cây component để lần ra trang nào hỏng.
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return <PageCrash error={error} onRetry={this.reset} />;
  }
}

/** Ném ra thứ không phải Error (chuỗi, object) thì bọc lại để có message đọc được. */
export function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  if (typeof e === "string") return new Error(e);
  let text: string;
  try {
    text = JSON.stringify(e) ?? String(e);
  } catch {
    text = String(e);
  }
  return new Error(text);
}

/** Dòng mô tả lỗi cho người dùng: message của Error, cắt ngắn; rỗng thì câu chung. */
export function crashMessage(error: Error, fallback: string): string {
  const m = (error.message ?? "").trim();
  if (!m) return fallback;
  return m.length > 200 ? `${m.slice(0, 200)}…` : m;
}

function PageCrash({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const t = useT();
  return <CrashCard error={error} onRetry={onRetry} t={t} />;
}

/** Thẻ báo lỗi của một trang. Tách khỏi hook i18n để test không cần provider. */
export function CrashCard({
  error,
  onRetry,
  t,
}: {
  error: Error;
  onRetry: () => void;
  t: (key: string) => string;
}) {
  return (
    <div
      role="alert"
      className="table-card"
      style={{
        maxWidth: 520,
        margin: "24px auto",
        padding: "28px 24px",
        textAlign: "center",
      }}
    >
      <div className="display-h2" style={{ marginBottom: 6 }}>
        {t("crash.title")}
      </div>
      <div
        style={{
          fontSize: 13,
          color: "var(--danger)",
          fontFamily: "var(--font-mono)",
          wordBreak: "break-word",
          marginBottom: 8,
        }}
      >
        {crashMessage(error, t("crash.unknown"))}
      </div>
      <p style={{ fontSize: 13, color: "var(--ink-2)", marginBottom: 18 }}>
        {t("crash.hint")}
      </p>
      <div
        style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}
      >
        <button type="button" className="btn btn-primary" onClick={onRetry}>
          {t("crash.retry")}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => window.location.reload()}
        >
          {t("crash.reload")}
        </button>
      </div>
    </div>
  );
}

/** Gốc app: ngoài mọi provider nên không có i18n lẫn token CSS, viết cứng. */
export function RootCrash(error: Error) {
  return (
    <div
      role="alert"
      style={{
        padding: 32,
        maxWidth: 520,
        margin: "40px auto",
        fontFamily: "system-ui, -apple-system, sans-serif",
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Ứng dụng gặp lỗi</h1>
      <p style={{ fontSize: 13, color: "#b02a1e", wordBreak: "break-word" }}>
        {crashMessage(error, "Lỗi không rõ.")}
      </p>
      <p style={{ fontSize: 13, color: "#565c56", marginBottom: 16 }}>
        Tải lại trang để tiếp tục.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          padding: "10px 18px",
          background: "#171a17",
          color: "#fff",
          border: "none",
          borderRadius: 9,
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Tải lại trang
      </button>
    </div>
  );
}
