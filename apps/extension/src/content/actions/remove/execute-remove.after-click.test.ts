/**
 * BẤM XOÁ XONG THÌ Ô TÌM KIẾM LÀ QUAN TOÀ, KHÔNG PHẢI CÁI HỘP THOẠI.
 *
 * Luật user chốt 10/9/2026: *"bấm xoá xong chờ thấy nó mất là xoá rồi, search là
 * đã kiểm tra rồi nên không thể failed được"*, *"chỉ cần 3s chờ thôi, search mà
 * không ra cái gì thì confirm luôn"*.
 *
 * Vì sao phải khoá bằng test: bản cũ chờ hộp thoại tắt trong 30s, không tắt là
 * `VERIFY_FAILED` kèm lý do đoán mò "ChatGPT hỏi OTP/2FA". Ca thật
 * khaialphauni003@gmail.com 10/9/2026 — ChatGPT gỡ xong nhưng bỏ lại một khung
 * `role="dialog"` rỗng — lệnh báo hỏng, tick sau xếp lại, tới lượt ba thì hệ
 * thống bỏ cuộc và kêu "cần gỡ thủ công" cho một email đã rời workspace.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecuteActionResponse } from "../../../shared/messages";

const failOf = (r: ExecuteActionResponse) =>
  r as { ok: false; error_code?: string; error_message?: string };
const dataOf = (r: ExecuteActionResponse) =>
  (r as { data?: Record<string, unknown> }).data;

const FAKE_EL = { textContent: "Gỡ bỏ khỏi không gian làm việc" };

/** Lượt 1 = tìm để bấm (phải THẤY), lượt 2 = tra lại sau khi bấm. */
const filterOutcomes: Array<Record<string, unknown>> = [];
const filterOnceAndResolve = vi.fn(async () => filterOutcomes.shift() ?? {});
const confirmDialogOpen = vi.fn(() => false);
const answerPaidSeatDialog = vi.fn(
  async (_log: string, _opts?: { release?: boolean }) => "none" as string,
);

vi.mock("../../human", () => ({
  humanClick: vi.fn(async () => {}),
  normalizeMatchText: (s: string) => s,
  querySelectorFirst: () => null,
  randomDelay: vi.fn(async () => {}),
  sleep: vi.fn(async () => {}),
  // Mọi cú `waitFor` ở đường bấm xoá đều coi như tìm thấy thứ nó chờ.
  waitFor: vi.fn(async (fn: () => unknown) => fn() ?? FAKE_EL),
}));
vi.mock("../../progress", () => ({ reportProgress: vi.fn(async () => {}) }));
vi.mock("../member-row", () => ({
  findMemberRow: () => null,
  findRowMenuButton: () => FAKE_EL,
}));
vi.mock("../../../shared/ui-labels", () => ({
  dbLabelsFor: () => [],
  reportLabelMismatch: vi.fn(),
}));
vi.mock("../sync", () => ({ clickTabAndWait: vi.fn(async () => true) }));
vi.mock("./member-filter", () => ({
  clearMemberFilter: vi.fn(async () => {}),
  filterOnceAndResolve: () => filterOnceAndResolve(),
}));
vi.mock("../menu-guard", () => ({
  isDataMenuItemText: () => false,
  pickRemoveMenuItemIndex: () => -1,
  sanitizeRemoveLabels: (x: string[]) => ({ safe: x, blocked: [] }),
}));
vi.mock("../dialog-commit", () => ({
  answerPaidSeatDialog: (log: string, opts?: { release?: boolean }) =>
    answerPaidSeatDialog(log, opts),
  confirmDialogOpen: () => confirmDialogOpen(),
  openDialogText: () => "",
  visibleDialogEl: () => null,
  waitForModalLockGone: vi.fn(async () => {}),
}));
vi.mock("../paid-seat-guard", async () => {
  const real = await vi.importActual<typeof import("../paid-seat-guard")>(
    "../paid-seat-guard",
  );
  // Chỉ cần `releaseWindowOpen` thật (thuần, so đồng hồ) — phần nhận nút đã có
  // test riêng ở paid-seat-guard.test.ts.
  return { releaseWindowOpen: real.releaseWindowOpen };
});
vi.mock("../revoke/pending-tab", () => ({
  ensurePendingInvitesTab: vi.fn(async () => true),
}));
vi.mock("../revoke/revoke-invite", () => ({
  revokeInvite: vi.fn(async (email: string) => ({
    email,
    ok: false,
    notInPending: true,
  })),
}));
vi.mock("../invite/pending-list-loaded", () => ({
  LOAD_BUDGET_MS: 30_000,
  readPendingSnapshot: () => ({}),
  waitForPendingListLoaded: vi.fn(async () => ({
    loaded: true,
    emails: [],
    waitedMs: 10,
    ticks: 1,
  })),
}));
vi.mock("../invite/scan-pending-page", () => ({
  emailsInListRegion: () => new Set<string>(),
}));

vi.stubGlobal("location", { pathname: "/admin/members", search: "", href: "x" });
vi.stubGlobal("document", {
  dispatchEvent: () => true,
  querySelector: () => null,
  querySelectorAll: () => [],
});
vi.stubGlobal(
  "KeyboardEvent",
  class {
    constructor(_type: string, _init?: unknown) {}
  },
);

const { executeRemove } = await import("./execute-remove");

const EMAIL = "hethan@example.com";
const FOUND = { outcome: "found", row: FAKE_EL, rows_before: 1 };

beforeEach(() => {
  filterOutcomes.length = 0;
  filterOnceAndResolve.mockClear();
  confirmDialogOpen.mockReset().mockReturnValue(false);
  answerPaidSeatDialog.mockReset().mockResolvedValue("none");
});

describe("executeRemove — sau khi bấm xoá", () => {
  it("hộp thoại LÌ nhưng tra lại không ra dòng nào → COMPLETED, không VERIFY_FAILED", async () => {
    confirmDialogOpen.mockReturnValue(true);
    filterOutcomes.push(FOUND, { outcome: "absent", rows_before: 0 });

    const r = await executeRemove("t1", EMAIL);

    expect(r.ok).toBe(true);
    expect(dataOf(r)).toMatchObject({ email: EMAIL, verified: true, dialog_stuck: true });
    // Hộp lì thì phải dẹp đi (giữ suất / ESC) chứ không ngồi chờ hết giờ.
    expect(answerPaidSeatDialog).toHaveBeenCalled();
  });

  it("ô lọc không tự chứng minh được (inconclusive) mà không ra dòng → vẫn COMPLETED", async () => {
    filterOutcomes.push(FOUND, {
      outcome: "inconclusive",
      reason: "no_filter_input",
      rows_before: 12,
    });

    const r = await executeRemove("t1", EMAIL);

    expect(r.ok).toBe(true);
    expect(dataOf(r)).toMatchObject({ email: EMAIL, verified: true });
  });

  it("tra lại VẪN thấy dòng đó → mới là hỏng, giữ nguyên để thử lại", async () => {
    filterOutcomes.push(FOUND, FOUND);

    const r = await executeRemove("t1", EMAIL);

    expect(r.ok).toBe(false);
    expect(failOf(r).error_code).toBe("REMOVE_VERIFY_FAILED");
    expect(dataOf(r)).toBeUndefined();
  });

  it("chỉ tra lại ĐÚNG MỘT LẦN sau khi bấm", async () => {
    filterOutcomes.push(FOUND, { outcome: "absent", rows_before: 0 });

    await executeRemove("t1", EMAIL);

    expect(filterOnceAndResolve).toHaveBeenCalledTimes(2); // 1 lần tìm + 1 lần tra lại
  });
});

describe("executeRemove — hộp \"Gỡ suất trả phí?\" theo ngày chốt chu kỳ", () => {
  /** Hộp suất bồi sau xác nhận: lượt đầu còn hộp, trả lời xong thì hết. */
  function paidSeatDialogOnce(): void {
    let open = true;
    confirmDialogOpen.mockImplementation(() => open);
    answerPaidSeatDialog.mockImplementation(async () => {
      open = false;
      return "kept";
    });
  }

  it("KHÔNG có mốc trả suất (giữa kỳ) → hỏi giữ suất", async () => {
    paidSeatDialogOnce();
    filterOutcomes.push(FOUND, { outcome: "absent", rows_before: 0 });

    const r = await executeRemove("t1", EMAIL);

    expect(r.ok).toBe(true);
    expect(answerPaidSeatDialog).toHaveBeenCalledTimes(1);
    expect(answerPaidSeatDialog.mock.calls[0][1]).toEqual({ release: false });
    expect(dataOf(r)).toMatchObject({ paid_seat: "kept" });
  });

  it("mốc trả suất còn ở tương lai (ngày chốt) → hỏi GỠ suất, báo released", async () => {
    let open = true;
    confirmDialogOpen.mockImplementation(() => open);
    answerPaidSeatDialog.mockImplementation(async () => {
      open = false;
      return "released";
    });
    filterOutcomes.push(FOUND, { outcome: "absent", rows_before: 0 });
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const r = await executeRemove("t1", EMAIL, { releasePaidSeatUntil: until });

    expect(r.ok).toBe(true);
    expect(answerPaidSeatDialog.mock.calls[0][1]).toEqual({ release: true });
    expect(dataOf(r)).toMatchObject({ paid_seat: "released", verified: true });
  });

  it("mốc trả suất ĐÃ QUA (chạy trễ qua giờ hoá đơn) → lại giữ suất như giữa kỳ", async () => {
    paidSeatDialogOnce();
    filterOutcomes.push(FOUND, { outcome: "absent", rows_before: 0 });
    const until = new Date(Date.now() - 60 * 1000).toISOString();

    const r = await executeRemove("t1", EMAIL, { releasePaidSeatUntil: until });

    expect(r.ok).toBe(true);
    expect(answerPaidSeatDialog.mock.calls[0][1]).toEqual({ release: false });
  });

  it("ChatGPT không hỏi gì (không có hộp) → paid_seat = none, không gọi trả lời", async () => {
    filterOutcomes.push(FOUND, { outcome: "absent", rows_before: 0 });
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const r = await executeRemove("t1", EMAIL, { releasePaidSeatUntil: until });

    expect(r.ok).toBe(true);
    expect(answerPaidSeatDialog).not.toHaveBeenCalled();
    expect(dataOf(r)).toMatchObject({ paid_seat: "none" });
  });
});
