/**
 * Luật "dòng này có đang HIỆN không" — cửa duy nhất phân biệt danh sách của tab
 * đang mở với danh sách tab cũ React chưa gỡ khỏi DOM.
 *
 * CA THẬT 30/8/2026: bấm sang tab "Lời mời đang chờ" xong, bảng tab "Người dùng"
 * vẫn nằm nguyên trong DOM ở dạng ẩn. Bộ đọc quét thẳng `document` nên đọc trúng
 * cả 25 dòng đã ẩn ⇒ cổng "đã nạp xong" của bước chốt suất lần nào cũng thấy
 * "vẫn còn 25 email của tab Người dùng" ⇒ chờ hết trần rồi bỏ cuộc. Bốn lệnh mời
 * sáng hôm đó hỏng `CONTENT_TIMEOUT` vì phần đọc số ăn hết ngân sách 300s.
 *
 * Không có jsdom trong repo → dựng phần tử giả với đúng ba thứ luật này đọc:
 * `closest`, `offsetParent`, `getClientRects`.
 */
import { describe, expect, it } from "vitest";
import { isRenderedVisible } from "./scrape-all-rows";

type FakeOptions = {
  /** Có tổ tiên mang `hidden` / `aria-hidden="true"`. */
  ariaHiddenAncestor?: boolean;
  /** Có `offsetParent` (phần tử nằm trong luồng bố cục bình thường). */
  hasOffsetParent?: boolean;
  /** Số hình chữ nhật bố cục — 0 nghĩa là không chiếm chỗ nào trên trang. */
  rects?: number;
};

function el(o: FakeOptions): Element {
  return {
    closest: (_sel: string) => (o.ariaHiddenAncestor ? ({} as Element) : null),
    offsetParent: o.hasOffsetParent ? ({} as Element) : null,
    getClientRects: () => ({ length: o.rects ?? 0 }),
  } as unknown as Element;
}

describe("isRenderedVisible", () => {
  it("dòng đang hiện bình thường → tính", () => {
    expect(isRenderedVisible(el({ hasOffsetParent: true, rects: 1 }))).toBe(true);
  });

  it("bảng tab cũ bị display:none → KHÔNG tính", () => {
    // Đúng hình dạng của bảng "Người dùng" còn sót sau khi sang tab "Lời mời".
    expect(isRenderedVisible(el({ hasOffsetParent: false, rects: 0 }))).toBe(false);
  });

  it("nằm trong khối hidden/aria-hidden → KHÔNG tính dù vẫn có bố cục", () => {
    expect(
      isRenderedVisible(
        el({ ariaHiddenAncestor: true, hasOffsetParent: true, rects: 1 }),
      ),
    ).toBe(false);
  });

  it("phần tử position:fixed (không có offsetParent) vẫn tính nếu còn chiếm chỗ", () => {
    expect(isRenderedVisible(el({ hasOffsetParent: false, rects: 1 }))).toBe(true);
  });

  it("không có phần tử → KHÔNG tính", () => {
    expect(isRenderedVisible(null)).toBe(false);
  });
});
