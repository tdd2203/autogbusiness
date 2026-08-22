import { humanClick, sleep, waitFor } from "../../../human";
import { SEAT_MODAL_CLOSE_TIMEOUT_MS } from "../constants";

/**
 * Đóng modal "Quản lý suất" — ưu tiên nút "Quay lại"/đóng, không được thì Esc.
 *
 * ⚠️ TUYỆT ĐỐI không bấm "Tiếp tục": nút đó dẫn thẳng sang modal thanh toán.
 *
 * Dùng ở 2 chỗ: bước đọc suất (chỉ-đọc) và bước LÀM LẠI của luồng mua khi số
 * suất trong thẻ tóm tắt không khớp — làm lại thì phải đóng hẳn modal cũ rồi mở
 * lại từ đầu, vì bộ đếm chỉ trở về số thật khi modal mở mới.
 */
export async function closeSeatModal(modal: HTMLElement): Promise<boolean> {
  const buttons = Array.from(modal.querySelectorAll<HTMLButtonElement>("button"));
  const back = buttons.find((b) => {
    const text = (b.textContent ?? "").trim().toLowerCase();
    const aria = (b.getAttribute("aria-label") ?? "").toLowerCase();
    return (
      /^(quay lại|quay lai|huỷ|hủy|cancel|back|close|đóng|dong|返回|关闭)$/.test(text) ||
      /close|đóng|dong|关闭/.test(aria)
    );
  });
  if (back) {
    await humanClick(back);
  } else {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  }

  try {
    await waitFor(
      () => (document.body.contains(modal) ? null : true),
      SEAT_MODAL_CLOSE_TIMEOUT_MS,
      200,
    );
    return true;
  } catch {
    // Thử Esc lần nữa rồi thôi — modal còn mở sẽ chặn thao tác sau, caller phải
    // biết để xử lý.
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await sleep(400);
    return !document.body.contains(modal);
  }
}
