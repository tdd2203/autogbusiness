/**
 * Khoá luật phán xử "lời mời đã biến mất chưa" — ca ickj886@gmail.com 27/8/2026:
 * thu hồi trót lọt mà bị chốt là hỏng vì đóng sổ ở giây thứ 12-17, giữa lúc
 * ChatGPT còn chưa cập nhật danh sách (~34s).
 */
import { describe, expect, it } from "vitest";
import { runAbsenceRounds, type Probe } from "./verify-invite-gone";

/** Đồng hồ giả: mỗi `sleep` nhích đúng bấy nhiêu ms, không chờ thật. */
function fakeClock(startAt = 0) {
  let t = startAt;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    tick: (ms: number) => {
      t += ms;
    },
  };
}

/** Trả lần lượt từng kết quả hỏi; mỗi lượt hỏi tốn `costMs`. */
function scripted(clock: ReturnType<typeof fakeClock>, seq: Probe[], costMs = 8000) {
  let i = 0;
  return async () => {
    clock.tick(costMs);
    return seq[Math.min(i++, seq.length - 1)];
  };
}

describe("phán xử lời mời đã biến mất chưa", () => {
  it("hai vòng liên tiếp không thấy → kết luận ĐÃ thu hồi", async () => {
    const clock = fakeClock();
    const res = await runAbsenceRounds(60_000, {
      now: clock.now,
      sleep: clock.sleep,
      probe: scripted(clock, ["empty", "empty"]),
    });
    expect(res).toEqual({ outcome: "gone", rounds: 2 });
  });

  it("thấy lời mời → dừng ngay, không hỏi thêm", async () => {
    const clock = fakeClock();
    let calls = 0;
    const res = await runAbsenceRounds(60_000, {
      now: clock.now,
      sleep: clock.sleep,
      probe: async () => {
        calls += 1;
        clock.tick(8000);
        return "found";
      },
    });
    expect(res).toEqual({ outcome: "still_there" });
    expect(calls).toBe(1);
  });

  it("ChatGPT chậm cập nhật: vòng đầu còn thấy → vẫn là CÒN, không đoán", async () => {
    const clock = fakeClock();
    const res = await runAbsenceRounds(60_000, {
      now: clock.now,
      sleep: clock.sleep,
      probe: scripted(clock, ["empty", "found"]),
    });
    expect(res).toEqual({ outcome: "still_there" });
  });

  it("danh sách không phản hồi → KHÔNG tính là đã thu hồi", async () => {
    const clock = fakeClock();
    const res = await runAbsenceRounds(60_000, {
      now: clock.now,
      sleep: clock.sleep,
      probe: scripted(clock, ["unresponsive", "unresponsive", "unresponsive"]),
    });
    expect(res.outcome).toBe("inconclusive");
  });

  it("một vòng trống + một vòng câm → chưa đủ, KHÔNG kết luận đã thu hồi", async () => {
    const clock = fakeClock();
    const res = await runAbsenceRounds(40_000, {
      now: clock.now,
      sleep: clock.sleep,
      probe: scripted(clock, ["empty", "unresponsive", "unresponsive"]),
    });
    expect(res.outcome).toBe("inconclusive");
  });

  it("ngân sách hẹp hơn một lượt hỏi → chỉ hỏi được một lần, không dám kết luận", async () => {
    const clock = fakeClock();
    let calls = 0;
    const res = await runAbsenceRounds(15_000, {
      now: clock.now,
      sleep: clock.sleep,
      probe: async () => {
        calls += 1;
        clock.tick(20_000);
        return "empty";
      },
    });
    expect(calls).toBe(1);
    expect(res.outcome).toBe("inconclusive");
  });

  it("ngân sách 60s đủ cho hai lượt hỏi thật (mỗi lượt ~20s)", async () => {
    const clock = fakeClock();
    const res = await runAbsenceRounds(60_000, {
      now: clock.now,
      sleep: clock.sleep,
      probe: scripted(clock, ["empty", "empty"], 20_000),
    });
    expect(res).toEqual({ outcome: "gone", rounds: 2 });
  });

  it("vòng đang chạy KHÔNG bị cắt ngang khi chạm hạn — chỉ không mở vòng mới", async () => {
    const clock = fakeClock();
    let calls = 0;
    const res = await runAbsenceRounds(25_000, {
      now: clock.now,
      sleep: clock.sleep,
      probe: async () => {
        calls += 1;
        clock.tick(20_000);
        return "empty";
      },
    });
    // Vòng 2 bắt đầu lúc 23s (còn trong hạn) và được chạy trọn vẹn.
    expect(calls).toBe(2);
    expect(res).toEqual({ outcome: "gone", rounds: 2 });
  });
});
