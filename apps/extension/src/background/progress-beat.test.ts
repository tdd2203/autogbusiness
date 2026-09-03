/**
 * Dấu nhịp tiến độ — thứ quyết định câu giải thích đi kèm `CONTENT_TIMEOUT`.
 *
 * Đọc DB production 25/8 → 3/9/2026: cả 5 mẻ SYNC_DATA hỏng `CONTENT_TIMEOUT`
 * đều còn gửi nhịp thêm 5-13 phút sau khi bị đánh hỏng, tức content chạy chậm
 * chứ không mất phiên đăng nhập. Không có dấu nhịp thì runner không phân biệt
 * được hai ca đó và luôn khuyên đăng nhập lại.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearProgressBeat,
  readProgressBeat,
  recordProgressBeat,
} from "./progress-beat";

describe("progress-beat", () => {
  beforeEach(() => {
    clearProgressBeat("t1");
  });

  it("chưa có nhịp nào → null", () => {
    expect(readProgressBeat("chua-chay")).toBeNull();
  });

  it("giữ chặng + câu mô tả của nhịp gần nhất", () => {
    recordProgressBeat("t1", { phase: "scraping", message: "Đã thu 42" });
    const beat = readProgressBeat("t1");
    expect(beat?.phase).toBe("scraping");
    expect(beat?.message).toBe("Đã thu 42");
    expect(beat?.at).toBeGreaterThan(0);
  });

  it("nhịp sau ghi đè nhịp trước", () => {
    recordProgressBeat("t1", { phase: "scraping", message: "pass 1" });
    recordProgressBeat("t1", { phase: "uploading", message: "pass 9" });
    expect(readProgressBeat("t1")?.message).toBe("pass 9");
  });

  it("progress rỗng/khác kiểu vẫn ghi được mốc, không ném", () => {
    recordProgressBeat("t1", undefined);
    expect(readProgressBeat("t1")?.phase).toBeNull();
    recordProgressBeat("t1", { phase: 7, message: null });
    expect(readProgressBeat("t1")?.message).toBeNull();
  });

  it("nhiều task thì task cũ bị dọn, task mới còn nguyên", () => {
    for (let i = 0; i < 80; i++) {
      recordProgressBeat(`bulk-${i}`, { phase: "scraping" });
    }
    expect(readProgressBeat("bulk-0")).toBeNull();
    expect(readProgressBeat("bulk-79")).not.toBeNull();
  });
});
