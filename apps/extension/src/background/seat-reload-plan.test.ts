/**
 * Bước "mua suất xong → tải lại trang → mời trong lượt mới" đứng đúng giữa TIỀN
 * ĐÃ TRỪ và cú bấm mời kế tiếp, nên test ở đây bám ba ranh giới dính tiền:
 *
 *   · lượt gọi lại KHÔNG BAO GIỜ được là một lượt MUA nữa;
 *   · số `seat_*` của lượt mua phải sang được kết quả cuối, kể cả khi lượt sau hỏng;
 *   · reload không chốt được ⇒ dừng TRƯỚC khi mời, và nói rõ đã mua bao nhiêu.
 */
import { describe, expect, it } from "vitest";

import { withExtraData } from "./invite-seat-fields";
import {
  planSeatReloadAfterPurchase,
  seatReloadFailureResponse,
  seatReloadRetryRequest,
} from "./seat-reload-plan";
import type { ExecuteActionRequest, ExecuteActionResponse } from "../shared/messages";

type InviteRequest = Extract<ExecuteActionRequest, { kind: "INVITE_MEMBER" }>;

const INVITE_REQUEST: InviteRequest = {
  kind: "INVITE_MEMBER",
  taskId: "task-1",
  emails: ["a@x.com"],
  role: "member",
};

/** Response của content sau khi vừa mua suất xong. */
function purchased(
  extra: Record<string, unknown> = {},
): ExecuteActionResponse {
  return {
    ok: true,
    data: {
      awaiting_seat_reload: true,
      emails: ["a@x.com"],
      count: 1,
      role: "member",
      seat_purchased: 2,
      seat_total_after: 64,
      seat_purchase: { charge_amount_text: "10.857 ₫" },
      ...extra,
    },
  };
}

describe("nhận diện lượt mua xin tải lại trang", () => {
  it("mời + awaiting_seat_reload → có kế hoạch, đọc đúng số suất đã mua", () => {
    const plan = planSeatReloadAfterPurchase("INVITE_MEMBER", "INVITE_MEMBER", purchased());
    expect(plan).toMatchObject({ kind: "reload", purchased: 2, recheck: false });
  });

  it("bộ đếm không chốt được tổng → lượt sau chỉ ĐỌC KIỂM", () => {
    const plan = planSeatReloadAfterPurchase(
      "INVITE_MEMBER",
      "INVITE_MEMBER",
      purchased({ seat_recheck_needed: true }),
    );
    expect(plan).toMatchObject({ kind: "reload", recheck: true });
  });

  it("bỏ qua task khác và mọi response không mang cờ", () => {
    // PURCHASE_SEAT có đường F5-kiểm-chứng riêng, không đi cửa này.
    expect(
      planSeatReloadAfterPurchase("PURCHASE_SEAT", "PURCHASE_SEAT", purchased()).kind,
    ).toBe("none");
    expect(
      planSeatReloadAfterPurchase("INVITE_MEMBER", "INVITE_MEMBER", {
        ok: true,
        data: { count: 1 },
      }).kind,
    ).toBe("none");
    // Lệnh hỏng thì đi đường báo lỗi, không phải đường tải lại.
    expect(
      planSeatReloadAfterPurchase("INVITE_MEMBER", "INVITE_MEMBER", {
        ok: false,
        error_code: "UNKNOWN",
        error_message: "x",
        data: { awaiting_seat_reload: true },
      }).kind,
    ).toBe("none");
  });

  it("thiếu seat_purchased → coi như 0 chứ không NaN", () => {
    const plan = planSeatReloadAfterPurchase("INVITE_MEMBER", "INVITE_MEMBER", {
      ok: true,
      data: { awaiting_seat_reload: true },
    });
    expect(plan).toMatchObject({ kind: "reload", purchased: 0 });
  });
});

describe("lệnh gửi lại: KHÔNG BAO GIỜ mua lần hai", () => {
  it("chốt được tổng mới → seatsReady, và KHÔNG kèm cờ đọc kiểm", () => {
    const plan = planSeatReloadAfterPurchase("INVITE_MEMBER", "INVITE_MEMBER", purchased());
    if (plan.kind !== "reload") throw new Error("phải có kế hoạch tải lại");
    const retry = seatReloadRetryRequest(INVITE_REQUEST, plan);
    expect(retry).toMatchObject({ kind: "INVITE_MEMBER", seatsReady: true });
    expect("seatsPurchasedAlready" in retry).toBe(false);
  });

  it("chưa chốt được → seatsPurchasedAlready mang đúng số đã mua, KHÔNG có seatsReady", () => {
    const plan = planSeatReloadAfterPurchase(
      "INVITE_MEMBER",
      "INVITE_MEMBER",
      purchased({ seat_recheck_needed: true }),
    );
    if (plan.kind !== "reload") throw new Error("phải có kế hoạch tải lại");
    const retry = seatReloadRetryRequest(INVITE_REQUEST, plan);
    expect(retry).toMatchObject({ seatsPurchasedAlready: 2 });
    // `seatsReady` bỏ HẲN bước suất → kèm vào đây là biến ca "chưa chốt được số"
    // thành mời liều, đúng thứ ca đọc kiểm sinh ra để tránh.
    expect((retry as { seatsReady?: boolean }).seatsReady).not.toBe(true);
  });

  it("giữ nguyên phần còn lại của lệnh gốc (email, vai trò, cờ khoá suất)", () => {
    const original: InviteRequest = {
      ...INVITE_REQUEST,
      emails: ["a@x.com", "b@x.com"],
      role: "owner",
      noSeatPurchase: false,
    };
    const plan = planSeatReloadAfterPurchase("INVITE_MEMBER", "INVITE_MEMBER", purchased());
    if (plan.kind !== "reload") throw new Error("phải có kế hoạch tải lại");
    const retry = seatReloadRetryRequest(original, plan);
    expect(retry).toMatchObject({
      emails: ["a@x.com", "b@x.com"],
      role: "owner",
      noSeatPurchase: false,
    });
    // Không đụng vào lệnh gốc: nhánh 'mời ngoài tên miền' phía sau còn dùng lại nó.
    expect((original as { seatsReady?: boolean }).seatsReady).toBeUndefined();
  });
});

describe("reload hỏng: dừng trước khi mời, nói rõ đã trừ tiền", () => {
  it("tab văng khỏi /admin", () => {
    const r = seatReloadFailureResponse(2, {
      reason: "off_admin",
      url: "https://chatgpt.com/auth/login",
    });
    expect(r.ok).toBe(false);
    expect((r as { error_code?: string }).error_code).toBe("SEAT_RELOAD_FAILED");
    const msg = (r as { error_message: string }).error_message;
    expect(msg).toContain("ĐÃ MUA 2 suất");
    expect(msg).toContain("CHƯA mời ai");
    expect(msg).toContain("https://chatgpt.com/auth/login");
  });

  it("trang mới chưa tiếp quản kênh", () => {
    const r = seatReloadFailureResponse(1, { reason: "stale_content" });
    expect((r as { error_code?: string }).error_code).toBe("SEAT_RELOAD_FAILED");
    const msg = (r as { error_message: string }).error_message;
    expect(msg).toContain("ĐÃ MUA 1 suất");
    expect(msg).toContain("chưa");
  });

  it("KHÔNG mang submit_clicked → backend hoàn phí thay vì hoãn phán xử", () => {
    // `defer_unverified_invite` (completion.py) chỉ giữ tiền khi result nói ĐÃ
    // bấm Gửi. Ca này chưa mở dialog mời, nên phải sạch cờ đó.
    const r = seatReloadFailureResponse(2, { reason: "stale_content" });
    expect((r as { data?: Record<string, unknown> }).data?.submit_clicked).toBeUndefined();
  });
});

describe("số suất của lượt mua sang được kết quả cuối", () => {
  it("lượt sau hỏng vẫn giữ 'đã mua N suất' cho dashboard", () => {
    const plan = planSeatReloadAfterPurchase("INVITE_MEMBER", "INVITE_MEMBER", purchased());
    if (plan.kind !== "reload") throw new Error("phải có kế hoạch tải lại");
    const failed = seatReloadFailureResponse(plan.purchased, { reason: "stale_content" });
    const final = withExtraData(failed, plan.seatFields);
    expect((final as { data?: Record<string, unknown> }).data).toMatchObject({
      seat_purchased: 2,
      seat_total_after: 64,
    });
  });

  it("lượt sau tự có số mới thì số MỚI thắng", () => {
    const plan = planSeatReloadAfterPurchase(
      "INVITE_MEMBER",
      "INVITE_MEMBER",
      purchased({ seat_recheck_needed: true }),
    );
    if (plan.kind !== "reload") throw new Error("phải có kế hoạch tải lại");
    const after: ExecuteActionResponse = {
      ok: true,
      data: { seat_total_after: 65, seat_purchased: 2 },
    };
    const final = withExtraData(after, plan.seatFields);
    expect((final as { data?: Record<string, unknown> }).data).toMatchObject({
      seat_total_after: 65,
      seat_purchased: 2,
    });
  });
});
