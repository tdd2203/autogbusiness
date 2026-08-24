/**
 * Đọc tình trạng suất của workspace bằng cách MỞ modal "Quản lý suất", đọc số,
 * rồi ĐÓNG LẠI. Thao tác CHỈ-ĐỌC — không bao giờ chạm nút "Tiếp tục".
 *
 * Dùng làm bước đầu tiên của luồng MỜI THÀNH VIÊN (quy trình user 2026-08-22):
 * biết còn bao nhiêu suất trống trước khi mời, thiếu thì mua bù rồi mới mời.
 *
 * ⚠️ Có workspace CHƯA được ChatGPT bật UI mới nên KHÔNG có nút "Quản lý số
 * suất" (user quan sát: workspace 47 thành viên có, workspace 145 thành viên
 * không). Trường hợp đó trả `supported:false` để caller giữ nguyên hành vi cũ
 * thay vì fail.
 */

import { dbLabelsFor } from "../../../shared/ui-labels";
import { humanClick, waitFor } from "../../human";
import { findControlByKey, findUiControlByTexts } from "../../i18n-ui";
import { TEXT_FALLBACKS } from "../../selectors";
import {
  MANAGE_SEATS_BUTTON_POLL_MS,
  MANAGE_SEATS_BUTTON_WAIT_MS,
  MODAL_OPEN_TIMEOUT_MS,
  SEAT_CROSSCHECK_POLL_MS,
  SEAT_CROSSCHECK_SETTLE_MS,
} from "./constants";
import { closeSeatModal } from "./modal1/close-seat-modal";
import { findSeatStepper } from "./modal1/find-seat-stepper";
import {
  parseSeatAvailability,
  type SeatAvailability,
} from "./modal1/parse-seat-availability";
import { settleSeatCrossCheck } from "./modal1/settle-seat-crosscheck";

const LOG = "[autogpt-seat-check]";

const DIALOG_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-state="open"]';

export type SeatCheckResult = {
  /** Workspace có nút "Quản lý số suất" (UI mới) hay không. */
  supported: boolean;
  /** Số suất đọc được. Null khi không mở/đọc được modal. */
  availability: SeatAvailability | null;
  /** Giá trị bộ đếm `[−] n [+]` — đối chiếu chéo với `availability.total`. */
  stepperTotal: number | null;
  /** Mô tả vì sao không đọc được (null nếu đọc được). */
  error: string | null;
  /**
   * Modal đã đóng lại hẳn chưa. Modal còn treo sẽ CHẶN mọi thao tác sau (mở
   * dialog mời, bấm "Quản lý số suất" lần nữa để mua) — caller PHẢI coi đây là
   * lỗi chứ không đi tiếp.
   */
  modalClosed: boolean;
};

/** Dialog đang mở chứa nội dung modal "Quản lý suất". */
function findSeatModal(): HTMLElement | null {
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>(DIALOG_SELECTOR),
  );
  for (const d of dialogs) {
    if (parseSeatAvailability(d.textContent ?? "")) return d;
  }
  // Modal có thể đã mở nhưng dòng tỉ lệ chưa render → nhận theo tiêu đề.
  for (const d of dialogs) {
    const t = (d.textContent ?? "").toLowerCase();
    if (/quản\s*lý\s*suất|manage\s*seats|管理席位/.test(t)) return d;
  }
  return null;
}

/**
 * Mở "Quản lý số suất" → đọc → đóng.
 *
 * Phải đang ở /admin/members và trang đã render xong (caller lo).
 */
export async function checkSeatAvailability(): Promise<SeatCheckResult> {
  // Hỏi ĐÚNG MỘT LẦN ngay lúc vừa tới trang là quá sớm: hàng nút của tab "Người
  // dùng" là component React render SAU danh sách, mà `membersListReady` của
  // ensure-seats chỉ đòi "trang có >2 nút" nên đã cho đi tiếp từ trước đó.
  //
  // ⚠️ Ca thật 22/8/2026 (2 lần: 18:03 và 18:20, workspace hết sạch suất): không
  // thấy nút ⇒ `supported:false` ⇒ ensure-seats hiểu là "workspace UI cũ" và BỎ
  // QUA chốt suất ⇒ mời mù ⇒ ChatGPT bật hộp "mua kèm gửi lời mời" ⇒ 15s không có
  // toast ⇒ VERIFY_FAILED. Đúng cái hộp mà cả thiết kế đếm-suất-trước sinh ra để
  // tránh. Hai lệnh "Mời lại" 14 phút sau (đi qua tiền tố thu hồi nên trang đã
  // render xong) lại đếm suất chuẩn — đó là dấu vân tay của một cuộc đua render,
  // không phải workspace UI cũ.
  //
  // Nay CHỜ nút xuất hiện rồi mới dám kết luận. Poll bằng finder IM LẶNG
  // (`findUiControlByTexts`) chứ không phải `findControlByKey`: hàm kia bắn
  // `reportLabelMismatch` mỗi lần trượt → poll sẽ spam dashboard. Hết giờ mới hỏi
  // lại đúng một lần qua `findControlByKey` để báo lệch nhãn như cũ.
  const probeManageBtn = (): HTMLElement | null =>
    findUiControlByTexts([
      ...dbLabelsFor("billing_manage_licenses", "/admin/members"),
      ...TEXT_FALLBACKS.billingManageLicenses,
    ]);

  let manageBtn = probeManageBtn();
  if (!manageBtn) {
    try {
      manageBtn = await waitFor(
        probeManageBtn,
        MANAGE_SEATS_BUTTON_WAIT_MS,
        MANAGE_SEATS_BUTTON_POLL_MS,
      );
    } catch {
      manageBtn = findControlByKey(
        "billing_manage_licenses",
        TEXT_FALLBACKS.billingManageLicenses,
        { page: "/admin/members" },
      );
    }
  }
  if (!manageBtn) {
    console.log(`${LOG} workspace KHÔNG có nút 'Quản lý số suất' → bỏ qua kiểm tra suất`);
    return {
      supported: false,
      availability: null,
      stepperTotal: null,
      error: null,
      modalClosed: true,
    };
  }

  await humanClick(manageBtn);

  let modal: HTMLElement;
  try {
    modal = await waitFor(() => findSeatModal(), MODAL_OPEN_TIMEOUT_MS, 300);
  } catch {
    return {
      supported: true,
      availability: null,
      stepperTotal: null,
      error:
        `Đã bấm 'Quản lý số suất' nhưng modal không mở sau ${MODAL_OPEN_TIMEOUT_MS / 1000}s.`,
      modalClosed: true,
    };
  }

  // Dòng tỉ lệ có thể điền sau modal một nhịp → chờ tới khi đọc được.
  let availability: SeatAvailability | null = null;
  try {
    availability = await waitFor(
      () => parseSeatAvailability(modal.textContent ?? ""),
      8_000,
      300,
    );
  } catch {
    availability = null;
  }

  // Bộ đếm là component React RIÊNG, có thể ổn định chậm hơn dòng tỉ lệ một nhịp →
  // đọc lại CẢ HAI cho tới khi khớp. Không chờ ở đây thì lệch quá độ 1 đơn vị sẽ
  // giết cả task mời (ca thật 23/8/2026 — xem settle-seat-crosscheck.ts).
  const settled = await settleSeatCrossCheck(
    () => parseSeatAvailability(modal.textContent ?? ""),
    () => findSeatStepper()?.read() ?? null,
    SEAT_CROSSCHECK_SETTLE_MS,
    SEAT_CROSSCHECK_POLL_MS,
  );
  if (settled.availability) availability = settled.availability;
  const stepperTotal = settled.stepperTotal;

  const closed = await closeSeatModal(modal);
  if (!closed) {
    console.warn(`${LOG} KHÔNG đóng được modal 'Quản lý suất' — thao tác sau có thể bị chặn`);
  }

  if (!availability) {
    return {
      supported: true,
      availability: null,
      stepperTotal,
      error:
        "Modal 'Quản lý suất' mở nhưng không đọc được dòng '<đã gán>/<tổng> đã gán'. " +
        "Có thể ChatGPT đổi cách hiển thị.",
      modalClosed: closed,
    };
  }

  // Đối chiếu chéo: bộ đếm khởi điểm PHẢI bằng tổng suất đã mua. Lệch nghĩa là
  // một trong hai chỗ bị đọc sai → không dám dùng con số để quyết định mua.
  // Tới đây là đã cho hai bên `SEAT_CROSSCHECK_SETTLE_MS` để ổn định mà vẫn lệch,
  // nên đây là lệch THẬT chứ không phải bắt trúng nhịp render dở.
  if (stepperTotal !== null && stepperTotal !== availability.total) {
    return {
      supported: true,
      availability: null,
      stepperTotal,
      error:
        `Số suất hiển thị không khớp sau ${SEAT_CROSSCHECK_SETTLE_MS / 1000}s ` +
        `(bộ đếm ${stepperTotal}, dòng tỉ lệ ${availability.total}).`,
      modalClosed: closed,
    };
  }

  console.log(
    `${LOG} tổng=${availability.total}, đã gán=${availability.assigned}, còn trống=${availability.free}` +
      (closed ? "" : " (modal chưa đóng!)"),
  );
  return { supported: true, availability, stepperTotal, error: null, modalClosed: closed };
}
