/**
 * TRANG CÓ ĐANG ĐƯỢC VẼ KHÔNG — cửa bắt buộc trước mọi lượt quét DOM.
 *
 * VÌ SAO CÓ (đo 6/9/2026 trên chính máy user):
 *
 *   document.visibilityState        = "hidden"
 *   requestAnimationFrame chạy      = 0 lần
 *   bấm nút tab "Lời mời"           → URL đổi thành ?tab=invites
 *   bảng sau 9 giây                 → VẪN 25 dòng của tab "Người dùng"
 *
 * Trình duyệt chỉ cấp nhịp vẽ khung hình cho tab đang được nhìn. React của
 * ChatGPT dựng lại bảng theo nhịp đó, nên trong một tab ẩn cú bấm vẫn "ăn" (URL
 * đổi, trang tin là đã đổi tab) mà bảng thì không bao giờ được dựng lại.
 *
 * Đây là kiểu hỏng TỆ NHẤT: không có lỗi nào nổ ra, bộ quét chỉ lặng lẽ đọc bảng
 * CŨ dưới nhãn tab MỚI. Ca 6/9/2026: 396 người ĐANG DÙNG suýt bị gắn nhãn "chờ
 * tham gia", chỉ thoát nhờ một chốt chặn khác bắt được. Và cả loạt lệnh đồng bộ
 * tự động ban đêm hỏng `CONTENT_TIMEOUT` từ 25/8/2026 — ban đêm không ai bấm vào
 * tab để nó chạy tiếp.
 *
 * CHỜ LÂU HƠN KHÔNG CHỮA ĐƯỢC: trang không chậm, nó dừng hẳn. Cách duy nhất là
 * cho tab được hiện (xem `ADMIN_TAB_ACTIVE` bên `background/runner.ts`). Cửa này
 * là lưới an toàn cho lúc điều đó không xảy ra — thà báo lỗi rõ ràng còn hơn trả
 * về một danh sách sai mà không ai biết.
 */

/** Chờ tab được hiện trong ngần này rồi mới kết luận. Tab vừa mở cần chút nhịp. */
const VISIBLE_GRACE_MS = 8_000;

/** Nhịp soi lại. Không dùng `sleep` của `human.ts` để tránh vòng phụ thuộc. */
const POLL_MS = 250;

export type VisibilityDeps = {
  state: () => DocumentVisibilityState;
  wait: (ms: number) => Promise<void>;
  now: () => number;
};

const defaultDeps: VisibilityDeps = {
  state: () => document.visibilityState,
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

/**
 * Chờ tới khi trang được vẽ. Trả `true` nếu đang hiện, `false` nếu hết hạn mà
 * vẫn ẩn.
 */
export async function waitForPageVisible(
  graceMs: number = VISIBLE_GRACE_MS,
  deps: VisibilityDeps = defaultDeps,
): Promise<boolean> {
  const deadline = deps.now() + graceMs;
  for (;;) {
    if (deps.state() === "visible") return true;
    if (deps.now() >= deadline) return false;
    await deps.wait(POLL_MS);
  }
}

/**
 * Trang có đang được vẽ NGAY LÚC NÀY không. Rẻ (một lần đọc thuộc tính) nên gọi
 * được trong vòng lặp quét.
 *
 * VÌ SAO CẦN RIÊNG, ngoài `waitForPageVisible`: cửa lúc khởi động chỉ chốt được
 * thời điểm bắt đầu. Một mẻ quét 400 người mất gần hai phút, và trong hai phút đó
 * người dùng bấm sang tab khác là trang ngừng được vẽ NGAY — từ đó bộ quét lại
 * đọc bảng cũ mà không có lỗi nào nổ ra, đúng kiểu hỏng đã suýt gắn nhãn sai cho
 * 396 người hôm 6/9/2026. Soi lại ở từng trang thì mất bao nhiêu cũng chỉ mất
 * phần chưa quét, và người dùng nhận được một câu lỗi thay vì dữ liệu sai.
 */
export function pageIsVisible(
  deps: Pick<VisibilityDeps, "state"> = defaultDeps,
): boolean {
  return deps.state() === "visible";
}

/** Câu lỗi dùng chung, nói đúng việc cần làm chứ không nói "thử lại sau". */
export const PAGE_HIDDEN_MESSAGE =
  "Tab ChatGPT đang chạy ngầm nên trình duyệt không vẽ lại trang: bấm sang tab " +
  "khác thì địa chỉ đổi nhưng bảng dữ liệu vẫn là bảng cũ. Đọc tiếp là ghi nhầm " +
  "danh sách, nên đã dừng. Mở cửa sổ chạy lệnh lên cho tab đó hiện rồi chạy lại.";

/** Câu lỗi cho ca MẤT hiển thị giữa chừng — nói rõ đã quét được tới đâu. */
export function pageHiddenMidRunMessage(daThu: number): string {
  return (
    `Tab ChatGPT bị chuyển xuống nền giữa lúc đang quét (mới thu ${daThu} dòng). ` +
    "Trình duyệt ngừng vẽ lại trang, nên đọc tiếp là đọc trúng bảng cũ. Đã dừng " +
    "để không ghi nhầm danh sách. Giữ nguyên tab đó ở trước rồi chạy lại."
  );
}
