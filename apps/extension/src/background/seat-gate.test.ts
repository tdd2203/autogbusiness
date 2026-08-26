/**
 * Chốt luật "mời song song" của user 2026-08-26: dư suất thì 2 lệnh chạy cùng
 * lúc, thiếu suất (phải mua) thì 1 workspace chỉ chạy 1 lệnh.
 *
 * Ca đắt nhất nằm ở phép ĐẶT CHỖ: còn 2 suất trống, hai lệnh mỗi lệnh cần 1 —
 * xét riêng lẻ thì cả hai đều "đủ chỗ". Cho cả hai chạy là đâm nhau đúng vào hộp
 * "Mua suất người dùng và gửi lời mời" (tiêu tiền thật, số tiền ChatGPT tự quyết).
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  acquireSeatLease,
  hintedFreeSeats,
  inviteSeatNeed,
  resetSeatGate,
  seatDemandForTask,
  seatGateState,
  type SeatLease,
} from "./seat-gate";

/** Nhường microtask + timer để mọi lease đáng được cấp đã cấp xong. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Theo dõi một lease đang chờ mà không block test. */
function pending(free: number | null, need: number): {
  got: () => SeatLease | null;
  wait: () => Promise<SeatLease>;
} {
  let lease: SeatLease | null = null;
  const p = acquireSeatLease({ free, need }).then((l) => {
    lease = l;
    return l;
  });
  return { got: () => lease, wait: () => p };
}

beforeEach(() => resetSeatGate());

describe("acquireSeatLease", () => {
  it("dư suất → hai lệnh mời chạy SONG SONG", async () => {
    const a = await acquireSeatLease({ free: 10, need: 1 });
    const b = await acquireSeatLease({ free: 10, need: 1 });
    expect(a.shared).toBe(true);
    expect(b.shared).toBe(true);
    expect(seatGateState()).toMatchObject({ sharedCount: 2, reserved: 2 });
  });

  it("đặt chỗ: 2 suất trống, hai lệnh mỗi lệnh 1 suất → lệnh sau PHẢI chờ", async () => {
    // Lệnh đầu: 2 − 0 ≥ 1 + 1 (dư an toàn) ⇒ chạy song song được.
    const first = await acquireSeatLease({ free: 2, need: 1 });
    expect(first.shared).toBe(true);
    // Lệnh sau nhìn thấy chỗ trống ĐÃ TRỪ phần lệnh đầu giữ: 2 − 1 = 1 < 1 + 1.
    const second = pending(2, 1);
    await flush();
    expect(second.got()).toBeNull();

    // Lệnh đầu xong, chỗ nó giữ được trả lại → lệnh sau mới được vào (và lúc này
    // nó chạy một mình nên "chia sẻ" hay không không còn nghĩa gì).
    first.release();
    await second.wait();
    expect(seatGateState()).toMatchObject({ sharedCount: 1, reserved: 1 });
  });

  it("dashboard chưa biết số suất (free = null) → độc quyền", async () => {
    const a = await acquireSeatLease({ free: null, need: 1 });
    expect(a.shared).toBe(false);
    const b = pending(10, 1);
    await flush();
    expect(b.got()).toBeNull();
    a.release();
    expect((await b.wait()).shared).toBe(true);
  });

  it("PURCHASE_SEAT đang chạy thì lệnh mời dư suất vẫn phải chờ", async () => {
    const buy = await acquireSeatLease(seatDemandForTask({ type: "PURCHASE_SEAT" })!);
    expect(buy.shared).toBe(false);
    const invite = pending(50, 1);
    await flush();
    expect(invite.got()).toBeNull();
    buy.release();
    expect((await invite.wait()).shared).toBe(true);
  });

  it("lệnh độc quyền ở đầu hàng KHÔNG bị lệnh chia sẻ phía sau vượt mặt", async () => {
    const running = await acquireSeatLease({ free: 10, need: 1 });
    const exclusive = pending(null, 1); // xếp hàng, chờ `running` nhả
    const shared = pending(10, 1); // tới sau — không được chen lên
    await flush();
    expect(exclusive.got()).toBeNull();
    expect(shared.got()).toBeNull();

    running.release();
    await flush();
    expect(exclusive.got()).not.toBeNull();
    expect(shared.got()).toBeNull();

    exclusive.got()!.release();
    expect((await shared.wait()).shared).toBe(true);
  });

  it("upgrade(): lease chia sẻ nâng lên độc quyền, chờ lease chia sẻ kia nhả", async () => {
    const a = await acquireSeatLease({ free: 10, need: 1 });
    const b = await acquireSeatLease({ free: 10, need: 1 });

    let upgraded = false;
    const p = a.upgrade().then(() => {
      upgraded = true;
    });
    await flush();
    // `a` đã nhả phần chia sẻ ngay (nếu không thì nó tự chờ chính mình).
    expect(a.shared).toBe(false);
    expect(upgraded).toBe(false);
    expect(seatGateState().sharedCount).toBe(1);

    b.release();
    await p;
    expect(upgraded).toBe(true);
    expect(seatGateState()).toMatchObject({ exclusiveHeld: true, sharedCount: 0 });

    a.release();
    expect(seatGateState()).toMatchObject({ exclusiveHeld: false, waiting: 0 });
  });

  it("upgrade() gọi lại lần nữa (hoặc trên lease vốn độc quyền) là no-op", async () => {
    const a = await acquireSeatLease({ free: null, need: 1 });
    await a.upgrade();
    expect(a.shared).toBe(false);
    expect(seatGateState()).toMatchObject({ exclusiveHeld: true, waiting: 0 });
    a.release();
    expect(seatGateState().exclusiveHeld).toBe(false);
  });
});

describe("seatDemandForTask", () => {
  it("task không dính suất → không cần lease", () => {
    expect(seatDemandForTask({ type: "REMOVE_MEMBER", payload: {} })).toBeNull();
  });

  it("mời: lấy chỗ trống từ seat_hint và số suất từ new_seat_count", () => {
    const demand = seatDemandForTask({
      type: "INVITE_MEMBER",
      payload: {
        emails: ["a@x.com", "b@x.com"],
        // 1 trong 2 email đang là thành viên active ⇒ chỉ tốn 1 suất MỚI.
        new_seat_count: 1,
        seat_hint: { total: 151, occupied: 148, pending: 1 },
      },
    });
    expect(demand).toEqual({ free: 3, need: 1 });
  });

  it("backend cũ không gửi seat_hint → free null ⇒ độc quyền", () => {
    expect(hintedFreeSeats({ emails: ["a@x.com"] })).toBeNull();
    expect(hintedFreeSeats({ seat_hint: { total: null, occupied: 3 } })).toBeNull();
  });

  it("thiếu new_seat_count → rơi về số email (mua thừa còn hơn mua thiếu)", () => {
    expect(inviteSeatNeed({ emails: ["a@x.com", "b@x.com"] })).toBe(2);
    expect(inviteSeatNeed({ email: "a@x.com" })).toBe(1);
    expect(inviteSeatNeed({})).toBe(0);
  });
});
