import { sleep } from "../../../human";
import {
  CHARGE_DISMISS_POLL_MS,
  CHARGE_DISMISS_STABLE_POLLS,
  CHARGE_DISMISS_TIMEOUT_MS,
  OVERLAY_CLEAR_TIMEOUT_MS,
} from "../constants";
import { findModalErrorBanner } from "./detect-error-banner";

const LOG = "[autogpt-purchase-seat]";

/**
 * Thấy băng-rôn lỗi rồi vẫn nán lại chừng này lượt đọc (≈3s) xem hộp có tự đóng
 * không — ChatGPT có lúc in lỗi ở một khung hình rồi vẫn đi tiếp. Hết ngần ấy mà
 * lỗi còn nguyên thì thôi chờ: ChatGPT ĐÃ trả lời (dù là trả lời hỏng), nằm thêm
 * cho đủ 120s chỉ tổ đốt thời gian của task.
 */
const ERROR_BANNER_STABLE_POLLS = 6;

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

  while (Date.now() < deadline) {
    if (isClosed(modal)) {
      closedStreak += 1;
      if (closedStreak >= CHARGE_DISMISS_STABLE_POLLS) {
        dismissed = true;
        errorBanner = null; // hộp đóng được = lỗi thoáng qua, không phải ca hỏng
        break;
      }
    } else {
      closedStreak = 0;

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
      errorBanner,
    };
  }

  // Hộp đóng rồi → đợi nốt lớp phủ, bằng không thao tác kế bấm vào khoảng không.
  const overlayDeadline = Date.now() + OVERLAY_CLEAR_TIMEOUT_MS;
  let overlayCleared = false;
  while (Date.now() < overlayDeadline) {
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
  return { dismissed: true, overlayCleared, waitedMs, errorBanner: null };
}
