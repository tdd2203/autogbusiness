import { describe, expect, it } from "vitest";
import {
  buildRemoveSalvageResponse,
  buildRevokeSalvageResponse,
  classifyAbsence,
  shouldSalvageDestructive,
  type AbsenceEvidence,
} from "./destructive-salvage";
import { splitResponseForTask } from "./merged-report";

/** Bằng chứng "cả hai tab đọc được, không thấy ai" — nền cho các ca dưới. */
const CLEAN: AbsenceEvidence = {
  stillPending: [],
  pendingUnusable: false,
  stillActive: [],
  activeInconclusive: [],
  activeUnusable: false,
};

const LOST_CHANNEL = {
  ok: false as const,
  error_code: "UNKNOWN" as const,
  error_message:
    "Lỗi gửi message tới content script: A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received.",
};

describe("lỗi gỡ/thu hồi nào là VÔ ĐỊNH (phải hỏi lại ChatGPT trước khi phán)", () => {
  it("kênh message đứt giữa chừng → phân xử lại (ca hungnd.aii 29/8/2026)", () => {
    expect(shouldSalvageDestructive(LOST_CHANNEL)).toBe(true);
  });

  it("trang bị đẩy vào bfcache → cũng là mất tiếng, không phải câu trả lời", () => {
    expect(
      shouldSalvageDestructive({
        error_code: "UNKNOWN",
        error_message:
          "Lỗi gửi message tới content script: The page keeping the extension port is moved into back/forward cache, so the message channel is closed.",
      }),
    ).toBe(true);
  });

  it("content chạy quá hạn → không ai biết tới đâu, phải soi lại", () => {
    expect(shouldSalvageDestructive({ error_code: "CONTENT_TIMEOUT" })).toBe(true);
    expect(shouldSalvageDestructive({ error_code: "TIMEOUT" })).toBe(true);
  });

  it("ĐÃ tra lại và VẪN thấy member → kết luận rồi, đừng hỏi lại", () => {
    expect(
      shouldSalvageDestructive({
        error_code: "REMOVE_VERIFY_FAILED",
        error_message:
          'Đã click xoá (dialog đã tắt hẳn) nhưng member VẪN còn trong tab "Người dùng" sau 3 lần tra.',
      }),
    ).toBe(false);
  });

  it("ô lọc chết nên không dám kết luận → giữ nguyên, phân xử cũng mù y vậy", () => {
    expect(
      shouldSalvageDestructive({ error_code: "MEMBER_NOT_IN_WORKSPACE" }),
    ).toBe(false);
  });

  it("chưa bấm được gì (UI đổi) → hỏng thật", () => {
    expect(shouldSalvageDestructive({ error_code: "UI_ELEMENT_NOT_FOUND" })).toBe(
      false,
    );
  });
});

describe("phân loại vắng mặt", () => {
  it("vắng ở cả hai tab, cả hai đọc được → đã có hiệu lực", () => {
    expect(classifyAbsence(["A@x.com"], CLEAN)).toEqual({
      gone: ["a@x.com"],
      present: [],
      unknown: [],
    });
  });

  it("còn ở tab Lời mời → chưa thu hồi được", () => {
    const v = classifyAbsence(["a@x.com", "b@x.com"], {
      ...CLEAN,
      stillPending: ["a@x.com"],
    });
    expect(v.present).toEqual(["a@x.com"]);
    expect(v.gone).toEqual(["b@x.com"]);
  });

  it("còn ở tab Người dùng → chưa gỡ được", () => {
    expect(classifyAbsence(["a@x.com"], { ...CLEAN, stillActive: ["a@x.com"] }))
      .toEqual({ gone: [], present: ["a@x.com"], unknown: [] });
  });

  it("một tab không đọc được → KHÔNG phán, dù tab kia sạch", () => {
    expect(classifyAbsence(["a@x.com"], { ...CLEAN, pendingUnusable: true }).unknown)
      .toEqual(["a@x.com"]);
    expect(classifyAbsence(["a@x.com"], { ...CLEAN, activeUnusable: true }).unknown)
      .toEqual(["a@x.com"]);
  });

  it("ô lọc không kết luận nổi email nào thì riêng email đó là ẩn số", () => {
    const v = classifyAbsence(["a@x.com", "b@x.com"], {
      ...CLEAN,
      activeInconclusive: ["b@x.com"],
    });
    expect(v.gone).toEqual(["a@x.com"]);
    expect(v.unknown).toEqual(["b@x.com"]);
  });
});

describe("kết quả thu hồi sau phân xử", () => {
  it("vắng mặt → results[].ok=true, đúng thứ backend đọc để mark removed", () => {
    const emails = ["hungnd.aii@gmail.con"];
    const resp = buildRevokeSalvageResponse(
      emails,
      classifyAbsence(emails, CLEAN),
      LOST_CHANNEL,
    );
    expect(resp.ok).toBe(true);
    const data = (resp as { data: Record<string, unknown> }).data;
    expect(data.revoked).toBe(1);
    expect(data.results).toEqual([
      { email: "hungnd.aii@gmail.con", ok: true, salvaged: true },
    ]);
    expect(String(data.salvaged_after_indeterminate_error)).toContain(
      "message channel closed",
    );
  });

  it("không email nào vắng mặt → giữ NGUYÊN lỗi gốc, không dựng task rỗng", () => {
    const emails = ["a@x.com"];
    const verdict = classifyAbsence(emails, { ...CLEAN, stillPending: emails });
    expect(buildRevokeSalvageResponse(emails, verdict, LOST_CHANNEL)).toBe(
      LOST_CHANNEL,
    );
  });

  it("một phần vắng mặt → email còn lại mang ok:false, backend giữ pending", () => {
    const emails = ["a@x.com", "b@x.com"];
    const verdict = classifyAbsence(emails, { ...CLEAN, stillActive: ["b@x.com"] });
    const data = (
      buildRevokeSalvageResponse(emails, verdict, LOST_CHANNEL) as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(data.revoked).toBe(1);
    expect(data.failed).toBe(1);
    const rows = data.results as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.ok)).toEqual([true, false]);
  });
});

describe("kết quả gỡ sau phân xử", () => {
  it("lệnh lẻ → verified+absent, đúng bằng chứng backend đòi để mark removed", () => {
    const emails = ["nga.17phan@dataidcc.com"];
    const data = (
      buildRemoveSalvageResponse(
        emails,
        classifyAbsence(emails, CLEAN),
        LOST_CHANNEL,
      ) as { data: Record<string, unknown> }
    ).data;
    expect(data).toMatchObject({
      email: "nga.17phan@dataidcc.com",
      verified: true,
      absent: true,
      absence_reason: "salvage_after_lost_channel",
    });
  });

  it("mẻ gộp → mỗi lệnh trong mẻ nhận đúng phần của mình", () => {
    const emails = [
      "nga.17phan@dataidcc.com",
      "nghia.thai@dataidcc.com",
      "hanhdoan@dataidcc.com",
    ];
    const verdict = classifyAbsence(emails, {
      ...CLEAN,
      stillActive: ["hanhdoan@dataidcc.com"],
    });
    const resp = buildRemoveSalvageResponse(emails, verdict, LOST_CHANNEL);

    const ok = splitResponseForTask(
      "REMOVE_MEMBER",
      { id: "t1", emails: ["nga.17phan@dataidcc.com"] },
      resp,
    );
    expect(ok.ok).toBe(true);
    expect((ok as { data: Record<string, unknown> }).data).toMatchObject({
      email: "nga.17phan@dataidcc.com",
      verified: true,
      absent: true,
    });

    const stillThere = splitResponseForTask(
      "REMOVE_MEMBER",
      { id: "t3", emails: ["hanhdoan@dataidcc.com"] },
      resp,
    );
    expect(stillThere.ok).toBe(false);
  });

  it("không ai vắng mặt → giữ nguyên lỗi gốc", () => {
    const emails = ["a@x.com"];
    const verdict = classifyAbsence(emails, { ...CLEAN, activeUnusable: true });
    expect(buildRemoveSalvageResponse(emails, verdict, LOST_CHANNEL)).toBe(
      LOST_CHANNEL,
    );
  });
});
