export const BILLING_PLAN_PATH = "/admin/billing";
export const BILLING_PLAN_SEARCH = "?tab=plan";

/** Render delay sau khi navigate / click trong SPA. GIỮ NGUYÊN: chờ trang
 * render sau nav → phụ thuộc tốc độ mạng/máy, giảm = thao tác sớm khi chưa render. */
export const POST_NAV_RENDER_MS = 2500;

/** Hard cap đợi modal "Xem xét" mở. */
export const MODAL_OPEN_TIMEOUT_MS = 15_000;

/** Hard cap đợi modal review #2 ("Quản lý chỗ ngồi") mở sau Tiếp tục. */
export const CHARGE_MODAL_TIMEOUT_MS = 12_000;

/** Đợi modal #2 đóng (= ChatGPT đã accept charge) sau Thêm người dùng. */
export const CHARGE_DISMISS_TIMEOUT_MS = 10_000;

/** Hard cap quantity per task (mirror backend `PURCHASE_SEAT_MAX_PER_TASK`). */
export const MAX_QUANTITY = 20;
