import { describe, expect, it } from "vitest";
import { buildGroups, importantGroup } from "./AuditLogs";

/* Hồi quy bug user 2026-08-04 (lingtruong1301@gmail.com): sự kiện đồng bộ "đã tham
   gia" của HÔM SAU bị dán vào lệnh "Xoá do hết hạn" HÔM TRƯỚC → nhóm hiện giờ của
   lần đồng bộ, trông như hệ thống vừa xoá một email vừa được mời lại + gia hạn.
   Dữ liệu dưới đây chép từ audit_logs production của chính ca đó. */

const MEMBER_ID = "a7433b0c-8391-4f93-ab1d-38d3e47cd91a";
const REMOVE_QID = "0843c49b-abb6-49ce-a365-1f85b42ba9df";
const INVITE_QID = "61432306-7200-4f4d-aa89-3c4bbff47e1e";
const EMAIL = "lingtruong1301@gmail.com";

type RawEvent = {
  id: string;
  timestamp: string;
  actor_type: string;
  action: string;
  result: string;
  target_type: string | null;
  target_id: string | null;
  data: Record<string, unknown> | null;
};

/** Dựng `Decorated` tối thiểu — các trường trang trí (avatar/nhãn) không ảnh hưởng
 *  việc gom nhóm nên để giá trị trơ; `impGroup` dùng đúng hàm của trang. */
function decorate(rows: RawEvent[]) {
  return rows.map((r) => {
    const impGroup = importantGroup(r.action);
    return {
      ...r,
      cat: "member" as const,
      impGroup,
      important: impGroup !== null,
      routine: impGroup === null,
      status: "success" as never,
      actorInitial: "S",
      actorSub: "",
      actorName: "hệ thống",
      avatarBg: "",
      targetEmails: [EMAIL],
      workspace_name: "CHATGPT PRO",
    };
  }) as never[];
}

/** API trả mới → cũ. */
const EVENTS: RawEvent[] = [
  {
    id: "e6",
    timestamp: "2026-08-04T08:43:01.868Z",
    actor_type: "EXTENSION",
    action: "MEMBER_SYNC_PROMOTED_ACTIVE",
    result: "COMPLETED",
    target_type: "MEMBER",
    target_id: MEMBER_ID,
    data: { email: EMAIL, found_in: "active", batch: true },
  },
  {
    id: "e5",
    timestamp: "2026-08-03T09:19:12.087Z",
    actor_type: "ADMIN",
    action: "MEMBER_FEE_SET",
    result: "SUCCESS",
    target_type: "MEMBER",
    target_id: MEMBER_ID,
    data: { fee_vnd: 370000 },
  },
  {
    id: "e4",
    timestamp: "2026-08-03T08:39:56.980Z",
    actor_type: "EXTENSION",
    action: "MEMBER_INVITE_VERIFIED",
    result: "COMPLETED",
    target_type: "MEMBER",
    target_id: MEMBER_ID,
    data: { email: EMAIL, queue_item_id: INVITE_QID },
  },
  {
    id: "e3",
    timestamp: "2026-08-03T08:39:24.157Z",
    actor_type: "ADMIN",
    action: "MEMBER_BULK_INVITE_QUEUED",
    result: "PENDING",
    target_type: "QUEUE_ITEM",
    target_id: INVITE_QID,
    data: { entries: [{ email: EMAIL }] },
  },
  {
    id: "e2",
    timestamp: "2026-08-03T04:03:08.067Z",
    actor_type: "EXTENSION",
    action: "MEMBER_REMOVED_SYNCED",
    result: "COMPLETED",
    target_type: "MEMBER",
    target_id: MEMBER_ID,
    data: { email: EMAIL, queue_item_id: REMOVE_QID, removal_reason: "expired" },
  },
  {
    id: "e1",
    timestamp: "2026-08-03T03:37:23.504Z",
    actor_type: "SYSTEM",
    action: "MEMBER_EXPIRED_REMOVE_QUEUED",
    result: "PENDING",
    target_type: "MEMBER",
    target_id: MEMBER_ID,
    data: { email: EMAIL, queue_item_id: REMOVE_QID, task_type: "REMOVE_MEMBER" },
  },
];

describe("gom nhóm nhật ký kiểm tra", () => {
  const groups = buildGroups(decorate(EVENTS));
  const byTitle = (title: string) => groups.filter((g) => g.title === title);

  it('ca "Xoá do hết hạn" giữ nguyên giờ chạy thật, không nuốt sự kiện ngày sau', () => {
    const [expiredRemove] = byTitle("Xoá do hết hạn");
    expect(expiredRemove).toBeDefined();
    expect(expiredRemove.count).toBe(2);
    expect(expiredRemove.latestTs).toBe("2026-08-03T04:03:08.067Z");
    expect(expiredRemove.events.map((e) => e.id).sort()).toEqual(["e1", "e2"]);
  });

  it('"đã tham gia (qua đồng bộ)" hôm sau đứng thành nhóm riêng', () => {
    const promoted = groups.find((g) => g.events.some((e) => e.id === "e6"));
    expect(promoted?.count).toBe(1);
    expect(promoted?.lifecycle).toBe(false);
  });

  it("thao tác admin (đặt phí) không bị gộp vào lệnh hàng đợi nào", () => {
    const fee = groups.find((g) => g.events.some((e) => e.id === "e5"));
    expect(fee?.count).toBe(1);
    expect(fee?.lifecycle).toBe(false);
  });

  it("lời mời gom đủ cả bước xếp hàng lẫn xác minh", () => {
    const invite = groups.find((g) => g.events.some((e) => e.id === "e3"));
    expect(invite?.events.map((e) => e.id).sort()).toEqual(["e3", "e4"]);
  });

  it("đồng bộ ngay sau lệnh mời VẪN nối vào đúng ca mời đó", () => {
    const promptSync: RawEvent = {
      ...EVENTS[0],
      id: "e7",
      timestamp: "2026-08-03T08:41:00.000Z", // 1 phút sau khi mời xong
    };
    const g = buildGroups(decorate([promptSync, ...EVENTS.slice(1)])).find((x) =>
      x.events.some((e) => e.id === "e7"),
    );
    expect(g?.title).toBe("Mời thành viên hàng loạt");
    expect(g?.events.map((e) => e.id).sort()).toEqual(["e3", "e4", "e7"]);
  });
});
