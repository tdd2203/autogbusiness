import { describe, expect, it } from "vitest";
import { completionResult } from "./canva-runner";
import type { CanvaActionRequest } from "../shared/messages";

/**
 * Hợp đồng chốt lệnh gỡ/thu hồi của nhánh Canva.
 *
 * Backend chỉ đổi trạng thái member khi đọc được `result.data.results[].ok` (thu
 * hồi lời mời) và `result.data.verified` (gỡ thành viên). Trả sai khuôn là lệnh
 * chạy xong thật trên Canva mà dashboard vẫn báo thất bại và giữ member ở "chờ
 * tham gia" — đúng chuyện đã xảy ra 1/9/2026.
 */
const remove = (emails: string[]): CanvaActionRequest => ({
  kind: "CANVA_REMOVE",
  taskId: "t1",
  emails,
});

describe("kết quả chốt lệnh gỡ Canva", () => {
  it("gỡ được hết thì mỗi email một dòng ok và có bằng chứng đã rời", () => {
    const out = completionResult(remove(["a@x.com"]), {
      removed_emails: ["a@x.com"],
      failed: [],
      results: [{ email: "a@x.com", ok: true }],
    });
    expect(out.data).toMatchObject({
      results: [{ email: "a@x.com", ok: true }],
      verified: true,
    });
  });

  it("gỡ được một nửa thì email hỏng phải mang ok=false và không nhận verified", () => {
    const out = completionResult(remove(["a@x.com", "b@x.com"]), {
      removed_emails: ["a@x.com"],
      failed: [{ email: "b@x.com", reason: "still_in_team" }],
      results: [
        { email: "a@x.com", ok: true },
        { email: "b@x.com", ok: false },
      ],
    });
    expect(out.data).toMatchObject({
      results: [
        { email: "a@x.com", ok: true },
        { email: "b@x.com", ok: false },
      ],
      verified: false,
    });
  });

  it("content script bản cũ không trả results thì KHÔNG được tự nhận đã gỡ", () => {
    const out = completionResult(remove(["a@x.com"]), {
      removed_emails: ["a@x.com"],
      failed: [],
    });
    expect(out.data).toMatchObject({
      results: [{ email: "a@x.com", ok: false }],
      verified: false,
    });
  });

  it("email hỏi bằng chữ hoa vẫn khớp kết quả trả về", () => {
    const out = completionResult(remove(["A@X.com"]), {
      results: [{ email: "a@x.com", ok: true }],
    });
    expect(out.data).toMatchObject({ verified: true });
  });

  it("lệnh khác giữ nguyên khuôn cũ, không bọc thêm lớp data", () => {
    const out = completionResult(
      { kind: "CANVA_SYNC", taskId: "t1" },
      { members: [], team_size: 3 },
    );
    expect(out).toEqual({ members: [], team_size: 3 });
  });
});
