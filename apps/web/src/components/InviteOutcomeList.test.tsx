import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InviteOutcomeList, outcomeSummary } from "./TaskCompletionBanner";
import { readInviteOutcome } from "../lib/inviteOutcome";
import vi from "../i18n/locales/vi.json";
import zhCN from "../i18n/locales/zh-CN.json";
import type { QueueItem } from "../types";

/* Bài kiểm tra gốc: người dùng nhìn banner có trả lời được "email nào đã mời được"
   không. Đủ email, có tên riêng từng cái, và KHÔNG được lòi key i18n ra màn hình. */

const DICT = vi as Record<string, string>;
const t = (key: string, params?: Record<string, string | number>): string => {
  let value = DICT[key] ?? key;
  for (const [k, v] of Object.entries(params ?? {})) {
    value = value.replaceAll(`{${k}}`, String(v));
  }
  return value;
};

function inviteTask(outcome: Record<string, unknown>): QueueItem {
  return {
    id: "q1",
    type: "INVITE_MEMBER",
    status: "COMPLETED",
    payload: {},
    result: { invite_outcome: outcome },
    progress: null,
    error_code: null,
    error_message: null,
    workspace_id: "w1",
    created_by_id: null,
    created_by_username: null,
    created_at: "2026-08-29T10:00:00Z",
    picked_at: null,
    completed_at: "2026-08-29T10:01:00Z",
  } as QueueItem;
}

const render = (task: QueueItem) =>
  renderToStaticMarkup(<InviteOutcomeList view={readInviteOutcome(task)!} t={t} />);

describe("InviteOutcomeList", () => {
  it("gọi tên từng email, không gộp '+N'", () => {
    const html = render(
      inviteTask({
        invited: ["a@x.com", "b@x.com"],
        failed: ["c@x.com"],
        pending_verify: ["d@x.com"],
        refunded: ["c@x.com"],
        reason_code: "VERIFY_FAILED",
      }),
    );
    for (const email of ["a@x.com", "b@x.com", "c@x.com", "d@x.com"]) {
      expect(html).toContain(email);
    }
    expect(html).not.toContain("+1");
  });

  it("dòng tóm tắt đếm đủ ba nhóm, bỏ qua nhóm rỗng", () => {
    const view = readInviteOutcome(
      inviteTask({
        invited: ["a@x.com", "b@x.com"],
        failed: ["c@x.com"],
        pending_verify: ["d@x.com"],
      }),
    )!;
    expect(outcomeSummary(view, t)).toBe("3 đã mời · 1 lỗi");

    const clean = readInviteOutcome(inviteTask({ invited: ["a@x.com"] }))!;
    expect(outcomeSummary(clean, t)).toBe("1 đã mời");
  });

  it("dòng email của nhóm hỏng chỉ nói chuyện TIỀN, không lặp lý do", () => {
    const view = readInviteOutcome(
      inviteTask({
        failed: ["c@x.com", "d@x.com"],
        refunded: ["c@x.com"],
        seat_credit: ["d@x.com"],
        reason_code: "SEAT_PURCHASE_FAILED",
        reason_text:
          "Mua thêm suất không thành công nên lệnh dừng lại. Chưa gửi lời mời nào.",
      }),
    )!;
    const html = renderToStaticMarkup(<InviteOutcomeList view={view} t={t} />);

    // Lý do là của cả nhóm → thuộc về thẻ, KHÔNG nằm trong danh sách email.
    expect(html).not.toContain("Mua thêm suất");
    expect(view.failureText).toContain("Mua thêm suất không thành công");

    // Mỗi email vẫn nói đúng đường tiền của chính nó.
    expect(html).toContain("Đã hoàn phí");
    expect(html).toContain("Mời lại miễn phí");
  });

  it("hỏng mà task không thu phí → dòng email im lặng, không bịa chuyện tiền", () => {
    const view = readInviteOutcome(inviteTask({ failed: ["c@x.com"] }))!;
    const html = renderToStaticMarkup(<InviteOutcomeList view={view} t={t} />);
    expect(html).toContain("c@x.com");
    expect(html).not.toContain("hoàn phí");
    expect(html).not.toContain("miễn phí");
  });

  it("không lòi key i18n ra màn hình ở bất kỳ nhóm nào", () => {
    const html = render(
      inviteTask({
        invited: ["a@x.com"],
        failed: ["b@x.com"],
        pending_verify: ["c@x.com"],
        reason_code: "SOMETHING_NEW_FROM_EXTENSION",
      }),
    );
    expect(html).not.toContain("inviteOutcome.");
  });
});

describe("i18n", () => {
  /* Thiếu key ở vi.json là chữ key hiện thẳng lên banner; thiếu ở zh-CN thì rơi về
     tiếng Việt giữa màn hình tiếng Trung. Cả hai đều phải chặn ở đây. */
  const KEYS = [
    "inviteOutcome.doneTitle",
    "inviteOutcome.failedTitle",
    "inviteOutcome.partialTitle",
    "inviteOutcome.countInvited",
    "inviteOutcome.countFailed",
    "inviteOutcome.invited",
    "inviteOutcome.pill.invited",
    "inviteOutcome.pill.failed",
    "inviteOutcome.money.refunded",
    "inviteOutcome.money.seatCredit",
    "inviteOutcome.reason.default",
  ];

  it.each(["vi", "zh-CN"])("%s có đủ key kết quả mời", (lang) => {
    const dict = (lang === "vi" ? vi : zhCN) as Record<string, string>;
    expect(KEYS.filter((k) => !dict[k])).toEqual([]);
  });
});
