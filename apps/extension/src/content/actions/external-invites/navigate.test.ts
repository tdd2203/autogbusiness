/**
 * `navigateTo(..., {spaFirst})` — chốt bằng test vì nó canh đúng ranh giới giữa
 * "đổi trang mà KHÔNG rời trang" (pushState, an toàn cho kênh message) và "click
 * link" (có thể là điều hướng thật → trang bị đẩy vào back/forward cache → kênh
 * đứt → kết quả không về được background). Chỗ gọi nó là `softReloadMembersPage`
 * trong `ensure-seats.ts`, chạy SAU KHI ĐÃ TRỪ TIỀN mua suất.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { navigateTo } from "./navigate";

/** DOM tối thiểu: một sidebar link + đếm số lần bị click. */
function setupDom(opts: { withLink: boolean }): { clicks: () => number } {
  let clicks = 0;
  const link = {
    getAttribute: () => "/admin/members",
    pathname: "/admin/members",
    click: () => {
      clicks++;
    },
  };
  vi.stubGlobal("document", {
    querySelectorAll: () => (opts.withLink ? [link] : []),
  });
  return { clicks: () => clicks };
}

/** `location` + `history` giả: pushState đổi pathname như trình duyệt thật. */
function setupNav(startPath: string): { path: () => string } {
  const loc = { pathname: startPath, search: "", href: "" };
  vi.stubGlobal("location", loc);
  vi.stubGlobal("history", {
    pushState: (_s: unknown, _t: string, url: string) => {
      loc.pathname = url;
    },
  });
  vi.stubGlobal("PopStateEvent", class {} as unknown as typeof PopStateEvent);
  vi.stubGlobal("window", { dispatchEvent: () => true });
  return { path: () => loc.pathname };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("navigateTo với spaFirst", () => {
  it("React nghe popstate → KHÔNG đụng tới link (không có cửa nào cho bfcache)", async () => {
    setupNav("/admin/billing");
    const dom = setupDom({ withLink: true });
    // Trang render ngay sau pushState.
    const ok = await navigateTo("/admin/members", () => true, 10_000, {
      spaFirst: true,
    });
    expect(ok).toBe(true);
    expect(dom.clicks()).toBe(0);
  });

  it("pushState không làm trang render → mới click link như cũ", async () => {
    setupNav("/admin/billing");
    const dom = setupDom({ withLink: true });
    let rendered = false;
    const ok = await navigateTo(
      "/admin/members",
      () => rendered,
      3_000,
      // spaFirstMs ngắn để test không chờ lâu; click link xong thì coi như render.
      { spaFirst: true, spaFirstMs: 100 },
    );
    // Sau khi click, predicate vẫn false tới hết timeout → trả false, nhưng điều
    // quan trọng là ĐÃ thử pushState trước rồi mới click.
    expect(dom.clicks()).toBe(1);
    expect(ok).toBe(false);
    rendered = true;
  });

  it("mặc định (không spaFirst) giữ nguyên hành vi cũ: click link ngay", async () => {
    setupNav("/admin/billing");
    const dom = setupDom({ withLink: true });
    const ok = await navigateTo("/admin/members", () => true, 10_000);
    expect(ok).toBe(true);
    expect(dom.clicks()).toBe(1);
  });

  it("đã ở đúng trang rồi thì không điều hướng gì cả", async () => {
    setupNav("/admin/members");
    const dom = setupDom({ withLink: true });
    const ok = await navigateTo("/admin/members", () => true, 10_000, {
      spaFirst: true,
    });
    expect(ok).toBe(true);
    expect(dom.clicks()).toBe(0);
  });

  it("không có sidebar link → pushState (đường fallback cũ)", async () => {
    const nav = setupNav("/admin/billing");
    setupDom({ withLink: false });
    const ok = await navigateTo("/admin/members", () => true, 10_000);
    expect(ok).toBe(true);
    expect(nav.path()).toBe("/admin/members");
  });
});
