/**
 * Action PURCHASE_SEAT: tăng số suất workspace ChatGPT Business +`quantity`.
 *
 * Flow UI 2026-08-22 (user chụp màn hình, locale vi) — KHÔNG còn Stripe:
 *   1. /admin/members → bấm "Quản lý số suất" (nút cạnh "+ Mời thành viên").
 *   2. Hộp "Quản lý suất": bộ đếm `[−] 53 [+]` → BÁM THEO CON SỐ đưa bộ đếm về
 *      `hiện tại + quantity`: thiếu bấm "+", lỡ vượt bấm "−" kéo xuống.
 *   3. Hộp tự in thẻ "Thêm N suất Tiêu chuẩn" → N phải bằng `quantity`. LỆCH thì
 *      ĐÓNG hộp, MỞ LẠI, bấm lại cho chuẩn (chưa hề tạo giao dịch nào).
 *   4. "Tiếp tục" → hộp "Xem lại giao dịch mua" → chốt SỐ SUẤT →
 *      "Xác nhận mua" ⚠️ TRỪ TIỀN THẬT NGAY qua thẻ đã lưu.
 *
 * Khác bản trước (UI cũ): đường cũ đi /admin/billing?tab=plan → "Quản lý giấy
 * phép" → "Thêm người dùng" → hoá đơn "Đến hạn" → mở invoice.stripe.com → chain
 * qua checkout.link.com mới thật sự trừ tiền. UI mới trừ tiền THẲNG trong hộp
 * nên toàn bộ chặng Stripe/Link bị bỏ khỏi luồng này. Chặng đó CHỈ còn dùng cho
 * `skipToPayment` — trả nốt hoá đơn "Đến hạn" tồn đọng từ các lần mua UI cũ.
 *
 * Chốt an toàn — TẤT CẢ đều dựa trên SỐ SUẤT, không dựa trên tiền:
 *   - hard cap `MAX_QUANTITY=20`/task (mirror backend);
 *   - bộ đếm phải về ĐÚNG `hiện tại + quantity` trước khi bấm "Tiếp tục";
 *   - thẻ tóm tắt trong hộp "Quản lý suất" phải nói đúng `quantity`;
 *   - hộp thanh toán phải nói đúng `quantity`;
 *   - số ghế trước/sau in trong hộp thanh toán phải chênh đúng `quantity`;
 *   - không đọc được số suất từ nguồn nào → KHÔNG bấm.
 * Số tiền vẫn được đọc để GHI AUDIT nhưng KHÔNG dùng làm chốt chặn — user đối
 * soát chi phí thật theo hoá đơn ngân hàng về sau.
 */

import type { ExecuteActionResponse } from "../../../shared/messages";
import { humanClick, sleep, waitFor } from "../../human";
import { findControlByKey } from "../../i18n-ui";
import { reportProgress } from "../../progress";
import { TEXT_FALLBACKS } from "../../selectors";
import {
  CHARGE_MODAL_TIMEOUT_MS,
  CONFIRM_ENABLE_TIMEOUT_MS,
  CONTINUE_ENABLE_TIMEOUT_MS,
  MANAGE_SEATS_BUTTON_POLL_MS,
  MANAGE_SEATS_BUTTON_WAIT_MS,
  MAX_QUANTITY,
  MEMBERS_PATH,
  MEMBERS_SEARCH,
  MODAL_OPEN_TIMEOUT_MS,
  POST_NAV_RENDER_MS,
  POST_PURCHASE_SETTLE_MS,
  PRE_CONFIRM_PAUSE_MS,
  PRE_CONTINUE_PAUSE_MS,
  REVIEW_MONEY_GRACE_MS,
  REVIEW_READY_TIMEOUT_MS,
  SEAT_CARDS_VERIFY_POLL_MS,
  SEAT_CARDS_VERIFY_SHORT_MS,
  SEAT_CARDS_VERIFY_TIMEOUT_MS,
  SEAT_MODAL_SETTLE_MS,
  SEAT_PREVIEW_TIMEOUT_MS,
  SEAT_RETRY_GAP_MS,
  SEAT_SETUP_MAX_ATTEMPTS,
  SEAT_STEP_GAP_MS,
  SEAT_STEP_TIMEOUT_MS,
  seatAdjustMaxSteps,
} from "./constants";
import { executePaymentChainOnly } from "./execute-payment-chain-only";
import { closeSeatModal } from "./modal1/close-seat-modal";
import { findContinueButton } from "./modal1/find-continue-button";
import {
  describeSeatModal,
  findSeatStepper,
  type SeatStepper,
} from "./modal1/find-seat-stepper";
import {
  detectMixedSeatTypes,
  extractAdditionalSeatCountFromModal,
} from "./modal2/extract-seat-count";
import { detectEffectiveLater } from "./modal2/detect-effective-later";
import { findConfirmPurchaseButton } from "./modal2/find-confirm-purchase-button";
import { findPurchaseReviewModal } from "./modal2/find-review-modal";
import { readPurchaseReview, type PurchaseReview } from "./modal2/read-review";
import { waitForChargeModalDismiss } from "./modal2/wait-dismiss";
import {
  readSeatCardsFromPage,
  readSeatTotalsFromPage,
  seatIncrease,
  seatTotalsOf,
  type SeatCardsReading,
  type SeatTotals,
} from "./read-seat-cards";

const LOG = "[autogpt-purchase-seat]";


const DIALOG_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-state="open"]';

function isDisabled(el: HTMLElement): boolean {
  return (
    el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true"
  );
}

function fail(
  error_code: "UI_ELEMENT_NOT_FOUND" | "VERIFY_FAILED",
  error_message: string,
): ExecuteActionResponse {
  return { ok: false, error_code, error_message };
}

/** Gói số liệu tiền vào payload result để dashboard ghi audit. */
function auditFields(review: PurchaseReview): Record<string, unknown> {
  const { monthly } = review;
  return {
    seat_count_in_modal: review.seatCount,
    charge_amount_text: review.todayText,
    charge_amount_vnd: review.todayVnd,
    proration_subtotal_text: review.prorationText,
    proration_subtotal_vnd: review.prorationVnd,
    sales_tax_text: review.taxText,
    sales_tax_vnd: review.taxVnd,
    sales_tax_percent: review.taxPercent,
    // Hậu tố _pretax là CỐ Ý: hộp ghi rõ "13.806.500 đ + thuế" — mấy số hằng
    // tháng này CHƯA gồm thuế. Bỏ hậu tố là mời người đọc sau tưởng đây là chi
    // phí cuối cùng.
    monthly_bill_current_text: monthly.currentText,
    monthly_bill_current_vnd_pretax: monthly.currentVnd,
    monthly_bill_new_text: monthly.newText,
    monthly_bill_new_vnd_pretax: monthly.newVnd,
    monthly_increase_vnd_pretax: monthly.deltaVnd,
    seats_before: monthly.currentSeats,
    seats_after: monthly.newSeats,
    amounts_basis:
      "Số do ChatGPT hiển thị. Hoá đơn hằng tháng là TRƯỚC thuế ('+ thuế'). " +
      "Tổng phải trả hôm nay đã gồm thuế bán hàng nhưng CHƯA gồm phí ngân hàng/" +
      "phí quy đổi ngoại tệ. Chi phí thật chốt theo hoá đơn ngân hàng.",
  };
}

/** Kết quả lượt xác nhận "số suất trên trang đã nhích lên chưa". */
type SeatVerifyOutcome = {
  /** Trang đã in số suất mới, tăng ĐỦ `qty` so với trước khi mua. */
  verified: boolean;
  before: SeatTotals | null;
  after: SeatTotals | null;
  /** Số suất tăng thêm đọc được (có thể âm/0 khi trang chưa cập nhật). */
  delta: number | null;
  basis: "standard" | "total" | null;
  waitedMs: number;
  /** Vì sao KHÔNG xác nhận được — null khi verified. */
  reason: string | null;
};

/**
 * Chốt "đã mua xong" bằng con số suất IN SẴN trên trang Thành viên.
 *
 * Quy trình user chốt 2026-08-26: tab "Người dùng" luôn hiện thẻ "Suất Tiêu
 * chuẩn · 66", mà mọi thành viên đều dùng suất Tiêu chuẩn — số đó nhích lên so
 * với trước khi bấm mua tức là ChatGPT đã ghi nhận giao dịch. Không phải mở lại
 * hộp "Quản lý suất" để đọc kiểm nữa: mỗi lượt mở hộp vừa chậm vừa thêm một cơ
 * hội hộp kẹt, mà lớp phủ của hộp kẹt chặn luôn bước mời phía sau.
 *
 * ⚠️ KHÔNG dùng làm chốt chặn tiền: tới đây tiền ĐÃ trừ rồi. Đọc không ra chỉ
 * làm mất đường xác nhận rẻ, caller quay về đường cũ (tải lại trang / đọc kiểm).
 */
async function waitForSeatCardsIncrease(
  before: SeatTotals | null,
  qty: number,
  onTick?: (elapsed: number) => Promise<void>,
  budgetMs: number = SEAT_CARDS_VERIFY_TIMEOUT_MS,
): Promise<SeatVerifyOutcome> {
  const started = Date.now();
  if (!before) {
    return {
      verified: false,
      before: null,
      after: readSeatTotalsFromPage(),
      delta: null,
      basis: null,
      waitedMs: 0,
      reason: "không đọc được số suất trên trang TRƯỚC khi mua nên không có gì để so",
    };
  }

  let after: SeatTotals | null = null;
  let last: { delta: number; basis: "standard" | "total" } | null = null;
  let ticked = 0;
  while (Date.now() - started < budgetMs) {
    // Hộp thanh toán còn mở thì `readSeatTotalsFromPage` trả null (nó từ chối
    // đọc khi có hộp in lại chính mấy con số này) — cứ dò tiếp, hộp đóng xong là
    // đọc được.
    const now = readSeatTotalsFromPage();
    if (now) {
      after = now;
      last = seatIncrease(before, now);
      if (last.delta >= qty) {
        return {
          verified: true,
          before,
          after,
          delta: last.delta,
          basis: last.basis,
          waitedMs: Date.now() - started,
          reason: null,
        };
      }
    }
    const elapsed = Date.now() - started;
    if (onTick && elapsed - ticked >= 3_000) {
      ticked = elapsed;
      await onTick(elapsed);
    }
    await sleep(SEAT_CARDS_VERIFY_POLL_MS);
  }

  return {
    verified: false,
    before,
    after,
    delta: last?.delta ?? null,
    basis: last?.basis ?? null,
    waitedMs: Date.now() - started,
    reason: after
      ? `số suất trên trang mới nhích ${last?.delta ?? 0}/${qty} sau ` +
        `${Math.round(budgetMs / 1000)}s`
      : `không đọc được số suất trên trang sau ${Math.round(budgetMs / 1000)}s`,
  };
}

/** Kết quả một lượt "mở hộp → bấm + → Tiếp tục". */
type SetupOutcome =
  | { kind: "continued"; initialSeat: number; finalSeat: number }
  | { kind: "retry"; reason: string }
  | { kind: "fail"; response: ExecuteActionResponse };

/**
 * Đọc số suất in sẵn trên trang rồi trả về NGAY — không bấm gì hết.
 *
 * Dùng cho lượt gọi SAU KHI background hard-reload tab: cú mua trước đó kết thúc
 * trong mập mờ (ChatGPT in băng-rôn "Đã xảy ra sự cố" rồi treo hộp), và con số
 * trên trang vừa tải lại là câu trả lời rẻ nhất cho "tiền đã trừ hay chưa".
 * Trang mới tinh nên không có hộp nào che, đọc là ra.
 */
async function readSeatsOnlyResponse(taskId: string): Promise<ExecuteActionResponse> {
  await reportProgress(
    taskId,
    { phase: "verify_seats", message: "Đọc lại số suất trên trang vừa tải lại..." },
    true,
  );

  // Trang vừa tải lại: hàng thẻ suất điền số sau vài nhịp render, nên chờ hẳn
  // như vòng xác nhận sau khi mua (15s) chứ không phải nhịp xem-trước 3s.
  let cards: SeatCardsReading | null = null;
  try {
    cards = await waitFor(
      () => readSeatCardsFromPage(),
      SEAT_CARDS_VERIFY_TIMEOUT_MS,
      SEAT_CARDS_VERIFY_POLL_MS,
    );
  } catch {
    cards = readSeatCardsFromPage();
  }
  const totals: SeatTotals | null = cards ? seatTotalsOf(cards) : null;

  if (!totals) {
    return fail(
      "UI_ELEMENT_NOT_FOUND",
      "Đã tải lại /admin/members nhưng KHÔNG đọc được thẻ số suất trên trang " +
        `(url=${location.href}). Admin mở ChatGPT xem số suất thật rồi quyết.`,
    );
  }

  console.log(
    `${LOG} đọc lại sau tải trang: tổng=${totals.total}, Tiêu chuẩn=${totals.standard ?? "?"}`,
  );
  return {
    ok: true,
    data: {
      seat_read_only: true,
      seat_page_total: totals.total,
      seat_page_standard: totals.standard,
      // Số suất ĐANG GÁN — background gắp sang `seat_assigned_after` để dashboard
      // khỏi phải chờ lần đồng bộ sau mới biết.
      seat_page_assigned: cards?.assigned ?? null,
    },
  };
}

export async function executePurchaseSeat(
  taskId: string,
  quantity: number,
  skipToPayment = false,
  readSeatsOnly = false,
): Promise<ExecuteActionResponse> {
  if (!location.pathname.startsWith("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}). Mở chatgpt.com/admin/members trước.`,
    };
  }

  if (readSeatsOnly) return readSeatsOnlyResponse(taskId);

  const qty = Math.max(1, Math.min(MAX_QUANTITY, Math.floor(quantity || 1)));
  if (qty !== quantity) {
    console.warn(`${LOG} quantity ${quantity} clamp về ${qty} (cap=${MAX_QUANTITY})`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // skipToPayment: hoá đơn "Đến hạn" đã tồn tại từ lần mua theo UI CŨ → bỏ qua
  // hộp, đi thẳng tab Hoá đơn + chain Stripe/Link. UI mới không tạo hoá đơn chờ
  // nữa nên nhánh này chỉ để dọn nốt phần tồn đọng.
  // ────────────────────────────────────────────────────────────────────────
  if (skipToPayment) {
    return executePaymentChainOnly(taskId, qty);
  }

  const TOTAL_STEPS = qty + 4;
  const progress = (phase: string, message: string, current: number) =>
    reportProgress(taskId, { phase, message, current, total: TOTAL_STEPS }, true);

  // ── Bước 1: về /admin/members ────────────────────────────────────────────
  await progress("navigate", `Đang mở /admin/members để mua thêm ${qty} suất...`, 0);

  // Tab có thể còn đọng ?tab=invites / ?tab=requests từ action trước → nút
  // "Quản lý số suất" nằm trong tab "Người dùng". Navigate về URL sạch cho chắc.
  const onMembersList =
    location.pathname.startsWith(MEMBERS_PATH) &&
    !/[?&]tab=(invites|requests)/.test(location.search);
  if (!onMembersList) {
    history.pushState({}, "", MEMBERS_PATH + MEMBERS_SEARCH);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(POST_NAV_RENDER_MS);
  } else {
    await sleep(800);
  }

  // Chụp số suất IN SẴN trên trang TRƯỚC khi đụng vào hộp. Sau khi trừ tiền,
  // chính con số này nhích lên là bằng chứng "đã mua xong" — khỏi mở lại hộp
  // "Quản lý suất" để đọc kiểm (user 2026-08-26). Đọc không ra thì thôi, luồng
  // mua không phụ thuộc vào nó.
  const cardsBefore = readSeatTotalsFromPage();
  if (cardsBefore) {
    console.log(
      `${LOG} số suất trên trang trước khi mua: Tiêu chuẩn ` +
        `${cardsBefore.standard ?? "?"}, tổng ${cardsBefore.total}`,
    );
  } else {
    console.log(
      `${LOG} chưa đọc được hàng thẻ suất trên trang — sẽ không có đường xác nhận nhanh sau khi mua`,
    );
  }

  /**
   * Một lượt: mở hộp "Quản lý suất" → bấm "+" qty lần → đối chiếu thẻ tóm tắt →
   * bấm "Tiếp tục".
   *
   * Trả "retry" khi bộ đếm hoặc thẻ tóm tắt không khớp — dấu hiệu bộ đếm KHÔNG
   * ở trạng thái ta tưởng. Làm lại từ đầu an toàn tuyệt đối về tiền: chưa bấm
   * "Tiếp tục" thì chưa có giao dịch nào tồn tại, và hộp mở mới thì bộ đếm trở
   * về đúng số suất thật của workspace.
   */
  const runSetupAttempt = async (attempt: number): Promise<SetupOutcome> => {
    // ── Bước 2: bấm "Quản lý số suất" ─────────────────────────────────────
    await progress(
      "open_modal",
      attempt === 1
        ? "Đang bấm 'Quản lý số suất'..."
        : `Mở lại 'Quản lý số suất' để bấm lại cho chuẩn (lượt ${attempt})...`,
      1,
    );
    // DÒ LẠI tới `MANAGE_SEATS_BUTTON_WAIT_MS` chứ KHÔNG hỏi một phát rồi bỏ.
    //
    // Ca thật 28/8/2026 15:39 (task tự sinh `auto_pending_seat`, 3 suất): chết ngay
    // ở đây với "Không tìm thấy nút 'Quản lý số suất'" — chưa kịp mở hộp, chưa đụng
    // tới bộ đếm. Nút đó render trễ là chuyện đã biết: `check-seat-availability.ts`
    // dò tới 6s vì đúng ca 22/8/2026 hỏi sớm quá rồi tưởng workspace không có nút.
    // Luồng mua lại chỉ ngủ cứng `POST_NAV_RENDER_MS` rồi hỏi một lần — trang nạp
    // chậm hơn chừng đó là trượt hẳn, dù nút vẫn hiện ra ngay sau đó.
    //
    // Nút có sẵn (đại đa số) → `waitFor` trả về ngay vòng đầu, không tốn thêm giây nào.
    let manageBtn: HTMLElement;
    try {
      manageBtn = await waitFor(
        () =>
          findControlByKey(
            "billing_manage_licenses",
            TEXT_FALLBACKS.billingManageLicenses,
            { page: "/admin/members" },
          ),
        MANAGE_SEATS_BUTTON_WAIT_MS,
        MANAGE_SEATS_BUTTON_POLL_MS,
      );
    } catch {
      return {
        kind: "fail",
        response: fail(
          "UI_ELEMENT_NOT_FOUND",
          "Không tìm thấy nút 'Quản lý số suất' trên /admin/members (nút này nằm cạnh " +
            `'+ Mời thành viên') sau ${MANAGE_SEATS_BUTTON_WAIT_MS / 1000}s dò lại. ` +
            "Có thể ChatGPT đổi nhãn, hoặc trang chưa render xong. " +
            `URL hiện tại: ${location.href}`,
        ),
      };
    }
    await humanClick(manageBtn);

    // ── Bước 3: đợi bộ đếm [−] n [+] ──────────────────────────────────────
    let stepper: SeatStepper;
    try {
      stepper = await waitFor(() => findSeatStepper(), MODAL_OPEN_TIMEOUT_MS, 300);
    } catch {
      return {
        kind: "fail",
        response: fail(
          "UI_ELEMENT_NOT_FOUND",
          `Đã bấm 'Quản lý số suất' nhưng không thấy bộ đếm số suất của hàng ` +
            `"Tiêu chuẩn" sau ${MODAL_OPEN_TIMEOUT_MS / 1000}s. Hộp nay có MỘT bộ đếm cho ` +
            `MỖI loại suất (Tiêu chuẩn / Cao cấp) — không ghim chắc được hàng Tiêu chuẩn thì ` +
            `KHÔNG bấm, vì suất Cao cấp đắt hơn 12 lần. Có thể ChatGPT lại đổi UI hộp 'Quản lý suất'. ` +
            `Hộp đang mở: ${describeSeatModal()}`,
        ),
      };
    }

    // Hộp vừa mở: cho nó đứng yên một nhịp rồi mới đọc/bấm. Không vội — số
    // trong bộ đếm điền vào sau một lượt re-render, đọc sớm là đọc số cũ.
    await sleep(SEAT_MODAL_SETTLE_MS);

    const initialSeat = stepper.read();
    if (initialSeat === null || initialSeat < 1) {
      return {
        kind: "fail",
        response: fail(
          "UI_ELEMENT_NOT_FOUND",
          `Bộ đếm số suất đọc ra giá trị không hợp lệ (source=${stepper.source}).`,
        ),
      };
    }
    const targetSeat = initialSeat + qty;
    console.log(
      `${LOG} lượt ${attempt}: initial=${initialSeat}, target=${targetSeat} (+${qty}), ` +
        `stepper=${stepper.source}, hàng=${stepper.scope}`,
    );

    // ── Bước 4: đưa bộ đếm về đúng targetSeat ─────────────────────────────
    //
    // KHÔNG đếm "bấm đủ qty lần" mà BÁM THEO CON SỐ: thiếu thì bấm "+", lỡ vượt
    // thì bấm "−" kéo xuống, tới khi bộ đếm bằng đúng targetSeat. Sai thì tự sửa
    // ngay tại chỗ.
    //
    // Nhịp bấm CÓ NGHỈ (user 2026-08-24: "thao tác rất nhanh, cần làm chậm lại,
    // không cần vội"): số nhích lên rồi React vẫn còn re-render, bấm chồng lên
    // lúc đó dễ trúng node đã rời DOM → cú bấm rơi vào khoảng không, hoặc ChatGPT
    // nhận hai sự kiện cho một cú. Vài trăm ms mỗi suất đổi lấy một lượt bấm sạch
    // là quá rẻ so với việc phải mở lại hộp.
    //
    // Vì sao hơn cách cũ: cú bấm nhân đôi (ChatGPT/React bắn 2 sự kiện) trước
    // đây làm hỏng cả lượt và phải mở lại hộp; giờ chỉ tốn thêm một cú "−".
    const maxSteps = seatAdjustMaxSteps(qty);
    let steps = 0;
    let current = initialSeat;

    while (current !== targetSeat) {
      if (++steps > maxSteps) {
        return {
          kind: "retry",
          reason: `bấm ${maxSteps} lần vẫn chưa đưa bộ đếm về ${targetSeat} (đang ${current})`,
        };
      }

      const goingUp = current < targetSeat;
      await progress(
        "increment",
        `Đang chỉnh số suất: ${current} → ${targetSeat}` +
          (goingUp ? "" : " (bấm '−' vì đang vượt)"),
        Math.min(2 + steps, qty + 1),
      );

      // Lấy lại nút mỗi vòng: React re-render có thể đã thay element, bấm vào
      // node cũ (đã rời DOM) thì không có gì xảy ra.
      const btn = goingUp
        ? stepper.getIncrementButton()
        : stepper.getDecrementButton();
      if (!btn) {
        return goingUp
          ? {
              kind: "fail",
              response: fail(
                "UI_ELEMENT_NOT_FOUND",
                `Mất nút '+' giữa chừng (bộ đếm đang ${current}/${targetSeat}).`,
              ),
            }
          : {
              // Vượt số mà không tìm ra nút "−" → không kéo xuống được tại chỗ,
              // mở lại hộp cho bộ đếm về số thật rồi bấm lại.
              kind: "retry",
              reason: `bộ đếm vượt lên ${current} (cần ${targetSeat}) mà không tìm thấy nút '−'`,
            };
      }
      await humanClick(btn);

      // Chờ tới khi số THỰC SỰ đổi thay vì ngủ cố định.
      try {
        current = await waitFor(
          () => {
            const now = stepper.read();
            return now !== null && now !== current ? now : null;
          },
          SEAT_STEP_TIMEOUT_MS,
          100,
        );
      } catch {
        return {
          kind: "retry",
          reason:
            `bấm '${goingUp ? "+" : "−"}' không làm số đổi (vẫn ${current}) sau ` +
            `${SEAT_STEP_TIMEOUT_MS / 1000}s — có thể đã đụng hạn mức của ChatGPT`,
        };
      }

      // Số đã đổi, nhưng để hộp thở một nhịp rồi hẵng bấm tiếp.
      if (current !== targetSeat) await sleep(SEAT_STEP_GAP_MS);
    }

    // Bấm xong: chờ hộp cập nhật lại thẻ tóm tắt/nút trước khi đọc kiểm.
    await sleep(SEAT_STEP_GAP_MS);

    const finalSeat = stepper.read();
    if (finalSeat !== targetSeat) {
      return {
        kind: "retry",
        reason: `bộ đếm đọc lại ra ${finalSeat} thay vì ${targetSeat}`,
      };
    }
    console.log(
      `${LOG} bộ đếm về đúng ${targetSeat} sau ${steps} lần bấm (cần ${qty} suất)`,
    );

    // ── Bước 5: đối chiếu thẻ tóm tắt rồi bấm "Tiếp tục" ──────────────────
    await progress(
      "continue",
      `Số suất đã tăng ${initialSeat} → ${finalSeat}. Đối chiếu rồi bấm 'Tiếp tục'...`,
      qty + 2,
    );
    const continueBtn = findContinueButton();
    if (!continueBtn) {
      return {
        kind: "fail",
        response: fail(
          "UI_ELEMENT_NOT_FOUND",
          `Đã tăng số suất ${initialSeat} → ${finalSeat} nhưng KHÔNG tìm thấy nút ` +
            "'Tiếp tục' trong hộp 'Quản lý suất'.",
        ),
      };
    }

    // CHỐT SỚM: hộp tự in thẻ "Thêm N suất Tiêu chuẩn" sau khi bấm "+".
    // N phải bằng qty. Lệch → LÀM LẠI (chưa tạo giao dịch nên hoàn toàn an toàn).
    const seatModal = continueBtn.closest<HTMLElement>(DIALOG_SELECTOR);
    if (seatModal) {
      let preview: number | null = null;
      try {
        preview = await waitFor(
          () => extractAdditionalSeatCountFromModal(seatModal.textContent ?? ""),
          SEAT_PREVIEW_TIMEOUT_MS,
          200,
        );
      } catch {
        // Workspace không in thẻ tóm tắt → bỏ qua, hộp thanh toán vẫn có chốt.
        preview = null;
      }
      if (preview !== null && preview !== qty) {
        return {
          kind: "retry",
          reason: `thẻ tóm tắt nói 'Thêm ${preview} suất' nhưng cần ${qty}`,
        };
      }
      // CHỐT LOẠI SUẤT: thẻ chỉ được nói về suất Tiêu chuẩn. "Thêm 1 suất Tiêu
      // chuẩn VÀ 1 suất Cao cấp" vẫn cho `preview = 1` nên chốt trên bỏ lọt —
      // mà suất Cao cấp đắt hơn 12 lần. Mở lại hộp để bộ đếm về số thật.
      const mixed = detectMixedSeatTypes(seatModal.textContent ?? "");
      if (mixed) {
        return {
          kind: "retry",
          reason: `thẻ tóm tắt dính loại suất khác Tiêu chuẩn — ${mixed}`,
        };
      }
      console.log(`${LOG} thẻ tóm tắt xác nhận thêm ${preview ?? "?"} suất Tiêu chuẩn`);
    }

    // ChatGPT khoá "Tiếp tục" tới khi số suất thực sự đổi. Còn khoá SAU khi bộ
    // đếm đã lên nghĩa là ChatGPT chưa ghi nhận thao tác → làm lại. KHÔNG phải
    // do thiếu phương thức thanh toán: workspace luôn có sẵn thẻ.
    if (isDisabled(continueBtn)) {
      try {
        await waitFor(
          () => (isDisabled(continueBtn) ? null : true),
          CONTINUE_ENABLE_TIMEOUT_MS,
          200,
        );
      } catch {
        return {
          kind: "retry",
          reason: `nút 'Tiếp tục' vẫn khoá sau ${CONTINUE_ENABLE_TIMEOUT_MS / 1000}s dù bộ đếm đã lên ${finalSeat}`,
        };
      }
    }

    // Nghỉ một nhịp trước cú bấm mở hộp thanh toán — không vội.
    await sleep(PRE_CONTINUE_PAUSE_MS);
    await humanClick(continueBtn);
    return { kind: "continued", initialSeat, finalSeat };
  };

  // ── Vòng làm lại ─────────────────────────────────────────────────────────
  let setup: SetupOutcome | null = null;
  const retryReasons: string[] = [];
  for (let attempt = 1; attempt <= SEAT_SETUP_MAX_ATTEMPTS; attempt++) {
    setup = await runSetupAttempt(attempt);
    if (setup.kind !== "retry") break;

    retryReasons.push(setup.reason);
    console.warn(`${LOG} lượt ${attempt} không chuẩn: ${setup.reason} → mở lại hộp`);

    // Đóng hộp hiện tại để lượt sau mở mới — bộ đếm chỉ trở về số thật khi hộp
    // được mở lại từ đầu.
    const openModal = document.querySelector<HTMLElement>(DIALOG_SELECTOR);
    if (openModal) {
      const closed = await closeSeatModal(openModal);
      if (!closed) {
        return fail(
          "UI_ELEMENT_NOT_FOUND",
          `Cần bấm lại số suất (${setup.reason}) nhưng KHÔNG đóng được hộp 'Quản lý suất'. ` +
            "Đóng hộp trên ChatGPT rồi chạy lại task.",
        );
      }
    }
    await sleep(SEAT_RETRY_GAP_MS);
  }

  if (!setup || setup.kind === "retry") {
    return fail(
      "VERIFY_FAILED",
      `Đã thử ${SEAT_SETUP_MAX_ATTEMPTS} lượt mà bộ đếm vẫn không khớp ${qty} suất cần mua. ` +
        `Các lượt: ${retryReasons.join("; ")}. DỪNG — chưa tạo giao dịch nào.`,
    );
  }
  if (setup.kind === "fail") return setup.response;

  const { initialSeat, finalSeat } = setup;
  const partial = (
    note: string,
    extra: Record<string, unknown> = {},
  ): ExecuteActionResponse => ({
    ok: true,
    data: {
      initial_seat: initialSeat,
      target_seat: finalSeat,
      quantity: qty,
      flow: "manage_seats_modal",
      modal_advanced: true,
      confirm_charge_clicked: false,
      charge_modal_dismissed: false,
      setup_retries: retryReasons.length,
      ...extra,
      note,
    },
  });

  // ── Bước 6: hộp "Xem lại giao dịch mua" ──────────────────────────────────
  await progress("charge_modal", "Đợi hộp 'Xem lại giao dịch mua'...", qty + 3);

  let reviewModal: HTMLElement;
  try {
    reviewModal = await waitFor(
      () => findPurchaseReviewModal(),
      CHARGE_MODAL_TIMEOUT_MS,
      300,
    );
  } catch {
    // Chưa mất tiền — UI mới chỉ trừ khi bấm "Xác nhận mua".
    return partial(
      `Đã bấm 'Tiếp tục' nhưng hộp 'Xem lại giao dịch mua' không xuất hiện sau ` +
        `${CHARGE_MODAL_TIMEOUT_MS / 1000}s. CHƯA trừ tiền. Admin kiểm tra ChatGPT thủ công.`,
      { charge_amount_text: null },
    );
  }

  // Hộp hiện ra TRƯỚC, nội dung điền vào SAU vài giây.
  // Chờ tới khi đọc được SỐ SUẤT — đây là thứ DUY NHẤT dùng để chặn.
  try {
    await waitFor(
      () => {
        const r = readPurchaseReview(reviewModal);
        return r.seatCount !== null || r.monthly.seatDelta !== null ? true : null;
      },
      REVIEW_READY_TIMEOUT_MS,
      400,
    );
  } catch {
    // Vẫn đọc lần cuối bên dưới — để chốt quyết định, không đoán ở đây.
  }
  // Số TIỀN chỉ để ghi audit → chờ thêm một nhịp ngắn, hết giờ vẫn đi tiếp.
  try {
    await waitFor(
      () => (readPurchaseReview(reviewModal).todayText !== null ? true : null),
      REVIEW_MONEY_GRACE_MS,
      400,
    );
  } catch {
    console.warn(
      `${LOG} chưa đọc được số tiền để ghi audit — vẫn tiếp tục (chốt dựa trên số suất)`,
    );
  }

  // ⚠️ ĐỌC MỘT LẦN, NGAY TRƯỚC KHI BẤM.
  const review = readPurchaseReview(reviewModal);
  const { monthly } = review;
  console.log(
    `${LOG} hộp xác nhận: suất=${review.seatCount}, ghế ${monthly.currentSeats}→${monthly.newSeats}, ` +
      `hôm nay=${review.todayText}, hằng tháng tăng ${monthly.deltaVnd} đ (TRƯỚC thuế)`,
  );

  // Hộp có nói thay đổi CHỈ có hiệu lực từ kỳ gia hạn sau không? Ghi lại NGAY,
  // trước cú bấm — sau khi bấm, hộp có thể đổi nội dung hoặc biến mất. Con số này
  // quyết định chuyện hệ trọng ở cuối luồng: hộp kiểu đó thì số suất trên trang
  // ĐÚNG RA không nhích hôm nay, nên KHÔNG được lấy "suất chưa tăng" làm bằng
  // chứng "chưa mua" rồi mua lại (= mua đúp bằng tiền thật).
  const effectiveLater = detectEffectiveLater(review.rawText);
  if (effectiveLater) {
    console.log(`${LOG} hộp nói thay đổi có hiệu lực sau: "${effectiveLater}"`);
  }

  // CHỐT #1: số suất hộp khai phải khớp task.
  if (review.seatCount !== null && review.seatCount !== qty) {
    return fail(
      "VERIFY_FAILED",
      `Hộp xác nhận nói thêm ${review.seatCount} suất nhưng task yêu cầu ${qty}. ` +
        "Có thể số suất trên ChatGPT đã đổi giữa chừng — DỪNG để tránh mua sai.",
    );
  }

  // CHỐT #1b: hộp không được nói tới loại suất nào khác "Tiêu chuẩn". Chốt #1
  // đọc cụm ĐẦU ("Thêm 1 suất Tiêu chuẩn và 1 suất Cao cấp" → 1) nên tự nó cho
  // qua ca mua kèm loại đắt gấp 12 lần. Cú bấm ngay sau đây TRỪ TIỀN THẬT.
  const mixedTypes = detectMixedSeatTypes(review.rawText);
  if (mixedTypes) {
    return fail(
      "VERIFY_FAILED",
      `Hộp xác nhận đang mua KÈM loại suất khác Tiêu chuẩn: ${mixedTypes}. ` +
        "DỪNG, KHÔNG bấm xác nhận — extension chỉ được phép mua suất Tiêu chuẩn. " +
        "Nếu thật sự cần suất Cao cấp thì mua thủ công trên ChatGPT.",
    );
  }

  // CHỐT #2: số ghế trước/sau phải chênh đúng qty. Nguồn ĐỘC LẬP với chốt #1.
  // Chốt này bao luôn ca hộp đang mô tả việc GIẢM suất (chênh ra số âm).
  if (monthly.seatDelta !== null && monthly.seatDelta !== qty) {
    return fail(
      "VERIFY_FAILED",
      `Hộp xác nhận nói số ghế đi từ ${monthly.currentSeats} lên ${monthly.newSeats} ` +
        `(chênh ${monthly.seatDelta}) nhưng task yêu cầu ${qty} suất. DỪNG.`,
    );
  }

  // CHỐT #3: KHÔNG nguồn nào cho ra số suất → không chắc đang đứng trước hộp
  // nào. Nút cuối trừ tiền thật ngay, nên thà dừng còn hơn bấm mù.
  // Số TIỀN không tham gia chốt: đọc được hay không cũng không chặn.
  if (review.seatCount === null && monthly.seatDelta === null) {
    return fail(
      "VERIFY_FAILED",
      "Hộp xác nhận không đọc được số suất từ bất kỳ nguồn nào (thẻ 'Thêm N suất' lẫn " +
        "số ghế trước/sau) — nhiều khả năng ChatGPT đã đổi UI. KHÔNG bấm 'Xác nhận mua'. " +
        `Nội dung hộp: ${review.rawText.slice(0, 300)}`,
    );
  }

  // ── Bước 7: bấm "Xác nhận mua" — ⚠️ TRỪ TIỀN THẬT ────────────────────────
  await progress(
    "confirm_charge",
    `Bấm 'Xác nhận mua' cho ${qty} suất (trừ ngay ${review.todayText ?? "?"})...`,
    qty + 4,
  );

  const confirmBtn = findConfirmPurchaseButton(reviewModal);
  if (!confirmBtn) {
    return partial(
      "Hộp 'Xem lại giao dịch mua' mở nhưng KHÔNG tìm thấy nút 'Xác nhận mua'. " +
        "CHƯA trừ tiền. Admin bấm thủ công trên ChatGPT.",
      auditFields(review),
    );
  }

  // ChatGPT KHOÁ nút này trong lúc còn đang tính tiền, mở khoá khi tính xong.
  // Ca thật 22/8/2026 (2 lần liền): bản trước thấy khoá là bỏ cuộc ngay → task
  // FAILED "nút bị khoá" dù UI hoàn toàn bình thường, chỉ là ta hỏi quá sớm.
  // Nay CHỜ mở khoá, y như đã làm với nút "Tiếp tục".
  if (isDisabled(confirmBtn)) {
    try {
      await waitFor(
        () => (isDisabled(confirmBtn) ? null : true),
        CONFIRM_ENABLE_TIMEOUT_MS,
        250,
      );
    } catch {
      return partial(
        `Nút 'Xác nhận mua' vẫn khoá sau ${CONFIRM_ENABLE_TIMEOUT_MS / 1000}s. CHƯA trừ tiền. ` +
          "Workspace luôn có sẵn thẻ nên nhiều khả năng ChatGPT chặn vì lý do khác " +
          "(hạn mức, thẻ bị từ chối) — admin kiểm tra trên ChatGPT.",
        auditFields(review),
      );
    }
  }

  // Nghỉ một nhịp trước cú bấm TRỪ TIỀN. Nút vừa hết khoá xong mà bấm ngay thì
  // có lúc React chưa gắn handler mới — cú bấm rơi vào khoảng không, hộp đứng im
  // và ta không biết là chưa mua hay đang mua.
  await sleep(PRE_CONFIRM_PAUSE_MS);

  await humanClick(confirmBtn);

  // ── Bước 8: đợi hộp đóng HẲN = ChatGPT đã xử lý xong lệnh mua ────────────
  //
  // ⚠️ KHÔNG được đi tiếp khi hộp còn mở: hộp là lớp phủ chặn cả trang, thao tác
  // ngay sau (mở dialog mời) sẽ bấm vào lớp phủ. Ca thật 24/8/2026 — lệnh mời
  // wallet_tester hỏng đúng vì vậy, user phải chạy lệnh thứ hai mới mời được.
  await progress("confirm_charge", "Đang đợi ChatGPT xử lý giao dịch...", qty + 4);
  const charge = await waitForChargeModalDismiss(reviewModal, async (elapsed) => {
    await progress(
      "confirm_charge",
      `Đã bấm 'Xác nhận mua', ChatGPT đang xử lý giao dịch (${Math.round(elapsed / 1000)}s)...`,
      qty + 4,
    );
  });
  const dismissed = charge.dismissed;

  // Giao dịch xong → nghỉ thêm một nhịp cho trang cập nhật số suất mới trước khi
  // caller (luồng mời) đụng vào trang.
  if (dismissed) await sleep(POST_PURCHASE_SETTLE_MS);

  // ── Bước 9: XÁC NHẬN bằng con số suất in sẵn trên trang ──────────────────
  //
  // Thẻ "Suất Tiêu chuẩn" trên tab "Người dùng" nhích lên đúng số vừa mua =
  // ChatGPT đã ghi nhận giao dịch. Đây là chốt xác nhận DUY NHẤT không tốn cú
  // bấm nào — thay hẳn việc mở lại hộp "Quản lý suất" để đọc kiểm.
  //
  // Chạy CẢ KHI hộp thanh toán chưa đóng: đúng ca "không biết mua được chưa" thì
  // con số này trả lời thẳng. Hộp còn treo vẫn là chuyện riêng (lớp phủ chặn
  // bước mời) → caller vẫn tải lại trang theo `charge_overlay_cleared`.
  await progress("verify_seats", "Đọc lại số suất trên trang để xác nhận...", qty + 4);
  // Hộp CÒN TREO mà ChatGPT đã in băng-rôn xanh "đã được cập nhật thành công"
  // (user 30/8/2026): câu đó đã trả lời xong câu hỏi "mua được chưa", trong khi
  // hộp còn che trang thì `readSeatTotalsFromPage` từ chối đọc — nằm chờ trọn
  // 15s chỉ để đọc ra null là đốt thời gian của lệnh mời. Ngó qua vài nhịp
  // phòng khi hộp vừa kịp đóng, rồi đi tiếp.
  const verifyBudgetMs =
    !dismissed && charge.successToast
      ? SEAT_CARDS_VERIFY_SHORT_MS
      : SEAT_CARDS_VERIFY_TIMEOUT_MS;
  const verify = await waitForSeatCardsIncrease(
    cardsBefore,
    qty,
    async (elapsed) => {
      await progress(
        "verify_seats",
        `Đang chờ trang cập nhật số suất mới (${Math.round(elapsed / 1000)}s)...`,
        qty + 4,
      );
    },
    verifyBudgetMs,
  );
  if (verify.verified) {
    console.log(
      `${LOG} XÁC NHẬN trên trang: suất ${verify.basis === "standard" ? "Tiêu chuẩn" : "tổng"} ` +
        `${(verify.basis === "standard" ? verify.before?.standard : verify.before?.total) ?? "?"} → ` +
        `${(verify.basis === "standard" ? verify.after?.standard : verify.after?.total) ?? "?"} ` +
        `(+${verify.delta}) sau ${Math.round(verify.waitedMs / 1000)}s — KHÔNG mở lại hộp 'Quản lý suất'`,
    );
  } else {
    console.warn(`${LOG} chưa xác nhận được qua số suất trên trang: ${verify.reason}`);
  }

  const verifyFields: Record<string, unknown> = {
    // Số suất trang in TRƯỚC/SAU khi mua — dashboard ghi để truy ngược, và
    // `ensure-seats` dùng để khỏi phải đọc kiểm lần nữa.
    seat_page_verified: verify.verified,
    seat_page_basis: verify.basis,
    seat_page_delta: verify.delta,
    seat_page_standard_before: verify.before?.standard ?? null,
    seat_page_standard_after: verify.after?.standard ?? null,
    seat_page_total_before: verify.before?.total ?? null,
    seat_page_total_after: verify.after?.total ?? null,
    seat_page_wait_ms: verify.waitedMs,
    seat_page_reason: verify.reason,
  };

  // ChatGPT trả lời thẳng là HỎNG ("Đã xảy ra sự cố khi cập nhật gói đăng ký của
  // bạn" — ảnh user 2026-08-26). KHÔNG suy ra "chưa trừ tiền": ChatGPT vẫn có
  // thể đã ghi nhận giao dịch rồi mới hỏng khâu dựng lại màn hình. Mà hộp thì
  // còn treo, nên `readSeatTotalsFromPage` ở trên từ chối đọc → chỉ còn một
  // đường: nhờ BACKGROUND tải lại trang rồi đọc số suất trên trang sạch.
  if (charge.errorBanner) {
    console.warn(
      `${LOG} ChatGPT báo hỏng trong hộp: "${charge.errorBanner}" — ` +
        (verify.verified
          ? "nhưng số suất trên trang ĐÃ lên, coi như giao dịch đã đi qua"
          : "cần tải lại trang để đọc lại số suất"),
    );
  }
  // Băng-rôn XANH ngoài trang ("Gói đăng ký của bạn đã được cập nhật thành
  // công") là lời ChatGPT nói thẳng rằng giao dịch đã đi qua. Ghi vào kết quả để
  // background dùng làm chốt CẤM MUA LẠI ở bước F5 đọc lại số suất.
  if (charge.successToast) {
    console.log(
      `${LOG} ChatGPT xác nhận: "${charge.successToast}" → giao dịch ĐÃ đi qua` +
        (verify.verified ? " (số suất trên trang cũng đã lên)" : ", còn số suất thì đọc lại sau khi tải trang"),
    );
  }
  // Chưa xác nhận được bằng con số nào → background tải lại trang rồi đọc lại
  // (`readSeatsOnly`). Xác nhận được rồi thì thôi, khỏi tốn một vòng tải trang.
  const needsReloadVerify = !verify.verified;

  const seatMovedText =
    verify.verified && verify.before && verify.after
      ? verify.basis === "standard"
        ? `suất Tiêu chuẩn trên trang ${verify.before.standard} → ${verify.after.standard}`
        : `tổng suất trên trang ${verify.before.total} → ${verify.after.total}`
      : null;

  // KHÔNG còn Phase 3 (tab Hoá đơn) + Phase 4 (Stripe → Link) như bản cũ: UI mới
  // trừ tiền ngay tại đây. Giữ lại 2 phase đó còn TAI HẠI: sau khi đã trừ tiền,
  // luồng cũ sẽ đi tìm "hoá đơn chưa thanh toán đầu tiên" rồi tự thanh toán nó —
  // tức trả nhầm một hoá đơn KHÁC không liên quan tới task này.
  return {
    ok: true,
    data: {
      initial_seat: initialSeat,
      target_seat: finalSeat,
      quantity: qty,
      flow: "manage_seats_modal",
      modal_advanced: true,
      confirm_charge_clicked: true,
      charge_modal_dismissed: dismissed,
      charge_overlay_cleared: charge.overlayCleared,
      charge_wait_ms: charge.waitedMs,
      setup_retries: retryReasons.length,
      // Câu ChatGPT in ra khi hỏng — null nếu không có. Dashboard hiện nguyên văn
      // để admin đối chiếu với màn hình ChatGPT.
      charge_error_banner: charge.errorBanner,
      // Câu ChatGPT in ra khi giao dịch ĐÃ đi qua ("Gói đăng ký của bạn đã được
      // cập nhật thành công") — null nếu không bắt được. Có nó thì tuyệt đối
      // KHÔNG được mua lại (xem `judgeSeatsAfterReload`).
      charge_success_toast: charge.successToast,
      // Hộp nói thay đổi chỉ có hiệu lực từ kỳ gia hạn sau ("Có hiệu lực vào 25
      // tháng 9, 2026") → số suất hôm nay KHÔNG phản ánh giao dịch này. Background
      // đọc cờ này để CẤM đường mua lại tự động.
      charge_effective_later_text: effectiveLater,
      // Background đọc cờ này để tải lại trang + đọc lại số suất (và mua lại một
      // lần nếu suất chưa nhích) — xem `runner.ts`, nhánh PURCHASE_SEAT.
      needs_seat_reload_verify: needsReloadVerify,
      ...auditFields(review),
      ...verifyFields,
      note:
        dismissed || verify.verified
          ? `✓ Đã mua ${qty} suất (bộ đếm ${initialSeat} → ${finalSeat}` +
            (seatMovedText ? `; ${seatMovedText}` : "") +
            `). Trừ ngay ${review.todayText ?? "?"}` +
            (monthly.deltaVnd !== null
              ? `; hoá đơn hằng tháng ${monthly.currentText} → ${monthly.newText} (+${monthly.deltaVnd.toLocaleString("vi-VN")} đ TRƯỚC thuế).`
              : ".") +
            (dismissed
              ? ""
              : ` ⚠️ Hộp thanh toán chưa đóng sau ${Math.round(charge.waitedMs / 1000)}s — số suất đã lên nên giao dịch ĐÃ đi qua, chỉ cần tải lại trang.`)
          : charge.successToast
            ? `ChatGPT báo "${charge.successToast}" ⇒ giao dịch ĐÃ đi qua (${qty} suất, tiền đã trừ), ` +
              `nhưng hộp thanh toán chưa đóng nên chưa đọc được số suất trên trang ` +
              `(${verify.reason ?? "?"}). Đang tải lại trang để đọc lại số suất — KHÔNG mua lại.`
            : charge.errorBanner
              ? `Đã bấm 'Xác nhận mua' nhưng ChatGPT báo: "${charge.errorBanner}". ` +
                `Số suất trên trang chưa xác nhận được (${verify.reason ?? "?"}) vì hộp còn che trang. ` +
                "Đang tải lại trang để đọc lại số suất — chưa kết luận đã trừ tiền hay chưa."
              : `Đã bấm 'Xác nhận mua' nhưng hộp chưa đóng sau ${Math.round(charge.waitedMs / 1000)}s chờ, ` +
                `số suất trên trang cũng chưa xác nhận (${verify.reason ?? "?"}). ` +
                "Giao dịch CÓ THỂ đã đi qua — kiểm tra lại số suất trên ChatGPT trước khi tạo task mua mới.",
    },
  };
}
