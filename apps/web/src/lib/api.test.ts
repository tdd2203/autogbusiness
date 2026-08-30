/**
 * Hạn giờ của `api()` — lý do có file test này: trước 2026-08-30 `fetch` chạy không
 * hạn giờ, nên một lượt gọi bị server ngậm là màn hình treo ở "…" vĩnh viễn
 * (react-query không mở lượt mới khi lượt cũ còn bay). Chỗ dễ vỡ lại là chỗ khó
 * thấy bằng mắt, nên chốt bằng test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, ApiTimeoutError, apiErrorText } from "./api";

/** localStorage không có sẵn trong môi trường node của vitest — `getToken` cần nó. */
function stubStorage(): void {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  });
}

/** Server ngậm kết nối: không trả lời, chỉ chịu dừng khi bị abort. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init: RequestInit = {}) =>
      new Promise<Response>((_ok, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
}

beforeEach(() => {
  stubStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api() hết giờ chờ", () => {
  it("bỏ cuộc thay vì treo mãi", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    await expect(api("/api/v1/wallet", { timeoutMs: 20 })).rejects.toBeInstanceOf(
      ApiTimeoutError,
    );
  });

  it("GET thì xui thử lại", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const err = await api("/api/v1/wallet", { timeoutMs: 20 }).catch((e) => e);
    expect(apiErrorText(err)).toContain("Kiểm tra mạng rồi thử lại");
  });

  it("lệnh GHI thì KHÔNG xui bấm lại — chưa biết nó đã chạy hay chưa", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const err = await api("/api/v1/wallet/topups", {
      method: "POST",
      body: "{}",
      timeoutMs: 20,
    }).catch((e) => e);
    expect(apiErrorText(err)).toContain("Chưa rõ việc đã chạy hay chưa");
  });

  it("`timeoutMs: null` = không đặt hạn (dành cho luồng dài)", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const race = await Promise.race([
      api("/api/v1/wallet", { timeoutMs: null }).catch(() => "vỡ"),
      new Promise((ok) => setTimeout(() => ok("vẫn chờ"), 60)),
    ]);
    expect(race).toBe("vẫn chờ");
  });

  it("trả lời kịp thì vẫn là dữ liệu bình thường", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ balance: 2310000 }), { status: 200 })),
    );
    await expect(api("/api/v1/wallet", { timeoutMs: 500 })).resolves.toEqual({
      balance: 2310000,
    });
  });
});

describe("api() lỗi mạng", () => {
  it("TypeError của fetch được gói thành câu tiếng Việt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const err = await api("/api/v1/wallet").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);
    expect(apiErrorText(err)).toContain("Không kết nối được máy chủ");
  });

  it("người gọi tự huỷ thì giữ nguyên AbortError, không nhận vơ là hết giờ", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const ctl = new AbortController();
    const p = api("/api/v1/wallet", { signal: ctl.signal, timeoutMs: 5_000 }).catch((e) => e);
    ctl.abort();
    const err = await p;
    expect(err).not.toBeInstanceOf(ApiTimeoutError);
    expect((err as DOMException).name).toBe("AbortError");
  });
});

describe("apiErrorText", () => {
  it("bóc được cả `detail` chuỗi lẫn `{message}`", () => {
    expect(apiErrorText(new ApiError(400, "Số dư không đủ"))).toBe("Số dư không đủ");
    expect(
      apiErrorText(new ApiError(429, { code: "RATE_LIMITED", message: "Chậm thôi" })),
    ).toBe("Chậm thôi");
  });

  it("lỗi lạ thì rơi về câu mặc định thay vì [object Object]", () => {
    expect(apiErrorText(null)).toBe("Không tải được dữ liệu.");
    expect(apiErrorText({}, "Không đọc được sổ.")).toBe("Không đọc được sổ.");
  });
});
