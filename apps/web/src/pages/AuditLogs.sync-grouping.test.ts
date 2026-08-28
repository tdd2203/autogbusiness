/* Nhật ký của MỘT lệnh đồng bộ phải là MỘT dòng, và dòng đó tự nói được đã thêm
   ai / thiếu ai (chốt user 28/8/2026).

   Ca thật (ảnh user, mốc 15:38:19): một mẻ `SYNC_MEMBERS_BATCH` đưa 12 email vào
   nhóm → nhật ký đẻ ra 12 dòng "Thành viên đã tham gia (qua đồng bộ)" giống hệt
   nhau, đọc hết màn hình không ra việc gì. Dữ liệu dưới đây chép từ audit_logs
   production của chính mẻ đó. */

import { describe, expect, it } from "vitest";
import { buildGroups, importantGroup, summarize } from "./AuditLogs";

const SYNC_QID = "a03294be-91c9-429b-a773-27019d52c433";
const WS = "GPT1";

const PROMOTED = [
  "gq2020ilove@gmail.com",
  "haphong26122002@gmail.com",
  "hieulebg018@gmail.com",
  "jsceqas@gmail.com",
  "minhthu21222709@gmail.com",
  "nmhung0931699995@gmail.com",
  "nongvandattk10@gmail.com",
  "suadung68@gmail.com",
  "tranthikimhien2511@gmail.com",
  "trongtan030108@gmail.com",
  "trongtien.db@gmail.com",
  "vupqxebk580@outlook.com",
];

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

function decorate(rows: RawEvent[]) {
  return rows.map((r) => {
    const impGroup = importantGroup(r.action);
    const email = typeof r.data?.email === "string" ? r.data.email : null;
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
      targetEmails: email ? [email] : [],
      workspace_name: WS,
    };
  }) as never[];
}

/** API trả mới → cũ. */
function syncEvents(): RawEvent[] {
  const promoted: RawEvent[] = PROMOTED.map((email, i) => ({
    id: `p${i}`,
    timestamp: "2026-08-28T08:38:19.000Z",
    actor_type: "EXTENSION",
    action: "MEMBER_SYNC_PROMOTED_ACTIVE",
    result: "COMPLETED",
    target_type: "MEMBER",
    // Mỗi email một member khác nhau — đúng như thật.
    target_id: `11111111-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`,
    data: { email, found_in: "active", batch: true, queue_item_id: SYNC_QID },
  }));
  return [
    {
      id: "done",
      timestamp: "2026-08-28T08:38:19.500Z",
      actor_type: "EXTENSION",
      action: "QUEUE_UPDATED:SYNC_MEMBERS_BATCH",
      result: "COMPLETED",
      target_type: "QUEUE_ITEM",
      target_id: SYNC_QID,
      data: {
        status: "COMPLETED",
        promoted_active: 12,
        promoted_emails: PROMOTED,
      },
    },
    ...promoted,
    {
      id: "picked",
      timestamp: "2026-08-28T08:38:10.000Z",
      actor_type: "EXTENSION",
      action: "QUEUE_PICKED:SYNC_DATA",
      result: "COMPLETED",
      target_type: "QUEUE_ITEM",
      target_id: SYNC_QID,
      data: null,
    },
    {
      id: "queued",
      timestamp: "2026-08-28T08:38:05.000Z",
      actor_type: "SYSTEM",
      action: "WORKSPACE_SYNC_QUEUED",
      result: "PENDING",
      target_type: "WORKSPACE",
      target_id: "ee3597dc-581a-4e2d-ac22-de44b71e6509",
      data: { queue_item_id: SYNC_QID, include_pending: true },
    },
  ];
}

describe("nhật ký lệnh đồng bộ", () => {
  it("cả mẻ 12 email về MỘT dòng, không phải 12 dòng", () => {
    const groups = buildGroups(decorate(syncEvents()));
    expect(groups).toHaveLength(1);
    expect(groups[0].events).toHaveLength(15); // 12 email + queued + picked + updated
  });

  it("dòng đó nói rõ đã thêm bao nhiêu email và là những email nào", () => {
    const [g] = buildGroups(decorate(syncEvents()));
    const line = summarize(g);
    expect(line).toBeTruthy();
    expect(line).toContain("12 email đã vào nhóm");
    expect(line).toContain("gq2020ilove@gmail.com");
    // Không dán hết 12 địa chỉ vào một dòng — cắt còn 4 rồi ghi "+8".
    expect(line).toContain("+8");
    expect(line).not.toContain("vupqxebk580@outlook.com");
  });

  it("thiếu email / lệch tổng thì tách hẳn ra cho dễ thấy", () => {
    const evs = syncEvents();
    evs.push({
      id: "upsert",
      timestamp: "2026-08-28T08:38:19.400Z",
      actor_type: "EXTENSION",
      action: "MEMBER_BULK_UPSERT",
      result: "COMPLETED",
      target_type: "WORKSPACE",
      target_id: "ee3597dc-581a-4e2d-ac22-de44b71e6509",
      data: {
        queue_item_id: SYNC_QID,
        total: 243,
        created: 2,
        updated: 241,
        removed_missing: 3,
        fake_removed: 0,
        is_full_sync: true,
        expected_total: 245,
      },
    });
    const line = summarize(buildGroups(decorate(evs))[0]);
    expect(line).toContain("2 email mới ghi nhận");
    expect(line).toContain("3 email ChatGPT không còn");
    expect(line).toContain("lệch tổng: ChatGPT 245, hệ thống 243");
  });

  it("email vừa được MỜI xong vẫn thuộc lệnh mời, không bị kéo sang lệnh đồng bộ", () => {
    // Bằng chứng "đã tham gia" của một lời mời phải đứng cùng lời mời đó, nếu
    // không thì lệnh mời trông như chưa có kết quả.
    const MEMBER = "22222222-0000-0000-0000-000000000001";
    const INVITE_QID = "61432306-7200-4f4d-aa89-3c4bbff47e1e";
    const evs: RawEvent[] = [
      {
        id: "sync",
        timestamp: "2026-08-28T08:38:19.000Z",
        actor_type: "EXTENSION",
        action: "MEMBER_SYNC_PROMOTED_ACTIVE",
        result: "COMPLETED",
        target_type: "MEMBER",
        target_id: MEMBER,
        data: {
          email: "moi-xong@gmail.com",
          found_in: "active",
          queue_item_id: SYNC_QID,
        },
      },
      {
        id: "inv-done",
        timestamp: "2026-08-28T08:38:00.000Z",
        actor_type: "EXTENSION",
        action: "QUEUE_UPDATED:INVITE_MEMBER",
        result: "COMPLETED",
        target_type: "QUEUE_ITEM",
        target_id: INVITE_QID,
        data: { status: "COMPLETED" },
      },
      {
        id: "inv-queued",
        timestamp: "2026-08-28T08:37:50.000Z",
        actor_type: "ADMIN",
        action: "MEMBER_INVITE_QUEUED",
        result: "PENDING",
        target_type: "MEMBER",
        target_id: MEMBER,
        data: { email: "moi-xong@gmail.com", queue_item_id: INVITE_QID },
      },
    ];
    const groups = buildGroups(decorate(evs));
    const inviteGroup = groups.find((g) =>
      g.events.some((e) => e.id === "inv-queued"),
    );
    expect(inviteGroup?.events.map((e) => e.id)).toContain("sync");
  });
});
