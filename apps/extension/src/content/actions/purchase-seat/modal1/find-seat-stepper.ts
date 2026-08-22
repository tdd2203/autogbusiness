import { normalizeMatchText } from "../../../human";
import { findIncrementButton } from "./find-increment-button";
import { findUserCountInput } from "./find-user-count-input";

/**
 * Bộ đếm suất trong modal "Quản lý suất" (UI 2026-08-22): `[−] 47 [+]`.
 *
 * Vì sao không dùng thẳng `findUserCountInput` như bản cũ: bản cũ giả định con
 * số nằm trong `<input>`. Modal mới hiển thị `47` như TEXT giữa 2 nút — nếu
 * ChatGPT bỏ `<input>` thì bản cũ không đọc được số nào, fail ngay ở bước đầu.
 * Ở đây thử `<input>` trước (UI cũ + trường hợp ChatGPT giữ input ẩn), không
 * có thì đọc text giữa 2 nút.
 */
export type SeatStepper = {
  /** Đọc số suất hiện tại. Null nếu không còn đọc được. */
  read: () => number | null;
  /** Nút "+" hiện tại. Null nếu modal đã đóng / không còn tìm thấy. */
  getIncrementButton: () => HTMLElement | null;
  /**
   * Nút "−" hiện tại. Dùng để KÉO XUỐNG khi lỡ bấm quá số cần mua.
   * Null nếu không nhận ra được (khi đó vượt số = phải mở lại hộp làm lại).
   */
  getDecrementButton: () => HTMLElement | null;
  /** Nguồn con số — ghi vào log để debug khi ChatGPT đổi UI. */
  source: "input" | "text";
};

/** Cặp element đã định vị được trong một lần quét. */
type Located = {
  /** Element chứa con số (input hoặc leaf text). */
  readEl: HTMLInputElement | HTMLElement;
  incEl: HTMLElement;
  /** Nút "−". Null khi chỉ nhận ra được nút "+". */
  decEl: HTMLElement | null;
  source: "input" | "text";
};

function isVisible(el: HTMLElement): boolean {
  if (el.hasAttribute("hidden")) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return true;
  // jsdom / element chưa layout: rơi về offsetParent.
  return el.offsetParent !== null;
}

function toSeatNumber(raw: string | null | undefined): number | null {
  const value = (raw ?? "").trim();
  if (!/^\d{1,3}$/.test(value)) return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function openDialogs(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-state="open"]',
    ),
  );
}

/** Nút "+" nhận diện được bằng aria-label hoặc bằng chính chữ "+". */
function isIncrementLabelled(btn: HTMLElement): boolean {
  const aria = btn.getAttribute("aria-label") ?? "";
  if (/increase|increment|plus|add|tăng|thêm|增加|加/i.test(aria)) return true;
  const text = normalizeMatchText(btn.textContent ?? "");
  return text === "+";
}

/**
 * Nút MANG CHỮ hành động — TUYỆT ĐỐI không được coi là nút của bộ đếm.
 *
 * Bộ đếm là 2 nút icon ("−" / "+"). Hộp còn có "Quay lại", "Tiếp tục" và nút X
 * đóng. Trước đây chỉ nút "+" được bấm nên nhận nhầm chỉ làm hỏng thao tác;
 * giờ luồng còn bấm cả "−" để kéo số xuống, nhận nhầm "Tiếp tục" là nhảy thẳng
 * sang hộp thanh toán. Loại các nút này ra khỏi ứng viên ngay từ đầu.
 */
const ACTION_BUTTON_TEXT =
  /^(tiep tuc|continue|next|proceed|quay lai|back|huy|huy bo|cancel|dong|close|xac nhan mua|confirm|them nguoi dung|继续|下一步|返回|取消|关闭|确认购买)$/i;

function isActionButton(btn: HTMLElement): boolean {
  const text = normalizeMatchText(btn.textContent ?? "");
  if (text && ACTION_BUTTON_TEXT.test(text)) return true;
  // Nút chữ dài (>2 ký tự) chắc chắn không phải icon "−"/"+" của bộ đếm.
  return text.length > 2;
}

/** Nút "−" nhận diện được — dùng để loại khỏi ứng viên "+". */
function isDecrementLabelled(btn: HTMLElement): boolean {
  const aria = btn.getAttribute("aria-label") ?? "";
  if (/decrease|decrement|minus|remove|giảm|bớt|减少|减/i.test(aria)) return true;
  const text = (btn.textContent ?? "").trim();
  // "-" ascii, "−" U+2212 minus, "–" en dash.
  return text === "-" || text === "−" || text === "–";
}

/**
 * Tìm element chỉ chứa con số (không có element con) nằm GIỮA 2 nút.
 *
 * Vì sao phải "giữa": modal còn in "47 người dùng · 46/47 đã gán" ngay dưới bộ
 * đếm. Nếu chỉ quét "leaf nào là số" thì rất dễ vớ trúng mẩu "47" của dòng đó
 * rồi đọc số suất từ chỗ không bao giờ thay đổi khi bấm "+" → tưởng nút "+"
 * hỏng và fail oan.
 */
function readoutBetween(
  container: HTMLElement,
  left: HTMLElement,
  right: HTMLElement,
): HTMLElement | null {
  const leaves = Array.from(container.querySelectorAll<HTMLElement>("*")).filter(
    (el) =>
      el.children.length === 0 &&
      toSeatNumber(el.textContent) !== null &&
      !el.closest("button"),
  );
  if (leaves.length === 0) return null;

  const lRect = left.getBoundingClientRect();
  const rRect = right.getBoundingClientRect();
  const hasLayout = lRect.width > 0 && rRect.width > 0;

  if (hasLayout) {
    const lx = lRect.left + lRect.width / 2;
    const rx = rRect.left + rRect.width / 2;
    const [minX, maxX] = lx <= rx ? [lx, rx] : [rx, lx];
    const between = leaves.filter((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const vertOverlap = cy >= Math.min(lRect.top, rRect.top) && cy <= Math.max(lRect.bottom, rRect.bottom);
      return cx > minX && cx < maxX && vertOverlap;
    });
    if (between[0]) return between[0];
  }

  // Không có layout (element ẩn / môi trường test): xét theo thứ tự DOM.
  const inDomOrder = leaves.filter((el) => {
    const afterLeft =
      (left.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const beforeRight =
      (right.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
    return afterLeft && beforeRight;
  });
  return inDomOrder[0] ?? null;
}

/** Bộ đếm dạng text: `[−] 47 [+]`, con số KHÔNG nằm trong <input>. */
function findTextStepper(dialog: HTMLElement): Located | null {
  const buttons = Array.from(
    dialog.querySelectorAll<HTMLButtonElement>("button"),
  ).filter((b) => isVisible(b) && !isActionButton(b));
  if (buttons.length < 2) return null;

  // Ưu tiên cặp nhận diện được bằng nhãn; không có nhãn thì xét mọi cặp liền kề
  // trong cùng container (icon-only button không có aria-label).
  const pairs: Array<[HTMLElement, HTMLElement]> = [];
  for (let i = 0; i < buttons.length - 1; i++) {
    for (let j = i + 1; j < buttons.length; j++) {
      pairs.push([buttons[i], buttons[j]]);
    }
  }
  const labelled = pairs.filter(
    ([a, b]) =>
      (isDecrementLabelled(a) && isIncrementLabelled(b)) ||
      (isDecrementLabelled(b) && isIncrementLabelled(a)),
  );

  for (const [a, b] of labelled.length > 0 ? labelled : pairs) {
    // Container chung gần nhất của 2 nút.
    let container: HTMLElement | null = a.parentElement;
    for (let i = 0; i < 5 && container; i++) {
      if (container.contains(b)) break;
      container = container.parentElement;
    }
    if (!container || !container.contains(b)) continue;

    const readout = readoutBetween(container, a, b);
    if (!readout) continue;

    // Nút "+" là nút đứng SAU con số (bên phải nếu có layout, sau trong DOM nếu
    // không). Đây là nút sẽ được bấm để TĂNG số suất — chọn nhầm là bấm "−".
    const aRect = a.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    let inc: HTMLElement;
    if (isIncrementLabelled(a) && !isIncrementLabelled(b)) inc = a;
    else if (isIncrementLabelled(b) && !isIncrementLabelled(a)) inc = b;
    else if (aRect.width > 0 && bRect.width > 0) inc = aRect.left >= bRect.left ? a : b;
    else
      inc =
        (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
          ? b
          : a;

    // Nút còn lại của cặp chính là "−".
    const dec = inc === a ? b : a;
    return { readEl: readout, incEl: inc, decEl: dec, source: "text" };
  }
  return null;
}

function locate(): Located | null {
  // Chiến lược 1: con số nằm trong <input> (UI cũ).
  //
  // BẮT BUỘC input phải nằm TRONG dialog. `findUserCountInput` có fallback quét
  // toàn trang (di sản của UI cũ, khi action chạy trên /admin/billing?tab=plan);
  // luồng mới chạy trên /admin/members, nơi còn ô lọc và phân trang — nhận nhầm
  // một input số nào đó ngoài modal thì `findIncrementButton` sẽ trả về một nút
  // bất kỳ cạnh nó và extension đi bấm loạn trên trang thành viên.
  const input = findUserCountInput();
  const inputInDialog = input?.closest<HTMLElement>(
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-state="open"]',
  );
  if (input && inputInDialog) {
    const inc = findIncrementButton(input);
    if (inc) {
      // "−" là nút anh em còn lại trong cùng khung bộ đếm (không phải "+",
      // không phải nút đóng/hành động). Không tìm ra thì để null — khi đó lỡ
      // bấm quá sẽ mở lại hộp làm lại thay vì kéo xuống.
      const box = inc.parentElement?.parentElement ?? inc.parentElement ?? inputInDialog;
      const dec =
        Array.from(box.querySelectorAll<HTMLButtonElement>("button")).find(
          (b) =>
            b !== inc &&
            isVisible(b) &&
            !isActionButton(b) &&
            !isIncrementLabelled(b),
        ) ?? null;
      return { readEl: input, incEl: inc, decEl: dec, source: "input" };
    }
  }

  // Chiến lược 2: con số là text giữa 2 nút (UI 2026-08-22).
  for (const dialog of openDialogs()) {
    const located = findTextStepper(dialog);
    if (located) return located;
  }
  return null;
}

function readLocated(loc: Located): number | null {
  return loc.source === "input"
    ? toSeatNumber((loc.readEl as HTMLInputElement).value)
    : toSeatNumber(loc.readEl.textContent);
}

/**
 * Bộ đếm suất, TỰ ĐỊNH VỊ LẠI khi element bị React thay.
 *
 * Vì sao cần: React re-render sau mỗi lần bấm "+" có thể THAY element chứ không
 * chỉ sửa text. Giữ tham chiếu cứng tới element cũ thì sau lần bấm đầu tiên,
 * `read()` đọc mãi node đã rời DOM (số không bao giờ đổi) và `humanClick` bấm
 * vào node chết → action fail oan dù UI hoạt động bình thường.
 */
export function findSeatStepper(): SeatStepper | null {
  let cached = locate();
  if (!cached) return null;

  const fresh = (): Located | null => {
    if (cached && cached.readEl.isConnected && cached.incEl.isConnected) {
      return cached;
    }
    cached = locate();
    return cached;
  };

  return {
    read: () => {
      const loc = fresh();
      return loc ? readLocated(loc) : null;
    },
    getIncrementButton: () => fresh()?.incEl ?? null,
    getDecrementButton: () => fresh()?.decEl ?? null,
    source: cached.source,
  };
}
