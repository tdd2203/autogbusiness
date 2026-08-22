import { queryByAnyText } from "../../../human";
import { TEXT_FALLBACKS } from "../../../selectors";
import { extractAdditionalSeatCountFromModal } from "./extract-seat-count";
import { extractChargeAmountFromModal, normalizeForMatch } from "./money";

/**
 * Nhãn nút cuối của modal "Xem lại giao dịch mua" thuộc LUỒNG MỜI THÀNH VIÊN
 * ("Mua suất người dùng và gửi lời mời" — mua + gửi lời mời trong một cú bấm).
 *
 * ⚠️ Hai luồng dùng CHUNG tên modal nhưng khác nút cuối và khác ngữ cảnh. Luồng
 * mời do phần code khác xử lý; ở đây chỉ cần chắc chắn KHÔNG nhận nhầm modal đó
 * rồi bấm nút mua-và-mời (mua suất xong gửi luôn lời mời cho người lạ).
 */
const INVITE_FLOW_BUTTON = /gui\s*loi\s*moi|send\s*invit|发送邀请/i;

function hasInviteFlowButton(dialog: HTMLElement): boolean {
  return Array.from(dialog.querySelectorAll("button")).some((b) =>
    INVITE_FLOW_BUTTON.test(normalizeForMatch(b.textContent ?? "")),
  );
}

function openDialogs(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-state="open"]',
    ),
  );
}

/**
 * Tìm modal "Xem lại giao dịch mua" (UI 2026-08-22) — modal cuối cùng trước khi
 * TIỀN THẬT bị trừ.
 *
 * Phân biệt với modal "Quản lý suất" đứng trước nó: modal kia có bộ đếm
 * `[−] n [+]` và nút "Tiếp tục", KHÔNG có dòng "Tổng phải trả hôm nay" cũng
 * không mang tiêu đề "Xem lại giao dịch mua". Nên điều kiện nhận dạng là
 * "có nút xác nhận" VÀ ("đúng tiêu đề" HOẶC "đọc được tổng phải trả hôm nay").
 *
 * Bản cũ nhận dạng bằng heuristic lỏng (có cụm tiền bất kỳ + có nút xác nhận +
 * không có input số). Với UI mới, modal "Quản lý suất" cũng in tiền
 * ("649.000 đ/tháng") và có thể không dùng <input> cho bộ đếm → heuristic đó có
 * thể trỏ nhầm sang modal ĐẦU. Ở đây neo theo nhãn đặc trưng thay vì đoán.
 */
export function findPurchaseReviewModal(): HTMLElement | null {
  for (const dialog of openDialogs()) {
    if (hasInviteFlowButton(dialog)) continue;

    const hasConfirmButton = !!queryByAnyText(
      "button",
      TEXT_FALLBACKS.billingAddUserButton,
      dialog,
    );
    if (!hasConfirmButton) continue;

    const text = dialog.textContent ?? "";
    const norm = normalizeForMatch(text);

    const hasTitle =
      /xem\s*lai\s*giao\s*dich\s*mua|review\s*(?:your\s*)?purchase|review\s*order|quan\s*ly\s*cho\s*ngoi|查看购买|确认购买/i.test(
        norm,
      );
    const hasTodayTotal = extractChargeAmountFromModal(text) !== null;
    if (hasTitle || hasTodayTotal) return dialog;

    // Fallback UI cũ: "X suất ... bổ sung" + không còn input số.
    const numericInputs = Array.from(
      dialog.querySelectorAll<HTMLInputElement>("input"),
    ).filter((i) => /^\d{1,3}$/.test((i.value ?? "").trim()));
    if (
      numericInputs.length === 0 &&
      extractAdditionalSeatCountFromModal(text) !== null
    ) {
      return dialog;
    }
  }
  return null;
}
