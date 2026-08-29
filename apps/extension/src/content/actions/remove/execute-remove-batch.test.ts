/**
 * Mẻ gỡ gộp: mỗi email là một LỆNH riêng ở backend, nên một email hỏng KHÔNG
 * được kéo theo email khác — trừ khi trang không dùng được nữa, lúc đó chạy tiếp
 * chỉ tốn thời gian mà kết quả vẫn thế.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeRemove = vi.fn();
vi.mock("./execute-remove", () => ({ executeRemove: (...a: unknown[]) => executeRemove(...a) }));
vi.mock("../../progress", () => ({ reportProgress: vi.fn(async () => {}) }));

const { executeRemoveBatch } = await import("./execute-remove-batch");

type Row = Record<string, unknown>;
const dataOf = (resp: { ok: boolean; data?: unknown }): Record<string, unknown> =>
  (resp.data ?? {}) as Record<string, unknown>;
const rowsOf = (resp: { ok: boolean; data?: unknown }): Row[] =>
  (dataOf(resp).results ?? []) as Row[];

beforeEach(() => executeRemove.mockReset());

describe("executeRemoveBatch", () => {
  it("gỡ tuần tự từng email, trả kết quả theo từng email", async () => {
    executeRemove
      .mockResolvedValueOnce({ ok: true, data: { email: "a@x.com", verified: true } })
      .mockResolvedValueOnce({
        ok: true,
        data: { email: "b@x.com", verified: true, absent: true },
      });

    const resp = await executeRemoveBatch("t1", ["A@x.com", "b@x.com"]);

    expect(resp.ok).toBe(true);
    expect(executeRemove.mock.calls.map((c) => c[1])).toEqual(["a@x.com", "b@x.com"]);
    expect(rowsOf(resp)).toEqual([
      { email: "a@x.com", ok: true, verified: true, absent: false, via_revoke: false },
      { email: "b@x.com", ok: true, verified: true, absent: true, via_revoke: false },
    ]);
  });

  it("một email hỏng KHÔNG chặn email sau", async () => {
    executeRemove
      .mockResolvedValueOnce({
        ok: false,
        error_code: "REMOVE_VERIFY_FAILED",
        error_message: "vẫn còn",
      })
      .mockResolvedValueOnce({ ok: true, data: { email: "b@x.com", verified: true } });

    const resp = await executeRemoveBatch("t1", ["a@x.com", "b@x.com"]);

    expect(executeRemove).toHaveBeenCalledTimes(2);
    const rows = rowsOf(resp);
    expect(rows[0]).toMatchObject({ email: "a@x.com", ok: false, error_code: "REMOVE_VERIFY_FAILED" });
    expect(rows[1]).toMatchObject({ email: "b@x.com", ok: true });
    expect(dataOf(resp).ok_count).toBe(1);
  });

  it("lỗi CẤP TRANG → dừng mẻ, các email còn lại nhận cùng lý do", async () => {
    executeRemove.mockResolvedValueOnce({
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: "không ở trang admin",
    });

    const resp = await executeRemoveBatch("t1", ["a@x.com", "b@x.com", "c@x.com"]);

    expect(executeRemove).toHaveBeenCalledTimes(1);
    const rows = rowsOf(resp);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.ok === false && r.error_code === "PAGE_NOT_ADMIN")).toBe(true);
  });

  it("executeRemove ném lỗi → ghi thành kết quả hỏng của email đó, mẻ vẫn chạy tiếp", async () => {
    executeRemove
      .mockRejectedValueOnce(new Error("mất kênh"))
      .mockResolvedValueOnce({ ok: true, data: { email: "b@x.com", verified: true } });

    const resp = await executeRemoveBatch("t1", ["a@x.com", "b@x.com"]);

    const rows = rowsOf(resp);
    expect(rows[0]).toMatchObject({ email: "a@x.com", ok: false, error_code: "UNKNOWN" });
    expect(rows[1]).toMatchObject({ email: "b@x.com", ok: true });
  });

  it("mẻ rỗng → báo lỗi thay vì im lặng báo xong", async () => {
    const resp = await executeRemoveBatch("t1", []);
    expect(resp.ok).toBe(false);
  });
});
