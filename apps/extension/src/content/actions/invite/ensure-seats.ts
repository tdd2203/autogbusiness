/**
 * BƯỚC ĐẦU TIÊN của luồng mời (quy trình user 2026-08-22): kiểm tra số suất
 * còn trống, thiếu thì MUA BÙ, đủ rồi mới mời.
 *
 * Vì sao phải mua TRƯỚC khi mời: nếu mời khi thiếu suất, ChatGPT bật một modal
 * "Xem lại giao dịch mua" riêng với nút **"Mua suất người dùng và gửi lời mời"**
 * — mua suất VÀ gửi lời mời trong MỘT cú bấm. Extension không kiểm soát được
 * đường đó (không biết trước mua bao nhiêu, hết bao nhiêu tiền), nên ta chủ động
 * làm cho nó KHÔNG BAO GIỜ xuất hiện: đảm bảo đủ suất trước, rồi mới mở dialog
 * mời như bình thường.
 *
 * Workspace CHƯA được ChatGPT bật UI mới (không có nút "Quản lý số suất") →
 * bỏ qua toàn bộ bước này, mời y như trước.
 */

import { sleep } from "../../human";
import { reportProgress } from "../../progress";
import { checkSeatAvailability } from "../purchase-seat/check-seat-availability";
import {
  MAX_QUANTITY,
  POST_NAV_RENDER_MS,
  SEAT_SETTLE_AFTER_PURCHASE_MS,
} from "../purchase-seat/constants";
import { executePurchaseSeat } from "../purchase-seat/execute-purchase-seat";
import { navigateTo } from "../external-invites/navigate";
import { countPendingInvites } from "./count-pending-invites";
import { readMemberCountFromPage } from "./read-member-count";
import {
  dashboardPendingDebt,
  freeSeatsWithPendingDebt,
  seatsToBuy,
} from "./seat-math";

const LOG = "[autogpt-invite-seats]";

/**
 * Số suất dashboard đang biết, gửi kèm task (backend `_seat_hint`).
 * `total` = seat_total (có thể CŨ), `occupied` = member chưa bị gỡ (active + pending),
 * `pending` = RIÊNG lời mời đang chờ. Cả `occupied` lẫn `pending` đều KHÔNG kể
 * email của chính lệnh mời này — chúng đã được đếm một lần trong `need`.
 */
export type SeatHint = {
  total: number | null;
  occupied: number;
  pending?: number;
};

/**
 * Đòi dư thêm bằng này suất so với số cần thì mới dám bỏ qua hộp "Quản lý suất".
 *
 * `seat_total` của dashboard scrape từ trang thanh toán nên có thể CŨ. Cũ theo
 * chiều THẤP thì vô hại (chỉ mở hộp thừa). Cũ theo chiều CAO mới nguy: workspace
 * hạ số suất hẹn hiệu lực kỳ sau, tới kỳ thì tổng tụt xuống mà DB chưa biết. Dư
 * 1 suất đủ nuốt trọn ca đó — và mọi ca lệch lớn hơn thì hết dư, tự khắc quay về
 * mở hộp đếm tận nơi.
 */
const SEAT_HINT_SPARE = 1;
const MEMBERS_PATH = "/admin/members";
const BILLING_PATH = "/admin/billing";

export type EnsureSeatsResult = {
  /** false = KHÔNG được mời tiếp. */
  ok: boolean;
  /** true = workspace UI cũ, đã bỏ qua kiểm tra. */
  skipped: boolean;
  error_code?: "NOT_ENOUGH_SEATS" | "SEAT_CHECK_FAILED" | "SEAT_PURCHASE_FAILED";
  error_message?: string;
  /** Số liệu gắn vào result của task mời để dashboard ghi nhận. */
  data: Record<string, unknown>;
};

/** Số nguyên đọc từ payload result của luồng mua; mọi thứ khác → null. */
function asInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

/** Trang phải ở tab "Người dùng" — hàng nút "Quản lý số suất" nằm trong tab đó. */
function membersListReady(): boolean {
  if (!location.pathname.includes(MEMBERS_PATH)) return false;
  return document.querySelectorAll("button").length > 2;
}

/**
 * Tải lại trang Thành viên để lấy số suất mới nhất.
 *
 * KHÔNG dùng `location.reload()`: content script bị huỷ giữa chừng, lời gọi từ
 * background treo rồi chết với CONTENT_TIMEOUT — trong khi tiền thì đã trừ xong.
 * Thay bằng điều hướng SPA sang trang admin khác rồi quay lại: React unmount/
 * mount lại trang Thành viên và gọi lại API số suất, mà content script vẫn sống
 * nên task chạy tiếp được tới bước mời.
 */
async function softReloadMembersPage(): Promise<void> {
  // `spaFirst`: đổi URL bằng pushState trước, chỉ click link khi trang không chịu
  // render. Hàm này CHỈ được gọi SAU KHI ĐÃ MUA SUẤT — tiền đã trừ thật — nên
  // tuyệt đối không được để cú điều hướng làm rời trang: rời trang là kênh với
  // background đứt (back/forward cache), kết quả không về được, dashboard mất dấu
  // khoản vừa mua. Xem `external-invites/navigate.ts` và `background/content-ready.ts`.
  const opts = { spaFirst: true } as const;
  await navigateTo(
    BILLING_PATH,
    () => location.pathname.includes(BILLING_PATH),
    10_000,
    opts,
  );
  await sleep(POST_NAV_RENDER_MS);
  await navigateTo(MEMBERS_PATH, membersListReady, 10_000, opts);
  await sleep(POST_NAV_RENDER_MS);
}

/**
 * Chắc chắn còn thừa chỗ chưa? Chỉ dựa vào những gì ĐỌC ĐƯỢC MÀ KHÔNG mở hộp:
 * số thành viên in trên trang + cặp số dashboard gửi kèm.
 *
 * Số suất ĐANG BỊ CHIẾM lấy theo bên LỚN HƠN giữa hai nguồn, vì mỗi bên sót một
 * kiểu: trang chỉ đếm người ĐÃ tham gia, còn DB thì thiếu người vào ChatGPT bằng
 * đường khác. Lấy max là cận trên của cả hai chiều sót.
 *
 * ⚠️ `hint.occupied` CÓ cộng lời mời đang chờ, và đó là ĐẾM THỪA CÓ CHỦ Ý — không
 * phải vì lời mời chờ đang giữ suất. Đo trên production 24/8/2026: GPT1 có 148
 * active + 1 chờ, ChatGPT báo đúng `148/151 đã gán`; CHATGPT PRO còn rõ hơn —
 * `60/60 đã gán`, KHÔNG còn suất trống nào, mà vẫn đang treo 1 lời mời chờ. Nếu
 * lời mời chờ giữ suất thì ca đó không tồn tại được. Tức "đã gán" của ChatGPT =
 * đúng số active.
 *
 * Vẫn cộng vào vì lời mời chờ BIẾN THÀNH suất thật ngay khi người ta bấm nhận —
 * có thể xảy ra đúng giữa lúc đọc số này và lúc bấm mời. Đếm thừa thì cùng lắm là
 * mở hộp đếm tận nơi (chậm); đếm thiếu là mời mù vào chỗ không có, đúng cái hộp
 * "Mua suất người dùng và gửi lời mời" mà cả thiết kế này sinh ra để tránh.
 *
 * Xuất khẩu để test được — đây là một trong hai đường quyết định dính tới tiền.
 */
export function headroomWithoutModal(
  need: number,
  hint: SeatHint | undefined,
  pageMembers: number | null,
): { enough: boolean; total: number | null; occupied: number | null; free: number | null } {
  const total = hint?.total ?? null;
  if (total === null) return { enough: false, total, occupied: null, free: null };
  const occupied = Math.max(hint?.occupied ?? 0, pageMembers ?? 0);
  if (occupied <= 0) return { enough: false, total, occupied: null, free: null };
  const free = total - occupied;
  return { enough: free >= need + SEAT_HINT_SPARE, total, occupied, free };
}

/**
 * Có được phép SUY RA tổng suất mới từ bộ đếm của hộp mua, thay vì mở lại hộp
 * "Quản lý suất" để đọc kiểm?
 *
 * Chỉ dám tin khi CẢ BA khớp: hộp xác nhận đã đóng (giao dịch đã đi qua), bộ đếm
 * khởi điểm đúng bằng tổng vừa đọc được, và điểm đến đúng bằng tổng + số mua.
 * Lệch bất kỳ chỗ nào = một trong hai bên đọc sai, hoặc admin khác vừa đổi suất
 * giữa chừng → caller quay về đường đọc lại tận nơi.
 *
 * Cả ba đều so BẰNG NHAU chứ không so "đủ lớn": chỉ cần tổng thật thấp hơn số
 * suy ra là bước mời phía sau đâm vào hộp mua-kèm-mời. Xuất khẩu để test được —
 * đây là đường thứ hai dính tới tiền.
 */
export function canDeriveTotalAfterPurchase(
  purchaseData: Record<string, unknown>,
  totalBefore: number,
  shortfall: number,
): boolean {
  return (
    purchaseData.charge_modal_dismissed === true &&
    asInt(purchaseData.initial_seat) === totalBefore &&
    asInt(purchaseData.target_seat) === totalBefore + shortfall
  );
}

/**
 * @param need số suất MỚI mà lần mời này cần (số email sắp mời).
 * @param inviteEmails các email sắp mời — LOẠI khỏi phép đếm lời mời đang chờ
 *   (chúng đã được tính một lần trong `need`; đếm hai lần ⇒ mua thừa tiền thật).
 * @param seatHint cặp số dashboard đang biết — có thì thử bỏ qua hộp "Quản lý suất".
 */
export async function ensureSeatsForInvite(
  taskId: string,
  need: number,
  inviteEmails: string[],
  seatHint?: SeatHint,
): Promise<EnsureSeatsResult> {
  // Hàng nút "Quản lý số suất" thuộc tab "Người dùng". Tiền tố "Mời lại" trước
  // đó có thể đã chuyển sang tab "Lời mời đang chờ" (?tab=invites) — kiểm tra ở
  // đó sẽ KHÔNG thấy nút rồi kết luận nhầm là "workspace UI cũ" và bỏ qua chốt
  // suất. Ép về URL sạch trước.
  await navigateTo(MEMBERS_PATH, membersListReady, 10_000);
  if (/[?&]tab=(invites|requests)/.test(location.search)) {
    history.pushState({}, "", MEMBERS_PATH);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(1200);
  }

  // ── ĐƯỜNG TẮT: thừa chỗ rõ ràng thì mời thẳng, KHÔNG mở hộp ─────────────
  // Mở hộp "Quản lý suất" trước mỗi lần mời là chỗ hỏng nhiều nhất của luồng mời
  // (24/8/2026: 8 task chết liên tiếp — 4 ca hộp không mở sau 15s, 4 ca bộ đếm
  // lệch dòng tỉ lệ — trong khi workspace thừa suất). Trang đã in sẵn "146 thành
  // viên"; dashboard gửi kèm tổng suất + số member chưa bị gỡ. Hai số đó nói còn
  // dư thì không có lý do gì đụng vào hộp.
  //
  // Không đủ dư (hoặc dashboard chưa biết tổng suất) → rơi về đếm tận nơi như cũ.
  const pageMembers = readMemberCountFromPage();
  const room = headroomWithoutModal(need, seatHint, pageMembers);
  if (room.enough) {
    console.log(
      `${LOG} bỏ qua hộp 'Quản lý suất': tổng ${room.total} suất, đang chiếm ` +
        `${room.occupied} (trang ${pageMembers ?? "?"}, dashboard ${seatHint?.occupied ?? "?"}) ` +
        `→ trống ${room.free}, cần ${need}. Mời thẳng.`,
    );
    return {
      ok: true,
      skipped: false,
      data: {
        seat_check: "skipped_headroom",
        seat_total: room.total,
        seat_assigned: room.occupied,
        seat_free: room.free,
        seat_needed: need,
        seat_page_members: pageMembers,
        seat_hint_occupied: seatHint?.occupied ?? null,
        seat_purchased: 0,
      },
    };
  }

  // ── NỢ SUẤT: đếm TẬN NƠI, đừng tin DB ──────────────────────────────────
  // Tới đây là đã phải mở hộp "Quản lý suất" rồi — chậm sẵn, nên thêm một cú
  // click sang tab "Lời mời đang chờ" để đếm cho ĐÚNG là đáng. Dashboard có thể
  // đang giữ bản ghi "Chờ tham gia" mà lời mời trên ChatGPT đã chết — chiều lệch
  // đó không tự lành nếu đồng bộ chỉ chạy scope 'members'. Mỗi bản ghi thừa ăn
  // một suất trong phép tính (xem `count-pending-invites.ts`).
  //
  // Đọc không được thì rơi về số của DB: nó đếm THỪA, mà thừa thì cùng lắm là
  // mở hộp / mua dư một suất, còn thiếu là mời mù vào chỗ không có.
  const scannedPending = await countPendingInvites(inviteEmails);
  // Quay lại tab "Người dùng": nút "Quản lý số suất" chỉ có ở đó.
  await navigateTo(MEMBERS_PATH, membersListReady, 10_000);
  if (/[?&]tab=(invites|requests)/.test(location.search)) {
    history.pushState({}, "", MEMBERS_PATH);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(1200);
  }

  const check = await checkSeatAvailability();

  // ── Workspace UI cũ → giữ nguyên hành vi trước đây ──────────────────────
  if (!check.supported) {
    return {
      ok: true,
      skipped: true,
      data: { seat_check: "skipped_no_ui", seat_needed: need },
    };
  }

  // ── Modal còn treo → KHÔNG đi tiếp ──────────────────────────────────────
  // Lớp phủ của modal chặn mọi click phía sau: bấm "Quản lý số suất" để mua sẽ
  // trượt, mà mở dialog mời cũng trượt. Dừng sớm với thông báo rõ còn hơn để
  // các bước sau fail lung tung.
  if (!check.modalClosed) {
    return {
      ok: false,
      skipped: false,
      error_code: "SEAT_CHECK_FAILED",
      error_message:
        "Đã đọc suất nhưng KHÔNG đóng được modal 'Quản lý suất' — lớp phủ của nó chặn " +
        "mọi thao tác sau. Đóng modal trên ChatGPT rồi chạy lại task.",
      data: { seat_check: "modal_stuck", seat_needed: need },
    };
  }

  // ── Có UI mới nhưng đọc không ra số → KHÔNG mời ─────────────────────────
  // Mời mù khi không biết còn bao nhiêu suất chính là tình huống làm ChatGPT
  // bật modal "Mua suất người dùng và gửi lời mời". Thà dừng với thông báo rõ.
  if (!check.availability) {
    return {
      ok: false,
      skipped: false,
      error_code: "SEAT_CHECK_FAILED",
      error_message:
        `Không đọc được số suất còn trống: ${check.error ?? "?"} Đã dừng, chưa mời ai.`,
      data: { seat_check: "failed", seat_needed: need },
    };
  }

  const before = check.availability;

  // ── NỢ SUẤT CỦA LỜI MỜI ĐANG TREO ───────────────────────────────────────
  // Hộp "Quản lý suất" đếm "đã gán" = người ĐÃ THAM GIA. Lời mời treo không nằm
  // trong đó nhưng sẽ chiếm suất ngay khi người ta bấm nhận (ca thật CHATGPT PRO
  // 24/8/2026: "60/60 đã gán" mà vẫn còn 1 lời mời chưa ai nhận). Lấy thẳng
  // `total − đã gán` làm chỗ trống là bỏ quên món nợ đó: mời thêm 1 email ở
  // workspace đó sẽ chỉ mua 1 suất trong khi phải mua 2 (user chốt 24/8/2026).
  //
  // NGUỒN của con số này: ưu tiên bản ĐẾM TẬN NƠI ở tab "Lời mời đang chờ"
  // (`countPendingInvites` phía trên) — đó là sự thật. Chỉ khi không đọc được
  // mới rơi về `seatHint.pending` của dashboard, vốn có thể còn giữ bản ghi của
  // lời mời đã chết trên ChatGPT. Sát trần suất thì mỗi bản ghi thừa là chênh
  // lệch giữa "mời được" và "báo thiếu suất rồi dừng".
  //
  // Cả hai nguồn đều đã LOẠI email của chính lệnh mời này nên không đếm hai lần
  // với `need`. Backend cũ chưa gửi `pending` → 0, hành vi y như trước.
  //
  // Số của DB còn một kiểu đếm thừa NỮA: người vừa
  // bấm nhận lời mời đã nằm trong "đã gán" của ChatGPT trong khi DB còn để
  // 'pending' tới lần đồng bộ sau ⇒ cộng thẳng là đếm họ HAI lần. Đối chiếu với
  // `seatHint.occupied` để trừ ra — xem `dashboardPendingDebt`.
  const hintPending = seatHint?.pending ?? 0;
  const hintDebt = dashboardPendingDebt(
    seatHint?.occupied,
    before.assigned,
    hintPending,
  );
  const pendingDebt = scannedPending.authoritative
    ? scannedPending.emails.length
    : hintDebt;
  const freeReal = freeSeatsWithPendingDebt(
    before.total,
    before.assigned,
    pendingDebt,
  );

  const baseData: Record<string, unknown> = {
    seat_check: check.uncertain ? "ok_uncertain" : "ok",
    // `seat_total` là con số DASHBOARD hiển thị → DÒNG TỈ LỆ ("147/151 đã gán"
    // → 151), tức số suất workspace ĐANG giữ. Từ 24/8/2026 `before.total` cũng
    // đúng bằng số này (không còn bị hạ theo bộ đếm); `?? ` chỉ là lưới an toàn.
    seat_total: check.ratioTotal ?? before.total,
    seat_assigned: before.assigned,
    // Tổng DÈ DẶT = số thấp hơn giữa bộ đếm và dòng tỉ lệ. CHỈ để chẩn đoán —
    // `seat_free` tính theo `seat_total` (dòng tỉ lệ = suất ĐANG có). Xem khối
    // chú thích cuối `check-seat-availability.ts`.
    seat_total_safe: check.safeTotal ?? before.total,
    // `seat_free` = chỗ trống THẬT (đã trừ nợ suất của lời mời treo) — đây là số
    // mọi quyết định bên dưới dùng. `seat_free_raw` là số thô ChatGPT ngụ ý
    // (total − đã gán), giữ lại để tra khi cần.
    seat_free: freeReal,
    seat_free_raw: before.free,
    seat_pending_debt: pendingDebt,
    // Nợ suất lấy từ đâu — cần khi truy ngược một ca "thiếu suất" khó hiểu.
    seat_pending_source: scannedPending.authoritative ? "chatgpt_tab" : "dashboard",
    seat_pending_scanned: scannedPending.authoritative
      ? scannedPending.emails.length
      : null,
    seat_pending_hint: hintPending,
    // Nợ suất suy từ cặp số DB sau khi trừ người đã nhận lời mời mà sync chưa
    // biết. Lệch `seat_pending_hint` = đúng số người đang ở giữa hai trạng thái.
    seat_pending_hint_debt: hintDebt,
    seat_hint_occupied: seatHint?.occupied ?? null,
    seat_pending_scan_skipped: scannedPending.reason,
    seat_needed: need,
    seat_uncertain: check.uncertain,
    // Chỉ có ý nghĩa khi `seat_uncertain`: giá trị bộ đếm + nội dung hộp, để truy
    // nguyên nhân vênh. Xem `summarizeSeatModalText`.
    seat_stepper_total: check.stepperTotal,
    seat_modal_text: check.modalText,
  };
  console.log(
    `${LOG} cần ${need} suất, đang trống ${freeReal}/${before.total} ` +
      `(đã gán ${before.assigned} + ${pendingDebt} lời mời đang chờ, nguồn ` +
      `${scannedPending.authoritative ? "tab Lời mời của ChatGPT" : `dashboard — ${scannedPending.reason}`})` +
      (check.uncertain
        ? ` — bộ đếm lệch dòng tỉ lệ, giữ tổng theo dòng tỉ lệ (${check.ratioTotal ?? before.total}), tổng dè dặt ${check.safeTotal ?? before.total}, CẤM mua`
        : ""),
  );

  // ── Đủ suất → mời luôn ──────────────────────────────────────────────────
  // Kể cả khi bộ đếm lệch dòng tỉ lệ: `before.total` là tổng của DÒNG TỈ LỆ, tức
  // số suất workspace ĐANG giữ — đúng số cho câu hỏi "mời thêm được không". Mời
  // không tiêu tiền nên số chưa chắc cũng không hại, và nếu nó sai thật thì chặn
  // cuối ở `execute-invite-inner` (nhãn nút "Mua suất người dùng và gửi lời mời")
  // vẫn dừng trước khi bấm. Chỉ cấm MUA theo nó (nhánh dưới).
  if (freeReal >= need) {
    return { ok: true, skipped: false, data: { ...baseData, seat_purchased: 0 } };
  }

  // ── Thiếu → mua bù ──────────────────────────────────────────────────────
  // KHÔNG lấy `need − freeReal`: `freeReal` kẹp sàn ở 0 nên khi workspace đang ÂM
  // CHỖ (đã gán + lời mời chờ > tổng suất) thì phần âm bị nuốt mất ⇒ mua hụt đúng
  // bằng phần đó. Ca thật CHATGPT PRO 24/8/2026 (60 suất, 60 đã gán, 1 lời mời
  // chờ, mời thêm 1): đường cũ ra 1, đúng phải là 2 — một suất cho người đang
  // chờ, một cho email mới (user chốt). Xem `seatsToBuy`.
  const shortfall = seatsToBuy(before.total, before.assigned, pendingDebt, need);

  // Số chưa chắc thì TUYỆT ĐỐI không mua: bộ đếm và dòng tỉ lệ đang nói hai tổng
  // khác nhau, mua theo số sai là mất tiền thật (mà tiền đã trừ thì không đòi lại
  // được). Dừng, báo rõ để admin mở ChatGPT xem rồi mua tay.
  if (check.uncertain) {
    // Luồng mua lái BỘ ĐẾM, mà bộ đếm đang khởi điểm ở một số khác tổng thật →
    // bấm `+ shortfall` lần sẽ ra sai đích. Không đoán hộ: dừng, nhưng đưa cho
    // admin ĐÚNG con số cần đặt thay vì bảo chung chung "mua thủ công".
    //
    // Đích = tổng THẬT (dòng tỉ lệ) + số thiếu. Nếu bộ đếm thấp hơn tổng thật thì
    // đặt tới đích này cũng huỷ luôn phần chênh đang hẹn hiệu lực kỳ sau — đó là
    // quyết định chi tiền, phải do người bấm, không để máy tự làm.
    const target =
      check.ratioTotal !== null ? check.ratioTotal + shortfall : null;
    return {
      ok: false,
      skipped: false,
      error_code: "SEAT_CHECK_FAILED",
      error_message:
        `Thiếu ${shortfall} suất (cần ${need}) nhưng hộp "Quản lý suất" đang nói HAI tổng ` +
        `khác nhau: bộ đếm ${check.stepperTotal ?? "?"}, dòng tỉ lệ ${before.assigned}/` +
        `${check.ratioTotal ?? "?"}. Không mua tự động theo số chưa chắc. ` +
        (target !== null
          ? `Mở "Quản lý số suất" trên ChatGPT, đặt bộ đếm lên ${target} rồi chạy lại task.`
          : "Mở ChatGPT kiểm tra rồi mua suất thủ công, sau đó chạy lại task.") +
        (check.modalText ? ` — Hộp đang hiện: "${check.modalText}"` : ""),
      data: {
        ...baseData,
        seat_shortfall: shortfall,
        seat_purchased: 0,
        seat_manual_target: target,
      },
    };
  }

  // Cap 20/task là chốt cứng mirror backend. Mua 20 khi cần 25 thì vẫn không
  // mời đủ — tiền mất mà việc không xong, nên dừng hẳn thay vì mua một phần.
  if (shortfall > MAX_QUANTITY) {
    return {
      ok: false,
      skipped: false,
      error_code: "NOT_ENOUGH_SEATS",
      error_message:
        `Thiếu ${shortfall} suất (cần ${need}, còn trống ${freeReal}) — vượt hạn mức ` +
        `${MAX_QUANTITY} suất/lần. KHÔNG mua một phần. Chia nhỏ danh sách mời, hoặc mua suất thủ công trước.`,
      data: { ...baseData, seat_shortfall: shortfall, seat_purchased: 0 },
    };
  }

  console.log(`${LOG} thiếu ${shortfall} suất → mua bù trước khi mời`);
  const purchase = await executePurchaseSeat(taskId, shortfall);

  const purchaseData =
    purchase.ok && "data" in purchase
      ? ((purchase.data ?? {}) as Record<string, unknown>)
      : {};
  const charged = purchaseData.confirm_charge_clicked === true;

  if (!purchase.ok || !charged) {
    return {
      ok: false,
      skipped: false,
      error_code: "SEAT_PURCHASE_FAILED",
      error_message:
        `Cần mua thêm ${shortfall} suất trước khi mời nhưng không mua được: ` +
        (purchase.ok
          ? String(purchaseData.note ?? "luồng mua dừng trước bước xác nhận")
          : purchase.error_message ?? "?") +
        " — KHÔNG mời để tránh kích hoạt luồng mua-kèm-mời của ChatGPT.",
      data: {
        ...baseData,
        seat_shortfall: shortfall,
        seat_purchased: 0,
        seat_purchase: purchaseData,
      },
    };
  }

  // ── Mua xong: SUY RA số suất mới từ chính bộ đếm của hộp mua ────────────
  // Bộ đếm `[−] n [+]` trong hộp "Quản lý suất" CHÍNH LÀ tổng suất: `initial_seat`
  // là tổng trước khi bấm +, `target_seat` là tổng sau khi bấm — và số đó đã được
  // đối chiếu với thẻ tóm tắt của hộp "Xem lại giao dịch mua" rồi mới bấm "Xác
  // nhận mua". Ta chưa mời ai nên số suất ĐANG GÁN không đổi → tổng mới lớn hơn
  // số đang gán đúng bằng số suất trống mới.
  //
  // Biết chắc rồi thì KHÔNG mở lại hộp "Quản lý suất" nữa (user 2026-08-24): mỗi
  // lượt mở/đóng vừa chậm vừa thêm một cơ hội hộp kẹt — mà hộp kẹt là lớp phủ
  // chặn luôn cả bước mời phía sau.
  const initialSeat = asInt(purchaseData.initial_seat);
  const targetSeat = asInt(purchaseData.target_seat);
  const derived = canDeriveTotalAfterPurchase(
    purchaseData,
    before.total,
    shortfall,
  );

  if (derived) {
    // `shortfall` được tính sao cho `tổng + shortfall = đã gán + nợ suất + need`
    // (xem `seatsToBuy`), nên chỗ trống mới ĐÚNG BẰNG `need` — kể cả ca workspace
    // đang âm chỗ. Khỏi phải đọc lại để so.
    const totalAfter = before.total + shortfall;

    // Hộp mua đã đóng nhưng LỚP PHỦ còn nằm lại → mọi cú bấm của bước mời phía
    // sau rơi vào lớp phủ chứ không tới nút thật. Tải lại trang cho sạch rồi mới
    // mời (số suất thì đã biết chắc, không cần đọc lại).
    if (purchaseData.charge_overlay_cleared === false) {
      console.warn(
        `${LOG} mua xong nhưng lớp phủ của hộp còn nằm lại → tải lại trang cho sạch trước khi mời`,
      );
      await reportProgress(
        taskId,
        {
          phase: "seat-purchased",
          message:
            `Đã mua ${shortfall} suất (tiền đã trừ trên ChatGPT) — hộp còn lớp phủ, đang tải lại trang trước khi mời...`,
        },
        true,
      );
      await softReloadMembersPage();
    }
    console.log(
      `${LOG} mua xong ${shortfall} suất (bộ đếm ${before.total} → ${totalAfter}), ` +
        `đã gán ${before.assigned} → đủ ${need} suất trống. Mời tiếp, KHÔNG mở lại hộp suất.`,
    );
    return {
      ok: true,
      skipped: false,
      data: {
        ...baseData,
        seat_shortfall: shortfall,
        seat_purchased: shortfall,
        seat_purchase: purchaseData,
        seat_total_after: totalAfter,
        seat_assigned_after: before.assigned,
        seat_free_after: totalAfter - before.assigned,
        seat_after_source: "purchase_counter",
        seat_reloaded_once: purchaseData.charge_overlay_cleared === false,
      },
    };
  }

  // ── Số không khớp → ĐỌC LẠI ĐÚNG MỘT LẦN ────────────────────────────────
  // Tới đây là bộ đếm của hộp mua không nói được tổng mới (hộp chưa đóng, hoặc
  // lệch so với số đã đọc). Phải xác nhận bằng mắt. Nhưng CHỈ đọc MỘT lần:
  // mở/đóng hộp nhiều lượt vừa chậm vừa thêm cơ hội hộp kẹt.
  console.log(
    `${LOG} không suy ra được tổng suất mới từ hộp mua ` +
      `(bộ đếm ${initialSeat ?? "?"} → ${targetSeat ?? "?"}, đã đọc tổng ${before.total}, ` +
      `hộp đóng=${purchaseData.charge_modal_dismissed === true}) → mở lại hộp đọc kiểm.`,
  );
  await sleep(SEAT_SETTLE_AFTER_PURCHASE_MS);

  // Hộp thanh toán chưa đóng (hoặc lớp phủ còn đó) → trang đang bị chặn, mở hộp
  // "Quản lý suất" để đọc kiểm chắc chắn trượt. Tải lại trang TRƯỚC cho sạch,
  // thay vì đốt một lượt chờ 15s rồi mới tải.
  // Đã tải lại trang chưa — dùng chung cho cả hai lý do (hộp kẹt / số cũ) để
  // không bao giờ tải quá MỘT lần sau khi tiền đã trừ.
  let reloadedOnce = false;
  if (
    purchaseData.charge_modal_dismissed !== true ||
    purchaseData.charge_overlay_cleared === false
  ) {
    reloadedOnce = true;
    console.warn(`${LOG} hộp mua chưa đóng sạch → tải lại trang trước khi đọc kiểm`);
    await reportProgress(
      taskId,
      {
        phase: "seat-purchased",
        message:
          `Đã bấm mua ${shortfall} suất nhưng hộp chưa đóng sạch — đang tải lại trang để đọc lại số suất...`,
      },
      true,
    );
    await softReloadMembersPage();
  }

  let recheck = await checkSeatAvailability();
  let after =
    recheck.availability && recheck.modalClosed ? recheck.availability : null;

  // Vẫn thiếu ở lần đọc đầu → nhiều khả năng trang còn giữ số cũ trong bộ nhớ
  // của React. TẢI LẠI TRANG MỘT LẦN rồi đọc lại. Đủ thì mời tiếp như thường.
  // Chỗ trống THẬT = tổng − (đã gán + nợ suất của lời mời treo). Suất vừa mua đã
  // bao gồm phần bù cho món nợ đó nên phải trừ lại y như lúc đầu, bằng không đọc
  // lại sẽ tưởng dư và mời vào đúng chỗ của người đang chờ.
  const freeOf = (a: { total: number; assigned: number } | null): number | null =>
    a ? freeSeatsWithPendingDebt(a.total, a.assigned, pendingDebt) : null;

  if (!reloadedOnce && (freeOf(after) ?? -1) < need) {
    reloadedOnce = true;
    console.log(`${LOG} đọc lần 1 vẫn thiếu → tải lại trang rồi đọc lại`);
    // Ghi DẤU VẾT trước khi điều hướng: progress đi content → background →
    // backend nên nó nằm lại trong DB kể cả khi lần điều hướng ngay sau đây làm
    // đứt kênh và task chết. Không có dòng này thì "đã mua N suất, tiền đã trừ"
    // chỉ tồn tại trong `result` — mà `result` chỉ về khi task chạy tới cuối.
    await reportProgress(
      taskId,
      {
        phase: "seat-purchased",
        message:
          `Đã mua ${shortfall} suất (tiền đã trừ trên ChatGPT) — đang tải lại trang để đọc lại số suất...`,
      },
      true,
    );
    await softReloadMembersPage();
    recheck = await checkSeatAvailability();
    after =
      recheck.availability && recheck.modalClosed ? recheck.availability : null;
  }

  const purchasedData = {
    ...baseData,
    seat_shortfall: shortfall,
    seat_purchased: shortfall,
    seat_purchase: purchaseData,
    // Như `seat_total` ở trên: dashboard nhận tổng của DÒNG TỈ LỆ, không nhận số
    // đã bị hạ theo bộ đếm.
    seat_total_after: after ? recheck.ratioTotal ?? after.total : null,
    seat_assigned_after: after?.assigned ?? null,
    seat_free_after: freeOf(after),
    seat_free_after_raw: after?.free ?? null,
    seat_after_source: "recheck",
    seat_reloaded_once: reloadedOnce,
  };

  const afterFree = freeOf(after);
  if (afterFree === null || afterFree < need) {
    return {
      ok: false,
      skipped: false,
      error_code: "SEAT_PURCHASE_FAILED",
      error_message:
        `ĐÃ MUA ${shortfall} suất (đã trừ tiền: ${String(purchaseData.charge_amount_text ?? "?")}) ` +
        `nhưng đọc lại (đã tải lại trang) vẫn thấy còn ${afterFree ?? "?"} suất trống, cần ${need}. ` +
        "KHÔNG mời. Kiểm tra ChatGPT rồi chạy lại task — lần sau sẽ thấy suất đã mua và không mua nữa.",
      data: purchasedData,
    };
  }

  console.log(
    `${LOG} mua xong ${shortfall} suất → còn trống ${afterFree}/${after?.total ?? "?"}, mời tiếp`,
  );
  return { ok: true, skipped: false, data: purchasedData };
}
