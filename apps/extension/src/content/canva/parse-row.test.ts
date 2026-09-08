/**
 * Đọc một dòng của bảng thành viên Canva.
 *
 * CA THẬT 1-2/9/2026: bộ đọc cũ bóc email từ `row.textContent` — chuỗi Canva nối
 * các ô KHÔNG có khoảng trắng — nên cả ba người trong "Canva Team" vào dashboard
 * thành `scurryncub8927@outlook.comteam`, `inoueinouengoc@gmail.comteam`,
 * `anhnguyenanhtu22117@gmail.comteam`, tên thì mang nguyên email theo sau. Lượt
 * đồng bộ kế tiếp không thấy `inouengoc@gmail.com` trong đội nữa nên gỡ nó ra
 * (`sync_missing`) cùng chu kỳ 12 tháng khách đã trả.
 *
 * Dữ liệu dưới đây chép đúng các ô trong ảnh user gửi, giữ nguyên thứ tự text node
 * (avatar → tên → email → vai trò).
 */
import { describe, expect, it } from "vitest";
import { emailIn } from "./dom";
import { parseMemberRow } from "./parse-row";

describe("parseMemberRow", () => {
  it("avatar chữ tắt không dính vào tên, vai trò không dính vào email", () => {
    expect(parseMemberRow(["JS", "Jarron Scurry", "ncub8927@outlook.com", "Team owner"])).toEqual({
      email: "ncub8927@outlook.com",
      name: "Jarron Scurry",
      status: "active",
      role: "owner",
    });
  });

  it("avatar là ảnh (không có chữ) vẫn ra đúng tên", () => {
    expect(parseMemberRow(["Ngoc Inoue", "inouengoc@gmail.com", "Team member"])).toEqual({
      email: "inouengoc@gmail.com",
      name: "Ngoc Inoue",
      status: "active",
      role: "member",
    });
  });

  it("tên tiếng Việt có dấu, avatar trùng đầu tên", () => {
    expect(
      parseMemberRow(["Tú", "Tú Nguyễn anh", "nguyenanhtu22117@gmail.com", "Team admin"]),
    ).toEqual({
      email: "nguyenanhtu22117@gmail.com",
      name: "Tú Nguyễn anh",
      status: "active",
      role: "admin",
    });
  });

  it("dòng lời mời chờ tiếng Anh: email nằm giữa câu, dấu nháy cong không lọt vào tên", () => {
    expect(
      parseMemberRow([
        "Ngoc Inoue",
        "inouengoc@gmail.com’s invite is valid for 29 more days.",
        "Invited",
        "Resend invite",
      ]),
    ).toEqual({
      email: "inouengoc@gmail.com",
      name: "Ngoc Inoue",
      status: "pending",
      role: null,
    });
  });

  it("dòng lời mời chờ tiếng Việt: không có tên thì để trống, không lấy nhãn làm tên", () => {
    expect(
      parseMemberRow([
        "Lời mời của datlla1307@gmail.com còn hiệu lực trong 29 ngày nữa.",
        "Đã mời",
        "Gửi lại lời mời",
      ]),
    ).toEqual({
      email: "datlla1307@gmail.com",
      name: null,
      status: "pending",
      role: null,
    });
  });

  it("dòng không có email thì bỏ qua", () => {
    expect(parseMemberRow(["Invite people", "Groups"])).toBeNull();
  });
});

describe("emailIn", () => {
  it("cắt nhãn ô bên cạnh bị dán vào tên miền", () => {
    expect(emailIn("ncub8927@outlook.comTeam owner")).toBe("ncub8927@outlook.com");
    expect(emailIn("datlla1307@gmail.com’s invite is valid")).toBe("datlla1307@gmail.com");
  });

  it("giữ nguyên phần trước @ dù viết hoa xen kẽ", () => {
    expect(emailIn("ngocInoue@gmail.com")).toBe("ngocinoue@gmail.com");
  });

  it("tên miền nhiều cấp vẫn đủ", () => {
    expect(emailIn("ai@mail.co.ukTeam member")).toBe("ai@mail.co.uk");
  });
});
