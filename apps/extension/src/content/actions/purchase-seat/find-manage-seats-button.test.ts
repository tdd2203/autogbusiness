/**
 * UI 4/9/2026: nút mở hộp "Quản lý suất" chỉ còn một chữ "Quản lý"/"Manage" và
 * MỖI thẻ suất có một nút như vậy. Test chốt: bám đúng thẻ suất, ưu tiên thẻ
 * Tiêu chuẩn, và KHÔNG vơ nút "Quản lý" của khu khác trên trang.
 *
 * Repo không có jsdom → dựng cây DOM giả tối thiểu (mirror find-seat-stepper.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { findManageButtonOnSeatCard } from "./find-manage-seats-button";

class E {
  parent: E | null = null;
  kids: E[] = [];
  attrs: Record<string, string> = {};
  constructor(
    public tag: string,
    public ownText = "",
  ) {}
  add(...kids: E[]): this {
    for (const k of kids) {
      k.parent = this;
      this.kids.push(k);
    }
    return this;
  }
  get parentElement(): E | null {
    return this.parent;
  }
  get offsetParent(): E | null {
    return this.parent;
  }
  get textContent(): string {
    return this.kids.length === 0
      ? this.ownText
      : this.kids.map((k) => k.textContent).join(" ");
  }
  hasAttribute(n: string): boolean {
    return n in this.attrs;
  }
  getAttribute(n: string): string | null {
    return this.attrs[n] ?? null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 20, height: 20, right: 20, bottom: 20 };
  }
  matches(sel: string): boolean {
    return sel.split(",").some((raw) => {
      const s = raw.trim();
      if (s === '[role="button"]') return this.attrs["role"] === "button";
      return s === this.tag;
    });
  }
  descendants(): E[] {
    return this.kids.flatMap((k) => [k, ...k.descendants()]);
  }
  querySelectorAll(sel: string): E[] {
    return this.descendants().filter((d) => d.matches(sel));
  }
}

const el = (tag: string, text = "") => new E(tag, text);

/** Một thẻ suất của UI 4/9/2026. */
function seatCard(label: string, total: number, assigned: number, free: number): E {
  return el("div").add(
    el("div").add(el("span", String(total)), el("button", "Quản lý")),
    el("div", label),
    el("div").add(
      el("div").add(el("div", String(assigned)), el("div", "Đã gán")),
      el("div").add(el("div", String(free)), el("div", "Khả dụng")),
    ),
  );
}

function page(...cards: E[]): E {
  const body = el("div").add(
    el("nav").add(el("button", "Quản lý"), el("a", "Quản lý")), // khu khác, KHÔNG phải thẻ suất
    el("div").add(...cards),
    el("button", "+ Mời thành viên"),
  );
  vi.stubGlobal("document", { querySelectorAll: (sel: string) => body.querySelectorAll(sel) });
  return body;
}

afterEach(() => vi.unstubAllGlobals());

describe("findManageButtonOnSeatCard", () => {
  it("chọn nút 'Quản lý' của thẻ Tiêu chuẩn, không phải thẻ Cao cấp", () => {
    page(
      seatCard("Suất Tiêu chuẩn", 360, 340, 20),
      seatCard("Suất Cao cấp", 0, 0, 0),
    );
    const btn = findManageButtonOnSeatCard()! as unknown as E;
    expect(btn).not.toBeNull();
    // Thẻ chứa nút phải là thẻ Tiêu chuẩn.
    expect(btn.parentElement!.parentElement!.textContent).toContain("Tiêu chuẩn");
  });

  it("thẻ Cao cấp đứng trước vẫn ghim đúng thẻ Tiêu chuẩn", () => {
    page(seatCard("Suất Cao cấp", 0, 0, 0), seatCard("Suất Tiêu chuẩn", 360, 340, 20));
    const btn = findManageButtonOnSeatCard()! as unknown as E;
    expect(btn.parentElement!.parentElement!.textContent).toContain("Tiêu chuẩn");
  });

  it("bản tiếng Anh", () => {
    page(
      el("div").add(
        el("div").add(el("span", "360"), el("button", "Manage")),
        el("div", "Standard seats"),
        el("div").add(el("div", "340"), el("div", "Assigned"), el("div", "20"), el("div", "Available")),
      ),
    );
    expect(findManageButtonOnSeatCard()).not.toBeNull();
  });

  it("trang không có thẻ suất nào ⇒ null, KHÔNG vơ nút 'Quản lý' khác", () => {
    page();
    expect(findManageButtonOnSeatCard()).toBeNull();
  });
});
