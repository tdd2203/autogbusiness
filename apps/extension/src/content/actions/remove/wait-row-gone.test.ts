/**
 * BẤM XOÁ XONG THÌ CHỜ DÒNG ĐÓ BIẾN MẤT — không chờ theo đồng hồ.
 *
 * Luật user chốt 11/9/2026: *"xoá xong chờ nó biến mất rồi tìm kiếm đúng 1 lần
 * cho chắc chắn"*. Bản chờ tối đa 3 giây hết giờ lúc ChatGPT còn quay hộp xác
 * nhận, tra ngay nên lần nào cũng còn thấy dòng và lệnh gỡ nào cũng phải chạy hai
 * lượt. Khoá ở đây: còn quay thì chờ, dòng vắng đủ nhịp liên tiếp mới tính.
 */
import { describe, expect, it, vi } from "vitest";

import type { PaidSeatOutcome } from "../dialog-commit";
import {
  GONE_BEAT_TICKS,
  GONE_BUSY_TICKS,
  GONE_MAX_TICKS,
  GONE_POLL_MS,
  GONE_STABLE_TICKS,
  waitForRowGone,
  type AfterConfirmSnapshot,
} from "./wait-row-gone";

type Snap = AfterConfirmSnapshot;
const CALM: Snap = { dialog: false, busy: false, paidSeat: false, row: false };

/** Trang diễn theo kịch bản từng nhịp; hết kịch bản thì đứng yên ở nhịp cuối. */
function scripted(frames: Array<[ticks: number, snap: Partial<Snap>]>): () => Snap {
  const seq = frames.flatMap(([n, s]) =>
    Array.from({ length: n }, () => ({ ...CALM, ...s })),
  );
  let i = 0;
  return () => seq[Math.min(i++, seq.length - 1)];
}

function makeDeps(read: () => Snap, answer?: () => Promise<PaidSeatOutcome>) {
  return {
    read: vi.fn(read),
    answerPaidSeat: vi.fn(answer ?? (async (): Promise<PaidSeatOutcome> => "none")),
    beat: vi.fn(async (_ms: number) => {}),
    sleep: vi.fn(async (_ms: number) => {}),
  };
}

describe("waitForRowGone", () => {
  it("hộp xác nhận quay quá 3 giây → vẫn chờ, tới khi dòng rời danh sách mới thôi", async () => {
    const SPIN = 40; // 12 giây
    const deps = makeDeps(
      scripted([
        [SPIN, { dialog: true, busy: true, row: true }],
        [3, { row: true }], // hộp đã tắt, danh sách chưa kịp vẽ lại
        [1, { row: false }],
      ]),
    );

    const v = await waitForRowGone(deps);

    expect(v.gone).toBe(true);
    expect(deps.read).toHaveBeenCalledTimes(SPIN + 3 + GONE_STABLE_TICKS);
    expect(v.waitedMs).toBeGreaterThan(SPIN * GONE_POLL_MS);
  });

  it("dòng nháy trống giữa hai lần vẽ không tính là đã mất", async () => {
    const blink = GONE_STABLE_TICKS - 1;
    const deps = makeDeps(
      scripted([
        [2, { row: true }],
        [blink, { row: false }],
        [5, { row: true }],
        [1, { row: false }],
      ]),
    );

    const v = await waitForRowGone(deps);

    expect(v.gone).toBe(true);
    expect(deps.read).toHaveBeenCalledTimes(2 + blink + 5 + GONE_STABLE_TICKS);
  });

  it("hộp suất hiện ra → trả lời đúng một lần, chờ dòng biến mất", async () => {
    let tick = 0;
    let seatOpen = false;
    let answeredAt = -1;
    const read = (): Snap => {
      tick += 1;
      if (tick === 6) seatOpen = true; // ChatGPT gỡ xong, bồi hộp suất
      return {
        dialog: tick <= 5 || seatOpen,
        busy: tick <= 5,
        paidSeat: seatOpen,
        row: answeredAt < 0 || tick < answeredAt + 3,
      };
    };
    const deps = makeDeps(read, async () => {
      seatOpen = false;
      answeredAt = tick;
      return "kept";
    });

    const v = await waitForRowGone(deps);

    expect(v).toMatchObject({ gone: true, paidSeat: "kept" });
    expect(deps.answerPaidSeat).toHaveBeenCalledTimes(1);
    expect(answeredAt).toBe(6);
  });

  it("hộp suất còn quay thì CHƯA bấm; không nhận ra nút thì không bấm lại liên hồi", async () => {
    const deps = makeDeps(
      scripted([
        [5, { dialog: true, busy: true, paidSeat: true, row: true }],
        [20, { dialog: true, paidSeat: true, row: true }],
        [1, { dialog: true, paidSeat: true, row: false }],
      ]),
      async () => "unknown",
    );

    const v = await waitForRowGone(deps);

    expect(deps.answerPaidSeat).toHaveBeenCalledTimes(1);
    // Cú bấm duy nhất rơi đúng vào nhịp đầu tiên hộp thôi quay (nhịp thứ 6).
    const clickedAt = deps.answerPaidSeat.mock.invocationCallOrder[0];
    expect(clickedAt).toBeGreaterThan(deps.read.mock.invocationCallOrder[5]);
    expect(clickedAt).toBeLessThan(deps.read.mock.invocationCallOrder[6]);
    // Dòng đã mất mà hộp vẫn nằm đó → vẫn là "mất"; dẹp hộp là việc của caller.
    expect(v).toMatchObject({ gone: true, paidSeat: "unknown" });
  });

  it("dòng nằm lì suốt trần chờ → gone:false, và báo nhịp đều trong lúc chờ", async () => {
    const deps = makeDeps(scripted([[1, { row: true }]]));

    const v = await waitForRowGone(deps);

    expect(v.gone).toBe(false);
    expect(deps.read).toHaveBeenCalledTimes(GONE_MAX_TICKS);
    expect(deps.beat).toHaveBeenCalledTimes(Math.floor(GONE_MAX_TICKS / GONE_BEAT_TICKS));
  });

  it("hộp cứ báo đang quay nhưng dòng đã vắng đủ lâu → vẫn tính là đã mất", async () => {
    const deps = makeDeps(scripted([[1, { dialog: true, busy: true, row: false }]]));

    const v = await waitForRowGone(deps);

    expect(v.gone).toBe(true);
    expect(deps.read).toHaveBeenCalledTimes(GONE_BUSY_TICKS);
  });
});
