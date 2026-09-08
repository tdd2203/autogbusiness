/**
 * BƯỚC CHỐT SUẤT KHÔNG ĐƯỢC QUAY VỀ TAB "NGƯỜI DÙNG" KHI ĐÃ ĐỦ CHỖ.
 *
 * Quy trình user chốt 8/9/2026: tab mở sẵn ở tab "Người dùng" → đọc ngay hàng
 * thẻ suất (tổng / đã gán / khả dụng) → sang tab "Lời mời đang chờ" đếm → lấy
 * khả dụng trừ số vừa đếm → đủ chỗ thì đi thẳng sang trang bật "mời ngoài tên
 * miền", KHÔNG vòng lại tab "Người dùng".
 *
 * Vì sao khoá bằng test: một lượt quay về tab đó bắt ChatGPT truy vấn lại toàn
 * bộ danh sách thành viên (workspace 400 người mất vài giây) rồi chờ trang in
 * số + đọc kiểm thêm một lượt — chỉ để đọc lại đúng hai con số vừa đọc, ngay
 * trước khi rời trang. Rất dễ bị thêm lại "cho chắc" trong một lần sửa sau.
 *
 * Vế thứ hai cũng phải giữ: CHƯA đủ chỗ thì vẫn PHẢI quay về đọc lại, vì từ đó
 * trở đi là chuyện tiêu tiền — hàng thẻ và nút "Quản lý số suất" chỉ có ở tab
 * "Người dùng", và lượt đọc đầu có thể rơi vào lúc trang vẽ dở.
 *
 * Không có jsdom → chỉ dựng đúng mấy global mà hàm chạm tới.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const goToUsersTab = vi.fn(async () => {});
const checkSeatAvailability = vi.fn();
let cards: unknown = null;
let members: number | null = null;

vi.mock("../../human", () => ({ sleep: async () => {} }));
vi.mock("../../progress", () => ({ reportProgress: async () => {} }));
vi.mock("./users-tab", () => ({ goToUsersTab: () => goToUsersTab() }));
vi.mock("./read-member-count", () => ({ readMemberCountFromPage: () => members }));
vi.mock("./count-pending-invites", () => ({
  countPendingInvites: async () => ({
    authoritative: true,
    emails: ["cho1@x.com", "cho2@x.com", "cho3@x.com"],
    pages: 1,
    reason: null,
  }),
}));
vi.mock("../purchase-seat/read-seat-cards", () => ({
  readSeatCardsFromPage: () => cards,
  describeSeatCards: () => "",
}));
vi.mock("../purchase-seat/check-seat-availability", () => ({
  checkSeatAvailability: (...a: unknown[]) => checkSeatAvailability(...a),
}));
vi.mock("../purchase-seat/execute-purchase-seat", () => ({
  executePurchaseSeat: async () => ({ ok: false }),
}));

import { ensureSeatsForInvite } from "./ensure-seats";

/** Hàng thẻ suất như tab "Người dùng" in ra: tổng / đã gán / khả dụng. */
function seatCards(total: number, assigned: number) {
  return {
    cards: [{ kind: "standard", label: "Suất Tiêu chuẩn", assigned, total }],
    total,
    assigned,
    free: Math.max(0, total - assigned),
    mixed: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cards = null;
  members = null;
  // @ts-expect-error — dựng global tối thiểu cho content script
  globalThis.location = { pathname: "/admin/members", search: "" };
});

describe("đủ chỗ theo hàng thẻ đọc lúc đầu", () => {
  it("KHÔNG quay lại tab Người dùng, KHÔNG mở hộp Quản lý suất", async () => {
    // Ảnh user: 405 suất, 398 đã gán, 7 khả dụng; 3 lời mời đang chờ ⇒ còn 4.
    cards = seatCards(405, 398);
    members = 398;

    const res = await ensureSeatsForInvite("t1", 2, ["moi@x.com", "moi2@x.com"]);

    expect(res.ok).toBe(true);
    expect(res.data.seat_check).toBe("ok_page_cards");
    expect(res.data.seat_total).toBe(405);
    expect(res.data.seat_pending_debt).toBe(3);
    expect(res.data.seat_free).toBe(4);
    // Đúng MỘT lần: cú đưa trang về tab "Người dùng" ở đầu bước. Sau khi đếm
    // lời mời xong thì đi thẳng, không vòng lại.
    expect(goToUsersTab).toHaveBeenCalledTimes(1);
    expect(checkSeatAvailability).not.toHaveBeenCalled();
  });
});

describe("hàng thẻ lúc đầu nói THIẾU chỗ", () => {
  it("quay lại tab Người dùng đọc lại, đủ thì vẫn khỏi mở hộp", async () => {
    // Lượt đọc đầu: 400 suất, 398 đã gán, 3 lời mời chờ ⇒ âm chỗ.
    cards = seatCards(400, 398);
    members = 398;
    // Lượt quay về đọc lại thấy con số thật: 410 suất ⇒ còn 9 chỗ.
    goToUsersTab.mockImplementation(async () => {
      if (goToUsersTab.mock.calls.length >= 2) cards = seatCards(410, 398);
    });

    const res = await ensureSeatsForInvite("t2", 1, ["moi@x.com"]);

    expect(res.ok).toBe(true);
    expect(res.data.seat_total).toBe(410);
    expect(res.data.seat_free).toBe(9);
    expect(goToUsersTab).toHaveBeenCalledTimes(2);
    expect(checkSeatAvailability).not.toHaveBeenCalled();
  });
});
