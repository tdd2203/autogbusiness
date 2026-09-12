/**
 * BẤM XOÁ XONG: CHỜ DÒNG ĐÓ BIẾN MẤT, RỒI Ô TÌM KIẾM PHÂN XỬ ĐÚNG MỘT LẦN.
 *
 * Luật user: *"bấm xoá xong chờ thấy nó mất là xoá rồi, search mà không ra cái gì
 * thì confirm luôn"* (10/9/2026) và *"xoá xong chờ nó biến mất rồi tìm kiếm đúng 1
 * lần cho chắc chắn"* (11/9/2026).
 *
 * Vì sao phải khoá bằng test, hai lần sai theo hai chiều:
 *   · bản chờ hộp thoại tắt trong 30s — ChatGPT gỡ xong nhưng bỏ lại một khung
 *     `role="dialog"` rỗng thì lệnh báo `VERIFY_FAILED`, tick sau xếp lại, tới
 *     lượt ba hệ thống bỏ cuộc cho một email đã rời workspace;
 *   · bản chờ 3 giây — hộp xác nhận còn quay đã bị ESC và ô lọc gõ ngay khi
 *     ChatGPT chưa gỡ xong, nên lệnh gỡ nào cũng báo "vẫn thấy dòng" và phải chạy
 *     lại lượt hai.
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
const confirmDialogBusy = vi.fn(() => false);
const paidSeatDialogOpen = vi.fn(() => false);
/** Dòng của email trong danh sách đang lọc — mặc định đã biến mất. */
const findMemberRow = vi.fn((_email: string): unknown => null);
const answerPaidSeatDialog = vi.fn(
  async (_log: string, _opts?: { release?: boolean }) => "none" as string,
);
/** Mọi cú ESC đi qua `document.dispatchEvent`. */
const dispatchEvent = vi.fn((_e: unknown) => true);
/** Tab "Lời mời đang chờ xử lý" — đường gỡ bình thường KHÔNG được đụng tới. */
const ensurePendingInvitesTab = vi.fn(async () => true);
const revokeInvite = vi.fn(async (email: string) => ({
  email,
  ok: false,
  notInPending: true,
}));

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
  findMemberRow: (email: string) => findMemberRow(email),
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
  confirmDialogBusy: () => confirmDialogBusy(),
  confirmDialogOpen: () => confirmDialogOpen(),
  openDialogText: () => "",
  paidSeatDialogOpen: () => paidSeatDialogOpen(),
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
  ensurePendingInvitesTab: () => ensurePendingInvitesTab(),
}));
vi.mock("../revoke/revoke-invite", () => ({
  revokeInvite: (email: string) => revokeInvite(email),
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
  dispatchEvent: (e: unknown) => dispatchEvent(e),
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
const ABSENT = { outcome: "absent", rows_before: 0 };

beforeEach(() => {
  filterOutcomes.length = 0;
  filterOnceAndResolve.mockReset().mockImplementation(async () => filterOutcomes.shift() ?? {});
  confirmDialogOpen.mockReset().mockReturnValue(false);
  confirmDialogBusy.mockReset().mockReturnValue(false);
  paidSeatDialogOpen.mockReset().mockReturnValue(false);
  findMemberRow.mockReset().mockReturnValue(null);
  answerPaidSeatDialog.mockReset().mockResolvedValue("none");
  dispatchEvent.mockClear();
  ensurePendingInvitesTab.mockClear();
  revokeInvite.mockClear();
});

describe("executeRemove — sau khi bấm xoá", () => {
  it("hộp xác nhận còn quay quá 3 giây → không ESC, không tra sớm; dòng biến mất rồi mới tra", async () => {
    const SPIN = 40; // ~12 giây ChatGPT còn đang gỡ
    const GONE_AT = SPIN + 5; // hộp tắt rồi danh sách mới vẽ lại
    let ticks = 0;
    confirmDialogOpen.mockImplementation(() => ticks < SPIN);
    confirmDialogBusy.mockImplementation(() => ticks < SPIN);
    findMemberRow.mockImplementation(() => (++ticks < GONE_AT ? FAKE_EL : null));
    let ticksAtRecheck = -1;
    filterOnceAndResolve
      .mockImplementationOnce(async () => FOUND)
      .mockImplementationOnce(async () => {
        ticksAtRecheck = ticks;
        return ABSENT;
      });

    const r = await executeRemove("t1", EMAIL);

    expect(r.ok).toBe(true);
    expect(dataOf(r)).toMatchObject({ verified: true, row_gone: true, dialog_stuck: false });
    expect(ticksAtRecheck).toBeGreaterThanOrEqual(GONE_AT);
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(filterOnceAndResolve).toHaveBeenCalledTimes(2);
  });

  it("hộp thoại LÌ (không quay) nhưng dòng đã mất, tra lại không ra → dẹp hộp, COMPLETED", async () => {
    confirmDialogOpen.mockReturnValue(true);
    filterOutcomes.push(FOUND, ABSENT);

    const r = await executeRemove("t1", EMAIL);

    expect(r.ok).toBe(true);
    expect(dataOf(r)).toMatchObject({ email: EMAIL, verified: true, dialog_stuck: true });
    // Hộp lì thì phải dẹp đi (giữ suất / ESC) chứ không ngồi chờ hết giờ.
    expect(answerPaidSeatDialog).toHaveBeenCalled();
    expect(dispatchEvent).toHaveBeenCalled();
  });

  it("dòng đã biến mất, ô lọc không tự chứng minh được (inconclusive) → vẫn COMPLETED", async () => {
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

  it("dòng nằm lì suốt trần chờ → vẫn chỉ tra lại một lần, thấy dòng thì báo hỏng", async () => {
    findMemberRow.mockReturnValue(FAKE_EL);
    filterOutcomes.push(FOUND, FOUND);

    const r = await executeRemove("t1", EMAIL);

    expect(r.ok).toBe(false);
    expect(failOf(r).error_code).toBe("REMOVE_VERIFY_FAILED");
    expect(filterOnceAndResolve).toHaveBeenCalledTimes(2);
  });

  it("dòng nằm lì và ô lọc không tra lại được → chưa có bằng chứng, không báo xong", async () => {
    findMemberRow.mockReturnValue(FAKE_EL);
    filterOutcomes.push(FOUND, {
      outcome: "inconclusive",
      reason: "no_filter_input",
      rows_before: 12,
    });

    const r = await executeRemove("t1", EMAIL);

    expect(r.ok).toBe(false);
    expect(failOf(r).error_code).toBe("REMOVE_VERIFY_FAILED");
    expect(failOf(r).error_message).toContain("no_filter_input");
  });

  it("chỉ tra lại ĐÚNG MỘT LẦN sau khi bấm", async () => {
    filterOutcomes.push(FOUND, ABSENT);

    await executeRemove("t1", EMAIL);

    expect(filterOnceAndResolve).toHaveBeenCalledTimes(2); // 1 lần tìm + 1 lần tra lại
  });

  // User 12/9/2026 rút lại luật 6/9: xoá xong chỉ tra ở tab "Người dùng", KHÔNG
  // ghé tab "Lời mời đang chờ xử lý" quét thêm. Cú quét ấy không lật được kết quả
  // nào (gỡ đã có bằng chứng dương) mà tốn thêm một lần chuyển tab và tới 20s gõ
  // ô tìm kiếm.
  it("xoá xong KHÔNG ghé tab Lời mời đang chờ xử lý", async () => {
    filterOutcomes.push(FOUND, ABSENT);

    const r = await executeRemove("t1", EMAIL);

    expect(r.ok).toBe(true);
    expect(ensurePendingInvitesTab).not.toHaveBeenCalled();
    expect(revokeInvite).not.toHaveBeenCalled();
  });
});

describe("executeRemove — hộp \"Gỡ suất trả phí?\" theo ngày chốt chu kỳ", () => {
  /** Hộp suất bồi sau xác nhận: còn hộp tới khi được trả lời. */
  function paidSeatDialogOnce(answer: string): void {
    let open = true;
    confirmDialogOpen.mockImplementation(() => open);
    paidSeatDialogOpen.mockImplementation(() => open);
    answerPaidSeatDialog.mockImplementation(async () => {
      open = false;
      return answer;
    });
  }

  it("KHÔNG có mốc trả suất (giữa kỳ) → hỏi giữ suất, đúng một lần", async () => {
    paidSeatDialogOnce("kept");
    filterOutcomes.push(FOUND, ABSENT);

    const r = await executeRemove("t1", EMAIL);

    expect(r.ok).toBe(true);
    expect(answerPaidSeatDialog).toHaveBeenCalledTimes(1);
    expect(answerPaidSeatDialog.mock.calls[0][1]).toEqual({ release: false });
    expect(dataOf(r)).toMatchObject({ paid_seat: "kept", dialog_stuck: false });
  });

  it("mốc trả suất còn ở tương lai (ngày chốt) → hỏi GỠ suất, báo released", async () => {
    paidSeatDialogOnce("released");
    filterOutcomes.push(FOUND, ABSENT);
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const r = await executeRemove("t1", EMAIL, { releasePaidSeatUntil: until });

    expect(r.ok).toBe(true);
    expect(answerPaidSeatDialog).toHaveBeenCalledTimes(1);
    expect(answerPaidSeatDialog.mock.calls[0][1]).toEqual({ release: true });
    expect(dataOf(r)).toMatchObject({ paid_seat: "released", verified: true });
  });

  it("mốc trả suất ĐÃ QUA (chạy trễ qua giờ hoá đơn) → lại giữ suất như giữa kỳ", async () => {
    paidSeatDialogOnce("kept");
    filterOutcomes.push(FOUND, ABSENT);
    const until = new Date(Date.now() - 60 * 1000).toISOString();

    const r = await executeRemove("t1", EMAIL, { releasePaidSeatUntil: until });

    expect(r.ok).toBe(true);
    expect(answerPaidSeatDialog.mock.calls[0][1]).toEqual({ release: false });
  });

  it("ChatGPT không hỏi gì (không có hộp) → paid_seat = none, không gọi trả lời", async () => {
    filterOutcomes.push(FOUND, ABSENT);
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const r = await executeRemove("t1", EMAIL, { releasePaidSeatUntil: until });

    expect(r.ok).toBe(true);
    expect(answerPaidSeatDialog).not.toHaveBeenCalled();
    expect(dataOf(r)).toMatchObject({ paid_seat: "none" });
  });
});
