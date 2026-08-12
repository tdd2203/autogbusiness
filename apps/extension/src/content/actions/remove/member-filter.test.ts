/**
 * GUARD chống XOÁ-GIẢ (sự cố 03→12/8/2026).
 *
 * `filterOnceAndResolve` trả `absent` ⇒ backend mark member `removed` mà KHÔNG
 * click xoá lần nào. Sai một lần = email vẫn nằm trên ChatGPT (vẫn ăn ghế) trong
 * khi dashboard tưởng đã xoá, tới lần full sync sau mới lộ (lần đó cách 11 ngày).
 * Nên bộ test này dựng lại đúng các kiểu "list nói dối" đã gây sự cố và đòi
 * `filterOnceAndResolve` KHÔNG được kết luận vắng mặt trong các ca đó.
 *
 * Không có jsdom trong repo → dựng DOM tối thiểu: chỉ `document.querySelectorAll`
 * (đếm row) + 1 ô input giả. Thời gian chạy bằng đồng hồ ảo (mọi `sleep` đều đi
 * qua mock) nên test tức thì và tất định.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Đồng hồ ảo — mọi `sleep`/`Date.now()` trong code đều đọc mốc này. */
let now = 0;
function tick(ms: number): Promise<void> {
  now += ms;
  vi.setSystemTime(now);
  return Promise.resolve();
}

type ListOptions = {
  /** Email đang có trong workspace. */
  members: string[];
  /**
   * List là VIRTUALIZED: khi chưa lọc, DOM chỉ render bấy nhiêu row đầu. Member
   * nằm ngoài cửa sổ này CÓ trong workspace nhưng KHÔNG có trong DOM — chỉ ô lọc
   * server-side mới lôi ra được. Mặc định: render hết.
   */
  windowSize?: number;
  /** Tới mốc này list vẫn đang stream row (số row TỰ TĂNG dù chưa lọc). */
  streamUntilMs?: number;
  /** Lọc là server-side: sau khi gõ, list trống bấy nhiêu ms rồi mới đổ row khớp. */
  serverLagMs?: number;
  /** Gõ vào ô lọc KHÔNG tác động gì tới list (event bị Chrome throttle nuốt). */
  filterDead?: boolean;
  /** Clear ô lọc KHÔNG làm list đầy lại (ô lọc/list đã chết giữa chừng). */
  neverRestores?: boolean;
};

/** Mô phỏng tab "Người dùng" của ChatGPT: stream lúc mở + lọc server-side. */
class FakeList {
  filter = "";
  typedAt = -1;
  constructor(private o: ListOptions) {}

  private streaming(): boolean {
    return now < (this.o.streamUntilMs ?? 0);
  }

  onInput(value: string): void {
    if (this.o.filterDead) return;
    if (value === "" && this.o.neverRestores) return;
    this.filter = value;
    this.typedAt = now;
  }

  rendered(): string[] {
    if (this.filter === "") {
      const windowSize = this.o.windowSize ?? this.o.members.length;
      // Lúc mới mở tab, list đổ row dần → số row tự tăng theo thời gian.
      const shown = this.streaming()
        ? Math.min(windowSize, 1 + Math.floor(now / 500))
        : windowSize;
      return this.o.members.slice(0, shown);
    }
    // Fetch lọc chưa về → ChatGPT hiện list TRỐNG (skeleton). Đây đúng khoảng
    // "nháy trống" mà bản cũ chốt luôn là `absent` sau 1 nhịp 1.2s.
    if (now < this.typedAt + (this.o.serverLagMs ?? 0)) return [];
    return this.o.members.filter((m) => m.includes(this.filter));
  }

  rowCount(): number {
    // +1 = hàng tiêu đề của bảng, luôn hiện diện (giống DOM thật).
    return this.rendered().length + 1;
  }
}

let list: FakeList;
let input: FakeInput;

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

vi.mock("../../human", () => ({
  humanType: async (el: { value: string }, text: string) => {
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

const { filterOnceAndResolve } = await import("./member-filter");

const TARGET = "expired-member@example.com";
/** Workspace thật ~150 member; ở đây 30 là đủ để cửa sổ virtualized không chứa TARGET. */
const OTHERS = Array.from({ length: 30 }, (_, i) => `member${i}@example.com`);
/** TARGET nằm CUỐI list ⇒ ngoài cửa sổ render → chỉ ô lọc mới lôi ra được. */
const WITH_TARGET = [...OTHERS, TARGET];

function setup(o: ListOptions): void {
  now = 0;
  vi.setSystemTime(0);
  list = new FakeList(o);
  input = new FakeInput();
  globalThis.document = {
    querySelectorAll: () => ({ length: list.rowCount() }),
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

describe("filterOnceAndResolve — chống xoá-giả", () => {
  it("lọc server-side trả row TRỄ 4s → 'found', KHÔNG kết luận vắng mặt", async () => {
    // Ca gây sự cố 09/8: list nháy trống sau khi gõ, row khớp về muộn hơn 1.2s.
    setup({ members: WITH_TARGET, windowSize: 20, serverLagMs: 4000 });
    const r = await filterOnceAndResolve(TARGET);
    expect(r.outcome).toBe("found");
  });

  it("list còn đang stream row (chưa load xong) → 'inconclusive', không chốt absent", async () => {
    // `rows_before` chụp lúc list còn đổ row → số row tự tăng. Bản cũ hiểu nhầm
    // "số row đổi = query lọc đã chạy" → chốt absent oan.
    setup({
      members: WITH_TARGET,
      windowSize: 30,
      streamUntilMs: 30_000,
      serverLagMs: 500,
    });
    const r = await filterOnceAndResolve(TARGET);
    expect(r.outcome).toBe("inconclusive");
    if (r.outcome === "inconclusive") expect(r.reason).toBe("list_never_settled");
  });

  it("gõ ô lọc không tác động gì (event bị nuốt) → 'inconclusive'", async () => {
    setup({ members: WITH_TARGET, windowSize: 20, filterDead: true });
    const r = await filterOnceAndResolve(TARGET);
    expect(r.outcome).toBe("inconclusive");
    if (r.outcome === "inconclusive")
      expect(r.reason).toBe("filter_never_applied_round_1");
  });

  it("clear ô lọc mà list KHÔNG đầy lại → 'inconclusive' (ô lọc không đáng tin)", async () => {
    setup({ members: OTHERS, serverLagMs: 300, neverRestores: true });
    const r = await filterOnceAndResolve(TARGET);
    expect(r.outcome).toBe("inconclusive");
    if (r.outcome === "inconclusive") expect(r.reason).toBe("filter_box_dead");
  });

  it("vắng mặt THẬT (list khoẻ, 2 vòng đều trống) → 'absent'", async () => {
    setup({ members: OTHERS, serverLagMs: 300 });
    const r = await filterOnceAndResolve(TARGET);
    expect(r.outcome).toBe("absent");
  });

  it("confirmRounds=1 (đường xác minh sau click) vẫn kết luận được absent", async () => {
    setup({ members: OTHERS, serverLagMs: 300 });
    const r = await filterOnceAndResolve(TARGET, {
      confirmRounds: 1,
      requireStableList: false,
    });
    expect(r.outcome).toBe("absent");
  });
});
