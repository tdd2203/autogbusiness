/**
 * Chốt bằng test cái đắt nhất của luồng mua: SAU khi đã bấm "Xác nhận mua" (tiền
 * đã trừ), phải chờ hộp đóng HẲN rồi mới cho caller đi mời tiếp.
 *
 * Ca thật 24/8/2026 — lệnh mời wallet_tester: bản cũ chờ 10s rồi bỏ đi mời trong
 * khi ChatGPT còn đang xử lý giao dịch; hộp là lớp phủ chặn cả trang nên cú mời
 * hỏng, user phải chạy lệnh thứ hai. Ba thứ được chốt ở đây: chờ đủ lâu, không
 * tin một khung hình "đã đóng" thoáng qua, và báo được khi lớp phủ còn nằm lại.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { waitForChargeModalDismiss } from "./wait-dismiss";

type FakeEl = {
  state: string | null;
  hidden: boolean;
  /** Chữ đang in trong hộp — dùng để dựng ca ChatGPT in băng-rôn lỗi. */
  textContent: string;
  children: FakeEl[];
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { width: number; height: number };
};

/** Ép kiểu cho gọn: hàm chỉ đụng vào contains/getAttribute/getComputedStyle. */
const asEl = (el: FakeEl): HTMLElement => el as unknown as HTMLElement;

function makeEl(state: string | null = "open", text = ""): FakeEl {
  return {
    state,
    hidden: false,
    textContent: text,
    children: [],
    getAttribute(name: string) {
      return name === "data-state" ? this.state : null;
    },
    getBoundingClientRect() {
      return { width: 400, height: 300 };
    },
  };
}

/** DOM tối thiểu: một tập node đang nằm trong trang + getComputedStyle giả. */
function setupDom(nodes: FakeEl[]): { remove: (el: FakeEl) => void } {
  const inDom = new Set(nodes);
  vi.stubGlobal("document", {
    body: { contains: (el: FakeEl) => inDom.has(el) },
    querySelectorAll: () => Array.from(inDom),
  });
  vi.stubGlobal("window", {
    getComputedStyle: (el: FakeEl) => ({
      display: el.hidden ? "none" : "block",
      visibility: "visible",
    }),
  });
  return { remove: (el: FakeEl) => inDom.delete(el) };
}

describe("waitForChargeModalDismiss", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("chờ quá 10s — hộp đóng ở giây thứ 40 vẫn tính là mua xong", async () => {
    const modal = makeEl();
    const dom = setupDom([modal]);

    let done: Awaited<ReturnType<typeof waitForChargeModalDismiss>> | null = null;
    void waitForChargeModalDismiss(asEl(modal)).then((r) => {
      done = r;
    });

    // Mốc bản cũ bỏ cuộc: 10s. Hộp còn mở → chưa được kết luận gì.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(done).toBeNull();

    await vi.advanceTimersByTimeAsync(30_000);
    dom.remove(modal); // ChatGPT xử lý xong, hộp rời DOM
    await vi.advanceTimersByTimeAsync(5_000);

    expect(done).toMatchObject({ dismissed: true, overlayCleared: true });
    expect(done!.waitedMs).toBeGreaterThanOrEqual(40_000);
  });

  it("một khung hình 'đã đóng' thoáng qua KHÔNG được tính là đóng", async () => {
    const modal = makeEl();
    setupDom([modal]);

    let done: Awaited<ReturnType<typeof waitForChargeModalDismiss>> | null = null;
    void waitForChargeModalDismiss(asEl(modal)).then((r) => {
      done = r;
    });

    await vi.advanceTimersByTimeAsync(2_000);
    modal.state = "closed"; // nhịp animation
    await vi.advanceTimersByTimeAsync(500);
    modal.state = "open"; // vẫn đang xử lý
    await vi.advanceTimersByTimeAsync(5_000);
    expect(done).toBeNull();

    modal.state = "closed";
    await vi.advanceTimersByTimeAsync(3_000);
    expect(done).toMatchObject({ dismissed: true });
  });

  it("hộp đóng nhưng lớp phủ còn nằm lại → báo overlayCleared=false", async () => {
    const modal = makeEl();
    const overlay = makeEl();
    const dom = setupDom([modal, overlay]);

    let done: Awaited<ReturnType<typeof waitForChargeModalDismiss>> | null = null;
    void waitForChargeModalDismiss(asEl(modal)).then((r) => {
      done = r;
    });

    dom.remove(modal);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(done).toBeNull(); // còn đang đợi lớp phủ

    await vi.advanceTimersByTimeAsync(25_000);
    expect(done).toMatchObject({ dismissed: true, overlayCleared: false });
  });

  it("hết giờ mà hộp vẫn mở → dismissed=false để caller đi đường đọc kiểm", async () => {
    const modal = makeEl();
    setupDom([modal]);

    let done: Awaited<ReturnType<typeof waitForChargeModalDismiss>> | null = null;
    void waitForChargeModalDismiss(asEl(modal)).then((r) => {
      done = r;
    });

    await vi.advanceTimersByTimeAsync(125_000);
    expect(done).toMatchObject({ dismissed: false, overlayCleared: false });
  });

  // ── Ca ChatGPT in băng-rôn đỏ trong hộp (ảnh user 2026-08-26) ───────────
  it("ChatGPT báo 'Đã xảy ra sự cố' → thôi chờ ngay, không nằm đủ 120s", async () => {
    const modal = makeEl();
    setupDom([modal]);

    let done: Awaited<ReturnType<typeof waitForChargeModalDismiss>> | null = null;
    void waitForChargeModalDismiss(asEl(modal)).then((r) => {
      done = r;
    });

    await vi.advanceTimersByTimeAsync(3_000);
    modal.textContent =
      "Xem lại thay đổi người dùngĐã xảy ra sự cố khi cập nhật gói đăng ký của bạn";
    modal.children = [
      makeEl("open", "Đã xảy ra sự cố khi cập nhật gói đăng ký của bạn"),
    ];

    // Nán lại ~3s xem hộp có tự đóng không, rồi mới thôi chờ.
    await vi.advanceTimersByTimeAsync(4_000);

    expect(done).toMatchObject({
      dismissed: false,
      overlayCleared: false,
      errorBanner: "Đã xảy ra sự cố khi cập nhật gói đăng ký của bạn",
    });
    // Chốt cái đắt nhất: KHÔNG đốt hết 120s mới trả lời.
    expect(done!.waitedMs).toBeLessThan(15_000);
  });

  it("lỗi chớp một nhịp rồi hộp đóng → vẫn tính là mua xong, không báo lỗi", async () => {
    const modal = makeEl();
    const dom = setupDom([modal]);

    let done: Awaited<ReturnType<typeof waitForChargeModalDismiss>> | null = null;
    void waitForChargeModalDismiss(asEl(modal)).then((r) => {
      done = r;
    });

    modal.textContent = "Đã xảy ra sự cố khi cập nhật gói đăng ký của bạn";
    await vi.advanceTimersByTimeAsync(1_000);
    modal.textContent = ""; // ChatGPT tự dựng lại rồi đi tiếp
    await vi.advanceTimersByTimeAsync(1_000);
    dom.remove(modal);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(done).toMatchObject({ dismissed: true, errorBanner: null });
  });

  it("chờ lâu thì gọi onWait để báo tiến độ, không im lặng", async () => {
    const modal = makeEl();
    const dom = setupDom([modal]);
    const ticks: number[] = [];

    void waitForChargeModalDismiss(asEl(modal), (elapsed) => {
      ticks.push(elapsed);
    });

    await vi.advanceTimersByTimeAsync(35_000);
    dom.remove(modal);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks[0]).toBeGreaterThanOrEqual(10_000);
  });
});
