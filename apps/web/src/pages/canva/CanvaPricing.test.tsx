/* Bài kiểm tra gốc: nhìn trang Bảng giá Canva có TRẢ LỜI ĐƯỢC hai câu hỏi không —
   "mua dài rẻ hơn bao nhiêu" và "đại lý nào đang không dùng bảng mặc định".
   Bản cũ chỉ có ô nhập số trần trụi và danh sách tên có ô tích, nhìn không ra cả hai
   (user 2026-09-01: "bảng giá này khó hiểu quá"). */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// I18nProvider đọc localStorage/navigator/document ngay lúc khởi tạo state; test chạy
// môi trường node nên phải dựng sẵn mấy thứ đó trước khi import.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= {
  getItem: () => "vi",
  setItem: () => {},
  removeItem: () => {},
};
g.navigator ??= { language: "vi" };
g.document ??= { documentElement: {} };

const { I18nProvider } = await import("../../i18n");
const { default: CanvaPricing, TierEditor } = await import("./CanvaPricing");

const DEFAULT_TIERS = [
  { months: 1, price_vnd: 15_000 },
  { months: 3, price_vnd: 40_000 },
  { months: 6, price_vnd: 70_000 },
  { months: 12, price_vnd: 100_000 },
];

function renderPage(overrides: { user_id: string; tiers: typeof DEFAULT_TIERS }[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["canva-price-default"], {
    tiers: DEFAULT_TIERS,
    sellable_months: [1, 3, 6, 12],
    source: "system",
  });
  qc.setQueryData(["users"], [
    { id: "u1", username: "dangkhoa", email: "dangkhoa@no-email.local", is_super_admin: false },
    { id: "u2", username: "tuan", email: "tuan@no-email.local", is_super_admin: false },
    { id: "u9", username: "admin", email: "admin@x.local", is_super_admin: true },
  ]);
  qc.setQueryData(["canva-price-agents"], { overrides });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <CanvaPricing />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const renderEditor = (rows: { months: string; price: string }[]) =>
  renderToStaticMarkup(
    <I18nProvider>
      <TierEditor rows={rows} setRows={() => {}} />
    </I18nProvider>,
  );

describe("bảng bậc đọc ra được tiền mỗi tháng và mức rẻ hơn", () => {
  const html = () =>
    renderEditor(DEFAULT_TIERS.map((t) => ({ months: String(t.months), price: String(t.price_vnd) })));

  it("hiện đơn giá mỗi tháng có đơn vị, không phải số trần", () => {
    const out = html();
    expect(out).toContain("15.000 đ/tháng");
    expect(out).toContain("8.333 đ/tháng");
  });

  it("nói thẳng mua dài rẻ hơn bao nhiêu phần trăm so với bậc ngắn nhất", () => {
    const out = html();
    expect(out).toContain("Giá gốc"); // bậc 1 tháng là mốc
    expect(out).toContain("Rẻ hơn 11%"); // 3 tháng
    expect(out).toContain("Rẻ hơn 22%"); // 6 tháng
    expect(out).toContain("Rẻ hơn 44%"); // 12 tháng
  });

  it("bậc dài mà không rẻ hơn thì bị chỉ mặt, khỏi lỡ tay bán lỗ ngược", () => {
    const out = renderEditor([
      { months: "1", price: "15000" },
      { months: "12", price: "200000" },
    ]);
    expect(out).toContain("Không rẻ hơn");
    expect(out).not.toContain("Rẻ hơn");
  });

  it("trùng số tháng thì báo trước, đừng để lưu xong mới mất bậc", () => {
    const out = renderEditor([
      { months: "3", price: "40000" },
      { months: "3", price: "42000" },
    ]);
    expect(out).toContain("Có bậc trùng số tháng");
  });
});

describe("danh sách đại lý nói rõ ai đang lệch khỏi bảng mặc định", () => {
  it("đánh dấu người có giá riêng kèm luôn các bậc của họ", () => {
    const out = renderPage([
      { user_id: "u1", tiers: [{ months: 1, price_vnd: 11_000 }] as typeof DEFAULT_TIERS },
    ]);
    expect(out).toContain("dangkhoa");
    expect(out).toContain("Giá riêng");
    expect(out).toContain("1 tháng 11.000");
    // Người còn lại vẫn nói rõ đang theo bảng mặc định, không để trống cho đoán.
    expect(out).toContain("Theo bảng mặc định ở trên");
  });

  it("không liệt kê super-admin vào danh sách đại lý", () => {
    const out = renderPage([]);
    expect(out).not.toContain("admin@x.local");
  });

  it("chưa chọn ai thì KHÔNG hiện ô soạn giá riêng, tránh nhầm với bảng mặc định", () => {
    const out = renderPage([]);
    expect(out).toContain("Tích chọn đại lý ở trên");
    expect(out).not.toContain("Giá riêng cho");
  });

  it("không lòi key i18n ra màn hình", () => {
    expect(renderPage([])).not.toContain("canva.");
  });
});
