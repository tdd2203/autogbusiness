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
  /**
   * Tổng suất ĐANG CÓ theo DÒNG TỈ LỆ ("147/151 đã gán" → 151).
   *
   * `availability.total` LUÔN bằng số này — kể cả khi bộ đếm nói khác. Xem khối
   * chú thích ở cuối `checkSeatAvailability`.
   */
  ratioTotal: number | null;
  /**
   * Tổng DÈ DẶT = số THẤP HƠN giữa bộ đếm và dòng tỉ lệ. Bằng `ratioTotal` khi
   * hai nguồn khớp. CHỈ để hiển thị/chẩn đoán: mọi quyết định "còn chỗ không"
   * dùng `availability.total`, còn quyết định MUA thì `uncertain` đã cấm hẳn.
   */
  safeTotal: number | null;
  /**
   * Nội dung hộp đã rút gọn (1 dòng, đã xoá email). Manh mối DUY NHẤT về nguyên
   * nhân khi bộ đếm lệch dòng tỉ lệ — xem `summarizeSeatModalText`.
   */
  modalText: string | null;
  /** Mô tả vì sao không đọc được (null nếu đọc được). */
  error: string | null;
  /**
   * Bộ đếm và dòng tỉ lệ nói hai tổng KHÁC NHAU (đã chờ ổn định mà vẫn lệch).
   * KHÔNG được dùng để quyết định MUA: xem `ensure-seats.ts`.
   */
  uncertain: boolean;
  /**
   * Modal đã đóng lại hẳn chưa. Modal còn treo sẽ CHẶN mọi thao tác sau (mở
   * dialog mời, bấm "Quản lý số suất" lần nữa để mua) — caller PHẢI coi đây là
   * lỗi chứ không đi tiếp.
   */
  modalClosed: boolean;
};

/** Dài nhất được giữ lại của nội dung hộp — đủ đọc, không phình `result` của task. */
const MODAL_TEXT_MAX = 500;

/**
 * Rút gọn nội dung hộp "Quản lý suất" thành MỘT dòng để ghi vào `result` của task.
 *
 * VÌ SAO PHẢI GIỮ: khi bộ đếm và dòng tỉ lệ nói hai số khác nhau, đó là toàn bộ
 * manh mối về NGUYÊN NHÂN — hộp thường tự nói ra ("đang chờ N lượt gỡ", "có hiệu
 * lực từ kỳ sau"…). Bản trước vứt hết, chỉ giữ đúng cờ `uncertain`, nên mỗi lần
 * gặp lại vẫn phải nhờ người mở ChatGPT nhìn tận mắt.
 *
 * Xoá mọi thứ hình dạng email trước khi trả về: `result` của task đi vào DB và
 * có thể lọt vào nhật ký/commit, mà hộp này không có lý do gì cần tới danh tính.
 */
export function summarizeSeatModalText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > MODAL_TEXT_MAX
    ? `${cleaned.slice(0, MODAL_TEXT_MAX)}…`
    : cleaned;
}

/**
 * Chốt hai con số tổng suất từ hai nguồn của hộp "Quản lý suất".
 *
 * @param ratioTotal tổng theo DÒNG TỈ LỆ ("148/151 đã gán" → 151) — số suất
 *   workspace ĐANG giữ ở thời điểm này.
 * @param stepperTotal tổng theo bộ đếm `[−] n [+]`, hoặc null khi không định vị
 *   được bộ đếm.
 * @returns `total` = số dùng cho MỌI quyết định "còn chỗ không" (luôn là dòng tỉ
 *   lệ); `safeTotal` = số thấp hơn, chỉ để hiển thị/chẩn đoán; `uncertain` = hai
 *   nguồn lệch ⇒ CẤM mua (`ensure-seats.ts`).
 *
 * Xuất khẩu để test được — đây là đường quyết định dính tới tiền.
 */
export function resolveSeatTotals(
  ratioTotal: number,
  stepperTotal: number | null,
): { total: number; safeTotal: number; uncertain: boolean } {
  if (stepperTotal === null || stepperTotal === ratioTotal) {
    return { total: ratioTotal, safeTotal: ratioTotal, uncertain: false };
  }
  return {
    total: ratioTotal,
    safeTotal: Math.min(stepperTotal, ratioTotal),
    uncertain: true,
  };
}

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
      ratioTotal: null,
      safeTotal: null,
      modalText: null,
      error: null,
      uncertain: false,
      modalClosed: true,
    };
  }

  // Bấm rồi hộp KHÔNG mở là lỗi hay gặp nhất của luồng mời (5 ca ngày 24/8/2026):
  // cú bấm rơi vào lúc React đang gắn lại handler nên trượt hẳn. Bấm lại một lần
  // trước khi bỏ cuộc — thao tác này CHỈ-ĐỌC nên bấm thừa không hại gì.
  let modal: HTMLElement | null = null;
  for (let attempt = 1; attempt <= 2 && !modal; attempt++) {
    if (attempt > 1) {
      console.log(`${LOG} hộp 'Quản lý suất' chưa mở → bấm lại lần ${attempt}`);
    }
    const btn =
      attempt === 1
        ? manageBtn
        : findControlByKey(
            "billing_manage_licenses",
            TEXT_FALLBACKS.billingManageLicenses,
            { page: "/admin/members" },
          );
    if (!btn) break;
    await humanClick(btn);
    try {
      modal = await waitFor(() => findSeatModal(), MODAL_OPEN_TIMEOUT_MS, 300);
    } catch {
      modal = null;
    }
  }
  if (!modal) {
    return {
      supported: true,
      availability: null,
      stepperTotal: null,
      ratioTotal: null,
      safeTotal: null,
      modalText: null,
      error:
        `Đã bấm 'Quản lý số suất' 2 lần nhưng modal không mở sau ` +
        `${(MODAL_OPEN_TIMEOUT_MS * 2) / 1000}s.`,
      uncertain: false,
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

  // Chụp nội dung hộp TRƯỚC khi đóng — đóng rồi thì DOM không còn gì để đọc.
  const modalText = summarizeSeatModalText(modal.textContent);

  const closed = await closeSeatModal(modal);
  if (!closed) {
    console.warn(`${LOG} KHÔNG đóng được modal 'Quản lý suất' — thao tác sau có thể bị chặn`);
  }

  if (!availability) {
    return {
      supported: true,
      availability: null,
      stepperTotal,
      ratioTotal: null,
      safeTotal: null,
      modalText,
      error:
        "Modal 'Quản lý suất' mở nhưng không đọc được dòng '<đã gán>/<tổng> đã gán'. " +
        "Có thể ChatGPT đổi cách hiển thị.",
      uncertain: false,
      modalClosed: closed,
    };
  }

  // Đối chiếu chéo: bộ đếm khởi điểm PHẢI bằng tổng suất đã mua. Tới đây là đã
  // cho hai bên `SEAT_CROSSCHECK_SETTLE_MS` để ổn định mà vẫn lệch, nên đây là
  // lệch THẬT chứ không phải bắt trúng nhịp render dở.
  //
  // Lệch KHÔNG phải lỗi chết task, và cũng KHÔNG được hạ tổng xuống theo bộ đếm
  // nữa (user 2026-08-24 — ca GPT1). Lịch sử của chỗ này:
  //   - Bản đầu: lệch ⇒ chết task.
  //   - Bản hai: lệch ⇒ lấy `min(bộ đếm, dòng tỉ lệ)` cho MỌI quyết định, vì
  //     "tưởng thiếu suất còn hơn tưởng thừa".
  // Bản hai làm GPT1 KẸT VĨNH VIỄN: bộ đếm 150, dòng tỉ lệ 151 (workspace có lượt
  // hạ suất hẹn hiệu lực kỳ sau nên hai chỗ nói hai KỲ khác nhau — lệch này lặp
  // lại y hệt mọi lần chạy, chờ bao lâu cũng vô ích). Thực tế còn 1 suất trống,
  // nhưng hạ tổng về 150 ⇒ tính ra 0 ⇒ đòi mua ⇒ `uncertain` cấm mua ⇒ mọi lệnh
  // mời cần suất trên workspace này chết, lần nào cũng vậy (maitran.hy
  // 24/8: 16:20 và 16:28, cùng một `FAILED_UI_CHANGED`).
  //
  // Nay: `availability.total` LUÔN là dòng tỉ lệ — đó mới là số suất workspace
  // ĐANG giữ ở thời điểm này, tức số đúng cho câu hỏi "mời thêm được không". Bộ
  // đếm nói về kỳ sau, không phải bây giờ.
  //  - MUA vẫn CẤM khi lệch (`ensure-seats.ts`): mua theo số không chắc là mất
  //    tiền thật, mà tiền đã trừ thì không đòi lại được.
  //  - Rủi ro còn lại của việc mời theo số cao hơn — nếu dòng tỉ lệ mới là số
  //    sai — đã có CHẶN CUỐI đỡ: trước khi bấm nút gửi, `execute-invite-inner`
  //    đọc nhãn nút, thấy "Mua suất người dùng và gửi lời mời" thì DỪNG, không
  //    bấm. Tức sai về phía rộng chỉ tốn một task hỏng, không tiêu tiền.
  const ratioTotal = availability.total;
  const { safeTotal, uncertain } = resolveSeatTotals(ratioTotal, stepperTotal);
  if (uncertain) {
    console.warn(
      `${LOG} bộ đếm ${stepperTotal} ≠ dòng tỉ lệ ${ratioTotal} sau ` +
        `${SEAT_CROSSCHECK_SETTLE_MS / 1000}s → GIỮ tổng theo dòng tỉ lệ ` +
        `(${ratioTotal}, tổng dè dặt ${safeTotal}), nhưng CẤM mua theo số này.` +
        ` Nội dung hộp: ${modalText ?? "(không đọc được)"}`,
    );
  }

  console.log(
    `${LOG} tổng=${availability.total}, đã gán=${availability.assigned}, còn trống=${availability.free}` +
      (uncertain ? " (hai nguồn lệch — số chưa chắc)" : "") +
      (closed ? "" : " (modal chưa đóng!)"),
  );
  return {
    supported: true,
    availability,
    stepperTotal,
    ratioTotal,
    safeTotal,
    modalText,
    error: null,
    uncertain,
    modalClosed: closed,
  };
}
