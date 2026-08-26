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
function setupDom(nodes: FakeEl[]): {
  remove: (el: FakeEl) => void;
  /** Chữ ĐANG in ngoài trang (ngoài hộp) — nơi băng-rôn xanh treo. */
  setPageText: (text: string) => void;
} {
  const inDom = new Set(nodes);
  const page = { text: "" };
  vi.stubGlobal("document", {
    body: {
      contains: (el: FakeEl) => inDom.has(el),
      get textContent() {
        return page.text;
      },
      children: [] as FakeEl[],
    },
    querySelectorAll: () => Array.from(inDom),
  });
  vi.stubGlobal("window", {
    getComputedStyle: (el: FakeEl) => ({
      display: el.hidden ? "none" : "block",
      visibility: "visible",
    }),
  });
  return {
    remove: (el: FakeEl) => inDom.delete(el),
    setPageText: (text: string) => {
      page.text = text;
    },
  };
}

/** Câu ChatGPT in ra khi giao dịch đã đi qua (ảnh user 26/8/2026). */
const SUCCESS_TOAST = "Gói đăng ký của bạn đã được cập nhật thành công";

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

  // ── Ca ChatGPT in băng-rôn XANH ngoài trang (ảnh user 2026-08-26) ──────
  it("thấy 'đã cập nhật thành công' mà hộp vẫn treo → thôi chờ sau 15s, ghi lại câu đó", async () => {
    const modal = makeEl();
    const dom = setupDom([modal]);

    let done: Awaited<ReturnType<typeof waitForChargeModalDismiss>> | null = null;
    void waitForChargeModalDismiss(asEl(modal)).then((r) => {
      done = r;
    });

    await vi.advanceTimersByTimeAsync(3_000);
    dom.setPageText(`Thành viên${SUCCESS_TOAST}Suất Tiêu chuẩn 68`);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(done).toBeNull(); // còn nán cho hộp tự đóng

    await vi.advanceTimersByTimeAsync(16_000);
    expect(done).toMatchObject({
      dismissed: false,
      // DOM giả không có node toast riêng nên hàm chép cả cụm text — điều được
      // chốt ở đây là "có bắt được câu đó", còn việc cắt gọn thì
      // `detect-success-toast.test.ts` chốt trên DOM có node hẳn hoi.
      successToast: expect.stringContaining(SUCCESS_TOAST),
    });
    // Không đốt hết 120s: ChatGPT đã trả lời rồi.
    expect(done!.waitedMs).toBeLessThan(30_000);
  });

  it("băng-rôn xanh ĐÈ băng-rôn đỏ — lỗi kia chỉ là lỗi dựng màn hình", async () => {
    const modal = makeEl();
    const dom = setupDom([modal]);

    let done: Awaited<ReturnType<typeof waitForChargeModalDismiss>> | null = null;
    void waitForChargeModalDismiss(asEl(modal)).then((r) => {
      done = r;
    });

    dom.setPageText(SUCCESS_TOAST);
    await vi.advanceTimersByTimeAsync(1_000);
    modal.textContent = "Đã xảy ra sự cố khi cập nhật gói đăng ký của bạn";
    modal.children = [
      makeEl("open", "Đã xảy ra sự cố khi cập nhật gói đăng ký của bạn"),
    ];
    await vi.advanceTimersByTimeAsync(20_000);

    expect(done).toMatchObject({
      dismissed: false,
      errorBanner: null,
      successToast: SUCCESS_TOAST,
    });
  });

  it("toast chớp một nhịp rồi tắt vẫn được GIỮ tới lúc trả kết quả", async () => {
    const modal = makeEl();
    const dom = setupDom([modal]);

    let done: Awaited<ReturnType<typeof waitForChargeModalDismiss>> | null = null;
    void waitForChargeModalDismiss(asEl(modal)).then((r) => {
      done = r;
    });

    await vi.advanceTimersByTimeAsync(1_000);
    dom.setPageText(SUCCESS_TOAST);
    await vi.advanceTimersByTimeAsync(1_000);
    dom.setPageText(""); // toast tự tắt
    dom.remove(modal);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(done).toMatchObject({ dismissed: true, successToast: SUCCESS_TOAST });
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
