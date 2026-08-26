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
 *
 * ⚠️⚠️ HỘP NAY CÓ HAI BỘ ĐẾM (user 2026-08-26) ⚠️⚠️
 *
 *   Tiêu chuẩn  260.500 đ/tháng     [−] 152 [+]
 *   Cao cấp   3.245.000 đ/tháng     [−]   0 [+]
 *
 * Suất Cao cấp đắt hơn suất Tiêu chuẩn **12 lần**. Bấm nhầm bộ đếm dưới là mua
 * nhầm loại suất bằng TIỀN THẬT. Bản trước lấy "cặp nút hợp lệ ĐẦU TIÊN tìm
 * thấy trong hộp" — đúng hàng Tiêu chuẩn hay không hoàn toàn phụ thuộc thứ tự
 * DOM và phép dò container, không có gì bảo đảm.
 *
 * Nay:
 *   1. GHIM vào hàng "Tiêu chuẩn" — tìm nhãn loại suất, lấy khung của riêng
 *      hàng đó (khung nào chứa cả nhãn loại khác thì KHÔNG nhận), rồi chỉ dò
 *      nút trong khung ấy;
 *   2. Ghim không được mà hộp lại có NHIỀU bộ đếm (đọc ra nhiều con số khác
 *      nhau) ⇒ trả null, KHÔNG bấm gì cả. Task dừng với thông báo rõ còn hơn
 *      bấm mù vào một hàng không biết là hàng nào.
 * Hộp chỉ có MỘT loại suất (workspace UI cũ) thì hành vi y như trước.
 */
/** Bộ đếm đang đứng ở hàng loại suất nào. */
export type SeatStepperScope = "standard_row" | "single";

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
  /**
   * `standard_row` = đã ghim đúng hàng "Tiêu chuẩn" trong hộp nhiều loại suất;
   * `single` = hộp chỉ có một bộ đếm (không có gì để nhầm).
   */
  scope: SeatStepperScope;
};

/** Cặp element đã định vị được trong một lần quét. */
type Located = {
  /** Element chứa con số (input hoặc leaf text). */
  readEl: HTMLInputElement | HTMLElement;
  incEl: HTMLElement;
  /** Nút "−". Null khi chỉ nhận ra được nút "+". */
  decEl: HTMLElement | null;
  source: "input" | "text";
  scope: SeatStepperScope;
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

/**
 * MỌI bộ đếm dạng text `[−] 47 [+]` trong `root` (con số KHÔNG nằm trong
 * <input>). Trả về danh sách chứ không phải cái đầu tiên: đếm được BAO NHIÊU
 * bộ đếm mới biết có đang đứng trước hộp nhiều loại suất hay không.
 */
function collectTextSteppers(root: HTMLElement): Located[] {
  const found: Located[] = [];
  const buttons = Array.from(
    root.querySelectorAll<HTMLButtonElement>("button"),
  ).filter((b) => isVisible(b) && !isActionButton(b));
  if (buttons.length < 2) return found;

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
    // Cùng một con số có thể lọt vào nhiều cặp nút (vd nút "−" hàng trên ghép
    // với nút "+" hàng dưới). Giữ MỘT bản cho mỗi con số — số lượng con số khác
    // nhau mới là thứ nói lên hộp có mấy bộ đếm.
    if (!found.some((f) => f.readEl === readout)) {
      found.push({ readEl: readout, incEl: inc, decEl: dec, source: "text", scope: "single" });
    }
  }
  return found;
}

/**
 * Nhãn của một hàng loại suất trong hộp "Quản lý suất".
 *
 * Khớp theo ĐẦU CHUỖI chứ không bắt bằng đúng: ChatGPT có thể gộp nhãn với giá
 * vào một node ("Tiêu chuẩn 260.500 đ/tháng"). Đòi bằng đúng mà trượt thì không
 * ghim được hàng nào ⇒ luồng mua dừng hẳn dù UI vẫn bình thường.
 */
const SEAT_ROW_LABELS: Array<{ standard: boolean; re: RegExp }> = [
  { standard: true, re: /^(tieu chuan|standard|标准)\b/ },
  { standard: false, re: /^(cao cap|premium|高级)\b/ },
];

type RowLabel = { standard: boolean; el: HTMLElement };

/** Các nhãn loại suất (leaf) có trong hộp. */
function findRowLabels(dialog: HTMLElement): RowLabel[] {
  const out: RowLabel[] = [];
  for (const el of Array.from(dialog.querySelectorAll<HTMLElement>("*"))) {
    if (el.children.length !== 0) continue;
    const text = normalizeMatchText(el.textContent ?? "");
    if (!text || text.length > 40) continue;
    const hit = SEAT_ROW_LABELS.find((l) => l.re.test(text));
    if (hit) out.push({ standard: hit.standard, el });
  }
  return out;
}

/**
 * Khung CỦA RIÊNG hàng chứa `label`: leo lên tới khi khung có đủ 2 nút (bộ đếm).
 * Trả null nếu khung ấy nuốt luôn nhãn của loại suất khác — nghĩa là không tách
 * được hàng, và tách không được thì TUYỆT ĐỐI không bấm.
 */
function rowContainerFor(
  label: HTMLElement,
  others: HTMLElement[],
): HTMLElement | null {
  let node: HTMLElement | null = label.parentElement;
  for (let i = 0; i < 6 && node; i++) {
    if (others.some((o) => node!.contains(o))) return null;
    if (node.querySelectorAll("button").length >= 2) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Bộ đếm cần bấm trong `dialog`.
 *
 * @returns `Located` khi chắc chắn đúng hàng; `null` khi không tìm thấy bộ đếm
 *   nào HOẶC khi hộp có nhiều bộ đếm mà không ghim được hàng "Tiêu chuẩn".
 */
function locateInDialog(dialog: HTMLElement): Located | null {
  const labels = findRowLabels(dialog);
  const standard = labels.find((l) => l.standard);
  const others = labels.filter((l) => !l.standard).map((l) => l.el);

  // Có nhãn của loại suất KHÁC ⇒ hộp nhiều loại ⇒ BẮT BUỘC ghim hàng Tiêu chuẩn.
  if (others.length > 0) {
    if (!standard) return null;
    const row = rowContainerFor(standard.el, others);
    if (!row) return null;
    const inRow = collectTextSteppers(row);
    if (inRow.length !== 1) return null;
    return { ...inRow[0], scope: "standard_row" };
  }

  const all = collectTextSteppers(dialog);
  if (all.length === 0) return null;
  // Nhiều con số khác nhau mà không có nhãn nào để ghim (ChatGPT đổi chữ?) →
  // không đoán bừa hàng nào là hàng Tiêu chuẩn.
  if (all.length > 1) return null;
  return all[0];
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
  // Hộp có từ 2 loại suất trở lên → KHÔNG dùng đường <input>: nó không biết
  // input thuộc hàng nào. Đi thẳng xuống đường ghim-theo-hàng bên dưới.
  const multiType =
    inputInDialog !== undefined &&
    inputInDialog !== null &&
    findRowLabels(inputInDialog).filter((l) => !l.standard).length > 0;
  if (input && inputInDialog && !multiType) {
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
      return { readEl: input, incEl: inc, decEl: dec, source: "input", scope: "single" };
    }
  }

  // Chiến lược 2: con số là text giữa 2 nút (UI 2026-08-22 — và từ 26/8/2026 là
  // MỘT bộ đếm cho MỖI loại suất).
  for (const dialog of openDialogs()) {
    const located = locateInDialog(dialog);
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
    scope: cached.scope,
  };
}
