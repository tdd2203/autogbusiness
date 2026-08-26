import { sleep } from "../../../human";
import {
  CHARGE_DISMISS_POLL_MS,
  CHARGE_DISMISS_STABLE_POLLS,
  CHARGE_DISMISS_TIMEOUT_MS,
  OVERLAY_CLEAR_TIMEOUT_MS,
} from "../constants";
import { findModalErrorBanner } from "./detect-error-banner";
import { findSuccessToast, isToastNode } from "./detect-success-toast";

const LOG = "[autogpt-purchase-seat]";

/**
 * Thấy băng-rôn lỗi rồi vẫn nán lại chừng này lượt đọc (≈3s) xem hộp có tự đóng
 * không — ChatGPT có lúc in lỗi ở một khung hình rồi vẫn đi tiếp. Hết ngần ấy mà
 * lỗi còn nguyên thì thôi chờ: ChatGPT ĐÃ trả lời (dù là trả lời hỏng), nằm thêm
 * cho đủ 120s chỉ tổ đốt thời gian của task.
 */
const ERROR_BANNER_STABLE_POLLS = 6;

/**
 * Thấy băng-rôn XANH "Gói đăng ký của bạn đã được cập nhật thành công" rồi thì
 * chỉ nán thêm chừng này cho hộp tự đóng. ChatGPT đã nói thẳng là xong, nằm chờ
 * đủ 120s nữa chẳng biết thêm điều gì — mà caller thì có sẵn đường tải lại trang
 * cho sạch lớp phủ.
 */
const SUCCESS_TOAST_GRACE_MS = 15_000;

export type ChargeDismissResult = {
  /** Hộp "Xem lại giao dịch mua" đã đóng hẳn. */
  dismissed: boolean;
  /** Lớp phủ của hộp cũng đã rời trang → thao tác kế bấm được vào trang thật. */
  overlayCleared: boolean;
  /** Tổng thời gian đã chờ (ms) — ghi audit để biết ChatGPT xử lý bao lâu. */
  waitedMs: number;
  /**
   * Câu báo hỏng ChatGPT in TRONG hộp ("Đã xảy ra sự cố khi cập nhật gói đăng ký
   * của bạn" — ảnh user 2026-08-26). null = không có.
   *
   * ⚠️ Có câu này KHÔNG có nghĩa là chưa trừ tiền: ChatGPT vẫn có thể đã ghi nhận
   * giao dịch rồi mới hỏng ở bước dựng lại màn hình. Caller phải TẢI LẠI TRANG và
   * đọc lại SỐ SUẤT mới biết được, tuyệt đối không tự bấm mua lại khi chưa đọc.
   */
  errorBanner: string | null;
  /**
   * Câu báo THÀNH CÔNG ChatGPT in ra ngoài trang ("Gói đăng ký của bạn đã được
   * cập nhật thành công" — ảnh user 2026-08-26). null = không thấy.
   *
   * Có câu này ⇒ giao dịch ĐÃ đi qua, dù hộp còn treo hay băng-rôn đỏ có chớp.
   * Không có thì KHÔNG kết luận được gì (toast tự tắt sau vài giây, ta chỉ đọc
   * trang theo nhịp poll) — xem `detect-success-toast.ts`.
   */
  successToast: string | null;
};

/** Hộp coi như đã đóng khi rời DOM, bị ẩn, hoặc Radix đánh dấu data-state=closed. */
function isClosed(modal: HTMLElement): boolean {
  if (!document.body.contains(modal)) return true;
  if (modal.getAttribute("data-state") === "closed") return true;
  const style = window.getComputedStyle(modal);
  return style.display === "none" || style.visibility === "hidden";
}

/**
 * Còn lớp phủ nào đang mở không?
 *
 * Radix dựng backdrop riêng, tách khỏi node hộp — hộp rời DOM rồi mà backdrop
 * còn nằm lại là mọi cú bấm phía sau rơi vào backdrop. Chỉ tính những thứ ĐANG
 * mở (`data-state="open"` hoặc dialog đang hiển thị), không tính node ẩn.
 */
function overlayStillUp(): boolean {
  const nodes = document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-radix-popper-content-wrapper], [data-state="open"]',
  );
  for (const el of Array.from(nodes)) {
    if (el.getAttribute("data-state") === "closed") continue;
    if (el.getAttribute("aria-hidden") === "true") continue;
    // Toast KHÔNG chặn trang: nó là dải thông báo nổi, bấm xuyên qua được. Radix
    // đánh dấu nó `data-state="open"` y như hộp thật, nên không loại ra là mọi
    // cú mua thành công đều bị kết luận "lớp phủ còn nằm lại" → tải lại trang oan.
    if (isToastNode(el)) continue;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    return true;
  }
  return false;
}

/**
 * Đợi hộp review #2 đóng HẲN sau khi bấm "Xác nhận mua", rồi đợi nốt lớp phủ.
 *
 * Vì sao phải chặt tay tới vậy (ca thật 24/8/2026 — lệnh mời wallet_tester):
 * ChatGPT xử lý giao dịch mất khá lâu và hộp giữ nguyên trên màn hình suốt lúc
 * đó. Bản cũ chờ 10s là bỏ đi mời tiếp — hộp còn mở, lớp phủ chặn cả trang, cú
 * mời hỏng và user phải chạy lại lệnh thứ hai. Nay chờ tới khi hộp đóng, đọc
 * được `CHARGE_DISMISS_STABLE_POLLS` lần liên tiếp (tránh bắt trúng khung hình
 * animation), rồi mới đợi lớp phủ rời trang.
 *
 * @param onWait gọi định kỳ trong lúc chờ để báo tiến độ — chờ có thể tới vài
 *   chục giây, im lặng chừng đó thì dashboard tưởng task treo.
 */
export async function waitForChargeModalDismiss(
  modal: HTMLElement,
  onWait?: (elapsedMs: number) => void | Promise<void>,
): Promise<ChargeDismissResult> {
  const started = Date.now();
  const deadline = started + CHARGE_DISMISS_TIMEOUT_MS;
  let closedStreak = 0;
  let lastTick = started;
  let dismissed = false;
  let errorBanner: string | null = null;
  let errorStreak = 0;
  let successToast: string | null = null;
  let successAt: number | null = null;

  while (Date.now() < deadline) {
    // Băng-rôn xanh có thể chớp lên rồi tắt — thấy một lần là GIỮ, vì nó chỉ nói
    // một điều và điều đó không đảo ngược: ChatGPT đã ghi nhận giao dịch.
    if (successToast === null) {
      const toast = findSuccessToast();
      if (toast) {
        successToast = toast;
        successAt = Date.now();
        console.log(`${LOG} ChatGPT báo THÀNH CÔNG ngoài trang: "${toast}"`);
      }
    }

    if (isClosed(modal)) {
      closedStreak += 1;
      if (closedStreak >= CHARGE_DISMISS_STABLE_POLLS) {
        dismissed = true;
        errorBanner = null; // hộp đóng được = lỗi thoáng qua, không phải ca hỏng
        break;
      }
    } else {
      closedStreak = 0;

      // Đã có băng-rôn thành công mà hộp vẫn treo → thôi chờ. Giao dịch xong
      // rồi; việc còn lại (dọn lớp phủ) là của cú tải lại trang phía caller.
      if (successAt !== null && Date.now() - successAt >= SUCCESS_TOAST_GRACE_MS) {
        console.warn(
          `${LOG} đã thấy báo thành công nhưng hộp còn treo sau ` +
            `${SUCCESS_TOAST_GRACE_MS / 1000}s → thôi chờ, caller tải lại trang`,
        );
        break;
      }

      // Hộp còn mở: ChatGPT đang xử lý, hay đã trả lời rằng hỏng?
      const banner = findModalErrorBanner(modal);
      if (banner) {
        errorBanner = banner;
        errorStreak += 1;
        if (errorStreak >= ERROR_BANNER_STABLE_POLLS) {
          console.warn(
            `${LOG} ChatGPT báo hỏng ngay trong hộp: "${banner}" → thôi chờ, ` +
              "caller phải tải lại trang đọc lại số suất mới biết đã trừ tiền hay chưa",
          );
          break;
        }
      } else {
        errorBanner = null;
        errorStreak = 0;
      }
    }

    if (onWait && Date.now() - lastTick >= 10_000) {
      lastTick = Date.now();
      await onWait(Date.now() - started);
    }
    await sleep(CHARGE_DISMISS_POLL_MS);
  }

  if (!dismissed) {
    if (!errorBanner) {
      console.warn(
        `${LOG} hộp xác nhận CHƯA đóng sau ${Math.round((Date.now() - started) / 1000)}s`,
      );
    }
    return {
      dismissed: false,
      overlayCleared: false,
      waitedMs: Date.now() - started,
      // Báo thành công đè băng-rôn đỏ: ChatGPT có ca in lỗi ở khâu dựng lại màn
      // hình SAU khi đã trừ tiền. Câu xanh nói về giao dịch, câu đỏ nói về màn hình.
      errorBanner: successToast ? null : errorBanner,
      successToast,
    };
  }

  // Hộp đóng rồi → đợi nốt lớp phủ, bằng không thao tác kế bấm vào khoảng không.
  const overlayDeadline = Date.now() + OVERLAY_CLEAR_TIMEOUT_MS;
  let overlayCleared = false;
  while (Date.now() < overlayDeadline) {
    // Toast thường hiện ĐÚNG LÚC hộp vừa đóng, tức là sau vòng lặp trên. Đọc
    // tiếp ở đây để không bỏ lỡ câu khẳng định "đã trừ tiền".
    if (successToast === null) {
      const toast = findSuccessToast();
      if (toast) {
        successToast = toast;
        console.log(`${LOG} ChatGPT báo THÀNH CÔNG ngoài trang: "${toast}"`);
      }
    }
    if (!overlayStillUp()) {
      overlayCleared = true;
      break;
    }
    await sleep(CHARGE_DISMISS_POLL_MS);
  }
  if (!overlayCleared) {
    console.warn(
      `${LOG} hộp đã đóng nhưng LỚP PHỦ còn nằm lại sau ${OVERLAY_CLEAR_TIMEOUT_MS / 1000}s`,
    );
  }

  const waitedMs = Date.now() - started;
  console.log(
    `${LOG} giao dịch xong sau ${Math.round(waitedMs / 1000)}s ` +
      `(hộp đóng, lớp phủ ${overlayCleared ? "đã rời trang" : "CÒN nằm lại"})`,
  );
  return { dismissed: true, overlayCleared, waitedMs, errorBanner: null, successToast };
}
