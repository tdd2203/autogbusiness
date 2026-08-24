/**
 * "Trang mới đã tiếp quản chưa?" — chốt bằng test vì đây là chỗ đã làm mất tiền
 * thật: gửi lệnh mời vào content script của trang sắp bị Chrome đóng băng
 * (back/forward cache) thì lời mời đi được mà kênh đứt, task báo hỏng, backend
 * hoàn phí oan (ca 2a5d6450 ngày 31/7/2026 — 340.000đ, phải thu lại tay).
 */
import { describe, expect, it } from "vitest";

import { waitForFreshContent } from "./content-ready";

/** Đồng hồ giả: mỗi lần `sleep` là nhảy đúng số ms đó, không chờ thật. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("chờ content script của TRANG MỚI", () => {
  it("loadId khác ngay lần ping đầu → đi tiếp luôn", async () => {
    const r = await waitForFreshContent("cu", 12_000, {
      ...fakeClock(),
      ping: async () => "moi",
    });
    expect(r).toEqual({ fresh: true, loadId: "moi", reason: "fresh" });
  });

  it("trang cũ còn trả lời rồi trang mới lên → chờ được, không bỏ cuộc sớm", async () => {
    let n = 0;
    const r = await waitForFreshContent("cu", 12_000, {
      ...fakeClock(),
      // 3 nhịp đầu vẫn là instance cũ (đang trong khe trước lúc navigation commit).
      ping: async () => (++n <= 3 ? "cu" : "moi"),
    });
    expect(r.fresh).toBe(true);
    expect(n).toBe(4);
  });

  it("CHỈ trang cũ trả lời tới hết giờ → KHÔNG fresh (đây là ca 31/7)", async () => {
    let n = 0;
    const r = await waitForFreshContent("cu", 1_000, {
      ...fakeClock(),
      ping: async () => {
        n++;
        return "cu";
      },
    });
    expect(r.fresh).toBe(false);
    expect(r.reason).toBe("same_load_id");
    expect(r.loadId).toBe("cu");
    // Có thoát, không quay vòng vô hạn.
    expect(n).toBeLessThan(10);
  });

  it("không ai trả lời tới hết giờ → timeout", async () => {
    const r = await waitForFreshContent("cu", 900, {
      ...fakeClock(),
      ping: async () => null,
    });
    expect(r).toEqual({ fresh: false, loadId: null, reason: "timeout" });
  });

  it("trước đó KHÔNG ping được ai (prev null) → instance nào trả lời cũng là mới", async () => {
    // Tab trắng / content chưa inject: không có trang cũ nào để lẫn.
    const r = await waitForFreshContent(null, 12_000, {
      ...fakeClock(),
      ping: async () => "bat-ky",
    });
    expect(r.fresh).toBe(true);
  });

  it("content script bản CŨ (không gửi loadId, runner quy về chuỗi rỗng) vẫn coi là trả lời được", async () => {
    // Extension chưa reload sau build: mất khả năng phân biệt instance, nhưng
    // KHÔNG được vì thế mà chặn hết mọi lệnh — giữ đúng hành vi trước đây.
    const r = await waitForFreshContent(null, 12_000, {
      ...fakeClock(),
      ping: async () => "",
    });
    expect(r.fresh).toBe(true);
    // Ngược lại, nếu TRƯỚC điều hướng cũng là bản cũ (""), thì không phân biệt
    // được → không dám khẳng định là trang mới.
    const r2 = await waitForFreshContent("", 900, {
      ...fakeClock(),
      ping: async () => "",
    });
    expect(r2.fresh).toBe(false);
    expect(r2.reason).toBe("same_load_id");
  });
});
