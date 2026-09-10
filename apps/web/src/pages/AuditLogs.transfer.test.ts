/* Lệnh mời / lệnh gỡ sinh ra từ một lần ĐỔI EMAIL (chuyển hạn sử dụng) phải tự
   kể được nó từ đâu ra.

   Ca thật (ảnh user 10/9/2026, mốc 08:31:43): admin huumisa bấm "Chuyển hạn sử
   dụng đến" cho hungcuong128 → cuongnh ở CHATGPT PRO. Lệnh mời cuongnh hiện trên
   tab Chính là "Mời thành viên · workspace:CHATGPT PRO · Tự động", bước "Xếp hàng"
   trống, không một chữ nào nói nó là kết quả của lần đổi email — dòng của admin
   (`MEMBER_SUBSCRIPTION_TRANSFERRED`) không mang `queue_item_id` nên đứng riêng ở
   tab Khác. Dữ liệu dưới đây chép từ audit_logs production của chính ca đó, cộng
   phần API nay bơm thêm lúc đọc (`queue_item_id` cho dòng của admin,
   `transfer_origin` cho mọi dòng của cả hai lệnh). */

import { describe, expect, it } from "vitest";
import { buildGroups, importantGroup, summarize } from "./AuditLogs";

const WS_ID = "e9cea7fc-f0ac-427f-bdea-0891bc721d81";
const WS = "CHATGPT PRO";
const ADMIN = "huumisa@no-email.local";
const OLD_EMAIL = "hungcuong128@gmail.com";
const NEW_EMAIL = "cuongnh@nghiadan.gov.vn";
const OLD_MID = "dfd1361a-6260-440c-98eb-b6ac07755179";
const NEW_MID = "b84966a2-5bce-4922-90d4-e63c3d5b4ea4";
const INVITE_QID = "35306155-c764-4b33-9122-d50d1d109006";
const REMOVE_QID = "487b05e4-33fc-43a9-b3f2-3dd5fef63ba0";

type RawEvent = {
  id: string;
  timestamp: string;
  actor_type: string;
  actor_label: string | null;
  action: string;
  result: string;
  target_type: string | null;
  target_id: string | null;
  data: Record<string, unknown> | null;
};

/** Ngữ cảnh API bơm vào từng dòng của lệnh (xem `audit_logs.py`). */
function origin(leg: "invite" | "remove", over: Record<string, unknown> = {}) {
  return {
    kind: "subscription_transfer",
    leg,
    source_email: OLD_EMAIL,
    target_email: NEW_EMAIL,
    mode: "fresh",
    actor_type: "ADMIN",
    actor_label: ADMIN,
    ...over,
  };
}

/** Email của một dòng — cùng các khoá mà trang đọc (`collectEmails`). */
function emailsOf(d: Record<string, unknown> | null): string[] {
  if (!d) return [];
  const out: string[] = [];
  for (const k of ["email", "target_email", "old_email", "new_email"]) {
    const v = d[k];
    if (typeof v === "string" && v.includes("@") && !out.includes(v)) out.push(v);
  }
  const list = d.emails;
  if (Array.isArray(list))
    for (const v of list) if (typeof v === "string" && !out.includes(v)) out.push(v);
  return out;
}

/** Dựng `Decorated` tối thiểu — tên người thực hiện tính y như trang. */
function decorate(rows: RawEvent[]) {
  return rows.map((r) => {
    const impGroup = importantGroup(r.action);
    const label = r.actor_label ?? "";
    const actorName =
      r.actor_type === "ADMIN"
        ? label.slice(0, Math.max(label.indexOf("@"), 0)) || label
        : r.actor_type === "SYSTEM"
          ? "hệ thống"
          : label;
    return {
      ...r,
      cat: "member" as const,
      impGroup,
      important: impGroup !== null,
      routine: impGroup === null,
      status: r.result === "FAILED" ? "failed" : "success",
      actorInitial: actorName.charAt(0).toUpperCase(),
      actorSub: "",
      actorName,
      avatarBg: "",
      targetEmails: emailsOf(r.data),
      workspace_name: WS,
    };
  }) as never[];
}

/* Dòng của admin — API đã gắn `queue_item_id` = lệnh mời + `transfer_origin`. */
const TRANSFER_ROW: RawEvent = {
  id: "t0",
  timestamp: "2026-09-10T01:30:08.000Z",
  actor_type: "ADMIN",
  actor_label: ADMIN,
  action: "MEMBER_SUBSCRIPTION_TRANSFERRED",
  result: "PENDING",
  target_type: "MEMBER",
  target_id: NEW_MID,
  data: {
    mode: "fresh",
    new_end_at: "2026-09-25T03:00:00+00:00",
    new_months: 1,
    will_invite: true,
    origin_email: OLD_EMAIL,
    source_email: OLD_EMAIL,
    target_email: NEW_EMAIL,
    workspace_id: WS_ID,
    source_end_at: "2026-09-25T03:00:00+00:00",
    source_status: "pending",
    transfer_kind: "takeover",
    carried_cycles: 1,
    repeat_transfer: false,
    source_member_id: OLD_MID,
    transferred_seconds: 1301391,
    invite_queue_item_id: INVITE_QID,
    remove_queue_item_id: REMOVE_QID,
    email: NEW_EMAIL,
    queue_item_id: INVITE_QID,
    transfer_origin: origin("invite"),
  },
};

/* Ba dòng của lệnh MỜI (tiện ích ghi), mỗi dòng mang `transfer_origin`. */
const INVITE_LEG: RawEvent[] = [
  {
    id: "i3",
    timestamp: "2026-09-10T01:31:43.900Z",
    actor_type: "EXTENSION",
    actor_label: `workspace:${WS}`,
    action: "QUEUE_UPDATED:INVITE_MEMBER",
    result: "COMPLETED",
    target_type: "QUEUE_ITEM",
    target_id: INVITE_QID,
    data: {
      status: "COMPLETED",
      error_code: null,
      reconciled: false,
      error_message: null,
      emails: [NEW_EMAIL],
      email: NEW_EMAIL,
      transfer_origin: origin("invite"),
    },
  },
  {
    id: "i2",
    timestamp: "2026-09-10T01:31:43.800Z",
    actor_type: "EXTENSION",
    actor_label: `workspace:${WS}`,
    action: "MEMBER_INVITE_VERIFIED",
    result: "COMPLETED",
    target_type: "MEMBER",
    target_id: NEW_MID,
    data: {
      email: NEW_EMAIL,
      error_code: null,
      verified_at: "2026-09-10T01:31:43.792839+00:00",
      workspace_id: WS_ID,
      queue_item_id: INVITE_QID,
      transfer_origin: origin("invite"),
    },
  },
  {
    id: "i1",
    timestamp: "2026-09-10T01:30:46.000Z",
    actor_type: "EXTENSION",
    actor_label: `workspace:${WS}`,
    action: "QUEUE_PICKED:INVITE_MEMBER",
    result: "PENDING",
    target_type: "QUEUE_ITEM",
    target_id: INVITE_QID,
    data: { emails: [NEW_EMAIL], email: NEW_EMAIL, transfer_origin: origin("invite") },
  },
];

/* Ba dòng của lệnh GỠ email cũ. */
const REMOVE_LEG: RawEvent[] = [
  {
    id: "r3",
    timestamp: "2026-09-10T01:30:46.500Z",
    actor_type: "EXTENSION",
    actor_label: `workspace:${WS}`,
    action: "QUEUE_UPDATED:REMOVE_MEMBER",
    result: "COMPLETED",
    target_type: "QUEUE_ITEM",
    target_id: REMOVE_QID,
    data: {
      status: "COMPLETED",
      error_code: null,
      reconciled: false,
      error_message: null,
      emails: [OLD_EMAIL],
      email: OLD_EMAIL,
      transfer_origin: origin("remove"),
    },
  },
  {
    id: "r2",
    timestamp: "2026-09-10T01:30:46.400Z",
    actor_type: "EXTENSION",
    actor_label: `workspace:${WS}`,
    action: "MEMBER_REMOVED_SYNCED",
    result: "COMPLETED",
    target_type: "MEMBER",
    target_id: OLD_MID,
    data: {
      email: OLD_EMAIL,
      workspace_id: WS_ID,
      queue_item_id: REMOVE_QID,
      removal_reason: "subscription_transferred",
      removal_evidence: "clicked_and_verified",
      transfer_origin: origin("remove"),
    },
  },
  {
    id: "r1",
    timestamp: "2026-09-10T01:30:09.000Z",
    actor_type: "EXTENSION",
    actor_label: `workspace:${WS}`,
    action: "QUEUE_PICKED:REMOVE_MEMBER",
    result: "PENDING",
    target_type: "QUEUE_ITEM",
    target_id: REMOVE_QID,
    data: { emails: [OLD_EMAIL], email: OLD_EMAIL, transfer_origin: origin("remove") },
  },
];

/** API trả mới → cũ. */
function newestFirst(rows: RawEvent[]): RawEvent[] {
  return [...rows].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

describe("lệnh mời sinh ra từ lần chuyển hạn sử dụng", () => {
  const groups = buildGroups(decorate(newestFirst([TRANSFER_ROW, ...INVITE_LEG, ...REMOVE_LEG])));
  const invite = groups.find((g) => g.key === `q:${INVITE_QID}`)!;
  const remove = groups.find((g) => g.key === `q:${REMOVE_QID}`)!;

  it("dòng của admin về chung nhóm với lệnh mời — hai lệnh, hai dòng, không có dòng thứ ba", () => {
    expect(groups).toHaveLength(2);
    expect(invite.events.map((e) => e.id).sort()).toEqual(["i1", "i2", "i3", "t0"]);
  });

  it("nhóm mời nói rõ đây là chuyển hạn sử dụng, do admin bấm, và từ email nào", () => {
    expect(invite.title).toBe("Chuyển hạn sử dụng");
    expect(invite.actorType).toBe("ADMIN");
    expect(invite.actorLabel).toBe("huumisa");
    // Cột email chỉ có email mới (email cũ nằm ở khoá `source_email`, trang không
    // đọc khoá đó — ca đổi email kiểu cũ và ca gỡ hỏng bên dưới mới ép lọc thật).
    expect(invite.emails).toEqual([NEW_EMAIL]);
    expect(summarize(invite)).toBe(
      `Mời vào ${WS} — nhận hạn chuyển từ ${OLD_EMAIL}`,
    );
  });

  it("cú bấm của admin là bước Xếp hàng; nhóm vẫn ở tab Chính › Mời + gia hạn", () => {
    expect(invite.stages).toEqual({ queued: true, running: true, done: true, failed: false });
    expect(invite.gstatus).toBe("done");
    expect(invite.buckets).toContain("member");
    expect(invite.memberSub).toBe("invite");
  });

  it("lệnh gỡ email cũ kể nó đã chuyển hạn sang đâu, cũng do admin đó bấm", () => {
    expect(remove.title).toBe("Xoá do chuyển hạn sử dụng");
    expect(remove.actorLabel).toBe("huumisa");
    expect(remove.actorType).toBe("ADMIN");
    expect(remove.emails).toEqual([OLD_EMAIL]);
    expect(remove.stages.queued).toBe(true);
    expect(summarize(remove)).toBe(`Gỡ khỏi ${WS} — đã chuyển hạn sang ${NEW_EMAIL}`);
    expect(remove.memberSub).toBe("remove");
  });
});

describe("tiện ích chưa nhận lệnh — nhóm chỉ có dòng của admin", () => {
  it("câu đủ hai email, ở đúng chỗ Mời + gia hạn, mang màu lệnh mời", () => {
    const [g] = buildGroups(decorate([TRANSFER_ROW]));
    expect(g.lifecycle).toBe(true); // API đã gắn khoá lệnh cho dòng này
    expect(g.title).toBe("Chuyển hạn sử dụng");
    expect(g.actorLabel).toBe("huumisa");
    expect(g.gstatus).toBe("queued");
    expect(g.impGroup).toBe("invite");
    expect(g.buckets).toContain("member");
    expect(g.memberSub).toBe("invite");
    expect(summarize(g)).toBe(`Chuyển hạn ${OLD_EMAIL} → ${NEW_EMAIL} · ${WS}`);
  });

  it("cộng dồn (không mời) thì đứng ở Xoá với màu lệnh gỡ", () => {
    const row: RawEvent = {
      ...TRANSFER_ROW,
      data: {
        ...TRANSFER_ROW.data,
        mode: "accumulate",
        will_invite: false,
        invite_queue_item_id: null,
        queue_item_id: REMOVE_QID,
        transfer_origin: origin("remove", { mode: "accumulate" }),
      },
    };
    const [g] = buildGroups(decorate([row]));
    expect(g.memberSub).toBe("remove");
    expect(g.impGroup).toBe("remove");
    expect(g.title).toBe("Xoá do chuyển hạn sử dụng");
    expect(summarize(g)).toBe(`Chuyển hạn ${OLD_EMAIL} → ${NEW_EMAIL} · ${WS}`);
  });
});

describe("lệnh gỡ email cũ THẤT BẠI", () => {
  it("vẫn mang tên chuyển hạn, đỏ, và nói rõ chưa gỡ được", () => {
    const failedLeg: RawEvent[] = [
      {
        ...REMOVE_LEG[0],
        result: "FAILED",
        data: { ...REMOVE_LEG[0].data, status: "FAILED", error_code: "MEMBER_NOT_FOUND" },
      },
      {
        ...REMOVE_LEG[1],
        action: "MEMBER_EMAIL_CHANGE_REMOVE_FAILED",
        result: "ERROR",
        data: {
          email: OLD_EMAIL,
          new_email: NEW_EMAIL, // email mới cũng nằm trong payload — không được chen vào cột
          workspace_id: WS_ID,
          queue_item_id: REMOVE_QID,
          task_type: "REMOVE_MEMBER",
          error_code: "MEMBER_NOT_FOUND",
          transfer_origin: origin("remove"),
        },
      },
      REMOVE_LEG[2],
    ];
    const [g] = buildGroups(decorate(newestFirst(failedLeg)));
    expect(g.title).toBe("Xoá do chuyển hạn sử dụng");
    expect(g.gstatus).toBe("failed");
    expect(g.emails).toEqual([OLD_EMAIL]);
    expect(g.actorLabel).toBe("huumisa");
    expect(summarize(g)).toBe(
      `Gỡ khỏi ${WS} — chưa gỡ được, hạn đã chuyển sang ${NEW_EMAIL}`,
    );
  });
});

describe("lệnh gỡ XẾP LẠI vì email cũ vẫn còn trên ChatGPT", () => {
  const RETRY_QID = "7277b8e7-7c58-45e9-8f34-2e99b6d61353";
  const retryOrigin = origin("remove", {
    retry: true,
    actor_type: "SYSTEM",
    actor_label: null,
    transfer_actor_label: ADMIN,
  });
  const rows: RawEvent[] = [
    {
      id: "y3",
      timestamp: "2026-09-10T03:00:40.000Z",
      actor_type: "EXTENSION",
      actor_label: `workspace:${WS}`,
      action: "QUEUE_UPDATED:REMOVE_MEMBER",
      result: "COMPLETED",
      target_type: "QUEUE_ITEM",
      target_id: RETRY_QID,
      data: { status: "COMPLETED", emails: [OLD_EMAIL], email: OLD_EMAIL, transfer_origin: retryOrigin },
    },
    {
      id: "y2",
      timestamp: "2026-09-10T03:00:39.000Z",
      actor_type: "EXTENSION",
      actor_label: `workspace:${WS}`,
      action: "MEMBER_REMOVED_SYNCED",
      result: "COMPLETED",
      target_type: "MEMBER",
      target_id: OLD_MID,
      data: {
        email: OLD_EMAIL,
        workspace_id: WS_ID,
        queue_item_id: RETRY_QID,
        removal_reason: "subscription_transferred",
        transfer_origin: retryOrigin,
      },
    },
    {
      id: "y1",
      timestamp: "2026-09-10T03:00:00.000Z",
      actor_type: "SYSTEM",
      actor_label: null,
      action: "MEMBER_EMAIL_CHANGE_REMOVE_RETRY",
      result: "PENDING",
      target_type: "MEMBER",
      target_id: OLD_MID,
      data: {
        email: OLD_EMAIL,
        changed_to: NEW_EMAIL,
        workspace_id: WS_ID,
        queue_item_id: RETRY_QID,
        task_type: "REMOVE_MEMBER",
        source: "scheduler",
        transfer_origin: retryOrigin,
      },
    },
  ];

  it("mang tên gỡ lại, vẫn là việc của hệ thống, nói rõ đã chuyển hạn sang đâu", () => {
    const [g] = buildGroups(decorate(rows));
    expect(g.events).toHaveLength(3);
    expect(g.title).toBe("Gỡ lại do chuyển hạn sử dụng");
    expect(g.actorType).toBe("SYSTEM");
    expect(g.actorLabel).toBe("hệ thống");
    expect(g.emails).toEqual([OLD_EMAIL]);
    expect(g.stages.queued).toBe(true);
    expect(g.gstatus).toBe("done");
    expect(g.memberSub).toBe("remove");
    expect(summarize(g)).toBe(`Gỡ khỏi ${WS} — đã chuyển hạn sang ${NEW_EMAIL}`);
  });

  it("không có ngữ cảnh (nhật ký rất cũ) thì giữ tên gộp như trước", () => {
    const bare = rows.map((r) => {
      const d = { ...(r.data ?? {}) };
      delete d.transfer_origin;
      return { ...r, data: d };
    });
    const [g] = buildGroups(decorate(bare));
    expect(g.title).toBe("Xoá do đổi email/chuyển hạn sử dụng");
    expect(g.actorLabel).toBe("hệ thống");
  });
});

describe("dòng của admin nằm ngoài cửa sổ đang tải", () => {
  it("lệnh mời vẫn tự kể được nhờ ngữ cảnh bơm vào từng dòng", () => {
    const [g] = buildGroups(decorate(newestFirst(INVITE_LEG)));
    expect(g.title).toBe("Chuyển hạn sử dụng");
    expect(g.actorLabel).toBe("huumisa");
    expect(g.actorType).toBe("ADMIN");
    expect(g.stages.queued).toBe(true);
    expect(summarize(g)).toBe(`Mời vào ${WS} — nhận hạn chuyển từ ${OLD_EMAIL}`);
  });
});

describe("API cũ chưa bơm ngữ cảnh", () => {
  const strip = (r: RawEvent): RawEvent => {
    const d = { ...(r.data ?? {}) };
    delete d.transfer_origin;
    if (r.action === "MEMBER_SUBSCRIPTION_TRANSFERRED") delete d.queue_item_id;
    return { ...r, data: d };
  };

  it("dòng của admin đứng riêng vẫn có tên tiếng Việt và câu đủ hai email", () => {
    const groups = buildGroups(decorate(newestFirst([TRANSFER_ROW, ...INVITE_LEG].map(strip))));
    const alone = groups.find((g) => g.events.some((e) => e.id === "t0"))!;
    expect(alone.lifecycle).toBe(false);
    expect(alone.title).toBe("Chuyển hạn sử dụng");
    expect(summarize(alone)).toBe(`Chuyển hạn ${OLD_EMAIL} → ${NEW_EMAIL} · ${WS}`);
    // Lệnh mời không có gì để bám → giữ nguyên như trước, không đoán bừa.
    const plain = groups.find((g) => g.key === `q:${INVITE_QID}`)!;
    expect(plain.title).toBe("Mời thành viên");
    expect(plain.actorType).toBe("EXTENSION");
  });

  /* Dự phòng, KHÔNG phải hình dạng dữ liệu thật: API hễ gắn khoá lệnh cho dòng của
     admin là gắn luôn transfer_origin. Giữ để nhánh đọc thẳng dòng của admin không
     chết lặng nếu một ngày trường đó thiếu. */
  it("dự phòng: dòng của admin có trong nhóm nhưng thiếu transfer_origin", () => {
    const row = strip(TRANSFER_ROW);
    row.data!.queue_item_id = INVITE_QID;
    const [g] = buildGroups(decorate(newestFirst([row, ...INVITE_LEG.map(strip)])));
    expect(g.title).toBe("Chuyển hạn sử dụng");
    expect(g.actorLabel).toBe("huumisa");
    expect(g.emails).toEqual([NEW_EMAIL]);
    expect(summarize(g)).toBe(`Mời vào ${WS} — nhận hạn chuyển từ ${OLD_EMAIL}`);
  });
});

describe("chuyển hạn cộng dồn (email nhận đang dùng, không mời)", () => {
  it("dòng của admin về chung nhóm với lệnh gỡ và nói rõ đã cộng dồn vào ai", () => {
    const acc = origin("remove", { mode: "accumulate" });
    const row: RawEvent = {
      ...TRANSFER_ROW,
      data: {
        ...TRANSFER_ROW.data,
        mode: "accumulate",
        will_invite: false,
        invite_queue_item_id: null,
        queue_item_id: REMOVE_QID,
        transfer_origin: acc,
      },
    };
    const legs = REMOVE_LEG.map((r) => ({
      ...r,
      data: { ...r.data, transfer_origin: acc },
    }));
    const [g] = buildGroups(decorate(newestFirst([row, ...legs])));
    expect(g.events).toHaveLength(4);
    expect(g.title).toBe("Xoá do chuyển hạn sử dụng");
    expect(g.emails).toEqual([OLD_EMAIL]);
    expect(summarize(g)).toBe(`Gỡ khỏi ${WS} — đã cộng dồn hạn vào ${NEW_EMAIL}`);
  });
});

describe("đổi email kiểu cũ (MEMBER_EMAIL_CHANGED)", () => {
  const legacy = (leg: "invite" | "remove") => origin(leg, { kind: "email_change", mode: null });

  it("lệnh mời email mới mang tên Đổi email, câu tóm tắt nêu email cũ", () => {
    const row: RawEvent = {
      ...TRANSFER_ROW,
      action: "MEMBER_EMAIL_CHANGED",
      data: {
        old_email: OLD_EMAIL,
        new_email: NEW_EMAIL,
        old_member_id: OLD_MID,
        workspace_id: WS_ID,
        invite_queue_item_id: INVITE_QID,
        remove_queue_item_id: REMOVE_QID,
        email: NEW_EMAIL,
        queue_item_id: INVITE_QID,
        transfer_origin: legacy("invite"),
      },
    };
    const legs = INVITE_LEG.map((r) => ({
      ...r,
      data: { ...r.data, transfer_origin: legacy("invite") },
    }));
    const [g] = buildGroups(decorate(newestFirst([row, ...legs])));
    expect(g.title).toBe("Đổi email");
    // `old_email` cũng là một email trong payload — vẫn không được chen vào cột.
    expect(g.emails).toEqual([NEW_EMAIL]);
    expect(summarize(g)).toBe(`Mời vào ${WS} — thay cho email cũ ${OLD_EMAIL}`);
  });

  it("lệnh gỡ email cũ mang tên Xoá do đổi email", () => {
    const legs = REMOVE_LEG.map((r) => ({
      ...r,
      data: { ...r.data, transfer_origin: legacy("remove") },
    }));
    const [g] = buildGroups(decorate(newestFirst(legs)));
    expect(g.title).toBe("Xoá do đổi email");
    expect(summarize(g)).toBe(`Gỡ khỏi ${WS} — đã đổi email sang ${NEW_EMAIL}`);
  });
});
