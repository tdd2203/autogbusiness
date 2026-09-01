/* Bài kiểm tra gốc: cột thao tác của một dòng tài khoản có gọn không. Trước đây rải
   ba nút chữ cạnh nhau, trong đó "Vô hiệu hoá" và "Reset password" là hai việc ít
   dùng mà nặng tay — để trần ngoài dòng rất dễ bấm nhầm (user 2026-09-01). */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// I18nProvider đọc localStorage/navigator/document ngay lúc khởi tạo state; test chạy
// môi trường node nên phải dựng sẵn mấy thứ đó trước khi import.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => "vi", setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: "vi" };
g.document ??= { documentElement: {} };

// Nút giá chỉ dành cho super-admin, mà AuthProvider thật lại gọi mạng lúc mount.
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { is_super_admin: true }, hasPermission: () => true }),
}));

const { I18nProvider } = await import("../i18n");
const { default: Users } = await import("./Users");

function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["users"], [
    {
      id: "u1",
      email: "dangkhoa@no-email.local",
      username: "dangkhoa",
      is_super_admin: false,
      is_active: true,
      permissions: [],
      created_at: "2026-08-16T00:00:00Z",
    },
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <Users />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("cột thao tác của tài khoản phụ", () => {
  it("chỉ để trần sửa quyền và sửa giá, phần còn lại nằm trong kebab", () => {
    const out = render();
    expect(out).toContain("Sửa quyền");
    expect(out).toContain("Sửa giá");
    expect(out).toContain("kebab-btn");
    // Hai việc nặng tay không còn nằm sẵn ngoài dòng.
    expect(out).not.toContain(">Vô hiệu hoá<");
    expect(out).not.toContain(">Reset password<");
  });

  it("có nút bảng giá chung cạnh nút tạo tài khoản", () => {
    const out = render();
    expect(out).toContain("Bảng giá");
    expect(out).toContain("Tạo tài khoản");
  });
});
