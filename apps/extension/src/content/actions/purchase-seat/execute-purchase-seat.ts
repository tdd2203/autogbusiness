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
  CONTINUE_ENABLE_TIMEOUT_MS,
  MAX_QUANTITY,
  MEMBERS_PATH,
  MEMBERS_SEARCH,
  MODAL_OPEN_TIMEOUT_MS,
  POST_NAV_RENDER_MS,
  REVIEW_MONEY_GRACE_MS,
  REVIEW_READY_TIMEOUT_MS,
  SEAT_PREVIEW_TIMEOUT_MS,
  SEAT_RETRY_GAP_MS,
  SEAT_SETUP_MAX_ATTEMPTS,
  SEAT_STEP_TIMEOUT_MS,
  seatAdjustMaxSteps,
} from "./constants";
import { executePaymentChainOnly } from "./execute-payment-chain-only";
import { closeSeatModal } from "./modal1/close-seat-modal";
import { findContinueButton } from "./modal1/find-continue-button";
import { findSeatStepper, type SeatStepper } from "./modal1/find-seat-stepper";
import { extractAdditionalSeatCountFromModal } from "./modal2/extract-seat-count";
import { findConfirmPurchaseButton } from "./modal2/find-confirm-purchase-button";
import { findPurchaseReviewModal } from "./modal2/find-review-modal";
import { readPurchaseReview, type PurchaseReview } from "./modal2/read-review";
import { waitForChargeModalDismiss } from "./modal2/wait-dismiss";

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

/** Kết quả một lượt "mở hộp → bấm + → Tiếp tục". */
type SetupOutcome =
  | { kind: "continued"; initialSeat: number; finalSeat: number }
  | { kind: "retry"; reason: string }
  | { kind: "fail"; response: ExecuteActionResponse };

export async function executePurchaseSeat(
  taskId: string,
  quantity: number,
  skipToPayment = false,
): Promise<ExecuteActionResponse> {
  if (!location.pathname.startsWith("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}). Mở chatgpt.com/admin/members trước.`,
    };
  }

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
    const manageBtn = findControlByKey(
      "billing_manage_licenses",
      TEXT_FALLBACKS.billingManageLicenses,
      { page: "/admin/members" },
    );
    if (!manageBtn) {
      return {
        kind: "fail",
        response: fail(
          "UI_ELEMENT_NOT_FOUND",
          "Không tìm thấy nút 'Quản lý số suất' trên /admin/members (nút này nằm cạnh " +
            "'+ Mời thành viên'). Có thể ChatGPT đổi nhãn, hoặc trang chưa render xong. " +
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
          `Đã bấm 'Quản lý số suất' nhưng không thấy bộ đếm số suất sau ` +
            `${MODAL_OPEN_TIMEOUT_MS / 1000}s. Có thể ChatGPT đổi UI hộp 'Quản lý suất'.`,
        ),
      };
    }

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
      `${LOG} lượt ${attempt}: initial=${initialSeat}, target=${targetSeat} (+${qty}), stepper=${stepper.source}`,
    );

    // ── Bước 4: đưa bộ đếm về đúng targetSeat ─────────────────────────────
    //
    // KHÔNG đếm "bấm đủ qty lần" mà BÁM THEO CON SỐ: thiếu thì bấm "+", lỡ vượt
    // thì bấm "−" kéo xuống, tới khi bộ đếm bằng đúng targetSeat. Bấm nhanh,
    // không nghỉ — sai thì tự sửa ngay tại chỗ.
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
    }

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
      console.log(`${LOG} thẻ tóm tắt xác nhận thêm ${preview ?? "?"} suất`);
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

  // CHỐT #1: số suất hộp khai phải khớp task.
  if (review.seatCount !== null && review.seatCount !== qty) {
    return fail(
      "VERIFY_FAILED",
      `Hộp xác nhận nói thêm ${review.seatCount} suất nhưng task yêu cầu ${qty}. ` +
        "Có thể số suất trên ChatGPT đã đổi giữa chừng — DỪNG để tránh mua sai.",
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

  if (isDisabled(confirmBtn)) {
    return partial(
      "Nút 'Xác nhận mua' bị khoá. CHƯA trừ tiền. Workspace luôn có sẵn thẻ nên nhiều " +
        "khả năng ChatGPT chặn vì lý do khác (hạn mức, thẻ bị từ chối) — admin kiểm tra trên ChatGPT.",
      auditFields(review),
    );
  }

  await humanClick(confirmBtn);

  // ── Bước 8: đợi hộp đóng = ChatGPT đã nhận lệnh mua ──────────────────────
  await progress("confirm_charge", "Đang đợi ChatGPT xử lý giao dịch...", qty + 4);
  const dismissed = await waitForChargeModalDismiss(reviewModal);

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
      setup_retries: retryReasons.length,
      ...auditFields(review),
      note: dismissed
        ? `✓ Đã mua ${qty} suất (bộ đếm ${initialSeat} → ${finalSeat}). Trừ ngay ${review.todayText ?? "?"}` +
          (monthly.deltaVnd !== null
            ? `; hoá đơn hằng tháng ${monthly.currentText} → ${monthly.newText} (+${monthly.deltaVnd.toLocaleString("vi-VN")} đ TRƯỚC thuế).`
            : ".")
        : "Đã bấm 'Xác nhận mua' nhưng hộp chưa đóng sau khi chờ. Giao dịch CÓ THỂ đã đi qua — " +
          "kiểm tra lại số suất trên ChatGPT trước khi tạo task mua mới.",
    },
  };
}
