/**
 * Khoá luật phán xử "lời mời đã biến mất chưa" — ca ickj886@gmail.com 27/8/2026:
 * thu hồi trót lọt mà bị chốt là hỏng vì đóng sổ ở giây thứ 12-17, giữa lúc
 * ChatGPT còn chưa cập nhật danh sách (~34s).
 *
 * Từ 6/9/2026 luật gọn lại: một vòng đọc được mà không thấy là đủ, và hỏi nhiều
 * nhất hai lượt — không gõ lại cùng một email cho hết ngân sách.
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
  it("một vòng đọc được mà không thấy → kết luận ĐÃ thu hồi, không hỏi thêm", async () => {
    const clock = fakeClock();
    let calls = 0;
    const res = await runAbsenceRounds(60_000, {
      now: clock.now,
      sleep: clock.sleep,
      probe: async () => {
        calls += 1;
        clock.tick(8000);
        return "empty";
      },
    });
    expect(res).toEqual({ outcome: "gone", rounds: 1 });
    expect(calls).toBe(1);
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

  it("vòng đầu câm, vòng sau còn thấy → vẫn là CÒN, không đoán", async () => {
    const clock = fakeClock();
    const res = await runAbsenceRounds(60_000, {
      now: clock.now,
      sleep: clock.sleep,
      probe: scripted(clock, ["unresponsive", "found"]),
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

  it("câm cả hai lượt → DỪNG ở lượt thứ hai dù ngân sách còn chán", async () => {
    const clock = fakeClock();
    let calls = 0;
    const res = await runAbsenceRounds(60_000, {
      now: clock.now,
      sleep: clock.sleep,
      probe: async () => {
        calls += 1;
        clock.tick(6000);
        return "unresponsive";
      },
    });
    expect(calls).toBe(2);
    expect(res.outcome).toBe("inconclusive");
  });

  it("vòng đầu câm, vòng sau đọc được mà không thấy → ĐÃ thu hồi", async () => {
    const clock = fakeClock();
    const res = await runAbsenceRounds(40_000, {
      now: clock.now,
      sleep: clock.sleep,
      probe: scripted(clock, ["unresponsive", "empty"]),
    });
    expect(res).toEqual({ outcome: "gone", rounds: 1 });
  });

  it("ngân sách hẹp hơn một lượt hỏi → hỏi đúng một lần và kết luận theo nó", async () => {
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
    // Lượt hỏi đó đã đọc được danh sách thật — hết giờ không làm dữ liệu sai đi.
    expect(calls).toBe(1);
    expect(res).toEqual({ outcome: "gone", rounds: 1 });
  });

  it("hết ngân sách mà chưa hỏi được lượt nào đọc được → không dám kết luận", async () => {
    const clock = fakeClock();
    const res = await runAbsenceRounds(15_000, {
      now: clock.now,
      sleep: clock.sleep,
      probe: scripted(clock, ["unresponsive"], 20_000),
    });
    expect(res.outcome).toBe("inconclusive");
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
        return calls === 1 ? "unresponsive" : "empty";
      },
    });
    // Lượt 2 bắt đầu lúc 23s (còn trong hạn) và được chạy trọn vẹn.
    expect(calls).toBe(2);
    expect(res).toEqual({ outcome: "gone", rounds: 1 });
  });
});
