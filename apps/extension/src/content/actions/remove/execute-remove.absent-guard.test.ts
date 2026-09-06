/**
 * `absent: true` LÀ CHỮ KÝ NHẢ GHẾ — chỉ được ký khi đã tra CẢ HAI tab.
 *
 * Backend nhận `absent` thì ghi `removal_evidence='absent_confirmed'` và mark
 * member `removed` mà KHÔNG click xoá lần nào (xem `queue/completion.md`). Nếu
 * email thật ra đang nằm ở tab "Lời mời đang chờ xử lý", nó vẫn ăn một ghế trên
 * ChatGPT trong khi dashboard tưởng đã trả — và cái ghế ma đó được bán cho người
 * tiếp theo. Ca thật GPT1 5/9/2026: gỡ lúc 18:00 kết luận `absent_confirmed`,
 * email ăn ghế thêm 16.7 giờ, workspace vượt trần 387/386 khi lần đồng bộ sau
 * chữa lại sự thật.
 *
 * Trước 6/9/2026 cả ba kết cục của cú ghé tab Lời mời — thu hồi xong, tra rồi
 * không thấy, và KHÔNG TRA ĐƯỢC — đều rơi về cùng một `null`, và caller đọc
 * `null` là "đã rời thật". Bộ test này đòi tách bạch: chưa tra được thì phải
 * FAILED để lượt sau thử lại, tuyệt đối không ký `absent`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecuteActionResponse } from "../../../shared/messages";

type RevokeStub = {
  email: string;
  ok: boolean;
  notInPending?: boolean;
  inconclusive?: boolean;
  reason?: string;
};

/** `ExecuteActionResponse` là union theo `ok` — hẹp về nhánh hỏng để đọc mã lỗi. */
const failOf = (r: ExecuteActionResponse) =>
  r as { ok: false; error_code?: string; error_message?: string };
/** Nhánh thành công: `data` là túi tự do, test tự soi khoá mình quan tâm. */
const dataOf = (r: ExecuteActionResponse) =>
  (r as { data?: Record<string, unknown> }).data;

const filterOutcome = { outcome: "absent" as string, rows_before: 12, reason: "" };
const ensurePendingInvitesTab = vi.fn(async () => true);
const revokeInvite = vi.fn(
  async (email: string): Promise<RevokeStub> => ({ email, ok: false, notInPending: true }),
);
const waitForPendingListLoaded = vi.fn(async () => ({
  loaded: true as boolean,
  emails: [] as string[],
  waitedMs: 10,
  ticks: 1,
  reason: "",
}));

vi.mock("../../human", () => ({
  humanClick: vi.fn(async () => {}),
  normalizeMatchText: (s: string) => s,
  querySelectorFirst: () => null,
  randomDelay: vi.fn(async () => {}),
  sleep: vi.fn(async () => {}),
  waitFor: vi.fn(async () => null),
}));
vi.mock("../../progress", () => ({ reportProgress: vi.fn(async () => {}) }));
vi.mock("../member-row", () => ({ findRowMenuButton: () => null }));
vi.mock("../../../shared/ui-labels", () => ({
  dbLabelsFor: () => [],
  reportLabelMismatch: vi.fn(),
}));
vi.mock("../sync", () => ({ clickTabAndWait: vi.fn(async () => true) }));
vi.mock("./member-filter", () => ({
  clearMemberFilter: vi.fn(async () => {}),
  filterOnceAndResolve: async () => filterOutcome,
}));
vi.mock("../menu-guard", () => ({
  isDataMenuItemText: () => false,
  pickRemoveMenuItemIndex: () => -1,
  sanitizeRemoveLabels: (x: string[]) => x,
}));
vi.mock("../dialog-commit", () => ({
  confirmDialogBusy: () => false,
  confirmDialogOpen: () => false,
  openDialogText: () => "",
  waitForConfirmDialogClosed: vi.fn(async () => true),
  waitForModalLockGone: vi.fn(async () => true),
}));
vi.mock("../revoke/pending-tab", () => ({
  ensurePendingInvitesTab: () => ensurePendingInvitesTab(),
}));
vi.mock("../revoke/revoke-invite", () => ({
  revokeInvite: (email: string) => revokeInvite(email),
}));
vi.mock("../invite/pending-list-loaded", () => ({
  LOAD_BUDGET_MS: 30_000,
  readPendingSnapshot: () => ({}),
  waitForPendingListLoaded: () => waitForPendingListLoaded(),
}));
vi.mock("../invite/scan-pending-page", () => ({
  emailsInListRegion: () => new Set<string>(),
}));

vi.stubGlobal("location", { pathname: "/admin/members", search: "", href: "x" });

const { executeRemove } = await import("./execute-remove");

const EMAIL = "gone@example.com";

beforeEach(() => {
  filterOutcome.outcome = "absent";
  ensurePendingInvitesTab.mockReset().mockResolvedValue(true);
  revokeInvite
    .mockReset()
    .mockResolvedValue({ email: EMAIL, ok: false, notInPending: true });
  waitForPendingListLoaded
    .mockReset()
    .mockResolvedValue({ loaded: true, emails: [], waitedMs: 10, ticks: 1, reason: "" });
});

describe("executeRemove — chữ ký `absent` đòi bằng chứng từ CẢ HAI tab", () => {
  it("KHÔNG vào được tab Lời mời → FAILED, không ký absent", async () => {
    ensurePendingInvitesTab.mockResolvedValue(false);

    const r = await executeRemove("t1", EMAIL);

    expect(r.ok).toBe(false);
    expect(failOf(r).error_code).toBe("MEMBER_NOT_IN_WORKSPACE");
    expect(dataOf(r)).toBeUndefined();
    expect(revokeInvite).not.toHaveBeenCalled();
  });

  it("vào được tab nhưng danh sách CHƯA NẠP XONG → FAILED, không ký absent", async () => {
    waitForPendingListLoaded.mockResolvedValue({
      loaded: false,
      emails: [],
      waitedMs: 30_000,
      ticks: 70,
      reason: "danh sách chưa đứng yên",
    });

    const r = await executeRemove("t1", EMAIL);

    expect(r.ok).toBe(false);
    expect(failOf(r).error_code).toBe("MEMBER_NOT_IN_WORKSPACE");
    expect(failOf(r).error_message).toContain("danh sách chưa đứng yên");
    // Danh sách chưa vẽ thì "không có row nào" là vô nghĩa — đừng tra.
    expect(revokeInvite).not.toHaveBeenCalled();
  });

  it("đã tra CẢ HAI tab và đều không có → mới được ký absent", async () => {
    const r = await executeRemove("t1", EMAIL);

    expect(r.ok).toBe(true);
    expect(dataOf(r)).toMatchObject({ email: EMAIL, verified: true, absent: true });
    expect(revokeInvite).toHaveBeenCalledWith(EMAIL);
  });

  it("có lời mời chờ và thu hồi được → COMPLETED qua đường thu hồi, KHÔNG absent", async () => {
    revokeInvite.mockResolvedValue({ email: EMAIL, ok: true, notInPending: false });

    const r = await executeRemove("t1", EMAIL);

    expect(r.ok).toBe(true);
    expect(dataOf(r)).toMatchObject({ verified: true, via_revoke: true });
    expect(dataOf(r)?.absent).toBeUndefined();
  });

  it("tra được tab nhưng CÚ TRA không phân xử được → FAILED, không ký absent", async () => {
    // `lookupPendingRow` không chứng minh được vắng mặt (không có ô tìm kiếm, hoặc
    // ô tìm kiếm chết) — xem `revoke/locate-pending-row.test.ts`.
    revokeInvite.mockResolvedValue({
      email: EMAIL,
      ok: false,
      inconclusive: true,
      reason: "Không tra được tab Lời mời (pending_search_dead, 40 dòng)",
    });

    const r = await executeRemove("t1", EMAIL);

    expect(r.ok).toBe(false);
    expect(failOf(r).error_code).toBe("MEMBER_NOT_IN_WORKSPACE");
    expect(failOf(r).error_message).toContain("pending_search_dead");
  });

  it("có lời mời chờ nhưng thu hồi hỏng → FAILED, không ký absent", async () => {
    revokeInvite.mockResolvedValue({
      email: EMAIL,
      ok: false,
      notInPending: false,
      reason: "menu không có mục thu hồi",
    });

    const r = await executeRemove("t1", EMAIL);

    expect(r.ok).toBe(false);
    expect(failOf(r).error_code).toBe("REMOVE_VERIFY_FAILED");
  });
});
