/**
 * Nút mở hộp "Quản lý suất" trên /admin/members.
 *
 * ⚠️ UI 4/9/2026 (ảnh user): nút KHÔNG còn tên riêng. Mỗi thẻ suất có một nút
 * nhỏ tên đúng một chữ "Quản lý" / "Manage" nằm ở góc thẻ:
 *
 *   360              [Quản lý]          0                [Quản lý]
 *   Suất Tiêu chuẩn                     Suất Cao cấp
 *   340 Đã gán · 20 Khả dụng            0 Đã gán · 0 Khả dụng
 *
 * `TEXT_FALLBACKS.billingManageLicenses` toàn nhãn DÀI ("Quản lý số suất",
 * "Manage seats") mà phép so khớp là "text của nút CHỨA nhãn" ⇒ nút một chữ
 * trượt hết. Hậu quả không phải chỉ là luồng mua chết: `checkSeatAvailability`
 * không thấy nút thì kết luận "workspace chưa có UI mới" (`supported:false`) và
 * luồng mời BỎ QUA chốt suất — đúng ca 22/8/2026 đã mời mù vào hộp "mua kèm gửi
 * lời mời".
 *
 * Không thể thêm thẳng chữ "Quản lý" vào danh sách nhãn: so khớp kiểu chứa-chuỗi
 * sẽ vơ mọi nút có chữ đó trên trang, mà bấm nhầm nút nào thì không ai biết.
 * Ở đây bám vào chính THẺ SUẤT: nút phải nằm trong khối có ô "Đã gán"/"Khả dụng",
 * và thẻ "Tiêu chuẩn" được ưu tiên hơn thẻ "Cao cấp".
 */

import { dbLabelsFor } from "../../../shared/ui-labels";
import { normalizeMatchText } from "../../human";
import { findControlByKey, findUiControlByTexts } from "../../i18n-ui";
import { TEXT_FALLBACKS } from "../../selectors";

/** Nhãn RÚT GỌN của nút trên thẻ suất — phải khớp BẰNG ĐÚNG, không chứa-chuỗi. */
const SHORT_MANAGE = /^(quan ly|manage|管理)$/;

/** Dấu vân tay của một thẻ suất: có ô tỉ lệ, hoặc có ô "Đã gán"/"Khả dụng". */
const SEAT_CARD_RE =
  /(?:da gan|assigned|已分配)|(?:kha dung|con trong|available|可用)/;

const PREMIUM_RE = /cao cap|premium|高级/;
const STANDARD_RE = /tieu chuan|standard|标准/;

/** Thẻ suất KHÔNG bao giờ dài bằng cả trang — chặn ca leo lên trúng <body>. */
const CARD_TEXT_MAX = 400;

function isVisible(el: HTMLElement): boolean {
  if (el.hasAttribute("hidden")) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return true;
  // jsdom / element chưa layout: rơi về offsetParent.
  return el.offsetParent !== null;
}

/**
 * Khối thẻ suất chứa `btn` — tổ tiên GẦN NHẤT nói được cả loại suất lẫn số suất.
 *
 * Leo từng tầng và dừng ngay ở tầng đầu tiên đủ dấu hiệu: leo tiếp là chạm khối
 * bọc CẢ HAI thẻ, khi đó thẻ nào cũng "vừa Tiêu chuẩn vừa Cao cấp".
 */
function seatCardOf(btn: HTMLElement): { el: HTMLElement; text: string } | null {
  let el: HTMLElement | null = btn.parentElement;
  for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
    const text = normalizeMatchText(el.textContent ?? "");
    if (text.length > CARD_TEXT_MAX) return null;
    if (SEAT_CARD_RE.test(text)) return { el, text };
  }
  return null;
}

/**
 * Nút "Quản lý" đứng trên thẻ suất. Ưu tiên thẻ Tiêu chuẩn — đó là loại duy
 * nhất luồng mua đụng tới; hộp mở ra vẫn liệt kê đủ mọi loại suất nên bấm nhầm
 * thẻ không mua nhầm gì, nhưng bấm đúng thì hộp mở ra đúng chỗ cần nhìn.
 */
export function findManageButtonOnSeatCard(): HTMLElement | null {
  const buttons = Array.from(
    document.querySelectorAll<HTMLElement>('button, [role="button"], a'),
  ).filter(
    (b) => isVisible(b) && SHORT_MANAGE.test(normalizeMatchText(b.textContent ?? "")),
  );

  let fallback: HTMLElement | null = null;
  for (const btn of buttons) {
    const card = seatCardOf(btn);
    if (!card) continue;
    if (STANDARD_RE.test(card.text) && !PREMIUM_RE.test(card.text)) return btn;
    fallback ??= btn;
  }
  return fallback;
}

/**
 * Nút mở hộp "Quản lý suất", thử nhãn đầy đủ trước rồi mới tới nút trên thẻ.
 *
 * @param silent bỏ qua `reportLabelMismatch`. Dùng khi POLL — hàm báo lệch nhãn
 *   bắn một request mỗi lần trượt, poll 6s sẽ ngập dashboard.
 */
export function findManageSeatsButton(silent = false): HTMLElement | null {
  const byLabel = silent
    ? findUiControlByTexts([
        ...dbLabelsFor("billing_manage_licenses", "/admin/members"),
        ...TEXT_FALLBACKS.billingManageLicenses,
      ])
    : findControlByKey(
        "billing_manage_licenses",
        TEXT_FALLBACKS.billingManageLicenses,
        { page: "/admin/members" },
      );
  return byLabel ?? findManageButtonOnSeatCard();
}
