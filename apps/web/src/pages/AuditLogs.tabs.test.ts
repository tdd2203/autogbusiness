import { describe, expect, it } from "vitest";
import { buildGroups, importantGroup, otherBucketOf } from "./AuditLogs";

/* Phân tab nhật ký (chốt user 2026-08-26, sửa 2026-09-07):
     • tab "Chính" CHỈ có 3 chip — Bảo mật (lịch sử đăng nhập) · Thành viên ·
       Thanh toán (tiền của chính các lệnh thành viên);
     • chip "Thành viên" chia 3 rẽ nhánh: mời + gia hạn · xoá · đồng bộ;
     • chuyện CÒN LẠI của một email (hết hạn, đổi chủ, đổi email, đổi vai trò,
       rút/gỡ hạn) xuống tab "Khác" nhánh "Thành viên";
     • mọi thứ còn lại xuống tab "Khác" và tự chia nhóm phụ;
     • mã hoá đơn trên lệnh mời/gia hạn phải TRÙNG mã trên khoản trừ phí tương ứng
       thì bấm vào mới ra đúng chi tiết thanh toán. */

const QID = "61432306-7200-4f4d-aa89-3c4bbff47e1e";
const MEMBER_ID = "a7433b0c-8391-4f93-ab1d-38d3e47cd91a";
const WALLET_ID = "0d1a9d4c-2f22-4a3e-9d55-2f9a0f5b4c31";
const EMAIL = "khach@gmail.com";

type Raw = {
  id: string;
  timestamp: string;
  actor_type: string;
  action: string;
  result: string;
  target_type: string | null;
  target_id: string | null;
  data: Record<string, unknown> | null;
};

function decorate(rows: Raw[]) {
  return rows.map((r) => {
    const impGroup = importantGroup(r.action);
    return {
      ...r,
      cat: "member" as const,
      impGroup,
      important: impGroup !== null,
      routine: impGroup === null,
      status: "success" as never,
      actorInitial: "A",
      actorSub: "",
      actorName: "admin",
      avatarBg: "",
      targetEmails: [EMAIL],
      workspace_name: "CHATGPT PRO",
    };
  }) as never[];
}

/** Nhóm duy nhất dựng từ một danh sách sự kiện. */
function only(rows: Raw[]) {
  const gs = buildGroups(decorate(rows));
  expect(gs).toHaveLength(1);
  return gs[0];
}

const ev = (over: Partial<Raw> & { id: string; action: string }): Raw => ({
  timestamp: "2026-08-26T10:00:00.000Z",
  actor_type: "ADMIN",
  result: "SUCCESS",
  target_type: null,
  target_id: null,
  data: null,
  ...over,
});

describe("tab Chính chỉ gồm 3 nhóm", () => {
  it("đăng nhập (kể cả hỏng/bị chặn) vào chip Bảo mật", () => {
    for (const action of [
      "LOGIN_SUCCESS",
      "LOGIN_FAILED",
      "LOGIN_BLOCKED_SPAM",
      "PASSWORD_CHANGED",
    ]) {
      const g = only([ev({ id: action, action })]);
      expect(g.buckets).toEqual(["security"]);
      expect(g.otherBucket).toBeNull();
    }
  });

  it("lệnh mời vừa là Thành viên vừa là Thanh toán, mang mã hoá đơn = mã hàng đợi", () => {
    const g = only([
      ev({
        id: "fee",
        action: "WALLET_INVITE_CHARGED",
        target_type: "WALLET",
        target_id: WALLET_ID,
        data: { email: EMAIL, fee: 330000, queue_item_id: QID, ref_id: QID },
      }),
      ev({
        id: "queued",
        timestamp: "2026-08-26T09:59:00.000Z",
        action: "MEMBER_BULK_INVITE_QUEUED",
        result: "PENDING",
        target_type: "QUEUE_ITEM",
        target_id: QID,
        data: { emails: [EMAIL] },
      }),
    ]);
    expect(g.buckets).toEqual(["member", "billing"]);
    expect(g.payRefs).toEqual([QID]);
  });

  /* Đồng bộ lời mời là một trong 3 rẽ nhánh của chip "Thành viên" (user
     2026-09-07). Nó không được rơi vào nhánh "Hàng đợi": ở đó chạy xong 42 email
     mà không ai tìm ra. */
  it("mẻ đồng bộ lời mời vào chip Thành viên, rẽ nhánh Đồng bộ", () => {
    const g = only([
      ev({
        id: "done",
        action: "QUEUE_UPDATED:SYNC_MEMBERS_BATCH",
        result: "COMPLETED",
        target_type: "QUEUE_ITEM",
        target_id: QID,
        data: { status: "COMPLETED" },
      }),
      ev({
        id: "promoted",
        action: "MEMBER_SYNC_PROMOTED_ACTIVE",
        target_type: "MEMBER",
        target_id: MEMBER_ID,
        data: { email: EMAIL, batch: true, found_in: "active", queue_item_id: QID },
      }),
      ev({
        id: "queued",
        timestamp: "2026-08-26T09:58:00.000Z",
        action: "SYNC_MEMBERS_BATCH_QUEUED",
        result: "PENDING",
        target_type: "WORKSPACE",
        target_id: null,
        data: { count: 42, queue_item_id: QID },
      }),
    ]);
    expect(g.buckets).toEqual(["member"]);
    expect(g.memberSub).toBe("sync");
    expect(g.otherBucket).toBeNull();
    // 42 email trong một lượt quét thì đúng là hàng loạt.
    expect(g.title).toBe("Đồng bộ lời mời hàng loạt");
  });

  /* "Hàng loạt" phải từ 2 email trở lên (user 2026-08-31): đồng bộ đúng 1 email mà
     ghi "hàng loạt" là đọc sai việc vừa làm. Mẻ đồng bộ không ghi danh sách email
     vào nhật ký nên số email đọc từ `count`. */
  it("đồng bộ đúng 1 email thì bỏ chữ hàng loạt", () => {
    const g = only([
      ev({
        id: "queued",
        action: "SYNC_MEMBERS_BATCH_QUEUED",
        result: "PENDING",
        target_type: "WORKSPACE",
        target_id: null,
        data: { count: 1, queue_item_id: QID },
      }),
    ]);
    expect(g.title).toBe("Đồng bộ lời mời");
    expect(g.buckets).toEqual(["member"]);
    expect(g.memberSub).toBe("sync");
  });

  it("mời đúng 1 email qua thanh hàng loạt cũng không gọi là hàng loạt", () => {
    const g = only([
      ev({
        id: "queued",
        action: "MEMBER_BULK_INVITE_QUEUED",
        result: "PENDING",
        target_type: "QUEUE_ITEM",
        target_id: QID,
        data: { emails: [EMAIL] },
      }),
    ]);
    expect(g.title).toBe("Mời thành viên");
  });

  it("lệnh gia hạn và khoản trừ phí của nó dùng CHUNG mã hoá đơn (member_id)", () => {
    const renew = only([
      ev({
        id: "renew",
        action: "MEMBER_SUBSCRIPTION_RENEWED",
        result: "OK",
        target_type: "MEMBER",
        target_id: MEMBER_ID,
        data: { email: EMAIL, months: 1 },
      }),
    ]);
    const charge = only([
      ev({
        id: "charge",
        action: "WALLET_RENEW_CHARGED",
        target_type: "WALLET",
        target_id: WALLET_ID,
        data: { member_id: MEMBER_ID, email: EMAIL, fee: 330000, ref_id: MEMBER_ID },
      }),
    ]);
    expect(renew.buckets).toEqual(["member"]);
    expect(charge.buckets).toEqual(["billing"]);
    // Bấm mã trên lệnh gia hạn phải lọc ra đúng khoản trừ phí của nó.
    expect(renew.payRefs).toEqual([MEMBER_ID]);
    expect(charge.payRefs).toEqual([MEMBER_ID]);
  });

  it("hoá đơn QR của lệnh mời/gia hạn là Thanh toán, hoá đơn loại khác thì không", () => {
    const credited = only([
      ev({
        id: "credited",
        action: "WALLET_ORDER_CREDITED",
        target_type: "WALLET",
        target_id: WALLET_ID,
        data: { kind: "order_topup", ref_type: "order", amount: 330000 },
      }),
    ]);
    expect(credited.buckets).toEqual(["billing"]);

    const inviteOrder = only([
      ev({
        id: "order",
        action: "PAYMENT_ORDER_CREATED",
        result: "PENDING",
        target_type: "PAYMENT_ORDER",
        target_id: "9a1f0d2c-1111-2222-3333-444455556666",
        data: { kind: "invite", amount_vnd: 330000, ref_code: "ORDER123" },
      }),
    ]);
    expect(inviteOrder.buckets).toEqual(["billing"]);

    const other = only([
      ev({
        id: "order2",
        action: "PAYMENT_ORDER_CREATED",
        result: "PENDING",
        target_type: "PAYMENT_ORDER",
        target_id: "9a1f0d2c-1111-2222-3333-444455556667",
        data: { kind: "subscription", amount_vnd: 330000 },
      }),
    ]);
    expect(other.buckets).toEqual([]);
    expect(other.otherBucket).toBe("wallet");
  });

  it("gia hạn qua modal đổi hạn (KÉO DÀI) cũng là lệnh Thành viên", () => {
    const g = only([
      ev({
        id: "ext",
        action: "MEMBER_SUBSCRIPTION_UPDATED",
        result: "OK",
        target_type: "MEMBER",
        target_id: MEMBER_ID,
        data: {
          email: EMAIL,
          old_end_at: "2026-08-31T07:46:00.000Z",
          new_end_at: "2026-09-30T07:46:00.000Z",
        },
      }),
    ]);
    expect(g.buckets).toEqual(["member"]);
  });
});

/* 3 rẽ nhánh của chip "Thành viên" (chốt user 2026-09-07). */
describe("chip Thành viên chia 3 rẽ nhánh", () => {
  it("lệnh mời và lệnh gia hạn vào nhánh Mời + gia hạn", () => {
    const invite = only([
      ev({
        id: "queued",
        action: "MEMBER_BULK_INVITE_QUEUED",
        result: "PENDING",
        target_type: "QUEUE_ITEM",
        target_id: QID,
        data: { emails: [EMAIL] },
      }),
    ]);
    expect(invite.memberSub).toBe("invite");
    const renew = only([
      ev({
        id: "renew",
        action: "MEMBER_SUBSCRIPTION_RENEWED",
        result: "OK",
        target_type: "MEMBER",
        target_id: MEMBER_ID,
        data: { email: EMAIL, months: 1 },
      }),
    ]);
    expect(renew.memberSub).toBe("invite");
  });

  it("gỡ thành viên và thu hồi lời mời vào nhánh Xoá", () => {
    for (const action of [
      "MEMBER_REMOVE_QUEUED",
      "MEMBER_BULK_REMOVE_QUEUED",
      "MEMBER_EXPIRED_REMOVE_QUEUED",
      "MEMBER_REMOVED_SYNCED",
      "MEMBER_REMOVE_STUCK",
      "REVOKE_INVITES_QUEUED",
      "MEMBER_INVITE_REVOKED",
      "QUEUE_PICKED:REMOVE_MEMBER",
    ]) {
      const g = only([
        ev({
          id: action,
          action,
          target_type: "QUEUE_ITEM",
          target_id: QID,
          data: { email: EMAIL },
        }),
      ]);
      expect(g.buckets).toEqual(["member"]);
      expect(g.memberSub).toBe("remove");
      expect(g.otherBucket).toBeNull();
    }
  });

  it("đồng bộ trên email vào nhánh Đồng bộ", () => {
    for (const action of [
      "SYNC_MEMBER_QUEUED",
      "SYNC_MEMBERS_BATCH_QUEUED",
      "QUEUE_TIMEOUT:SYNC_MEMBER",
      "MEMBER_SYNC_MISMATCH",
      "MEMBER_BULK_UPSERT",
      "MEMBER_ROLE_SYNCED",
    ]) {
      const g = only([
        ev({
          id: action,
          action,
          target_type: "MEMBER",
          target_id: MEMBER_ID,
          data: { email: EMAIL },
        }),
      ]);
      expect(g.buckets).toEqual(["member"]);
      expect(g.memberSub).toBe("sync");
    }
  });

  /* Mẻ mời có dòng đồng bộ nâng trạng thái đi kèm — việc của nhóm vẫn là MỜI,
     không được nhảy sang nhánh Đồng bộ. */
  it("nhóm chạm nhiều loại dòng thì lấy việc nặng nhất", () => {
    const g = only([
      ev({
        id: "promoted",
        action: "MEMBER_SYNC_PROMOTED_ACTIVE",
        target_type: "MEMBER",
        target_id: MEMBER_ID,
        data: { email: EMAIL, queue_item_id: QID },
      }),
      ev({
        id: "queued",
        timestamp: "2026-08-26T09:58:00.000Z",
        action: "MEMBER_BULK_INVITE_QUEUED",
        result: "PENDING",
        target_type: "QUEUE_ITEM",
        target_id: QID,
        data: { emails: [EMAIL] },
      }),
    ]);
    expect(g.memberSub).toBe("invite");
  });

  /* Đổi email có một bước gỡ trên ChatGPT, nhưng việc của nhóm là ĐỔI EMAIL →
     vẫn ở tab "Khác", không lọt vào nhánh Xoá. */
  it("bước gỡ nằm trong việc đổi email không kéo cả nhóm lên nhánh Xoá", () => {
    const g = only([
      ev({
        id: "retry",
        action: "MEMBER_EMAIL_CHANGE_REMOVE_RETRY",
        target_type: "MEMBER",
        target_id: MEMBER_ID,
        data: { email: EMAIL },
      }),
    ]);
    expect(g.buckets).toEqual([]);
    expect(g.memberSub).toBeNull();
    expect(g.otherBucket).toBe("member");
  });
});

describe("phần còn lại tự phân nhóm ở tab Khác", () => {
  it("đổi chủ sở hữu / đổi hạn là thao tác thành viên khác, KHÔNG lên tab Chính", () => {
    const g = only([
      ev({
        id: "owner",
        action: "MEMBER_OWNER_TRANSFERRED",
        target_type: "MEMBER",
        target_id: MEMBER_ID,
        data: { email: EMAIL },
      }),
    ]);
    expect(g.buckets).toEqual([]);
    expect(g.otherBucket).toBe("member");
  });

  it("RÚT NGẮN hạn là đổi hạn, không phải gia hạn", () => {
    const g = only([
      ev({
        id: "cut",
        action: "MEMBER_SUBSCRIPTION_UPDATED",
        result: "OK",
        target_type: "MEMBER",
        target_id: MEMBER_ID,
        data: {
          email: EMAIL,
          old_end_at: "2026-09-30T07:46:00.000Z",
          new_end_at: "2026-08-31T07:46:00.000Z",
        },
      }),
    ]);
    expect(g.buckets).toEqual([]);
    expect(g.otherBucket).toBe("member");
  });

  /* Ngoài mời và gia hạn, cái gì dính tới một email đều về nhánh "Thành viên" —
     kể cả dòng do đồng bộ sinh ra (user 2026-08-30). Lệnh đồng bộ của cả workspace
     vẫn ở nhánh "Hàng đợi" (test "nhóm phụ đọc theo lệnh KHỞI TẠO" bên dưới). */
  it("dòng đồng bộ TRÊN MỘT EMAIL về nhánh Thành viên, không lẫn vào Hàng đợi", () => {
    for (const action of [
      "MEMBER_SYNC_MISMATCH",
      "MEMBER_BULK_UPSERT",
      "MEMBER_ROLE_SYNCED",
      "MEMBER_INVITE_CLEANUP",
      "QUEUE_PICKED:REMOVE_MEMBER",
    ])
      expect(otherBucketOf(action)).toBe("member");
  });

  it("nạp ví / rút tiền là tiền NGOÀI lệnh → nhóm Ví", () => {
    for (const action of [
      "WALLET_TOPUP_CREDITED",
      "WALLET_WITHDRAW_HOLD",
      "WALLET_ADJUSTED",
    ]) {
      const g = only([
        ev({ id: action, action, target_type: "WALLET", target_id: WALLET_ID, data: {} }),
      ]);
      expect(g.buckets).toEqual([]);
      expect(g.otherBucket).toBe("wallet");
    }
  });

  it("đồng bộ CẢ WORKSPACE / hàng đợi / nhãn giao diện gom vào nhóm Hàng đợi", () => {
    expect(otherBucketOf("WORKSPACE_SYNC_QUEUED")).toBe("queue");
    expect(otherBucketOf("QUEUE_TIMEOUT:SYNC_DATA")).toBe("queue");
    expect(otherBucketOf("UI_LABELS_CALIBRATED")).toBe("queue");
  });

  /* Đồng bộ LỜI MỜI là chuyện của email, không phải việc hàng đợi — kể cả khi nhóm
     chỉ còn dòng QUEUE_* của task (user 2026-08-31). */
  it("lệnh đồng bộ lời mời về nhánh Thành viên", () => {
    for (const action of [
      "SYNC_MEMBERS_BATCH_QUEUED",
      "SYNC_MEMBER_QUEUED",
      "QUEUE_UPDATED:SYNC_MEMBERS_BATCH",
      "QUEUE_TIMEOUT:SYNC_MEMBER",
    ])
      expect(otherBucketOf(action)).toBe("member");
  });

  it("cấu hình workspace / API key / telegram / tài khoản gom vào nhóm Cấu hình", () => {
    expect(otherBucketOf("WORKSPACE_SETTINGS_UPDATED")).toBe("config");
    expect(otherBucketOf("WORKSPACE_API_KEY_REVEALED")).toBe("config");
    expect(otherBucketOf("PAYMENT_SETTINGS_UPDATED")).toBe("config");
    expect(otherBucketOf("TELEGRAM_LINKED")).toBe("config");
    expect(otherBucketOf("USER_DISABLED")).toBe("config");
  });

  /* Chốt chặn: mọi action ĐANG CÓ trong nhật ký production (đã đối chiếu ngày
     26/8/2026) phải có chỗ đứng — "Linh tinh" chỉ dành cho action tương lai chưa
     kịp xếp, không phải nơi chứa những thứ hay gặp. */
  it("các action ít gặp vẫn vào đúng nhóm, không rơi vào Linh tinh", () => {
    expect(otherBucketOf("WORKSPACE_RENEWAL_DATE_RESTORED")).toBe("config");
    expect(otherBucketOf("WORKSPACE_FINANCE_START_CHANGED")).toBe("wallet");
    expect(otherBucketOf("WORKSPACE_BILLING_INVOICES_PRUNED")).toBe("wallet");
    expect(otherBucketOf("USER_FEE_SET")).toBe("wallet"); // phí, không phải tài khoản
    expect(otherBucketOf("MEMBER_STATUS_RESTORED")).toBe("member");
  });

  it("nhóm phụ đọc theo lệnh KHỞI TẠO, không theo sự kiện mới nhất", () => {
    const g = only([
      ev({
        id: "done",
        action: "QUEUE_UPDATED:SYNC_DATA",
        result: "COMPLETED",
        target_type: "QUEUE_ITEM",
        target_id: QID,
        data: {},
      }),
      ev({
        id: "start",
        timestamp: "2026-08-26T09:50:00.000Z",
        action: "WORKSPACE_SYNC_QUEUED",
        result: "PENDING",
        target_type: "QUEUE_ITEM",
        target_id: QID,
        data: {},
      }),
    ]);
    expect(g.buckets).toEqual([]);
    expect(g.otherBucket).toBe("queue");
  });
});
