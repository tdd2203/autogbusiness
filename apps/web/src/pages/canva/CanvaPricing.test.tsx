/* Bài kiểm tra gốc: nhìn trang Bảng giá Canva có TRẢ LỜI ĐƯỢC hai câu hỏi không —
   "mua dài rẻ hơn bao nhiêu" và "đại lý nào đang không dùng giá chung".
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
const { default: CanvaPricing } = await import("./CanvaPricing");

type Tier = { months: number; price_vnd: number };

const DEFAULT_TIERS: Tier[] = [
  { months: 1, price_vnd: 15_000 },
  { months: 3, price_vnd: 40_000 },
  { months: 6, price_vnd: 70_000 },
  { months: 12, price_vnd: 100_000 },
];

/** Trang đọc giá chung qua useEffect nên bản dựng tĩnh chưa có dòng bậc nào; muốn
 *  kiểm phần đó thì nạp sẵn cache rồi dựng lần hai — react-query trả ngay từ cache. */
function renderPage(opts: {
  overrides?: { user_id: string; tiers: Tier[] }[];
  agents?: { id: string; username: string; email: string; is_super_admin: boolean }[];
} = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["canva-price-default"], {
    tiers: DEFAULT_TIERS,
    sellable_months: [1, 3, 6, 12],
    source: "system",
  });
  qc.setQueryData(
    ["users"],
    opts.agents ?? [
      { id: "u1", username: "dangkhoa", email: "dangkhoa@no-email.local", is_super_admin: false },
      { id: "u2", username: "tuan", email: "tuan@no-email.local", is_super_admin: false },
      { id: "u9", username: "admin", email: "admin@x.local", is_super_admin: true },
    ],
  );
  qc.setQueryData(["canva-price-agents"], { overrides: opts.overrides ?? [] });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <CanvaPricing />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("đại lý nào lệch khỏi giá chung thì nhìn là thấy", () => {
  it("gắn nhãn giá riêng kèm luôn các bậc của người đó", () => {
    const out = renderPage({
      overrides: [{ user_id: "u1", tiers: [{ months: 1, price_vnd: 11_000 }] }],
    });
    expect(out).toContain("dangkhoa");
    expect(out).toContain("giá riêng");
    expect(out).toContain("1 tháng 11.000");
    // Người còn lại vẫn nói rõ đang theo giá chung, không để trống cho đoán.
    expect(out).toContain("Theo giá chung ở trên");
  });

  it("bộ lọc đếm đúng số người giá riêng và giá chung", () => {
    const out = renderPage({
      overrides: [{ user_id: "u1", tiers: [{ months: 1, price_vnd: 11_000 }] }],
    });
    expect(out).toContain("Tất cả 2");
    expect(out).toContain("Giá riêng 1");
    expect(out).toContain("Giá chung 1");
    expect(out).toContain("Hiển thị 2 / 2 đại lý");
  });

  it("người chưa đặt riêng thì nút mời đặt giá riêng, đã đặt thì cho sửa", () => {
    const out = renderPage({
      overrides: [{ user_id: "u1", tiers: [{ months: 1, price_vnd: 11_000 }] }],
    });
    expect(out).toContain("Đặt giá riêng"); // tuan
    expect(out).toContain("Bỏ giá riêng"); // dangkhoa
  });

  it("không liệt kê super-admin vào danh sách đại lý", () => {
    expect(renderPage()).not.toContain("admin@x.local");
  });

  it("chưa chọn ai thì không hiện thanh áp giá hàng loạt", () => {
    const out = renderPage();
    expect(out).not.toContain("Đã chọn");
    expect(out).toContain("Chọn 2 đại lý đang hiển thị");
  });

  it("chưa có đại lý nào thì nói rõ, không để khung trống", () => {
    const out = renderPage({ agents: [] });
    expect(out).toContain("Chưa có tài khoản đại lý nào.");
  });

  it("chỉ hiện 8 đại lý đầu, phần còn lại nằm sau nút xem thêm", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `u${i}`,
      username: `daily${i}`,
      email: `daily${i}@no-email.local`,
      is_super_admin: false,
    }));
    const out = renderPage({ agents: many });
    expect(out).toContain("Hiển thị 8 / 12 đại lý");
    expect(out).toContain("Xem thêm 4 đại lý");
    expect(out).toContain("daily7");
    expect(out).not.toContain("daily8");
  });

  it("chưa sửa gì thì nút lưu giá chung đứng im", () => {
    const out = renderPage();
    expect(out).toContain("Chưa có thay đổi nào.");
    expect(out).toContain("Lưu giá chung");
    expect(out).toContain("disabled");
  });

  it("không lòi key i18n ra màn hình", () => {
    expect(renderPage()).not.toContain("canva.");
  });
});
