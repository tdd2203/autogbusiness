/* Bài kiểm tra gốc: workspace 404/405 thì tab Thanh toán phải nói 405 — số GHẾ
   ĐANG TRẢ TIỀN — chứ không phải 404 người đang dùng (user 8/9/2026: "bên ngoài
   quét đã thanh toán 405 seat bên trong lại có 404"). Panel từng truyền
   `seat_used` (đếm lại trong DB) vào phép tính nên thiếu một ghế cả ở "Tổng seat
   chu kỳ" lẫn "Dự kiến kỳ sau". */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BillingInvoice, Workspace } from "../types";

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= {
  getItem: () => "vi",
  setItem: () => {},
  removeItem: () => {},
};
g.navigator ??= { language: "vi" };
g.document ??= { documentElement: {} };

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { is_super_admin: true } }),
}));

const { I18nProvider } = await import("../i18n");
const { WorkspaceBillingPanel } = await import("./WorkspaceBillingPanel");

const INVOICE: BillingInvoice = {
  date: "2026-09-07T00:00:00Z",
  amount_vnd: 116123625,
  status: "paid",
  detail_scraped: true,
  quantity: 405,
  unit_price_vnd: 260659,
  subtotal_vnd: 105566895,
  vat_vnd: 10556690,
  total_vnd: 116123585,
  period_start: "2026-08-25T00:00:00Z",
  period_end: "2026-09-25T00:00:00Z",
  invoice_number: "MSNS6RGC-0074",
};

function render(over: Partial<Workspace>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const workspace = {
    id: "w1",
    name: "CHATGPT PRO",
    renewal_date: "2026-09-25T00:00:00Z",
    billing_invoices: [INVOICE],
    bank_fee_percent: null,
    ...over,
  } as unknown as Workspace;
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <WorkspaceBillingPanel workspace={workspace} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("WorkspaceBillingPanel — nguồn số seat", () => {
  it("404/405: tổng seat chu kỳ lấy tổng ghế (405), không lấy số người dùng (404)", () => {
    const html = render({ seat_total: 405, seat_used: 404 });
    const seatCard = html.slice(html.indexOf("Tổng seat chu kỳ"));
    expect(seatCard).toContain("405");
    expect(seatCard.slice(0, 200)).not.toContain("404");
  });

  it("chưa từng sync (seat_total trống) thì rơi về số người đang dùng", () => {
    const html = render({ seat_total: null, seat_used: 404 });
    expect(html.slice(html.indexOf("Tổng seat chu kỳ"))).toContain("404");
  });
});
