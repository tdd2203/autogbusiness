import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ErrorBoundary, { CrashCard, crashMessage, toError } from "./ErrorBoundary";
import vi from "../i18n/locales/vi.json";
import zhCN from "../i18n/locales/zh-CN.json";

/* Bài kiểm tra gốc: trang vẽ hỏng thì người dùng phải THẤY một thẻ báo lỗi đọc
   được, chứ không phải màn hình trắng. */

const tOf = (dict: Record<string, string>) => (key: string) => dict[key] ?? key;

describe("ErrorBoundary", () => {
  it("giữ lỗi vào state để vẽ thẻ báo lỗi thay cho cây con", () => {
    const s = ErrorBoundary.getDerivedStateFromError(new Error("boom"));
    expect(s.error?.message).toBe("boom");
  });

  it("ném ra chuỗi hay object cũng thành Error đọc được", () => {
    expect(toError("hỏng").message).toBe("hỏng");
    expect(toError({ code: "SEATS" }).message).toContain("SEATS");
    expect(toError(undefined).message).toBe("undefined");
  });

  it("message rỗng thì dùng câu chung, dài quá thì cắt còn 200 ký tự", () => {
    expect(crashMessage(new Error(""), "chung")).toBe("chung");
    expect(crashMessage(new Error("a".repeat(300)), "chung")).toHaveLength(201);
  });

  it("thẻ báo lỗi hiện đủ chữ ở cả hai ngôn ngữ, không lòi key i18n", () => {
    for (const dict of [vi, zhCN] as Record<string, string>[]) {
      const html = renderToStaticMarkup(
        <CrashCard
          error={new Error("Cannot read properties of undefined")}
          onRetry={() => {}}
          t={tOf(dict)}
        />,
      );
      expect(html).toContain("Cannot read properties of undefined");
      expect(html).toContain(dict["crash.title"]);
      expect(html).toContain(dict["crash.retry"]);
      expect(html).toContain(dict["crash.reload"]);
      expect(html).not.toMatch(/crash\.[a-zA-Z]+/);
    }
  });
});
