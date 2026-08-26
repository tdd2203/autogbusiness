/**
 * `filterLookupOnce` — tra 1 email bằng ô "Lọc theo tên" mà CHỈ GÕ 1 LẦN.
 *
 * Yêu cầu user 2026-08-26: lệnh "Đồng bộ (kiểm tra đã tham gia)" hàng loạt không
 * được nhập cùng một email vào ô tìm kiếm hai lần. Bộ test này canh đúng hai vế:
 *   · SỐ LẦN GÕ: ca thường (thấy / không thấy) phải đúng 1 lần `humanType`.
 *   · KHÔNG BÁO OAN: ca query bị nuốt (list đứng im) vẫn phải gõ lại rồi trả
 *     'inconclusive' thay vì 'absent' — 'absent' ở đây nghĩa là "chưa tham gia",
 *     báo sai thì người đã tham gia bị giữ nguyên trạng thái chờ.
 *
 * Không có jsdom → dựng DOM tối thiểu: `document.querySelectorAll` trả các row
 * giả có `textContent` chứa email. Đồng hồ ảo nên test chạy tức thì.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let now = 0;
function tick(ms: number): Promise<void> {
  now += ms;
  vi.setSystemTime(now);
  return Promise.resolve();
}

type ListOptions = {
  members: string[];
  /** Lọc server-side: sau khi gõ, list trống bấy nhiêu ms rồi mới đổ row khớp. */
  serverLagMs?: number;
  /** Gõ vào ô lọc KHÔNG tác động gì tới list (event bị Chrome throttle nuốt). */
  filterDead?: boolean;
};

class FakeList {
  filter = "";
  typedAt = -1;
  constructor(private o: ListOptions) {}

  onInput(value: string): void {
    if (this.o.filterDead) return;
    this.filter = value;
    this.typedAt = now;
  }

  rendered(): string[] {
    if (this.filter === "") return this.o.members;
    if (now < this.typedAt + (this.o.serverLagMs ?? 0)) return [];
    return this.o.members.filter((m) => m.includes(this.filter));
  }
}

class FakeInput {
  private _value = "";
  placeholder = "Lọc theo tên";
  get value(): string {
    return this._value;
  }
  set value(v: string) {
    this._value = v;
    list.onInput(v);
  }
  dispatchEvent(): boolean {
    return true;
  }
}

let list: FakeList;
let input: FakeInput;
let typeCount = 0;
/** Row giả PHẢI ổn định giữa các lần querySelectorAll (dedupe theo element). */
const rowCache = new Map<string, { textContent: string }>();

vi.mock("../../human", () => ({
  humanType: async (el: { value: string }, text: string) => {
    typeCount += 1;
    await tick(150);
    el.value = text;
  },
  querySelectorFirst: () => input,
  sleep: (ms: number) => tick(ms),
  waitFor: async <T>(fn: () => T, timeoutMs: number, stepMs: number) => {
    const deadline = now + timeoutMs;
    while (now < deadline) {
      const v = fn();
      if (v) return v;
      await tick(stepMs);
    }
    throw new Error("waitFor timeout");
  },
}));

vi.mock("../member-row", () => ({
  findMemberRow: (email: string) =>
    list.rendered().includes(email) ? ({ tagName: "TR" } as unknown as HTMLElement) : null,
}));

const { filterLookupOnce } = await import("./member-filter");

const TARGET = "cho-tham-gia@example.com";
const OTHERS = Array.from({ length: 30 }, (_, i) => `member${i}@example.com`);

function setup(o: ListOptions): void {
  now = 0;
  typeCount = 0;
  rowCache.clear();
  vi.setSystemTime(0);
  list = new FakeList(o);
  input = new FakeInput();
  globalThis.document = {
    querySelectorAll: () =>
      list.rendered().map((email) => {
        let row = rowCache.get(email);
        if (!row) {
          row = { textContent: `Ảnh ${email} Thành viên` };
          rowCache.set(email, row);
        }
        return row;
      }),
  } as unknown as Document;
  (globalThis as { window?: unknown }).window = { HTMLInputElement: FakeInput };
  (globalThis as { Event?: unknown }).Event = class {
    constructor(public type: string) {}
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("filterLookupOnce — gõ ô tìm kiếm ĐÚNG 1 lần", () => {
  it("email ĐÃ tham gia → found, chỉ gõ 1 lần", async () => {
    setup({ members: [...OTHERS, TARGET], serverLagMs: 300 });
    const r = await filterLookupOnce(TARGET);
    expect(r.outcome).toBe("found");
    expect(typeCount).toBe(1);
  });

  it("email CHƯA tham gia (list render lại, trống) → absent, chỉ gõ 1 lần", async () => {
    setup({ members: OTHERS, serverLagMs: 300 });
    const r = await filterLookupOnce(TARGET);
    expect(r.outcome).toBe("absent");
    expect(r.filterResponded).toBe(true);
    expect(typeCount).toBe(1);
  });

  it("row về TRỄ 3s → vẫn found, không cần gõ lại", async () => {
    setup({ members: [...OTHERS, TARGET], serverLagMs: 3000 });
    const r = await filterLookupOnce(TARGET);
    expect(r.outcome).toBe("found");
    expect(typeCount).toBe(1);
  });

  it("query bị nuốt (list đứng im) → gõ lại rồi 'inconclusive', KHÔNG báo absent oan", async () => {
    setup({ members: OTHERS, filterDead: true });
    const r = await filterLookupOnce(TARGET);
    expect(r.outcome).toBe("inconclusive");
    expect(r.reason).toBe("filter_never_applied");
    expect(typeCount).toBe(2);
  });

  it("list vốn trống + ô lọc đã chứng minh còn sống → absent, vẫn 1 lần gõ", async () => {
    // Email thứ 2 trở đi trong mẻ hàng loạt: list đang trống từ email trước nên
    // không có gì để "đổi" — nhưng ô lọc đã phản hồi ở email trước.
    setup({ members: [], filterDead: true });
    const r = await filterLookupOnce(TARGET, { assumeFilterAlive: true });
    expect(r.outcome).toBe("absent");
    expect(typeCount).toBe(1);
  });
});
