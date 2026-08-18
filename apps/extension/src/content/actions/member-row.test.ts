/**
 * REGRESSION 18/8/2026 — "bấm nhầm dropdown vai trò".
 *
 * ChatGPT gỡ `data-testid`/`aria-label` khỏi nút "..." của row member. Nút "..."
 * và dropdown vai trò từ đó mang ATTRIBUTE GIỐNG HỆT nhau (`aria-haspopup="menu"`,
 * không testid, không aria-label), mà dropdown vai trò đứng TRƯỚC trong DOM. Bản
 * cũ có fallback `button[aria-haspopup="menu"]` nên lấy trúng dropdown vai trò →
 * mọi action trên row (xoá, thu hồi, đổi ghế, harvest) mở nhầm menu → 15 task xoá
 * FAILED_UI_CHANGED, 5 member hết hạn kẹt STUCK.
 *
 * Không có jsdom trong repo → dựng row giả tối thiểu: chỉ `querySelector` +
 * `querySelectorAll` với bộ khớp selector đủ dùng cho các selector thật trong
 * `findRowMenuButton`.
 */
import { describe, expect, it } from "vitest";
import { findRowMenuButton } from "./member-row";

type FakeButton = {
  tag: "button" | "div";
  text: string;
  attrs: Record<string, string>;
};

/** Khớp selector THẬT mà `findRowMenuButton` dùng — không cần engine tổng quát. */
function matches(btn: FakeButton, selector: string): boolean {
  const sel = selector.trim();
  if (sel === 'button[data-testid="member-menu-button"]') {
    return btn.tag === "button" && btn.attrs["data-testid"] === "member-menu-button";
  }
  if (sel === 'button[aria-label*="actions" i]') {
    return (
      btn.tag === "button" &&
      (btn.attrs["aria-label"] ?? "").toLowerCase().includes("actions")
    );
  }
  if (sel === 'button[aria-haspopup="menu"]') {
    return btn.tag === "button" && btn.attrs["aria-haspopup"] === "menu";
  }
  if (sel === '[role="button"][aria-haspopup="menu"]') {
    return btn.attrs["role"] === "button" && btn.attrs["aria-haspopup"] === "menu";
  }
  throw new Error(`selector chưa hỗ trợ trong test: ${sel}`);
}

/** Row giả: mỗi button thành object có `textContent` + `getAttribute`. */
function makeRow(buttons: FakeButton[]): HTMLElement {
  const els = buttons.map((b) => ({
    __fake: b,
    textContent: b.text,
    getAttribute: (k: string) => b.attrs[k] ?? null,
  }));
  const pick = (selector: string) =>
    els.filter((el) =>
      selector.split(",").some((one) => matches(el.__fake, one)),
    );
  return {
    querySelector: (s: string) => pick(s)[0] ?? null,
    querySelectorAll: (s: string) => pick(s),
  } as unknown as HTMLElement;
}

const ROLE_DROPDOWN: FakeButton = {
  tag: "button",
  text: "Member",
  attrs: { "aria-haspopup": "menu" },
};
/** Nút "..." sau update 18/8/2026: chỉ còn icon, không attribute định danh. */
const KEBAB_2026_08_18: FakeButton = {
  tag: "button",
  text: "",
  attrs: { "aria-haspopup": "menu" },
};

describe("findRowMenuButton", () => {
  it("UI 18/8/2026: bỏ qua dropdown vai trò đứng trước, lấy nút '...' rỗng chữ", () => {
    const row = makeRow([ROLE_DROPDOWN, KEBAB_2026_08_18]);
    expect(findRowMenuButton(row)?.textContent).toBe("");
  });

  it("dropdown vai trò tiếng Việt cũng không bị lấy nhầm", () => {
    const row = makeRow([
      { tag: "button", text: "Thành viên", attrs: { "aria-haspopup": "menu" } },
      KEBAB_2026_08_18,
    ]);
    expect(findRowMenuButton(row)?.textContent).toBe("");
  });

  it("UI cũ còn data-testid thì dùng luôn selector định danh", () => {
    const row = makeRow([
      ROLE_DROPDOWN,
      {
        tag: "button",
        text: "",
        attrs: { "aria-haspopup": "menu", "data-testid": "member-menu-button" },
      },
    ]);
    expect(findRowMenuButton(row)?.getAttribute("data-testid")).toBe(
      "member-menu-button",
    );
  });

  it("có thêm nút icon khác thì '...' vẫn là nút icon CUỐI row", () => {
    const iconEarly: FakeButton = {
      tag: "button",
      text: "",
      attrs: { "aria-haspopup": "menu", "data-x": "seat" },
    };
    const row = makeRow([iconEarly, ROLE_DROPDOWN, KEBAB_2026_08_18]);
    expect(findRowMenuButton(row)).toBe(
      (row.querySelectorAll('button[aria-haspopup="menu"]') as unknown as unknown[])[2],
    );
  });

  it("row chỉ có 1 button popup (không có dropdown vai trò) → chính nó là '...'", () => {
    const only: FakeButton = {
      tag: "button",
      text: "Actions",
      attrs: { "aria-haspopup": "menu" },
    };
    const row = makeRow([only]);
    expect(findRowMenuButton(row)?.textContent).toBe("Actions");
  });

  it("nhiều button popup mà cái nào cũng có chữ → trả null, KHÔNG đoán bừa", () => {
    const row = makeRow([
      ROLE_DROPDOWN,
      { tag: "button", text: "ChatGPT", attrs: { "aria-haspopup": "menu" } },
    ]);
    expect(findRowMenuButton(row)).toBeNull();
  });
});
