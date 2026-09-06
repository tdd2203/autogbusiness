/**
 * VẮNG MẶT Ở TAB "LỜI MỜI" PHẢI CHỨNG MINH ĐƯỢC.
 *
 * `lookupPendingRow` trả `absent` ⇒ `revokeInvite` trả `notInPending` ⇒ lệnh gỡ
 * ký `absent_confirmed` ⇒ backend mark member `removed` mà KHÔNG click xoá lần
 * nào ⇒ MỘT GHẾ được nhả. Sai một lần là email vẫn ngồi trên ChatGPT trong khi
 * dashboard đã bán chỗ đó cho người tiếp theo (ca GPT1 5/9/2026, vượt trần
 * 387/386).
 *
 * Cái bẫy: danh sách lời mời là VIRTUALIZED. Cuộn chỉ render phần gần viewport,
 * nên "quét không thấy" và "không có" trông y hệt nhau — đúng bài học đã phải
 * chữa ở tab "Người dùng" bằng `preferFilter` (user 15/7/2026: *"check 6 email
 * nhưng chỉ đúng 1"*). Bộ test này dựng lại đúng các kiểu "list nói dối" đó và
 * đòi `lookupPendingRow` KHÔNG được kết luận vắng mặt trong các ca ấy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Đồng hồ ảo — mọi `sleep`/`Date.now()` trong code đều đọc mốc này. */
let now = 0;
function tick(ms: number): Promise<void> {
  now += ms;
  vi.setSystemTime(now);
  return Promise.resolve();
}

type Options = {
  /** Email THẬT SỰ đang có lời mời treo. */
  pending: string[];
  /** Cuộn chỉ render được bấy nhiêu email đầu (list virtualized). */
  scanWindow?: number;
  /** Không có ô "Search for invites" trên trang. */
  noSearchBox?: boolean;
  /** Gõ vào ô tìm kiếm KHÔNG tác động gì tới list (ô tìm kiếm chết). */
  searchDead?: boolean;
  /** Xoá ô tìm kiếm mà list KHÔNG đầy lại. */
  neverRestores?: boolean;
  /** Có thanh phân trang (⇒ bỏ nhánh quét vị trí). */
  paginated?: boolean;
};

class FakeList {
  query = "";
  constructor(readonly o: Options) {}

  /** Email đang HIỆN trên DOM. */
  visible(): string[] {
    if (this.query === "") return this.o.pending;
    return this.o.pending.filter((e) => e.includes(this.query));
  }
  rows(): number {
    return this.visible().length;
  }
  /** Cuộn quét: virtualized nên chỉ thấy `scanWindow` email đầu. */
  scanned(): string[] {
    return this.o.pending.slice(0, this.o.scanWindow ?? this.o.pending.length);
  }
}

let list: FakeList;

/**
 * Ô tìm kiếm THẬT của ChatGPT là input React: code sản xuất ghi giá trị bằng
 * native setter rồi mới `dispatchEvent("input")` — chính cú dispatch đó mới kích
 * hoạt truy vấn. Bản giả này giữ đúng nhịp ấy, nhờ vậy hai kiểu hỏng dựng được
 * riêng rẽ: gõ mà truy vấn không chạy (`searchDead`) và xoá mà list không đầy lại
 * (`neverRestores`).
 */
class FakeInput {
  placeholder = "Search for invites";
  private _v = "";
  get value(): string {
    return this._v;
  }
  set value(v: string) {
    this._v = v;
  }
  dispatchEvent(): boolean {
    if (this._v !== "" && list.o.searchDead) return true;
    if (this._v === "" && list.o.neverRestores) return true;
    list.query = this._v;
    return true;
  }
}
let input: FakeInput;

vi.mock("../../human", () => ({
  humanType: async (el: { value: string; dispatchEvent: () => boolean }, text: string) => {
    await tick(150);
    el.value = text;
    el.dispatchEvent();
  },
  querySelectorFirst: () => (list.o.noSearchBox ? null : input),
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
vi.mock("../../selectors", () => ({ SELECTORS: { pendingSearchInput: [], memberFilterInput: [] } }));
vi.mock("../invite/pending-list-loaded", () => ({
  readPendingSnapshot: () => ({ rows: list.rows() }),
}));
vi.mock("../member-row", () => ({
  findMemberRow: (email: string) =>
    list.visible().includes(email) ? ({ tagName: "TR" } as unknown as HTMLElement) : null,
}));
vi.mock("../remove/locate-member", () => ({
  scrollScanForRow: async (email: string) => {
    await tick(300);
    return list.scanned().includes(email)
      ? ({ tagName: "TR" } as unknown as HTMLElement)
      : null;
  },
}));
vi.mock("../sync/pagination", () => ({
  findPaginationState: () => (list.o.paginated ? { current: 1, total: 3 } : null),
}));
// `clearPendingSearch` ghi qua native setter của HTMLInputElement rồi dispatch —
// stub phải cho cú ghi đó chạm tới được ô giả, nếu không mọi lần xoá đều thành
// "list không đầy lại" và test tưởng nhầm là code sai.
vi.stubGlobal("window", {
  HTMLInputElement: {
    prototype: Object.defineProperty({}, "value", {
      configurable: true,
      set(this: { value: string }, v: string) {
        this.value = v;
      },
    }),
  },
});

const { lookupPendingRow } = await import("./locate-pending-row");

function setup(o: Options): void {
  now = 0;
  vi.setSystemTime(0);
  list = new FakeList(o);
  input = new FakeInput();
}

beforeEach(() => vi.useFakeTimers());

describe("lookupPendingRow — vắng mặt phải chứng minh được", () => {
  it("KHÔNG có ô tìm kiếm + quét không thấy → inconclusive, KHÔNG dám nói vắng mặt", async () => {
    // 40 lời mời, cuộn chỉ render 5 email đầu, email cần tìm nằm ở cuối.
    setup({
      pending: Array.from({ length: 40 }, (_, i) => `p${i}@x.com`),
      scanWindow: 5,
      noSearchBox: true,
    });

    const r = await lookupPendingRow("p39@x.com");

    expect(r.outcome).toBe("inconclusive");
    expect(r.outcome === "inconclusive" && r.reason).toBe("no_pending_search_input");
  });

  it("ô tìm kiếm CHẾT (gõ vào list không đổi, xoá cũng không đầy lại) → inconclusive", async () => {
    setup({
      pending: Array.from({ length: 40 }, (_, i) => `p${i}@x.com`),
      scanWindow: 5,
      searchDead: true,
      neverRestores: true,
    });

    const r = await lookupPendingRow("khong-co@x.com");

    expect(r.outcome).toBe("inconclusive");
    expect(r.outcome === "inconclusive" && r.reason).toBe("pending_search_dead");
  });

  it("quét trượt vì list virtualized NHƯNG ô tìm kiếm lôi ra được → found", async () => {
    // Đây đúng là ca đã kết luận nhầm `notInPending` trước 6/9/2026.
    setup({
      pending: Array.from({ length: 40 }, (_, i) => `p${i}@x.com`),
      scanWindow: 5,
    });

    const r = await lookupPendingRow("p39@x.com");

    expect(r.outcome).toBe("found");
  });

  it("ô tìm kiếm trống VÀ xoá đi list đầy lại → mới được kết luận absent", async () => {
    setup({
      pending: Array.from({ length: 40 }, (_, i) => `p${i}@x.com`),
      scanWindow: 5,
    });

    const r = await lookupPendingRow("khong-he-co@x.com");

    expect(r.outcome).toBe("absent");
    expect(r.outcome === "absent" && r.rows_before).toBe(40);
  });

  it("quét vị trí thấy ngay (list 1 trang, nhỏ) → found, không đụng ô tìm kiếm", async () => {
    setup({ pending: ["a@x.com", "b@x.com"] });

    const r = await lookupPendingRow("b@x.com");

    expect(r.outcome).toBe("found");
    expect(input.value).toBe("");
  });
});
