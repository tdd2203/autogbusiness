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
  SEAT_SETTLE_AFTER_PURCHASE_MS,
} from "../purchase-seat/constants";
import { executePurchaseSeat } from "../purchase-seat/execute-purchase-seat";
import {
  describeSeatCards,
  readSeatCardsFromPage,
  type SeatCardsReading,
} from "../purchase-seat/read-seat-cards";
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

export type EnsureSeatsResult = {
  /** false = KHÔNG được mời tiếp. */
  ok: boolean;
  /**
   * ĐÃ MUA SUẤT (tiền đã trừ) nhưng trang còn bẩn ⇒ background phải HARD-RELOAD
   * /admin/members rồi gọi lại lệnh mời. Content KHÔNG tự điều hướng để dọn: một
   * cú `<a>.click()` có thể là điều hướng thật, trang giữ kênh bị đẩy vào
   * back/forward cache và kết quả không bao giờ về được background.
   *
   *   `invite_ready`  — tổng suất mới đã chốt bằng bộ đếm hộp mua → gọi lại với
   *                     `seatsReady: true` (bỏ hẳn bước suất), mời ngay.
   *   `recheck_seats` — bộ đếm KHÔNG chốt được tổng mới → gọi lại với
   *                     `seatsPurchasedAlready: N` để ĐỌC KIỂM, không mua nữa.
   */
  needsPageReload?: "invite_ready" | "recheck_seats";
  /** true = workspace UI cũ, đã bỏ qua kiểm tra. */
  skipped: boolean;
  error_code?:
    | "NOT_ENOUGH_SEATS"
    | "SEAT_CHECK_FAILED"
    | "SEAT_PURCHASE_FAILED"
    /** Đang chạy song song mà chỗ trống hết chắc chắn → cần khoá độc quyền. */
    | "SEAT_LOCK_REQUIRED";
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
 * ⚠️ KHÔNG có hàm "tự tải lại trang" ở đây nữa (26/8/2026).
 *
 * CA THẬT 26/8/2026 — ba lệnh mời phải mua suất (fdeeadc5 11:25, cd03d5ff 11:50,
 * 3bc11c7b 12:10) đều chết im: tiến độ dừng ở `seat-purchased`, TIỀN ĐÃ TRỪ, rồi
 * không một request nào báo kết thúc cho tới khi backend dọn ở mốc 8′ — trong khi
 * lời mời ĐÃ đi thật (mẻ đồng bộ ngay sau đó thấy đủ email trong tab "Lời mời đang
 * chờ"). Đáng chú ý: `CONTENT_TIMEOUT` 450s của chính extension cũng KHÔNG nổ.
 *
 * Nguyên nhân: cả lệnh mời chạy trong MỘT lượt gọi content dài 4–5 phút (riêng hộp
 * "Xác nhận mua" chờ 180–200s) → service worker MV3 bị Chrome khai tử giữa chừng,
 * mang theo cả lời hứa đang chờ trả lời lẫn đồng hồ 450s (dấu vết: một kết nối
 * `/queue/stream` MỚI xuất hiện giữa mốc tiến độ cuối và lúc backend dọn = SW vừa
 * khởi động lại). Lệnh mời KHÔNG mua suất xong dưới 2 phút nên không lệnh nào dính.
 *
 * Bản cũ (`softReloadMembersPage`) còn cộng thêm một rủi ro nữa: nó điều hướng SPA
 * billing → members ngay trong content script, mà `navigateTo` có nhánh dự phòng
 * click `<a>` — trên ChatGPT cú click đó có thể là ĐIỀU HƯỚNG THẬT, trang đang giữ
 * kênh bị đẩy vào back/forward cache (đúng lớp tai nạn 31/7 đã hoàn 340k oan).
 *
 * Nay: trả `needsPageReload` lên `execute-invite.ts` → `awaiting_seat_reload` →
 * BACKGROUND hard-reload tab rồi gọi lại lệnh mời trong LƯỢT MỚI (đúng cơ chế đã
 * dùng cho toggle "mời ngoài tên miền" và vòng F5 verify). Hai lượt ngắn thay cho
 * một lượt dài: không lượt nào chạm ngưỡng tuổi thọ của service worker, và cú
 * reload do background làm nên kênh do chính nó dựng lại.
 */


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
  cards?: SeatCardsReading | null,
): {
  enough: boolean;
  total: number | null;
  occupied: number | null;
  free: number | null;
  /** Tổng suất lấy từ đâu — quyết định có ghi số này về DB hay không. */
  source: "page_cards" | "hint" | null;
} {
  // VẪN đòi hint như trước, KỂ CẢ khi trang in sẵn số suất: `hint.occupied` là
  // nguồn DUY NHẤT ở đường tắt này biết tới LỜI MỜI ĐANG CHỜ (thẻ trên trang chỉ
  // đếm người đã tham gia). Không có hint thì đi đường đầy đủ — ở đó có bước đếm
  // lời mời treo tận nơi.
  const hintTotal = hint?.total ?? null;
  if (hintTotal === null)
    return { enough: false, total: null, occupied: null, free: null, source: null };
  // Tổng ưu tiên số VỪA ĐỌC trên trang: `hint.total` là số DB, có thể cũ.
  const total = cards?.total ?? hintTotal;
  const source = cards ? ("page_cards" as const) : ("hint" as const);
  const occupied = Math.max(hint?.occupied ?? 0, pageMembers ?? 0, cards?.assigned ?? 0);
  if (occupied <= 0)
    return { enough: false, total, occupied: null, free: null, source };
  const free = total - occupied;
  return { enough: free >= need + SEAT_HINT_SPARE, total, occupied, free, source };
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
 * Tổng suất mới ĐỌC THẲNG trên trang sau khi mua, hoặc null khi trang chưa xác
 * nhận được.
 *
 * Từ 26/8/2026 luồng mua tự chờ thẻ "Suất Tiêu chuẩn" trên tab "Người dùng"
 * nhích lên đúng số vừa mua rồi mới trả kết quả (`seat_page_verified`). Số đó là
 * ChatGPT tự khai NGAY TRÊN TRANG — chắc hơn bộ đếm của hộp mua, và có cả ở
 * những ca bộ đếm không suy ra được (hộp chưa đóng, bộ đếm khởi điểm lệch).
 *
 * Vẫn đòi tổng mới ĐỦ LỚN (`≥ tổng cũ + số thiếu`): thấp hơn nghĩa là hai bên
 * đang nói hai chuyện khác nhau → quay về đường đọc kiểm chứ không mời liều vào
 * hộp mua-kèm-mời. Xuất khẩu để test được — đây là đường dính tới tiền.
 */
export function totalFromPageCardsAfterPurchase(
  purchaseData: Record<string, unknown>,
  totalBefore: number,
  shortfall: number,
): number | null {
  if (purchaseData.seat_page_verified !== true) return null;
  const after = asInt(purchaseData.seat_page_total_after);
  if (after === null || after < totalBefore + shortfall) return null;
  return after;
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
  opts: { noPurchase?: boolean; alreadyPurchased?: number } = {},
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
  // UI mới (26/8/2026) in sẵn hàng thẻ suất ngay trên tab "Người dùng" — số THẬT
  // của ChatGPT, đọc không tốn cú bấm nào. Có nó thì đường tắt không còn phải
  // tin vào `seat_total` của DB (vốn chỉ tươi sau mỗi lần đọc tận nơi).
  const pageCards = readSeatCardsFromPage();
  const room = headroomWithoutModal(need, seatHint, pageMembers, pageCards);
  if (room.enough) {
    const fromPage = room.source === "page_cards" && pageCards !== null;
    console.log(
      `${LOG} bỏ qua hộp 'Quản lý suất': tổng ${room.total} suất ` +
        `(${fromPage ? `thẻ trên trang — ${describeSeatCards(pageCards!)}` : "số dashboard"}), ` +
        `đang chiếm ${room.occupied} (trang ${pageMembers ?? "?"}, dashboard ` +
        `${seatHint?.occupied ?? "?"}) → trống ${room.free}, cần ${need}. Mời thẳng.`,
    );
    return {
      ok: true,
      skipped: false,
      data: {
        // Đọc được thẻ trên trang thì đây là số ĐỌC TẬN NƠI, không phải hint tự
        // xác nhận chính nó → backend được phép ghi về workspace (xem
        // `_absorb_seat_reading`, nó bỏ qua đúng scope "skipped_headroom").
        seat_check: fromPage ? "ok_page_cards" : "skipped_headroom",
        seat_total: room.total,
        // Khi số từ thẻ: `assigned` là con số ChatGPT tự khai. Khi từ hint: giữ
        // nguyên hành vi cũ (số đang chiếm suy ra được).
        seat_assigned: fromPage ? pageCards!.assigned : room.occupied,
        seat_free: room.free,
        seat_needed: need,
        seat_occupied_used: room.occupied,
        seat_page_members: pageMembers,
        seat_hint_occupied: seatHint?.occupied ?? null,
        seat_source: room.source,
        seat_cards: pageCards?.cards ?? null,
        // Lượt ĐỌC KIỂM sau khi background tải lại trang: suất đã mua ở lượt
        // trước, phải ghi nhận để dashboard không tưởng lệnh này mua 0 suất.
        seat_purchased: opts.alreadyPurchased ?? 0,
      },
    };
  }

  // ── ĐANG CHẠY SONG SONG mà đường tắt không chốt được → TRẢ KHOÁ, đừng đếm ──
  // Tới đây nghĩa là số của dashboard KHÔNG đủ để khẳng định còn dư chỗ. Với lệnh
  // chạy một mình thì đây là lúc mở hộp đếm tận nơi rồi mua bù. Nhưng lệnh này
  // đang chạy SONG SONG với một lệnh khác (`noPurchase`): số đếm được sẽ CŨ ngay
  // khi lệnh kia mời xong, và hai luồng cùng mua theo cùng một con số là mua đúp
  // bằng tiền thật.
  //
  // Dừng ở ĐÂY là chỗ dừng rẻ nhất và sạch nhất: chưa mở hộp nào, chưa bật toggle
  // nào, chưa bấm gì. Background nâng khoá suất lên độc quyền rồi gọi lại y hệt.
  if (opts.noPurchase) {
    console.log(
      `${LOG} đang chạy song song mà chỗ trống không chắc (trống ${room.free ?? "?"}, ` +
        `cần ${need}) → trả về SEAT_LOCK_REQUIRED để chạy lại một mình`,
    );
    return {
      ok: false,
      skipped: false,
      error_code: "SEAT_LOCK_REQUIRED",
      error_message:
        "Đang chạy song song với lệnh khác mà số suất trống không còn chắc chắn — " +
        "chờ khoá suất rồi chạy lại một mình.",
      data: {
        seat_check: "needs_exclusive_lock",
        seat_needed: need,
        seat_free_hint: room.free,
        seat_total_hint: room.total,
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
    // Số đọc từ hàng thẻ trên trang hay từ hộp "Quản lý suất".
    seat_source: check.source,
    seat_cards: check.cards,
    seat_uncertain_reason: check.uncertainReason,
  };
  console.log(
    `${LOG} cần ${need} suất, đang trống ${freeReal}/${before.total} ` +
      `(đã gán ${before.assigned} + ${pendingDebt} lời mời đang chờ, nguồn ` +
      `${scannedPending.authoritative ? "tab Lời mời của ChatGPT" : `dashboard — ${scannedPending.reason}`})` +
      (check.uncertain ? ` — CẤM mua: ${check.uncertainReason ?? "số chưa chắc"}` : ""),
  );

  // ── Đủ suất → mời luôn ──────────────────────────────────────────────────
  // Kể cả khi bộ đếm lệch dòng tỉ lệ: `before.total` là tổng của DÒNG TỈ LỆ, tức
  // số suất workspace ĐANG giữ — đúng số cho câu hỏi "mời thêm được không". Mời
  // không tiêu tiền nên số chưa chắc cũng không hại, và nếu nó sai thật thì chặn
  // cuối ở `execute-invite-inner` (nhãn nút "Mua suất người dùng và gửi lời mời")
  // vẫn dừng trước khi bấm. Chỉ cấm MUA theo nó (nhánh dưới).
  if (freeReal >= need) {
    return {
      ok: true,
      skipped: false,
      data: { ...baseData, seat_purchased: opts.alreadyPurchased ?? 0 },
    };
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
    // CHỈ gợi ý con số khi tổng đọc từ hộp: khi số đến từ hàng thẻ và workspace
    // có NHIỀU loại suất, bộ đếm trong hộp lái đúng MỘT loại — bảo admin đặt nó
    // lên "tổng gộp + thiếu" là chỉ cho họ mua sai số.
    const target =
      check.source === "modal" && check.ratioTotal !== null
        ? check.ratioTotal + shortfall
        : null;
    return {
      ok: false,
      skipped: false,
      error_code: "SEAT_CHECK_FAILED",
      error_message:
        `Thiếu ${shortfall} suất (cần ${need}) nhưng số suất chưa đủ chắc để mua theo: ` +
        `${check.uncertainReason ?? "nguồn số không thống nhất"}. ` +
        (target !== null
          ? `Mở "Quản lý số suất" trên ChatGPT, đặt bộ đếm lên ${target} rồi chạy lại task.`
          : `Mở "Quản lý số suất" trên ChatGPT, tự mua thêm ${shortfall} suất ĐÚNG LOẠI cần dùng, sau đó chạy lại task.`) +
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

  // ── ĐÃ MUA Ở LƯỢT TRƯỚC → CẤM MUA LẦN HAI ───────────────────────────────
  // Tới đây trong lượt ĐỌC KIỂM (`alreadyPurchased`) nghĩa là: lượt trước đã trừ
  // tiền mua suất, background đã tải lại trang cho sạch, mà đọc lại VẪN thiếu.
  // Mua tiếp là mua đúp bằng tiền thật cho cùng một lệnh mời. Dừng, báo rõ số để
  // admin mở ChatGPT xem — task hỏng ở đây thì chưa ai được mời, backend hoàn phí.
  if (opts.alreadyPurchased !== undefined) {
    return {
      ok: false,
      skipped: false,
      error_code: "SEAT_PURCHASE_FAILED",
      error_message:
        `ĐÃ MUA ${opts.alreadyPurchased} suất ở lượt trước (tiền đã trừ trên ChatGPT) ` +
        `nhưng sau khi tải lại trang vẫn chỉ thấy ${freeReal} suất trống, cần ${need} ` +
        `(còn thiếu ${shortfall}). KHÔNG mua lần hai và KHÔNG mời. Kiểm tra ChatGPT rồi ` +
        "chạy lại task — lần sau sẽ thấy suất đã mua và không mua nữa.",
      data: {
        ...baseData,
        seat_shortfall: shortfall,
        seat_purchased: opts.alreadyPurchased,
        seat_after_source: "recheck_after_reload",
      },
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
  // Nguồn CHẮC NHẤT: con số suất ChatGPT tự in trên trang sau khi mua (luồng mua
  // đã chờ nó nhích lên rồi mới trả về). Có nó thì khỏi cần bộ đếm, và cũng khỏi
  // mở lại hộp "Quản lý suất" — kể cả khi hộp thanh toán chưa đóng sạch.
  const pageTotalAfter = totalFromPageCardsAfterPurchase(
    purchaseData,
    before.total,
    shortfall,
  );
  const derived =
    pageTotalAfter !== null ||
    canDeriveTotalAfterPurchase(purchaseData, before.total, shortfall);

  if (derived) {
    // `shortfall` được tính sao cho `tổng + shortfall = đã gán + nợ suất + need`
    // (xem `seatsToBuy`), nên chỗ trống mới ĐÚNG BẰNG `need` — kể cả ca workspace
    // đang âm chỗ. Khỏi phải đọc lại để so.
    //
    // Trang xác nhận thì lấy luôn số của trang (nó gồm cả phần admin khác vừa
    // đổi); không thì suy từ bộ đếm như trước.
    const totalAfter = pageTotalAfter ?? before.total + shortfall;

    // Hộp mua đã đóng nhưng LỚP PHỦ còn nằm lại → mọi cú bấm của bước mời phía
    // sau rơi vào lớp phủ chứ không tới nút thật. Tải lại trang cho sạch rồi mới
    // mời (số suất thì đã biết chắc, không cần đọc lại).
    const purchasedOkData: Record<string, unknown> = {
      ...baseData,
      seat_shortfall: shortfall,
      seat_purchased: shortfall,
      seat_purchase: purchaseData,
      seat_total_after: totalAfter,
      seat_assigned_after: before.assigned,
      seat_free_after: totalAfter - before.assigned,
      seat_after_source:
        pageTotalAfter !== null ? "page_cards_after_purchase" : "purchase_counter",
      // Trang sẽ được BACKGROUND tải lại (không phải content tự điều hướng).
      seat_reloaded_once: purchaseData.charge_overlay_cleared === false,
    };

    if (purchaseData.charge_overlay_cleared === false) {
      console.warn(
        `${LOG} mua xong nhưng lớp phủ của hộp còn nằm lại → nhờ background tải lại trang rồi mời tiếp`,
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
      return {
        ok: true,
        skipped: false,
        needsPageReload: "invite_ready",
        data: purchasedOkData,
      };
    }

    console.log(
      `${LOG} mua xong ${shortfall} suất (${pageTotalAfter !== null ? "thẻ trên trang" : "bộ đếm"} ` +
        `${before.total} → ${totalAfter}), đã gán ${before.assigned} → đủ ${need} suất trống. ` +
        "Mời tiếp, KHÔNG mở lại hộp suất.",
    );
    return { ok: true, skipped: false, data: purchasedOkData };
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
  // Trang còn bẩn (hộp chưa đóng hẳn / lớp phủ còn nằm lại) → đọc kiểm ở đây
  // chắc chắn trượt. Nhờ BACKGROUND tải lại rồi gọi lại lệnh mời ở chế độ ĐỌC
  // KIỂM (`seatsPurchasedAlready`) — content tự điều hướng là tự cắt kênh về
  // background trong đúng lúc tiền vừa bị trừ.
  if (
    purchaseData.charge_modal_dismissed !== true ||
    purchaseData.charge_overlay_cleared === false
  ) {
    console.warn(
      `${LOG} hộp mua chưa đóng sạch → nhờ background tải lại trang rồi đọc kiểm`,
    );
    await reportProgress(
      taskId,
      {
        phase: "seat-purchased",
        message:
          `Đã bấm mua ${shortfall} suất nhưng hộp chưa đóng sạch — đang tải lại trang để đọc lại số suất...`,
      },
      true,
    );
    return {
      ok: true,
      skipped: false,
      needsPageReload: "recheck_seats",
      data: {
        ...baseData,
        seat_shortfall: shortfall,
        seat_purchased: shortfall,
        seat_purchase: purchaseData,
        seat_after_source: "pending_reload_recheck",
      },
    };
  }

  const recheck = await checkSeatAvailability();
  const after =
    recheck.availability && recheck.modalClosed ? recheck.availability : null;

  // Vẫn thiếu ở lần đọc đầu → nhiều khả năng trang còn giữ số cũ trong bộ nhớ
  // của React. TẢI LẠI TRANG MỘT LẦN rồi đọc lại. Đủ thì mời tiếp như thường.
  // Chỗ trống THẬT = tổng − (đã gán + nợ suất của lời mời treo). Suất vừa mua đã
  // bao gồm phần bù cho món nợ đó nên phải trừ lại y như lúc đầu, bằng không đọc
  // lại sẽ tưởng dư và mời vào đúng chỗ của người đang chờ.
  const freeOf = (a: { total: number; assigned: number } | null): number | null =>
    a ? freeSeatsWithPendingDebt(a.total, a.assigned, pendingDebt) : null;

  if ((freeOf(after) ?? -1) < need) {
    console.log(`${LOG} đọc lần 1 vẫn thiếu → nhờ background tải lại trang rồi đọc lại`);
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
    return {
      ok: true,
      skipped: false,
      needsPageReload: "recheck_seats",
      data: {
        ...baseData,
        seat_shortfall: shortfall,
        seat_purchased: shortfall,
        seat_purchase: purchaseData,
        seat_total_after: after ? recheck.ratioTotal ?? after.total : null,
        seat_assigned_after: after?.assigned ?? null,
        seat_free_after: freeOf(after),
        seat_after_source: "pending_reload_recheck",
      },
    };
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
    // Tải lại trang giờ do BACKGROUND làm (nhánh `needsPageReload`), nên tới được
    // đây nghĩa là lượt này đọc thẳng, không phải tải lại.
    seat_reloaded_once: false,
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
