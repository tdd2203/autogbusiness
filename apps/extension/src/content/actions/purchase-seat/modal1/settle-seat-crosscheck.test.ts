/**
 * Ca thật trên production 23/8/2026: cú "Mời lại" chết vì bộ đếm đọc ra
 * 150 trong khi dòng tỉ lệ nói 151 — tức CÒN TRỐNG 1 suất, thừa sức mời. Backend
 * nhận `FAILED_UI_CHANGED` rồi (bug riêng, đã vá) xoá luôn kỳ hạn khách đã trả.
 *
 * Bộ test khoá đúng ranh giới: CHỜ cho nhịp render dở, nhưng KHÔNG nuốt lệch thật.
 */
import { describe, expect, it } from "vitest";
import type { SeatAvailability } from "./parse-seat-availability";
import { settleSeatCrossCheck } from "./settle-seat-crosscheck";

const ratio = (assigned: number, total: number): SeatAvailability => ({
  total,
  assigned,
  free: Math.max(0, total - assigned),
});

/** Timeout ngắn để test chạy nhanh — logic không phụ thuộc con số thật. */
const TIMEOUT = 200;
const POLL = 10;

describe("settleSeatCrossCheck", () => {
  it("khớp ngay lần đọc đầu → trả về luôn, không tốn nhịp chờ", async () => {
    let ratioReads = 0;
    let stepperReads = 0;
    const started = Date.now();

    const out = await settleSeatCrossCheck(
      () => {
        ratioReads++;
        return ratio(150, 151);
      },
      () => {
        stepperReads++;
        return 151;
      },
      TIMEOUT,
      POLL,
    );

    expect(out.availability).toEqual(ratio(150, 151));
    expect(out.stepperTotal).toBe(151);
    expect(ratioReads).toBe(1);
    expect(stepperReads).toBe(1);
    // Không được ngồi chờ hết timeout khi mọi thứ đã ổn ngay từ đầu.
    expect(Date.now() - started).toBeLessThan(TIMEOUT);
  });

  it("ĐÚNG CA THẬT 23/8: bộ đếm chậm một nhịp (150 → 151) thì phải chờ tới khi khớp", async () => {
    let stepperReads = 0;
    const out = await settleSeatCrossCheck(
      () => ratio(150, 151),
      () => {
        stepperReads++;
        // Lần đọc đầu bắt trúng trị số quá độ, sau đó React chốt đúng 151.
        return stepperReads === 1 ? 150 : 151;
      },
      TIMEOUT,
      POLL,
    );

    expect(out.stepperTotal).toBe(151);
    expect(out.availability?.total).toBe(151);
    // Khớp rồi thì caller đi tiếp mời được — đây chính là cú mời đã chết oan.
    expect(out.stepperTotal).toBe(out.availability?.total);
  });

  it("bộ đếm render muộn (null → 151) vẫn bắt được", async () => {
    let reads = 0;
    const out = await settleSeatCrossCheck(
      () => ratio(150, 151),
      () => {
        reads++;
        return reads < 3 ? null : 151;
      },
      TIMEOUT,
      POLL,
    );

    expect(out.stepperTotal).toBe(151);
  });

  it("dòng tỉ lệ mới là bên chậm nhịp → cũng phải bắt được (không thiên vị bên nào)", async () => {
    let reads = 0;
    const out = await settleSeatCrossCheck(
      () => {
        reads++;
        return reads === 1 ? ratio(150, 150) : ratio(150, 151);
      },
      () => 151,
      TIMEOUT,
      POLL,
    );

    expect(out.availability?.total).toBe(151);
    expect(out.stepperTotal).toBe(151);
  });

  it("LỆCH THẬT thì vẫn lệch sau khi hết giờ — chốt chặn không bị nuốt", async () => {
    const out = await settleSeatCrossCheck(
      () => ratio(140, 151),
      () => 120,
      TIMEOUT,
      POLL,
    );

    expect(out.stepperTotal).toBe(120);
    expect(out.availability?.total).toBe(151);
    expect(out.stepperTotal).not.toBe(out.availability?.total);
  });

  it("dòng tỉ lệ biến mất giữa chừng KHÔNG được làm mất con số đã đọc", async () => {
    let reads = 0;
    const out = await settleSeatCrossCheck(
      () => {
        reads++;
        return reads === 1 ? ratio(150, 151) : null; // modal đang đóng
      },
      () => 999, // không bao giờ khớp → chạy hết timeout
      TIMEOUT,
      POLL,
    );

    expect(out.availability).toEqual(ratio(150, 151));
  });

  it("không có dòng tỉ lệ → về ngay, không chờ (caller có nhánh lỗi riêng)", async () => {
    const started = Date.now();
    let stepperReads = 0;

    const out = await settleSeatCrossCheck(
      () => null,
      () => {
        stepperReads++;
        return 151;
      },
      TIMEOUT,
      POLL,
    );

    expect(out.availability).toBeNull();
    expect(stepperReads).toBe(1);
    expect(Date.now() - started).toBeLessThan(TIMEOUT);
  });
});
