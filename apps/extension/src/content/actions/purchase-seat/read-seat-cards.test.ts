/**
 * UI ChatGPT mới 26/8/2026 — tab "Người dùng" in sẵn số suất theo TỪNG LOẠI.
 * Text trong test lấy đúng theo ảnh user chụp (workspace CHATGPT PRO, 60 thành
 * viên, 62 suất Tiêu chuẩn, 0 suất Cao cấp).
 *
 * Đây là đường đọc số dính tới TIỀN: đọc thiếu một thẻ ⇒ tưởng hết suất ⇒ mua
 * thừa; đọc thừa ⇒ tưởng còn chỗ ⇒ mời mù vào hộp "mua kèm gửi lời mời".
 */
import { describe, expect, it } from "vitest";
import {
  describeSeatCards,
  parseSeatCards,
  seatIncrease,
  seatTotalsOf,
} from "./read-seat-cards";

/** Nguyên văn tab "Người dùng" (rút gọn phần danh sách member). */
const MEMBERS_PAGE =
  "Thành viên Business · 60 thành viên " +
  "Người dùng Lời mời đang chờ xử lý Yêu cầu đang chờ xử lý " +
  "Suất Tiêu chuẩn Đã gán 60/62 62 " +
  "Suất Cao cấp Đã gán 0/0 0 " +
  "Lọc theo tên Tất cả các vai trò Quản lý số suất + Mời thành viên " +
  "Tên Vai trò Loại suất Ngày thêm " +
  "Andrew vanxuanthinhmk@gmail.com Thành viên Tiêu chuẩn 22 thg 8, 2026";

describe("parseSeatCards — hàng thẻ suất trên trang Thành viên", () => {
  it("đọc cả hai thẻ, tổng = suất đã mua, vế trái = suất đã phân bổ", () => {
    const r = parseSeatCards(MEMBERS_PAGE)!;
    expect(r.cards).toHaveLength(2);
    expect(r.total).toBe(62);
    expect(r.assigned).toBe(60);
    expect(r.free).toBe(2);
    expect(r.cards[0].kind).toBe("standard");
    expect(r.cards[1].kind).toBe("premium");
  });

  it("chỉ một loại suất có số ⇒ KHÔNG phải 'nhiều loại', vẫn được tự mua", () => {
    expect(parseSeatCards(MEMBERS_PAGE)!.mixed).toBe(false);
  });

  it("CỘNG cả hai loại: 62 Tiêu chuẩn + 10 Cao cấp = 72 suất đã mua", () => {
    const r = parseSeatCards(
      "Suất Tiêu chuẩn Đã gán 60/62 62 Suất Cao cấp Đã gán 4/10 10",
    )!;
    expect(r.total).toBe(72);
    expect(r.assigned).toBe(64);
    expect(r.free).toBe(8);
    // Hai loại cùng khác 0 ⇒ bộ đếm hộp "Quản lý suất" chỉ lái một loại ⇒ CẤM
    // tự mua theo tổng gộp.
    expect(r.mixed).toBe(true);
  });

  it("dòng tỉ lệ kiểu hộp 'Quản lý suất' (nhãn đứng SAU) vẫn đọc được", () => {
    const r = parseSeatCards(
      "Quản lý suất Tiêu chuẩn 649.000 đ/tháng 53 người dùng · 52/53 đã gán − 53 +",
    )!;
    expect(r.total).toBe(53);
    expect(r.assigned).toBe(52);
    expect(r.mixed).toBe(false);
  });

  it("bản tiếng Anh / tiếng Trung", () => {
    expect(parseSeatCards("Standard seats Assigned 60/62 62")).toMatchObject({
      total: 62,
      assigned: 60,
    });
    expect(parseSeatCards("标准席位 已分配 60/62 62")).toMatchObject({
      total: 62,
      assigned: 60,
    });
  });

  it("vượt suất (đã gán > tổng) là trạng thái HỢP LỆ, không được vứt", () => {
    const r = parseSeatCards("Suất Tiêu chuẩn Đã gán 64/62 62")!;
    expect(r.total).toBe(62);
    expect(r.assigned).toBe(64);
    // free kẹp sàn 0 — phần âm do caller xử lý (xem `seatsToBuy`).
    expect(r.free).toBe(0);
  });

  it("không có ô 'Đã gán' nào → null, caller mở hộp đọc như cũ", () => {
    expect(parseSeatCards("Thành viên Business · 60 thành viên")).toBeNull();
    expect(parseSeatCards("")).toBeNull();
  });

  it("KHÔNG bắt nhầm ngày tháng / số thành viên (thiếu chữ 'đã gán')", () => {
    expect(parseSeatCards("Ngày thêm 22 thg 8, 2026 · 5/16/2026 · 60 thành viên")).toBeNull();
  });

  it("quét ra quá nhiều ô ⇒ nghi bắt trúng bảng khác → null", () => {
    const many = Array.from({ length: 9 }, () => "Đã gán 1/2").join(" ");
    expect(parseSeatCards(many)).toBeNull();
  });

  it("nhãn giữ nguyên dấu để ghi nhật ký", () => {
    const r = parseSeatCards(MEMBERS_PAGE)!;
    expect(r.cards[0].label).toContain("Tiêu chuẩn");
    expect(describeSeatCards(r)).toContain("→ tổng 62 suất, đã gán 60");
  });
});

/**
 * Chốt "đã mua xong" mới (user 2026-08-26): số suất Tiêu chuẩn IN SẴN trên trang
 * nhích lên = mua thành công, khỏi mở lại hộp "Quản lý suất".
 */
/**
 * UI ChatGPT 4/9/2026 (ảnh user, workspace CHAT GPT PRO): thẻ suất bỏ hẳn cụm
 * tỉ lệ "340/360", thay bằng con số lớn + hai ô "Đã gán" / "Khả dụng".
 */
const MEMBERS_PAGE_TILES_EN =
  "Members Business · 340 members " +
  "Users Pending invites Pending requests " +
  "360 Manage Standard seats 340 Assigned 20 Available " +
  "0 Manage Premium seats 0 Assigned 0 Available " +
  "Filter by name All roles + Invite member " +
  "Name Role Seat type Date added " +
  "A HK phamtheanh060712@gmail.com Member Standard Sep 1, 2026";

describe("parseSeatCards — thẻ suất DẠNG 2 (Đã gán / Khả dụng)", () => {
  it("tổng suất lấy CON SỐ LỚN trên thẻ (360), không cộng 340 + 20", () => {
    const r = parseSeatCards(MEMBERS_PAGE_TILES_EN)!;
    expect(r.cards).toHaveLength(2);
    expect(r.cards[0]).toMatchObject({ kind: "standard", assigned: 340, total: 360 });
    expect(r.cards[1]).toMatchObject({ kind: "premium", assigned: 0, total: 0 });
    expect(r.total).toBe(360);
    expect(r.assigned).toBe(340);
    expect(r.free).toBe(20);
    // Chỉ suất Tiêu chuẩn khác 0 ⇒ vẫn được tự mua bù.
    expect(r.mixed).toBe(false);
  });

  it("bản tiếng Việt / tiếng Trung của cùng thẻ", () => {
    expect(
      parseSeatCards(
        "360 Quản lý Suất Tiêu chuẩn 340 Đã gán 20 Khả dụng " +
          "0 Quản lý Suất Cao cấp 0 Đã gán 0 Khả dụng",
      ),
    ).toMatchObject({ total: 360, assigned: 340, free: 20, mixed: false });
    expect(
      parseSeatCards("360 管理 标准席位 340 已分配 20 可用 0 管理 高级席位 0 已分配 0 可用"),
    ).toMatchObject({ total: 360, assigned: 340, free: 20 });
  });

  it("hai loại suất cùng khác 0 ⇒ CẤM tự mua theo tổng gộp", () => {
    const r = parseSeatCards(
      "360 Manage Standard seats 340 Assigned 20 Available " +
        "10 Manage Premium seats 4 Assigned 6 Available",
    )!;
    expect(r.total).toBe(370);
    expect(r.mixed).toBe(true);
    expect(seatTotalsOf(r).standard).toBe(360);
  });

  it("DẠNG 1 vẫn được ưu tiên khi trang còn in cụm tỉ lệ", () => {
    const r = parseSeatCards(MEMBERS_PAGE)!;
    expect(r.total).toBe(62);
  });

  it("trang không có ô suất nào ⇒ null, KHÔNG suy ra 'workspace hết suất'", () => {
    expect(
      parseSeatCards("Members Business · 340 members Users Pending invites"),
    ).toBeNull();
  });

  it("con số lớn KHÁC 'đã gán + khả dụng' ⇒ tin con số lớn", () => {
    // Chưa gặp trên production, nhưng đây là chỗ hai cách đọc tách nhau: nếu có
    // ngày ChatGPT cho "Khả dụng" trừ luôn lời mời đang chờ thì phép cộng ra
    // tổng THIẾU ⇒ tưởng workspace ít suất hơn thật rồi mua thừa bằng tiền thật.
    const r = parseSeatCards(
      "360 Manage Standard seats 340 Assigned 12 Available",
    )!;
    expect(r.total).toBe(360);
    expect(r.assigned).toBe(340);
    expect(r.free).toBe(20);
  });

  it("nhãn loại suất đọc thẳng trong cụm, không đoán theo chữ đứng trước", () => {
    const r = parseSeatCards(
      "0 Manage Premium seats 0 Assigned 0 Available " +
        "360 Manage Standard seats 340 Assigned 20 Available",
    )!;
    expect(r.cards[0].kind).toBe("premium");
    expect(r.cards[1].kind).toBe("standard");
    expect(seatTotalsOf(r).standard).toBe(360);
  });

  it("ChatGPT xếp lại thẻ (mất con số lớn) ⇒ lưới đỡ cộng đã gán + khả dụng", () => {
    expect(
      parseSeatCards("Standard seats Manage 340 Assigned 20 Available"),
    ).toMatchObject({ total: 360, assigned: 340, free: 20 });
  });

  it("mua thêm 1 suất: thẻ đổi 360 → 361, khả dụng 20 → 21", () => {
    const before = seatTotalsOf(parseSeatCards(MEMBERS_PAGE_TILES_EN)!);
    const after = seatTotalsOf(
      parseSeatCards(
        "361 Manage Standard seats 340 Assigned 21 Available " +
          "0 Manage Premium seats 0 Assigned 0 Available",
      )!,
    );
    expect(seatIncrease(before, after)).toEqual({ delta: 1, basis: "standard" });
  });
});

describe("seatTotalsOf / seatIncrease — so số suất trước và sau khi mua", () => {
  it("tách riêng suất Tiêu chuẩn, không gộp với Cao cấp", () => {
    const t = seatTotalsOf(
      parseSeatCards("Suất Tiêu chuẩn Đã gán 60/62 62 Suất Cao cấp Đã gán 4/10 10")!,
    );
    expect(t.total).toBe(72);
    expect(t.standard).toBe(62);
  });

  it("một thẻ duy nhất mà nhãn không nói loại → coi là suất Tiêu chuẩn", () => {
    const t = seatTotalsOf(parseSeatCards("Đã gán 64/66 66")!);
    expect(t.standard).toBe(66);
  });

  it("ảnh user 26/8: 64/66 → mua 2 suất → 66/68 là ĐÃ MUA XONG", () => {
    const before = seatTotalsOf(
      parseSeatCards("Suất Tiêu chuẩn Đã gán 64/66 66 Suất Cao cấp Đã gán 0/0 0")!,
    );
    const after = seatTotalsOf(
      parseSeatCards("Suất Tiêu chuẩn Đã gán 64/68 68 Suất Cao cấp Đã gán 0/0 0")!,
    );
    const inc = seatIncrease(before, after);
    expect(inc.basis).toBe("standard");
    expect(inc.delta).toBe(2);
  });

  it("trang chưa cập nhật (số y nguyên) → tăng 0, CHƯA được coi là mua xong", () => {
    const same = seatTotalsOf(parseSeatCards("Suất Tiêu chuẩn Đã gán 64/66 66")!);
    expect(seatIncrease(same, same).delta).toBe(0);
  });

  it("suất Cao cấp đổi mà Tiêu chuẩn đứng im → KHÔNG tính là mua được", () => {
    const before = seatTotalsOf(
      parseSeatCards("Suất Tiêu chuẩn Đã gán 64/66 66 Suất Cao cấp Đã gán 0/0 0")!,
    );
    const after = seatTotalsOf(
      parseSeatCards("Suất Tiêu chuẩn Đã gán 64/66 66 Suất Cao cấp Đã gán 0/3 3")!,
    );
    const inc = seatIncrease(before, after);
    expect(inc.basis).toBe("standard");
    expect(inc.delta).toBe(0);
  });

  it("một bên không tách được loại → rơi về so tổng gộp", () => {
    const before = seatTotalsOf(parseSeatCards("Đã gán 64/66 66 Đã gán 0/0 0")!);
    const after = seatTotalsOf(
      parseSeatCards("Suất Tiêu chuẩn Đã gán 64/68 68 Suất Cao cấp Đã gán 0/0 0")!,
    );
    expect(before.standard).toBeNull();
    expect(seatIncrease(before, after)).toEqual({ delta: 2, basis: "total" });
  });
});
