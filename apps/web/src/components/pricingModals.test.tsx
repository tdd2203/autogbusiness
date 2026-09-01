/* Bài kiểm tra gốc: mở popup giá lên có ĐỌC ĐƯỢC ngay tài khoản này đang bán giá nào
   không — trước đây giá ChatGPT nằm ở Quản trị Ví, giá Canva ở một trang khác, muốn
   biết một đại lý bán bao nhiêu là phải mở hai nơi rồi tự nhớ (user 2026-09-01). */
import { describe, expect, it, vi } from "vitest";
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

// Các hook ví chỉ chạy query khi biết người gọi là super-admin (useAuth), mà
// AuthProvider lại gọi mạng lúc mount.
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { is_super_admin: true } }),
}));

const { I18nProvider } = await import("../i18n");
const { default: UserPriceModal } = await import("./UserPriceModal");
const { default: PlatformPricingModal } = await import("./PlatformPricingModal");

type Tier = { months: number; price_vnd: number };

const COMMON_TIERS: Tier[] = [
  { months: 1, price_vnd: 15_000 },
  { months: 3, price_vnd: 40_000 },
];

function client(opts: {
  fee?: number | null;
  tiers?: Tier[] | null;
} = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["wallet", "admin", "settings"], { invite_fee_vnd: 60_000 });
  qc.setQueryData(["canva-price-default"], {
    tiers: COMMON_TIERS,
    sellable_months: [1, 3],
    source: "system",
  });
  qc.setQueryData(["wallet", "admin", "users"], [
    {
      user_id: "u1",
      username: "dangkhoa",
      email: "dangkhoa@no-email.local",
      wallet_beta: true,
      is_super_admin: false,
      balance: 0,
      held: 0,
      invite_fee_vnd: opts.fee ?? null,
    },
  ]);
  qc.setQueryData(["canva-price-agents"], {
    overrides: opts.tiers ? [{ user_id: "u1", tiers: opts.tiers }] : [],
  });
  return qc;
}

function renderUser(opts: { fee?: number | null; tiers?: Tier[] | null } = {}) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client(opts)}>
      <I18nProvider>
        <UserPriceModal
          userId="u1"
          username="dangkhoa"
          email="dangkhoa@no-email.local"
          onClose={() => {}}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("popup sửa giá của một tài khoản", () => {
  it("tài khoản chưa đặt riêng thì cả hai nền tảng đứng ở giá chung", () => {
    const out = renderUser();
    // Giá chung của cả hai nền tảng hiện ngay, khỏi phải mở nơi khác đối chiếu.
    expect(out).toContain("Giá chung 60.000 đ mỗi lượt");
    expect(out).toContain("1 tháng 15.000 · 3 tháng 40.000");
    // Chưa chọn giá riêng thì không bày ô nhập ra cho bấm nhầm.
    expect(out).not.toContain("Giá mỗi lượt mời / gia hạn");
  });

  it("tài khoản có giá riêng thì mở ra là thấy số của họ kèm chênh lệch", () => {
    const out = renderUser({
      fee: 50_000,
      tiers: [
        { months: 1, price_vnd: 12_000 },
        { months: 3, price_vnd: 40_000 },
      ],
    });
    expect(out).toContain("50.000");
    expect(out).toContain("rẻ hơn 17%"); // 50.000 so với giá chung 60.000
    expect(out).toContain("rẻ hơn 20%"); // bậc 1 tháng: 12.000 so với 15.000
    expect(out).toContain("bằng giá chung"); // bậc 3 tháng giữ nguyên
  });
});

describe("popup bảng giá chung", () => {
  it("hiện giá hai nền tảng và nói rõ mua dài rẻ hơn bao nhiêu", () => {
    const out = renderToStaticMarkup(
      <QueryClientProvider client={client()}>
        <I18nProvider>
          <PlatformPricingModal onClose={() => {}} />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(out).toContain("60.000");
    expect(out).toContain("13.333 đ mỗi tháng"); // 40.000 chia 3 tháng
    expect(out).toContain("rẻ hơn 11%"); // so với bậc 1 tháng
    expect(out).toContain("Chưa có thay đổi nào.");
  });
});
