/**
 * Đọc số suất NGAY TRÊN trang /admin/members — UI ChatGPT mới (user 2026-08-26).
 *
 * Tab "Người dùng" nay in sẵn mỗi LOẠI SUẤT một thẻ, không cần mở hộp nào.
 *
 * DẠNG 1 — thẻ có ô tỉ lệ (UI 26/8/2026):
 *
 *   Suất Tiêu chuẩn        [Đã gán 60/62]        Suất Cao cấp       [Đã gán 0/0]
 *   62                                           0
 *
 * DẠNG 2 — thẻ tách thành hai ô (UI 4/9/2026, ảnh user):
 *
 *   360              [Quản lý]          0                [Quản lý]
 *   Suất Tiêu chuẩn                     Suất Cao cấp
 *   ┌────────────┬────────────┐         ┌────────────┬────────────┐
 *   │    340     │     20     │         │     0      │     0      │
 *   │  Đã gán    │  Khả dụng  │         │  Đã gán    │  Khả dụng  │
 *
 * Dạng 2 không còn cụm "60/62" nào — tổng suất đã mua = "Đã gán" + "Khả dụng"
 * (đúng bằng con số lớn in phía trên: 340 + 20 = 360).
 *
 * User chốt cách đọc: số lớn = suất loại đó ĐÃ MUA, ô "Đã gán" = số suất đang
 * PHÂN BỔ cho người dùng. CỘNG các thẻ lại mới ra tổng suất workspace đã mua —
 * đọc mỗi thẻ Tiêu chuẩn là thiếu phần Cao cấp.
 *
 * VÌ SAO ĐÁNG LÀM: tới nay muốn biết số suất phải MỞ hộp "Quản lý suất" — chỗ
 * hỏng nhiều nhất của luồng mời (24/8/2026: 8 task chết liên tiếp vì hộp không
 * mở / bộ đếm lệch dòng tỉ lệ, trong khi workspace thừa suất). Số in sẵn trên
 * trang thì đọc không tốn cú bấm nào, cũng không có hộp nào để kẹt.
 *
 * ⚠️ Ô "Đã gán" đếm người ĐÃ THAM GIA, KHÔNG kể lời mời đang chờ — y hệt dòng
 * tỉ lệ trong hộp "Quản lý suất" (đo trên production 24/8/2026: CHATGPT PRO
 * "60/60 đã gán" mà vẫn treo 1 lời mời chưa ai nhận). Nợ suất của lời mời treo
 * vẫn phải trừ riêng — xem `ensure-seats.ts`.
 */

import { normalizeForMatch } from "./modal2/money";

export type SeatKind = "standard" | "premium" | "unknown";

export type SeatCard = {
  kind: SeatKind;
  /** Nhãn thô đứng trước ô "Đã gán" — CHỈ để ghi nhật ký/chẩn đoán. */
  label: string;
  /** Suất đang phân bổ cho người dùng (ô "Đã gán", vế trái). */
  assigned: number;
  /** Suất loại này đã mua (ô "Đã gán", vế phải). */
  total: number;
};

export type SeatCardsReading = {
  cards: SeatCard[];
  /** Σ total các thẻ = tổng suất workspace ĐÃ MUA. */
  total: number;
  /** Σ assigned các thẻ = tổng suất đang phân bổ. */
  assigned: number;
  /** total − assigned, kẹp sàn 0. CHƯA trừ nợ suất của lời mời đang chờ. */
  free: number;
  /**
   * Workspace đang có TỪ HAI loại suất trở lên cùng khác 0.
   *
   * Quan trọng với TIỀN: luồng mua lái bộ đếm trong hộp "Quản lý suất", mà bộ
   * đếm đó chỉ điều khiển MỘT loại suất. Cộng chung hai loại rồi mua theo hiệu
   * số là mua sai số. Caller phải coi đây là "số chưa chắc" và CẤM tự mua.
   */
  mixed: boolean;
};

/**
 * Ô "Đã gán 60/62" (UI mới, nhãn đứng TRƯỚC) và "52/53 đã gán" (hộp "Quản lý
 * suất", nhãn đứng SAU). Bắt cả hai thứ tự trong một lượt quét.
 */
const BADGE_RE =
  /(?:da\s*gan|assigned|已分配)\s*[:：]?\s*(\d{1,4})\s*\/\s*(\d{1,4})|(\d{1,4})\s*\/\s*(\d{1,4})\s*(?:da\s*gan|assigned|已分配)/gi;

/**
 * Trọn một thẻ suất DẠNG 2 (UI 4/9/2026):
 *
 *   360  [Quản lý]  Suất Tiêu chuẩn   340 Đã gán   20 Khả dụng
 *   └ TỔNG SUẤT ĐÃ MUA                └ đang gán   └ còn trống
 *
 * ⚠️ TỔNG lấy CON SỐ LỚN, không cộng "đã gán + khả dụng" (user chốt 4/9/2026:
 * "tổng seat đã mua dựa vào 360 + 0"). Hai cách hôm nay ra cùng một số, nhưng
 * con số lớn mới là thứ ChatGPT khai là đã mua — nếu có ngày "Khả dụng" đổi
 * nghĩa (vd trừ luôn lời mời đang chờ) thì phép cộng ra tổng THIẾU, tức tưởng
 * workspace ít suất hơn thật rồi mua thừa bằng TIỀN THẬT.
 *
 * Con số lớn là node rời không nhãn ⇒ chỉ nhận khi nó đứng NGAY TRƯỚC nhãn loại
 * suất, cách tối đa 24 ký tự KHÔNG CÓ CHỮ SỐ (chừa chỗ cho nút "Quản lý" chen
 * giữa). Rào "không có chữ số" là thứ chặn nó vơ nhầm con số của khối khác trên
 * trang ("Business · 340 members" ở phía trên).
 *
 * ⚠️ "Khả dụng" của ChatGPT KHÔNG trừ lời mời đang chờ (user chốt 4/9/2026:
 * lời mời chờ sẽ ăn vào chính con số này khi người ta bấm nhận). Nợ suất của
 * lời mời treo vẫn phải đếm riêng ở tab "Lời mời đang chờ xử lý" — y như DẠNG 1.
 */
const CARD_RE =
  /(\d{1,4})[^\d]{0,24}?(tieu\s*chuan|standard|cao\s*cap|premium|标准|高级)[^\d]{0,24}?(\d{1,4})\s*(?:da\s*gan|assigned|已分配)\s*(\d{1,4})\s*(?:kha\s*dung|con\s*trong|con\s*lai|available|可用)/gi;

/**
 * Lưới đỡ của `CARD_RE`: chỉ cặp ô "340 Đã gán · 20 Khả dụng", không đòi con số
 * lớn lẫn nhãn loại suất.
 *
 * Dùng khi ChatGPT xếp lại thẻ (con số lớn rơi xuống dưới nhãn, nhãn đổi chữ…).
 * Khi đó tổng đành lấy ĐÃ GÁN + KHẢ DỤNG — kém chắc hơn nên chỉ dùng khi đường
 * chính trượt, và loại suất suy từ nhãn đứng gần nhất như DẠNG 1.
 */
const TILE_RE =
  /(\d{1,4})\s*(?:da\s*gan|assigned|已分配)\s*(\d{1,4})\s*(?:kha\s*dung|con\s*trong|con\s*lai|available|可用)/gi;

/** Bao nhiêu ký tự trước ô "Đã gán" được coi là nhãn của thẻ. */
const LOOKBACK = 80;
const LABEL_MAX = 40;

/**
 * Quá số thẻ này là dấu hiệu quét trúng thứ khác (bảng, danh sách) chứ không
 * phải hàng thẻ suất → thà trả null để caller mở hộp đọc tận nơi.
 */
const MAX_CARDS = 8;

const PREMIUM_RE = /cao\s*cap|premium|高级/g;
/** Bản KHÔNG cờ `g` để gọi `.test()` — regex có `g` nhớ `lastIndex` giữa 2 lượt. */
const PREMIUM_ONE = /cao\s*cap|premium|高级/;
const STANDARD_RE = /tieu\s*chuan|standard|标准/g;
/** Neo cắt nhãn: "Suất Tiêu chuẩn" / "Standard seats" / "标准席位". */
const SEAT_WORD_RE = /su[aâ]t|seats?|席位/g;

function isSane(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 9999;
}

/** Vị trí khớp CUỐI CÙNG của `re` trong `text`, hoặc −1. */
function lastIndexOfRe(text: string, re: RegExp): number {
  let last = -1;
  for (const m of text.matchAll(re)) last = m.index ?? last;
  return last;
}

/** Loại suất suy từ nhãn đứng gần ô "Đã gán" NHẤT. */
function classify(window: string): SeatKind {
  const premium = lastIndexOfRe(window, PREMIUM_RE);
  const standard = lastIndexOfRe(window, STANDARD_RE);
  if (premium < 0 && standard < 0) return "unknown";
  return premium > standard ? "premium" : "standard";
}

/**
 * Quét một dạng thẻ trong `norm`, cắt nhãn từ `collapsed` (bản còn dấu).
 *
 * @returns null khi không thấy thẻ nào HOẶC thấy nhiều bất thường (quét trúng
 *   bảng/danh sách chứ không phải hàng thẻ suất) — caller đổi dạng khác / giữ
 *   nguyên đường cũ.
 */
function collectCards(
  norm: string,
  collapsed: string,
  re: RegExp,
  pick: (
    m: RegExpMatchArray,
  ) => {
    assigned: number;
    total: number;
    /** Loại suất đọc được NGAY trong cụm khớp; bỏ trống thì suy từ chữ đứng trước. */
    kind?: SeatKind;
    /** Nhãn thô để ghi nhật ký; bỏ trống thì cắt phần text đứng trước cụm. */
    label?: string;
  } | null,
): SeatCard[] | null {
  const cards: SeatCard[] = [];
  for (const m of norm.matchAll(re)) {
    const got = pick(m);
    if (!got) continue;
    const { assigned, total } = got;
    // KHÔNG đòi assigned <= total: vượt suất là trạng thái hợp lệ trên ChatGPT.
    if (!isSane(assigned) || !isSane(total)) continue;
    const at = m.index ?? 0;
    const from = Math.max(0, at - LOOKBACK);
    const window = norm.slice(from, at);
    const seatWord = lastIndexOfRe(window, SEAT_WORD_RE);
    const labelFrom = seatWord >= 0 ? from + seatWord : at - LABEL_MAX;
    cards.push({
      // Nhãn nằm TRONG cụm vừa khớp thì tin nhãn đó; không thì suy từ chữ đứng
      // trước cụm như DẠNG 1.
      kind: got.kind ?? classify(window),
      label: got.label ?? collapsed.slice(Math.max(0, labelFrom), at).trim(),
      assigned,
      total,
    });
    if (cards.length > MAX_CARDS) return null;
  }
  return cards.length > 0 ? cards : null;
}

/**
 * Quét MỌI ô "Đã gán" trong một khối text rồi cộng lại.
 *
 * @param text text của trang Thành viên (hoặc của hộp "Quản lý suất").
 * @returns null khi không thấy ô nào — caller giữ nguyên đường cũ.
 */
export function parseSeatCards(text: string): SeatCardsReading | null {
  const collapsed = (text ?? "").replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  // Bản thường hoá dài BẰNG ĐÚNG `collapsed` (1 ký tự → 1 ký tự) nên index khớp
  // trên bản này cắt thẳng ra bản gốc để lấy nhãn còn dấu.
  const norm = normalizeForMatch(collapsed);

  // DẠNG 1 trước, hết mới tới DẠNG 2 (thẻ đủ → chỉ còn cặp ô): các dạng không
  // bao giờ cùng xuất hiện, mà quét gộp thì cụm số của thẻ này có thể ghép nhầm
  // với nhãn của thẻ kia. Tách hẳn từng lượt là không có gì để ghép nhầm.
  const cards =
    collectCards(norm, collapsed, BADGE_RE, (m) => ({
      assigned: parseInt(m[1] ?? m[3], 10),
      total: parseInt(m[2] ?? m[4], 10),
    })) ??
    collectCards(norm, collapsed, CARD_RE, (m) => {
      // m[1] = con số lớn (TỔNG ĐÃ MUA), m[2] = nhãn loại, m[3] = đã gán.
      // m[4] (khả dụng) cố tình KHÔNG dùng: `free` suy từ total − assigned.
      const at = (m.index ?? 0) + m[0].indexOf(m[2]);
      return {
        total: parseInt(m[1], 10),
        kind: PREMIUM_ONE.test(m[2]) ? ("premium" as const) : ("standard" as const),
        assigned: parseInt(m[3], 10),
        label: collapsed.slice(at, at + m[2].length).trim(),
      };
    }) ??
    collectCards(norm, collapsed, TILE_RE, (m) => {
      const assigned = parseInt(m[1], 10);
      const free = parseInt(m[2], 10);
      if (!isSane(assigned) || !isSane(free)) return null;
      return { assigned, total: assigned + free };
    });
  if (!cards) return null;

  const total = cards.reduce((s, c) => s + c.total, 0);
  const assigned = cards.reduce((s, c) => s + c.assigned, 0);
  return {
    cards,
    total,
    assigned,
    free: Math.max(0, total - assigned),
    // Đếm theo SỐ THẺ CÓ SUẤT chứ không theo nhãn: workspace 62 Tiêu chuẩn + 0
    // Cao cấp chỉ có MỘT loại suất thật, mua bán không mập mờ gì cả. Cách đếm
    // này cũng không phụ thuộc ngôn ngữ của nhãn.
    mixed: cards.filter((c) => c.total > 0).length > 1,
  };
}

/** Một dòng tóm tắt để ghi nhật ký / gắn vào result của task. */
export function describeSeatCards(reading: SeatCardsReading): string {
  const parts = reading.cards.map(
    (c) => `${c.label || c.kind} ${c.assigned}/${c.total}`,
  );
  return `${parts.join(" · ")} → tổng ${reading.total} suất, đã gán ${reading.assigned}`;
}

/**
 * Chỉ nhận hộp thoại THẬT. KHÔNG dùng `[data-state="open"]` như các chỗ khác:
 * Radix gắn nó cho cả những thứ không phải hộp thoại (menu, khối gập), mà ở đây
 * nhận nhầm là bỏ luôn đường đọc nhanh.
 */
const REAL_DIALOG_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [aria-modal="true"]';

/**
 * Đọc hàng thẻ suất trên trang Thành viên đang mở.
 *
 * Trả null khi không đọc được — caller phải giữ nguyên đường cũ (mở hộp "Quản
 * lý suất") chứ không được coi là "workspace không có suất".
 */
export function readSeatCardsFromPage(): SeatCardsReading | null {
  const body = document.body;
  if (!body) return null;
  // Hộp thoại đang mở in LẠI chính những con số này (hộp "Quản lý suất" có dòng
  // tỉ lệ riêng) → cộng dồn hai nguồn là ra số sai. Thấy hộp nào có ô "Đã gán"
  // thì bỏ hẳn đường đọc nhanh.
  for (const d of Array.from(
    document.querySelectorAll<HTMLElement>(REAL_DIALOG_SELECTOR),
  )) {
    if (parseSeatCards(d.textContent ?? "")) return null;
  }
  return parseSeatCards(body.innerText || body.textContent || "");
}

/** Cặp số tổng suất rút từ hàng thẻ — đủ để so hai thời điểm với nhau. */
export type SeatTotals = {
  /** Σ suất đã mua của MỌI loại. */
  total: number;
  /**
   * Suất TIÊU CHUẨN đã mua — loại duy nhất luồng mua đụng tới (bộ đếm trong hộp
   * "Quản lý suất" bị ghim vào hàng Tiêu chuẩn). null khi không tách được loại
   * từ nhãn ⇒ caller so bằng `total`.
   */
  standard: number | null;
};

export function seatTotalsOf(reading: SeatCardsReading): SeatTotals {
  const std = reading.cards.filter((c) => c.kind === "standard");
  return {
    total: reading.total,
    standard:
      std.length > 0
        ? std.reduce((s, c) => s + c.total, 0)
        : // Đúng MỘT thẻ mà nhãn không nói ra loại → workspace chỉ có một loại
          // suất, con số đó chính là suất Tiêu chuẩn.
          reading.cards.length === 1
          ? reading.cards[0].total
          : null,
  };
}

/** Đọc cặp số tổng suất trên trang Thành viên đang mở, null khi không đọc được. */
export function readSeatTotalsFromPage(): SeatTotals | null {
  const reading = readSeatCardsFromPage();
  return reading ? seatTotalsOf(reading) : null;
}

/**
 * Số suất TĂNG THÊM giữa hai lần đọc hàng thẻ.
 *
 * Ưu tiên so theo suất Tiêu chuẩn: đó là loại luồng mua thật sự thêm vào, và so
 * theo tổng gộp sẽ nuốt mất trường hợp admin khác vừa đổi suất Cao cấp cùng lúc.
 * Chỉ khi một trong hai lần đọc không tách được loại mới rơi về tổng gộp.
 *
 * Xuất khẩu để test được — đây là chốt "đã mua xong chưa" thay cho việc mở lại
 * hộp "Quản lý suất" (user 2026-08-26).
 */
export function seatIncrease(
  before: SeatTotals,
  after: SeatTotals,
): { delta: number; basis: "standard" | "total" } {
  if (before.standard !== null && after.standard !== null) {
    return { delta: after.standard - before.standard, basis: "standard" };
  }
  return { delta: after.total - before.total, basis: "total" };
}
