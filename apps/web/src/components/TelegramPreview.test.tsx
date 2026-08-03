import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildPreview, TelegramPreview, type TemplateSample } from "./TelegramPreview";

const SAMPLE: TemplateSample = {
  items: [
    { email: "khach_a@gmail.com", expiry: "06/08/2026 09:15", days_left: "còn 2 ngày 20 giờ" },
    { email: "khach_b@gmail.com", expiry: "07/08/2026 14:00", days_left: "còn 3 ngày" },
  ],
  count: 2,
  bucket: 3,
  link: "https://gpt.lovevn.org/renewals",
  owner: "shopA",
  workspace: "Workspace 1",
};

const render = (html: string) =>
  renderToStaticMarkup(<TelegramPreview html={html} invalidNote="SAI" />);

describe("buildPreview", () => {
  it("bung {items} thành từng dòng email theo mẫu dòng", () => {
    const out = buildPreview(
      "Còn {count} email ≤{bucket} ngày\n\n{items}\n\nGia hạn: {link}",
      "• {email} — {expiry}",
      SAMPLE,
    );
    expect(out).toBe(
      "Còn 2 email ≤3 ngày\n\n" +
        "• khach_a@gmail.com — 06/08/2026 09:15\n" +
        "• khach_b@gmail.com — 07/08/2026 14:00\n\n" +
        "Gia hạn: https://gpt.lovevn.org/renewals",
    );
  });

  it("dấu { } lạ người dùng gõ vẫn giữ nguyên, không làm vỡ tin", () => {
    expect(buildPreview("{^_^} {owner} {khong_co}", "x", SAMPLE)).toBe(
      "{^_^} shopA {khong_co}",
    );
  });
});

describe("TelegramPreview", () => {
  it("vẽ thẻ Telegram thành định dạng thật, không in ra mã nguồn", () => {
    const html = render("<b>Nhắc</b> <i>gia hạn</i> <code>a@b.com</code>");
    expect(html).toContain("<strong>Nhắc</strong>");
    expect(html).toContain("<em>gia hạn</em>");
    expect(html).toContain("a@b.com</code>");
    expect(html).not.toContain("&lt;b&gt;");
  });

  it("link chỉ nhận scheme an toàn", () => {
    expect(render('<a href="https://x.dev">mở</a>')).toContain('href="https://x.dev"');
    const bad = render('<a href="javascript:alert(1)">mở</a>');
    expect(bad).not.toContain("javascript:");
    expect(bad).toContain("mở");
  });

  it("thẻ lạ → hiện nguyên văn + báo sai (Telegram sẽ từ chối mẫu)", () => {
    const html = render("<marquee>chạy</marquee>");
    expect(html).toContain("&lt;marquee&gt;");
    expect(html).toContain("SAI");
  });

  it("thẻ quên đóng → vẫn vẽ nhưng báo sai", () => {
    const html = render("<b>quên đóng");
    expect(html).toContain("<strong>quên đóng</strong>");
    expect(html).toContain("SAI");
  });

  it("mẫu hợp lệ thì không báo sai", () => {
    expect(render("<b>ok</b> &lt;không phải thẻ&gt;")).not.toContain("SAI");
  });
});
