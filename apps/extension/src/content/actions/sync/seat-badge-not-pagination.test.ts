/**
 * Ô "Đã gán 243/250" trên hàng thẻ suất có CÙNG DẠNG "N/M" với chỉ số trang
 * ("1/10") in ở cuối bảng Thành viên. Nhận nhầm nó là thanh phân trang thì
 * `goToFirstPage` sẽ đi bấm các nút cạnh thẻ suất ("Quản lý số suất", "Mời thành
 * viên") và tin rằng mình đang ở trang 243/250.
 *
 * Workspace lớn được `MAX_PAGINATION_PAGES` (200) chặn hộ, nhưng workspace nhỏ
 * ("Đã gán 60/62") thì lọt thẳng — nên phải chặn bằng NGỮ CẢNH quanh con số.
 */
import { describe, expect, it } from "vitest";
import { isSeatContext } from "./pagination";

describe("isSeatContext", () => {
  it("nhận ra ngữ cảnh ô suất", () => {
    expect(isSeatContext("Đã gán 243/250")).toBe(true);
    expect(isSeatContext("Suất Tiêu chuẩn Đã gán 60/62")).toBe(true);
    expect(isSeatContext("Assigned 60/62")).toBe(true);
    expect(isSeatContext("52/53 đã gán")).toBe(true);
    expect(isSeatContext("已分配 12/20")).toBe(true);
  });

  it("KHÔNG chặn thanh phân trang thật", () => {
    expect(isSeatContext("1/10")).toBe(false);
    expect(isSeatContext("1 / 10")).toBe(false);
    expect(isSeatContext("Trang tiếp theo")).toBe(false);
  });

  it("bỏ qua ngữ cảnh quá dài — leo cao là trúng cả trang", () => {
    const wholePage =
      "Suất Tiêu chuẩn Đã gán 243/250 Suất Cao cấp Đã gán 0/0 " +
      "Thành viên Business 243 thành viên Người dùng Lời mời đang chờ xử lý 1/10";
    expect(isSeatContext(wholePage)).toBe(false);
  });
});
