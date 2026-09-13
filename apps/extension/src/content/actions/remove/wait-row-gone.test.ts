/**
 * BẤM XOÁ XONG THÌ CHỜ DÒNG ĐÓ BIẾN MẤT — không chờ theo đồng hồ.
 *
 * Luật user chốt 11/9/2026: *"xoá xong chờ nó biến mất rồi tìm kiếm đúng 1 lần
 * cho chắc chắn"*. Bản chờ tối đa 3 giây hết giờ lúc ChatGPT còn quay hộp xác
 * nhận, tra ngay nên lần nào cũng còn thấy dòng và lệnh gỡ nào cũng phải chạy hai
 * lượt. Khoá ở đây: còn quay thì chờ, dòng vắng đủ nhịp liên tiếp mới tính.
 *
 * 13/9/2026: dòng mất rồi thì NÁN LẠI chờ hộp "Gỡ suất trả phí?" hiện muộn (hai
 * lệnh gỡ 12–13/9 hụt hộp vì đi tra ô lọc ngay khi dòng vừa vắng). Hộp hiện là trả
 * lời rồi đi tiếp ngay; hết quãng nán mà không có hộp thì thôi.
 */
import { describe, expect, it, vi } from "vitest";

import type { PaidSeatOutcome } from "../dialog-commit";
import {
  GONE_BEAT_TICKS,
  GONE_BUSY_TICKS,
  GONE_MAX_TICKS,
  GONE_POLL_MS,
  GONE_STABLE_TICKS,
  PAID_SEAT_GRACE_TICKS,
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
    beat: vi.fn(async (_ms: number, _stage: "row" | "paid_seat") => {}),
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
    const goneAt = SPIN + 3 + GONE_STABLE_TICKS;
    expect(v.waitedMs).toBe((goneAt - 1) * GONE_POLL_MS);
    // Không gặp hộp suất → nán trọn quãng chờ nó rồi mới thôi.
    expect(deps.read).toHaveBeenCalledTimes(goneAt + PAID_SEAT_GRACE_TICKS);
    expect(v.graceMs).toBe(PAID_SEAT_GRACE_TICKS * GONE_POLL_MS);
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
    expect(v.waitedMs).toBe((2 + blink + 5 + GONE_STABLE_TICKS - 1) * GONE_POLL_MS);
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

    expect(v).toMatchObject({ gone: true, paidSeat: "kept", graceMs: 0 });
    expect(deps.answerPaidSeat).toHaveBeenCalledTimes(1);
    expect(answeredAt).toBe(6);
    // Hộp đã trả lời từ trước → dòng vừa mất là đi tiếp ngay, không nán.
    expect(deps.read).toHaveBeenCalledTimes(answeredAt + 3 + GONE_STABLE_TICKS - 1);
  });

  it("dòng mất TRƯỚC, hộp suất hiện MUỘN → nán lại, trả lời rồi đi tiếp ngay", async () => {
    const LATE = 12; // hộp hiện ~3,6s sau khi bấm, tức sau khi dòng đã vắng đủ nhịp
    let tick = 0;
    let seatOpen = false;
    let answeredAt = -1;
    const read = (): Snap => {
      tick += 1;
      if (tick === LATE) seatOpen = true;
      return { dialog: seatOpen, busy: false, paidSeat: seatOpen, row: false };
    };
    const deps = makeDeps(read, async () => {
      seatOpen = false;
      answeredAt = tick;
      return "released";
    });

    const v = await waitForRowGone(deps);

    expect(v.gone).toBe(true);
    expect(v.paidSeat).toBe("released");
    expect(answeredAt).toBe(LATE);
    expect(deps.answerPaidSeat).toHaveBeenCalledTimes(1);
    // Dòng tính là mất ở nhịp 4; nán tới nhịp hộp hiện rồi thôi ngay.
    expect(v.waitedMs).toBe((GONE_STABLE_TICKS - 1) * GONE_POLL_MS);
    expect(v.graceMs).toBe((LATE - GONE_STABLE_TICKS) * GONE_POLL_MS);
    expect(deps.read).toHaveBeenCalledTimes(LATE);
  });

  it("dòng mất mà ChatGPT không hỏi gì → nán đủ quãng rồi thôi, báo nhịp đúng việc", async () => {
    const deps = makeDeps(scripted([[1, { row: false }]]));

    const v = await waitForRowGone(deps);

    expect(v).toMatchObject({ gone: true, paidSeat: "none" });
    expect(deps.read).toHaveBeenCalledTimes(GONE_STABLE_TICKS + PAID_SEAT_GRACE_TICKS);
    expect(deps.answerPaidSeat).not.toHaveBeenCalled();
    // Trong quãng nán, câu báo nhịp phải nói là đang chờ hộp suất chứ không phải
    // chờ dòng biến mất.
    const stages = deps.beat.mock.calls.map((c) => c[1]);
    expect(stages.length).toBeGreaterThan(0);
    expect(new Set(stages)).toEqual(new Set(["paid_seat"]));
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
    // Đã thử trả lời rồi thì không nán thêm.
    expect(v).toMatchObject({ gone: true, paidSeat: "unknown", graceMs: 0 });
  });

  it("dòng nằm lì suốt trần chờ → gone:false, và báo nhịp đều trong lúc chờ", async () => {
    const deps = makeDeps(scripted([[1, { row: true }]]));

    const v = await waitForRowGone(deps);

    expect(v.gone).toBe(false);
    expect(deps.read).toHaveBeenCalledTimes(GONE_MAX_TICKS);
    // Nhịp cuối (đúng trần) không báo nữa vì đã trả về ngay ở nhịp đó.
    expect(deps.beat).toHaveBeenCalledTimes(Math.floor((GONE_MAX_TICKS - 1) / GONE_BEAT_TICKS));
    expect(deps.beat.mock.calls.every((c) => c[1] === "row")).toBe(true);
  });

  it("hộp cứ báo đang quay nhưng dòng đã vắng đủ lâu → vẫn tính là đã mất", async () => {
    const deps = makeDeps(scripted([[1, { dialog: true, busy: true, row: false }]]));

    const v = await waitForRowGone(deps);

    expect(v.gone).toBe(true);
    expect(v.waitedMs).toBe((GONE_BUSY_TICKS - 1) * GONE_POLL_MS);
  });
});
