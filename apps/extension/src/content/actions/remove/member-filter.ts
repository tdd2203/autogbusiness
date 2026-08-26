import { humanType, querySelectorFirst, sleep, waitFor } from "../../human";
import { SELECTORS } from "../../selectors";
import { findMemberRow } from "../member-row";

const LOG = "[autogpt-locate]";

/**
 * Tìm input "Lọc theo tên" trên tab Người dùng /admin/members.
 * UI 2026 có ô search filter list — dùng để zoom thẳng vào row cần xoá thay
 * vì scroll qua hết list (failmode khi list > 50 row).
 */
export function findMemberFilterInput(): HTMLInputElement | null {
  return querySelectorFirst<HTMLInputElement>(SELECTORS.memberFilterInput);
}

/**
 * Filter list xuống chỉ còn row khớp email, rồi đợi DOM render xong.
 * Trả về row tìm được, hoặc null nếu hết timeout vẫn không có row khớp.
 *
 * Nếu không tìm được filter input → fallback scroll-find theo cách cũ
 * (findMemberRow trực tiếp trên DOM hiện tại).
 */
/** Đếm số row member đang hiển thị (debug). */
function visibleRowCount(): number {
  return document.querySelectorAll(
    'tr[data-testid^="member-row"], table tbody tr, [role="row"]',
  ).length;
}

export async function filterAndFindRow(email: string): Promise<HTMLElement | null> {
  // Tab mới (v0.8.13: mỗi action mở /admin/members MỚI) → content chạy NGAY khi
  // trang vừa load, ô lọc có thể CHƯA render → tra 1 lần sẽ null → fast-path bị bỏ
  // qua oan, rớt xuống scroll-scan chậm/ồn. POLL chờ ô lọc render tới 8s rồi mới
  // kết luận "không có ô lọc". Cùng lớp render-wait như clickTabAndWait
  // (waitForButtonMs) — nhưng cho ô lọc thay vì nút tab.
  let input = findMemberFilterInput();
  if (!input) {
    try {
      input = await waitFor(() => findMemberFilterInput(), 8000, 250);
    } catch {
      input = null;
    }
  }
  if (!input) {
    console.warn(
      "[autogpt-locate] KHÔNG tìm được ô lọc sau 8s — fallback scroll-find",
    );
    return findMemberRow(email);
  }
  console.log(
    `[autogpt-locate] ô lọc OK (placeholder="${input.placeholder}"), tìm ${email}`,
  );

  // Gõ CHÍNH XÁC email ĐẦY ĐỦ (user 2026-07-13: không gõ nửa (local-part) rồi gõ
  // full = 2 lần tra, tốn thời gian). ChatGPT "Filter by name" match cả email.
  //
  // FALSE-NEGATIVE OAN (user report 2026-07-21: "đồng bộ mấy lần vẫn còn pending
  // dù đã tham gia thật"): tab admin ChatGPT chạy NỀN (runner mở active:false) →
  // Chrome THROTTLE timer tab nền ~1000ms → chuỗi event `input` khi gõ ô lọc THI
  // THOẢNG bị nuốt/gộp → fetch server-side KHÔNG kích hoạt → list không bao giờ
  // hiện row trong cửa sổ chờ → báo "không có row" oan (member đã active). Bằng
  // chứng DB: cùng batch sync lại sau ~90s thì mọi email ra 'active'. Chờ LÂU HƠN
  // vô ích (đã chờ ~4.7s vẫn miss) — phải GÕ LẠI để kích hoạt lại fetch. Nên: thử
  // tối đa 2 lần, mỗi lần clear + gõ lại; chỉ kết luận null sau khi cả 2 lần miss.
  const ATTEMPTS = 2;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Query lần trước có thể đã bị throttle nuốt → clear + gõ lại để kích hoạt
      // lại fetch lọc (chứ không chờ dài thêm — chờ không cứu được query bị nuốt).
      await clearMemberFilter();
      await sleep(400);
    }
    await humanType(input, email);
    await sleep(600); // chờ React Query / debounce filter
    console.log(
      `[autogpt-locate] đã lọc "${email}" (lần ${attempt + 1}/${ATTEMPTS}) → ${visibleRowCount()} row hiển thị`,
    );
    try {
      const row = await waitFor(() => findMemberRow(email), 3000, 200);
      if (row) {
        console.log(
          `[autogpt-locate] ✓ thấy row sau khi lọc "${email}" (lần ${attempt + 1})`,
        );
        return row;
      }
    } catch {
      console.warn(
        `[autogpt-locate] lọc "${email}" lần ${attempt + 1} không ra row`,
      );
    }
  }
  console.warn(
    `[autogpt-locate] lọc "${email}" MISS sau ${ATTEMPTS} lần gõ lại → coi như không có ở tab này`,
  );
  return null;
}

/** Bắt chuỗi email đầu tiên trong text của 1 row. */
const EMAIL_IN_ROW = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/**
 * Email đọc được từ các row ĐANG render (dedupe theo element).
 *
 * Dùng để biết ô lọc ĐÃ CHẠY hay chưa mà KHÔNG cần gõ lại: list còn nguyên row
 * của người khác ⇒ query chưa áp dụng; list trống / chỉ còn row khớp ⇒ đã áp dụng.
 */
function renderedRowEmails(): string[] {
  const seen = new Set<Element>();
  const emails: string[] = [];
  for (const sel of SELECTORS.memberRow) {
    for (const row of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (seen.has(row)) continue;
      seen.add(row);
      const m = (row.textContent ?? "").match(EMAIL_IN_ROW);
      if (m) emails.push(m[0].toLowerCase());
    }
  }
  return emails;
}

/** "Ảnh chụp" trạng thái list — đổi chuỗi này ⇒ list đã render lại theo query. */
function listSignature(): string {
  return `${visibleRowCount()}|${renderedRowEmails().join(",")}`;
}

export type FilterLookup = {
  /**
   * found = có row khớp; absent = ô lọc đã chạy và KHÔNG có row khớp;
   * inconclusive = không đủ căn cứ kết luận (caller đừng ghi gì).
   */
  outcome: "found" | "absent" | "inconclusive";
  row?: HTMLElement;
  /** Chỉ có khi outcome='inconclusive'. */
  reason?: string;
  /** List có PHẢN HỒI query lần này không (bằng chứng ô lọc còn sống). */
  filterResponded: boolean;
};

/** Chờ ChatGPT debounce ô lọc trước khi soi row. */
const LOOKUP_DEBOUNCE_MS = 600;
/** Soi row khớp bấy nhiêu lâu sau debounce (lọc là server-side, row về trễ). */
const LOOKUP_ROW_WAIT_MS = 4000;
/** List đã render lại nhưng chưa thấy row → soi thêm bấy nhiêu, bắt row về trễ. */
const LOOKUP_LATE_MS = 1500;
const LOOKUP_POLL_MS = 200;

/**
 * Tra 1 email bằng ô "Lọc theo tên" — GÕ ĐÚNG MỘT LẦN (user 2026-08-26:
 * *"đồng bộ hàng loạt thì chỉ cần tìm 1 lần, không cần nhập email vào ô tìm kiếm
 * 2 lần"*).
 *
 * `filterAndFindRow` (v0.9.21) gõ lại lần hai MỖI KHI không thấy row. Với lệnh
 * "Đồng bộ (kiểm tra đã tham gia)" thì gần như email nào cũng miss (đang chờ
 * tham gia = không có ở tab Người dùng), nên lần gõ thứ hai luôn cho cùng kết
 * quả mà tốn thêm ~4s/email — 20 email là ~80s gõ vô ích.
 *
 * Lần gõ thứ hai vốn sinh ra để cứu ca "event `input` bị Chrome throttle nuốt ở
 * tab nền → fetch lọc chưa từng chạy → miss OAN". Ca đó KHÔNG cần gõ lại mới
 * nhận ra: nếu query đã chạy thì LIST PHẢI RENDER LẠI (`listSignature` đổi).
 * Nên ở đây gõ 1 lần rồi đọc bằng chứng:
 *   · thấy row                    → found
 *   · list đã render lại, không row → absent (kết luận ngay, KHÔNG gõ lại)
 *   · list đứng im như tờ          → query chưa chạy → mới gõ lại lần hai
 *
 * `opts.assumeFilterAlive`: caller (vòng lặp hàng loạt) đã thấy ô lọc phản hồi ở
 * email TRƯỚC ⇒ ô lọc còn sống. Khi ấy "list đứng im" là chuyện thường — list
 * đang trống sẵn từ email trước, lọc email mới cũng trống thì có gì để đổi — nên
 * kết luận absent luôn thay vì gõ lại.
 */
export async function filterLookupOnce(
  email: string,
  opts: { assumeFilterAlive?: boolean } = {},
): Promise<FilterLookup> {
  const target = email.trim().toLowerCase();
  let input = findMemberFilterInput();
  if (!input) {
    try {
      input = await waitFor(() => findMemberFilterInput(), 8000, 250);
    } catch {
      input = null;
    }
  }
  if (!input) {
    return { outcome: "inconclusive", reason: "no_filter_input", filterResponded: false };
  }

  const MAX_TYPES = 2;
  for (let attempt = 1; attempt <= MAX_TYPES; attempt++) {
    if (attempt > 1) {
      // Chỉ tới đây khi lần gõ trước KHÔNG hề làm list nhúc nhích ⇒ query bị nuốt.
      await clearMemberFilter();
      await sleep(400);
      input = findMemberFilterInput() ?? input;
    }
    const before = listSignature();
    await humanType(input, target);
    await sleep(LOOKUP_DEBOUNCE_MS);

    let responded = listSignature() !== before;
    const deadline = Date.now() + LOOKUP_ROW_WAIT_MS;
    while (Date.now() < deadline) {
      const row = findMemberRow(target);
      if (row) {
        console.log(`${LOG} ✓ thấy row "${target}" (gõ ${attempt} lần)`);
        return { outcome: "found", row, filterResponded: true };
      }
      if (!responded && listSignature() !== before) responded = true;
      await sleep(LOOKUP_POLL_MS);
    }

    if (responded) {
      // List đã render lại theo query mà chưa có row: lọc server-side hay nháy
      // trống trước rồi mới đổ row → soi nốt một nhịp ngắn cho chắc.
      const lateDeadline = Date.now() + LOOKUP_LATE_MS;
      while (Date.now() < lateDeadline) {
        await sleep(LOOKUP_POLL_MS);
        const late = findMemberRow(target);
        if (late) {
          console.log(`${LOG} ✓ row "${target}" hiện TRỄ`);
          return { outcome: "found", row: late, filterResponded: true };
        }
      }
      console.log(`${LOG} lọc "${target}" đã chạy, KHÔNG có row khớp → vắng mặt`);
      return { outcome: "absent", filterResponded: true };
    }

    if (opts.assumeFilterAlive) {
      // Ô lọc đã chứng minh còn sống ở email trước trong CÙNG mẻ này; list vốn
      // đang trống nên không có gì để "đổi". Gõ lại cũng chỉ ra đúng thế.
      console.log(
        `${LOG} lọc "${target}": list vốn trống, ô lọc đã chứng minh còn sống → vắng mặt`,
      );
      return { outcome: "absent", filterResponded: false };
    }

    console.warn(
      `${LOG} lọc "${target}" (lần ${attempt}): list KHÔNG hề đổi ⇒ query chưa chạy` +
        (attempt < MAX_TYPES ? " → gõ lại" : ""),
    );
  }

  return {
    outcome: "inconclusive",
    reason: "filter_never_applied",
    filterResponded: false,
  };
}

export type FilterResolution =
  /** Ô lọc trả về row khớp → member CÒN trong tab Người dùng. */
  | { outcome: "found"; row: HTMLElement }
  /** Ô lọc đã LOAD XONG và không có row nào khớp → member ĐÃ RỜI workspace. */
  | { outcome: "absent"; rows_before: number }
  /** Không kết luận được (ô lọc không có / list không hề phản hồi query). */
  | { outcome: "inconclusive"; reason: string; rows_before: number };

export type FilterResolveOptions = {
  /**
   * Số vòng lọc ĐỘC LẬP phải cùng ra "không có row" mới dám kết luận `absent`.
   * Mặc định 2 (xem docstring `filterOnceAndResolve`). Đường xác minh SAU KHI
   * CLICK có thể hạ xuống 1 nếu cần tiết kiệm ngân sách 45s.
   */
  confirmRounds?: number;
  /**
   * Chờ list ĐỨNG YÊN trước khi lấy mốc `rows_before`. Mặc định true — bắt buộc
   * cho lần tra TRƯỚC KHI CLICK (tab vừa mở, list còn đang stream). Đường xác
   * minh sau click tắt cờ này: list vừa bị chính cú click làm đổi, chờ "đứng
   * yên" chỉ đốt thời gian.
   */
  requireStableList?: boolean;
};

/** Tổng thời gian chờ list phản hồi query lọc (mỗi vòng gõ). */
const FILTER_LOAD_TIMEOUT_MS = 12_000;
/**
 * Sau khi list đã phản hồi query mà CHƯA thấy row: soi tiếp bấy nhiêu lâu nữa
 * (poll liên tục, không phải chờ 1 nhịp rồi chốt). Lọc của ChatGPT là
 * SERVER-SIDE: list nháy trống/skeleton trước, row khớp mới đổ về sau — bug
 * 2026-08 chốt `absent` sau đúng 1 nhịp 1.2s nên bắt trọn khoảng nháy này.
 */
const LATE_ROW_POLL_MS = 6000;
/** List phải đọc được BẤY NHIÊU lần liên tiếp cùng số row thì mới coi là đứng yên. */
const STABLE_HITS = 3;
const STABLE_POLL_MS = 400;
/** Trần chờ list đứng yên trước khi gõ (tab vừa mở còn đang stream row). */
const LIST_SETTLE_TIMEOUT_MS = 8000;
/** Trần chờ list ĐẦY LẠI sau khi clear ô lọc (positive control giữa 2 vòng). */
const LIST_RESTORE_TIMEOUT_MS = 8000;
/** Mặc định: 2 vòng lọc độc lập cùng trống mới kết luận vắng mặt. */
const ABSENCE_CONFIRM_ROUNDS = 2;

/**
 * Poll `visibleRowCount()` tới khi ĐỨNG YÊN (STABLE_HITS lần đọc liên tiếp bằng
 * nhau, và > 0). Trả về số row ổn định, hoặc null nếu hết hạn vẫn nhảy số.
 *
 * Vì sao cần: mỗi action mở TAB MỚI `/admin/members` (v0.8.13) → khi content
 * script chạy, list còn đang stream/virtualize nên số row TỰ TĂNG. Lấy
 * `rows_before` ngay lúc đó rồi coi "số row đổi = query lọc đã chạy" là SAI —
 * nó đổi vì list vẫn đang load. Đó chính là kẽ hở gây xoá-giả 09/8/2026.
 */
async function waitForStableRowCount(timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let hits = 0;
  while (Date.now() < deadline) {
    const n = visibleRowCount();
    if (n === last) {
      hits += 1;
      if (hits >= STABLE_HITS && n > 0) return n;
    } else {
      last = n;
      hits = 1;
    }
    await sleep(STABLE_POLL_MS);
  }
  return null;
}

type FilterRound =
  | { outcome: "found"; row: HTMLElement }
  /** List đã phản hồi query và không có row khớp. `rows_filtered` = số row lúc chốt. */
  | { outcome: "empty"; rows_filtered: number }
  /** List không hề nhúc nhích trong FILTER_LOAD_TIMEOUT_MS ⇒ query chưa từng chạy. */
  | { outcome: "no_response" };

/** Một vòng: gõ đủ email → chờ list phản hồi → soi row (kể cả row về TRỄ). */
async function filterRound(
  input: HTMLInputElement,
  email: string,
  rowsBefore: number,
  round: number,
): Promise<FilterRound> {
  await humanType(input, email);
  console.log(
    `${LOG} lọc "${email}" (vòng ${round}) — list trước khi lọc: ${rowsBefore} row`,
  );
  const deadline = Date.now() + FILTER_LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const row = findMemberRow(email);
    if (row) return { outcome: "found", row };
    if (visibleRowCount() !== rowsBefore) {
      // List đã render lại theo query. Row khớp VẪN có thể về trễ (fetch
      // server-side) → soi liên tục thêm LATE_ROW_POLL_MS rồi mới dám nói trống.
      const lateDeadline = Date.now() + LATE_ROW_POLL_MS;
      while (Date.now() < lateDeadline) {
        await sleep(300);
        const late = findMemberRow(email);
        if (late) {
          console.log(
            `${LOG} ✓ row "${email}" hiện TRỄ (vòng ${round}) → member CÒN, không xoá oan`,
          );
          return { outcome: "found", row: late };
        }
      }
      return { outcome: "empty", rows_filtered: visibleRowCount() };
    }
    await sleep(250);
  }
  return { outcome: "no_response" };
}

/**
 * LỌC rồi CHỜ LOAD XONG — nguồn sự thật cho "member còn hay đã rời".
 *
 * Quy tắc nghiệp vụ (user 2026-07-22): *"nhập toàn bộ địa chỉ email vào ô tìm
 * kiếm rồi chờ nó load thành công mà không thấy là chắc chắn email đó bị xoá
 * rồi"*. Mấu chốt KHÔNG nằm ở số lần gõ mà ở chỗ **phân biệt "list đã load xong
 * và trống" với "list chưa hề chạy query"**: kết luận `absent` khiến backend
 * mark removed KHÔNG CẦN CLICK, nên sai một lần là member vẫn nằm trên ChatGPT
 * (vẫn ăn ghế) mà dashboard tưởng đã xoá — xoá-giả.
 *
 * Bản trước đo bằng chứng "list đã phản hồi" bằng MỘT dấu hiệu duy nhất: số row
 * khác `rows_before`, rồi chờ đúng 1.2s là chốt. Cả hai vế đều thủng (sự cố
 * 03→12/8/2026: 4 email bị xoá-giả — chi tiết ca cụ thể xem nhật ký nội bộ):
 *   · `rows_before` chụp lúc list CÒN ĐANG LOAD → số row tự tăng → tưởng query
 *     đã chạy;
 *   · lọc là server-side, list nháy trống rồi mới đổ row → 1.2s là quá ngắn.
 *
 * Nên giờ đòi ĐÚNG hợp đồng mà `completion.py` vẫn ghi (nhưng bản cũ chưa hề
 * thực thi): *"lọc không ra email VÀ đã chứng minh ô lọc còn sống"*:
 *
 *   1. Ô lọc trống → chờ list ĐỨNG YÊN → `rows_before` (list đầy đủ, đã load
 *      xong). Không đứng yên nổi trong 8s → `inconclusive` (list còn đang load,
 *      mọi kết luận vắng mặt đều vô nghĩa).
 *   2. Vòng lọc: gõ TOÀN BỘ email → chờ tới 12s cho list phản hồi → nếu trống
 *      thì soi thêm 6s bắt row về trễ.
 *   3. POSITIVE CONTROL: clear ô lọc, list PHẢI đầy lại. Không đầy lại →
 *      `inconclusive` (ô lọc/list đã chết, "trống" ở vòng 1 không đáng tin).
 *   4. Lặp lại vòng lọc. CHỈ khi cả `confirmRounds` vòng độc lập đều trống mới
 *      trả `absent`.
 *   5. Bất kỳ vòng nào list không hề đổi → `inconclusive`, caller GIỮ member
 *      (thà chậm còn hơn xoá-giả).
 *
 * Không có ô lọc → `inconclusive` luôn: khi đó chỉ còn scroll-scan, mà scroll-scan
 * trên list VIRTUALIZED chỉ thấy vài row gần đỉnh nên "không thấy" là vô nghĩa.
 */
export async function filterOnceAndResolve(
  email: string,
  opts: FilterResolveOptions = {},
): Promise<FilterResolution> {
  const confirmRounds = Math.max(1, opts.confirmRounds ?? ABSENCE_CONFIRM_ROUNDS);
  const requireStableList = opts.requireStableList ?? true;

  let input = findMemberFilterInput();
  if (!input) {
    try {
      input = await waitFor(() => findMemberFilterInput(), 8000, 250);
    } catch {
      input = null;
    }
  }
  if (!input) {
    return { outcome: "inconclusive", reason: "no_filter_input", rows_before: 0 };
  }

  // Bước 1: ô lọc phải trống thì `rows_before` mới là "list đầy đủ" để so sánh.
  if (input.value) {
    await clearMemberFilter();
    await sleep(800);
    input = findMemberFilterInput() ?? input;
  }
  let rowsBefore = visibleRowCount();
  if (requireStableList) {
    const stable = await waitForStableRowCount(LIST_SETTLE_TIMEOUT_MS);
    if (stable === null) {
      console.warn(
        `${LOG} list KHÔNG đứng yên sau ${LIST_SETTLE_TIMEOUT_MS}ms (đang ${visibleRowCount()} row) ` +
          `→ chưa load xong → KHÔNG kết luận vắng mặt`,
      );
      return {
        outcome: "inconclusive",
        reason: "list_never_settled",
        rows_before: visibleRowCount(),
      };
    }
    rowsBefore = stable;
  }
  if (rowsBefore === 0) {
    // List trống trơn TRƯỚC khi lọc: không có gì để so sánh, và "không thấy row"
    // là đương nhiên. Ca này chỉ xảy ra khi list chưa render / DOM đổi selector.
    return {
      outcome: "inconclusive",
      reason: "empty_list_before_filter",
      rows_before: 0,
    };
  }

  let lastFiltered = 0;
  for (let round = 1; round <= confirmRounds; round++) {
    if (round > 1) {
      // POSITIVE CONTROL: clear lọc → list phải ĐẦY LẠI. Đây chính là bằng chứng
      // "ô lọc còn sống" — nếu list đứng im ở trạng thái đã lọc thì cái "trống" ở
      // vòng trước là do ô lọc chết chứ không phải member vắng mặt.
      await clearMemberFilter();
      const restored = await waitForStableRowCount(LIST_RESTORE_TIMEOUT_MS);
      if (restored === null || restored <= lastFiltered) {
        console.warn(
          `${LOG} clear lọc mà list KHÔNG đầy lại (${restored ?? "không ổn định"} ≤ ${lastFiltered} row) ` +
            `→ ô lọc không điều khiển được list → KHÔNG kết luận vắng mặt`,
        );
        return {
          outcome: "inconclusive",
          reason: "filter_box_dead",
          rows_before: rowsBefore,
        };
      }
      rowsBefore = restored;
      input = findMemberFilterInput() ?? input;
    }

    const r = await filterRound(input, email, rowsBefore, round);
    if (r.outcome === "found") {
      console.log(
        `${LOG} ✓ thấy row "${email}" (vòng ${round}) → member CÒN trong workspace`,
      );
      return { outcome: "found", row: r.row };
    }
    if (r.outcome === "no_response") {
      // List đứng im suốt 12s: không ra row khớp, cũng không đổi số row ⇒ query
      // lọc chưa từng chạy (event `input` bị throttle nuốt / ChatGPT đổi DOM).
      console.warn(
        `${LOG} lọc "${email}" vòng ${round}: list KHÔNG phản hồi sau ${FILTER_LOAD_TIMEOUT_MS}ms ` +
          `(vẫn ${rowsBefore} row) → KHÔNG kết luận được`,
      );
      return {
        outcome: "inconclusive",
        reason: `filter_never_applied_round_${round}`,
        rows_before: rowsBefore,
      };
    }
    lastFiltered = r.rows_filtered;
    console.log(
      `${LOG} vòng ${round}/${confirmRounds}: lọc đã load xong, KHÔNG có row khớp "${email}"`,
    );
  }

  console.log(
    `${LOG} ✓ ${confirmRounds} vòng lọc độc lập đều trống + ô lọc chứng minh còn sống ` +
      `→ "${email}" đã rời workspace`,
  );
  return { outcome: "absent", rows_before: rowsBefore };
}

/**
 * Clear filter input để list về trạng thái ban đầu sau khi xoá xong.
 * Best-effort — không throw nếu input đã unmount.
 */
export async function clearMemberFilter(): Promise<void> {
  try {
    const input = findMemberFilterInput();
    if (!input) return;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    nativeSetter?.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (e) {
    console.warn("[autogpt-remove] clear filter failed:", e);
  }
}
