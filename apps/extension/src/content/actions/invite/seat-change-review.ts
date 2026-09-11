/**
 * Hộp "Review seat changes" — ChatGPT bật SAU cú bấm "Send invites" khi workspace
 * đang treo lệnh hạ suất (ngày chốt đã bấm "Remove paid seat"). Ảnh user 11/9/2026:
 *
 *   Review seat changes
 *   Your changes take effect at your next renewal.
 *   ┌ Add 1 Standard seat                          + ₫260,500/mo ┐
 *   └ Takes effect on September 11, 2026                         ┘
 *   ┌ Current monthly bill    400 Standard · 0 Premium           ┐
 *   └ New monthly bill        396 Standard · 0 Premium           ┘
 *                               [Back]  [Update seats and send invites]
 *
 * Ô "Available" của ChatGPT đã trừ lệnh hạ, còn bước chốt suất lấy số lớn trừ đã
 * gán nên tưởng còn chỗ và cứ mời. Lời mời chỉ đi khi bấm nút cập nhật, và mỗi
 * suất thêm vào huỷ đúng MỘT lệnh hạ (5 lệnh còn 4) — tức giữ lại suất đã trả
 * tiền, rẻ hơn mua suất mới. Không bấm thì hộp nằm đó, vòng chờ tưởng hộp mời
 * chưa đóng rồi ESC mất: lời mời không bao giờ đi.
 *
 * User chốt 11/9/2026: ưu tiên bán hàng, cần suất thì cứ thêm, chỉ cần kiểm soát
 * được số suất. Nên hộp này luôn bấm; số suất ChatGPT thêm được ghi vào kết quả
 * task để soát.
 *
 * Mới thấy nhãn tiếng Anh. Nhãn Việt/Trung chưa ai chụp — khớp lỏng theo cặp
 * "cập nhật … lời mời" để khỏi trượt vì chữ đệm ở giữa.
 */

import { normalizeForMatch } from "../purchase-seat/modal2/money";

/** "Update seats and send invites" · "Cập nhật suất và gửi lời mời" · "更新席位并发送邀请". */
const CONFIRM_RE = /(?:update|cap\s*nhat|更新).{0,40}?(?:invite|loi\s*moi|邀请)/i;

/**
 * "Add 1 Standard seat". Đòi chữ chỉ loại suất ngay sau con số để không vơ nhầm
 * số tiền hay số suất của dòng hoá đơn ("400 Standard").
 */
const ADDED_RE =
  /(?:add|them|添加|增加)\s*(\d{1,4})\s*(?:个\s*)?(?:standard|premium|tieu\s*chuan|cao\s*cap|suat|seats?|标准|高级|席位)/gi;

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]';

export type SeatChangeNote = {
  /** Số suất ChatGPT ghi trong hộp ("Add N ..."); null khi không đọc ra. */
  added: number | null;
  /** Số email của lượt bấm Gửi. */
  invited: number;
  /** Đã bấm được nút cập nhật hay chưa. */
  clicked: boolean;
};

/** Tách khỏi phần DOM để test được bằng chuỗi thuần. */
export function isSeatChangeConfirmLabel(text: string): boolean {
  return CONFIRM_RE.test(normalizeForMatch(text));
}

/** Tổng số suất hộp định thêm, null khi không có dòng nào đọc được. */
export function seatsAddedInReview(text: string): number | null {
  let total: number | null = null;
  for (const m of normalizeForMatch(text).matchAll(ADDED_RE)) {
    total = (total ?? 0) + parseInt(m[1], 10);
  }
  return total;
}

/** Hộp "Review seat changes" đang mở: nút xác nhận và chữ của chính hộp đó. */
export function findSeatChangeReview(): { button: HTMLElement; text: string } | null {
  for (const button of Array.from(
    document.querySelectorAll<HTMLElement>(
      DIALOG_SELECTOR.split(", ").map((s) => `${s} button`).join(", "),
    ),
  )) {
    if (!isSeatChangeConfirmLabel(button.textContent ?? "")) continue;
    // Hộp trong cùng chứa nút — hộp mời nằm dưới (nếu còn) có chữ riêng của nó.
    const box = button.closest<HTMLElement>(DIALOG_SELECTOR);
    return { button, text: box?.innerText || box?.textContent || "" };
  }
  return null;
}
