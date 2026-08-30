import { describe, expect, it } from "vitest";
import { buildGroups, importantGroup, showsBalanceAfter } from "./AuditLogs";

/* Ca thật user 2026-08-26 (hdh2102, ws CHATGPT PRO): một lượt "ví thiếu → quét QR →
   mời 5 email" hiện thành BA dòng rời trên trang nhật ký — "Tạo lệnh thanh toán"
   (21:21:58), "Thanh toán thành công" (21:22:43) và cụm lệnh mời (21:24:55). Cả cụm
   là MỘT việc nên phải gom về một dòng.

   Liên kết thật nằm ở `payment_orders.queue_item_id`; API nhật ký phân giải lúc đọc
   rồi rót `queue_item_id` vào `data` của hai dòng tiền — test dựng dữ liệu ĐÚNG như
   API trả sau khi đã phân giải. */

const ORDER_ID = "5f2d9a4c-1b70-4f2e-9a11-6c0f2d8e77a1";
const QID = "003bfb81-9c4e-4a55-9a30-2f1d5c8b6e42";
const MEMBER_ID = "9c1f7a2e-3d45-4b88-9f01-5a6b7c8d9e00";
const EMAIL = "anhngoc0811@gmail.com";

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
    return {
      ...r,
      cat: "member" as const,
      impGroup,
      important: impGroup !== null,
      routine: impGroup === null,
      status: "success" as never,
      actorInitial: "H",
      actorSub: "",
      actorName: "hdh2102",
      avatarBg: "",
      targetEmails: [EMAIL],
      workspace_name: "CHATGPT PRO",
    };
  }) as never[];
}

/** API trả mới → cũ. */
const INVITE_FLOW: RawEvent[] = [
  {
    id: "e5",
    timestamp: "2026-08-26T14:24:55.000Z",
    actor_type: "EXTENSION",
    action: "MEMBER_INVITE_VERIFIED",
    result: "COMPLETED",
    target_type: "MEMBER",
    target_id: MEMBER_ID,
    data: { email: EMAIL, queue_item_id: QID },
  },
  {
    id: "e4",
    timestamp: "2026-08-26T14:22:43.400Z",
    actor_type: "ADMIN",
    action: "MEMBER_BULK_INVITE_QUEUED",
    result: "PENDING",
    target_type: "QUEUE_ITEM",
    target_id: QID,
    data: { count: 5, role: "member" },
  },
  {
    id: "e3",
    timestamp: "2026-08-26T14:22:43.300Z",
    actor_type: "ADMIN",
    action: "WALLET_INVITE_CHARGED",
    result: "SUCCESS",
    target_type: "WALLET",
    target_id: "w1",
    data: { email: EMAIL, fee: 60000, queue_item_id: QID },
  },
  {
    // Bút toán ví của hoá đơn — `queue_item_id` do API suy ra từ payment_orders.
    id: "e2",
    timestamp: "2026-08-26T14:22:43.000Z",
    actor_type: "SYSTEM",
    action: "WALLET_ORDER_CREDITED",
    result: "SUCCESS",
    target_type: "WALLET",
    target_id: "w1",
    data: {
      kind: "order_topup",
      ref_type: "order",
      ref_id: ORDER_ID,
      queue_item_id: QID,
    },
  },
  {
    id: "e1",
    timestamp: "2026-08-26T14:21:58.000Z",
    actor_type: "ADMIN",
    action: "PAYMENT_ORDER_CREATED",
    result: "PENDING",
    target_type: "PAYMENT_ORDER",
    target_id: ORDER_ID,
    data: { kind: "invite", amount_vnd: 300000, count: 5, queue_item_id: QID },
  },
];

describe("gom nhóm hoá đơn QR", () => {
  it("cả lượt mua-rồi-mời về đúng MỘT nhóm của lệnh mời", () => {
    const groups = buildGroups(decorate(INVITE_FLOW));
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.key).toBe("q:" + QID);
    expect(g.count).toBe(5);
    // Dòng vẫn đọc là LỆNH MỜI (không bị hoá đơn cướp tiêu đề) và giữ giờ mới nhất.
    expect(g.code).toBe("MEMBER_BULK_INVITE_QUEUED");
    expect(g.latestTs).toBe("2026-08-26T14:24:55.000Z");
    expect(g.gstatus).toBe("done");
    // Người tạo là admin bấm mời, không phải webhook.
    expect(g.actorLabel).toBe("hdh2102");
  });

  it("hoá đơn CHƯA gắn task vẫn gộp 2 dòng tiền của nó thành một", () => {
    // Gia hạn không đi qua hàng đợi → API không suy ra được queue_item_id.
    const rows = INVITE_FLOW.filter((r) => r.id === "e2" || r.id === "e1").map(
      (r) => ({
        ...r,
        data: Object.fromEntries(
          Object.entries(r.data ?? {}).filter(([k]) => k !== "queue_item_id"),
        ),
      }),
    );
    const groups = buildGroups(decorate(rows));
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("o:" + ORDER_ID);
    expect(groups[0].count).toBe(2);
    // Đã trả xong → dòng đọc là "thành công", không còn kẹt ở "Chờ thanh toán".
    expect(groups[0].code).toBe("WALLET_ORDER_CREDITED");
  });

  /* Ca thật user 2026-08-30 (brotherhood06022025): gia hạn trả bằng QR ghi 12:16:14
     "Thanh toán thành công" (neo theo id hoá đơn) và 12:16:14 "Trừ phí gia hạn"
     (neo theo member_id) — cùng MỘT việc mà nằm hai dòng. API nối lại qua
     `payment_orders.member_id` rồi rót `order_id` vào khoản trừ phí. */
  it("khoản trừ phí gia hạn nhập chung dòng với tiền QR của nó", () => {
    const rows: RawEvent[] = [
      {
        id: "fee",
        timestamp: "2026-08-30T05:16:14.200Z",
        actor_type: "ADMIN",
        action: "WALLET_RENEW_CHARGED",
        result: "SUCCESS",
        target_type: "WALLET",
        target_id: "w1",
        data: {
          member_id: MEMBER_ID,
          email: EMAIL,
          fee: 330000,
          ref_type: "renew",
          ref_id: MEMBER_ID,
          order_id: ORDER_ID,
        },
      },
      {
        id: "credited",
        timestamp: "2026-08-30T05:16:14.100Z",
        actor_type: "SYSTEM",
        action: "WALLET_ORDER_CREDITED",
        result: "SUCCESS",
        target_type: "WALLET",
        target_id: "w1",
        data: { kind: "order_topup", ref_type: "order", ref_id: ORDER_ID },
      },
      {
        id: "order",
        timestamp: "2026-08-30T05:10:00.000Z",
        actor_type: "ADMIN",
        action: "PAYMENT_ORDER_CREATED",
        result: "PENDING",
        target_type: "PAYMENT_ORDER",
        target_id: ORDER_ID,
        data: { kind: "subscription", amount_vnd: 330000 },
      },
    ];
    const groups = buildGroups(decorate(rows));
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("o:" + ORDER_ID);
    expect(groups[0].count).toBe(3);
    expect(groups[0].buckets).toEqual(["billing"]);
    // Dòng đọc là VIỆC ĐÃ LÀM ("Trừ phí gia hạn"), không phải bước ngân hàng.
    expect(groups[0].code).toBe("WALLET_RENEW_CHARGED");
  });

  it("hoá đơn chưa trả vẫn đứng riêng một dòng chờ thanh toán", () => {
    const groups = buildGroups(decorate([INVITE_FLOW[4]]));
    expect(groups).toHaveLength(1);
    expect(groups[0].code).toBe("PAYMENT_ORDER_CREATED");
  });
});

/* "Số dư sau" chỉ có nghĩa với ví NẠP TRƯỚC. Tài khoản trả thẳng từng lệnh luôn về 0
   → giấu đi, trừ khi có hoàn phí (user 2026-08-26). */
describe("số dư sau hộp phí", () => {
  const ev = (action: string) => ({
    action,
    target_type: null,
    target_id: null,
    data: null,
  });

  it("ví nạp trước vẫn hiện số dư sau", () => {
    expect(showsBalanceAfter([ev("WALLET_INVITE_CHARGED")])).toBe(true);
  });

  it("trả thẳng theo lệnh thì giấu số dư sau", () => {
    expect(
      showsBalanceAfter([ev("WALLET_INVITE_CHARGED"), ev("WALLET_ORDER_CREDITED")]),
    ).toBe(false);
  });

  it("trả thẳng nhưng phải hoàn phí do lời mời lỗi thì hiện lại", () => {
    expect(
      showsBalanceAfter([
        ev("WALLET_INVITE_REFUNDED"),
        ev("WALLET_INVITE_CHARGED"),
        ev("WALLET_ORDER_CREDITED"),
      ]),
    ).toBe(true);
  });
});

/* MÃ HOÁ ĐƠN TRÊN HÀNG (user 2026-08-29): chip cạnh tên workspace phải là mã hoá
   đơn thật (tra được ở sao kê + panel thành viên), không phải mã hàng đợi nội bộ.
   API bơm `order_ref_code` vào mọi sự kiện của lệnh; lệnh trả bằng ví không sinh
   hoá đơn nên không có mã và hàng rơi về mã lệnh như cũ. */
describe("mã hoá đơn của nhóm", () => {
  const REF = "c6a67ae1172b13987b21";

  it("lấy mã hoá đơn từ sự kiện của lệnh", () => {
    const rows = INVITE_FLOW.map((r) => ({
      ...r,
      data: { ...(r.data ?? {}), order_ref_code: REF },
    }));
    const g = buildGroups(decorate(rows))[0];
    expect(g.orderRefs).toEqual([REF]);
    // Mã lọc (khoá sổ cái ví neo vào) vẫn là mã hàng đợi — hai thứ khác nhau.
    expect(g.payRefs[0]).toBe(QID);
  });

  it("chỉ MỘT sự kiện mang mã cũng đủ cho cả nhóm", () => {
    const rows = INVITE_FLOW.map((r) =>
      r.id === "e2" ? { ...r, data: { ...(r.data ?? {}), order_ref_code: REF } } : r,
    );
    expect(buildGroups(decorate(rows))[0].orderRefs).toEqual([REF]);
  });

  it("lệnh trả bằng ví (không có hoá đơn) thì không có mã", () => {
    expect(buildGroups(decorate(INVITE_FLOW))[0].orderRefs).toEqual([]);
  });
});
