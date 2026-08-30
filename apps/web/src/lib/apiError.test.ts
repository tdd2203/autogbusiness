/**
 * `ApiError.message` phải là câu ĐỌC ĐƯỢC.
 *
 * Cả chục chỗ trong app toast thẳng `e.message`. Trước 2026-08-30, khi backend
 * trả `detail` dạng `{code, message}` (hạn mức thao tác, ví thiếu tiền, phiên bị
 * khoá) thì `message` là cục JSON `JSON.stringify(detail)` — người dùng đọc được
 * nguyên khối `{"code":"ACTION_COOLDOWN",...}` trên toast, còn câu tiếng Việt
 * viết sẵn ở backend thì không ai thấy. Chốt bằng test vì lỗi kiểu này chỉ lộ ra
 * đúng lúc có người bị chặn.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "./api";

describe("ApiError.message", () => {
  it("detail dạng chuỗi thì giữ nguyên", () => {
    expect(new ApiError(403, "Thiếu permission: MEMBER_REMOVE").message).toBe(
      "Thiếu permission: MEMBER_REMOVE",
    );
  });

  it("detail dạng object thì lấy đúng câu trong `message`", () => {
    const err = new ApiError(429, {
      code: "ACTION_COOLDOWN",
      action: "WORKSPACE_SYNC_BILLING",
      message:
        "Đồng bộ hoá đơn và suất: hai lần phải cách nhau ít nhất 1 phút. " +
        "Chờ thêm 43 giây rồi thử lại.",
      retry_after_sec: 43,
    });
    expect(err.message).toContain("Chờ thêm 43 giây");
    expect(err.message).not.toContain("ACTION_COOLDOWN");
  });

  it("object KHÔNG có `message` thì vẫn còn dữ liệu để lần, đừng nuốt mất", () => {
    expect(new ApiError(500, { code: "BOOM" }).message).toContain("BOOM");
  });

  it("`detail` vẫn nguyên vẹn cho chỗ nào cần đọc `code`", () => {
    const err = new ApiError(429, { code: "ACTION_COOLDOWN", message: "x" });
    expect((err.detail as { code: string }).code).toBe("ACTION_COOLDOWN");
  });
});
