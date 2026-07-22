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

export type FilterResolution =
  /** Ô lọc trả về row khớp → member CÒN trong tab Người dùng. */
  | { outcome: "found"; row: HTMLElement }
  /** Ô lọc đã LOAD XONG và không có row nào khớp → member ĐÃ RỜI workspace. */
  | { outcome: "absent"; rows_before: number }
  /** Không kết luận được (ô lọc không có / list không hề phản hồi query). */
  | { outcome: "inconclusive"; reason: string; rows_before: number };

/** Tổng thời gian chờ list phản hồi query lọc (1 lần gõ duy nhất). */
const FILTER_LOAD_TIMEOUT_MS = 12_000;
/** Chờ list ổn định sau khi thấy nó đổi, trước khi chốt "không có row". */
const FILTER_SETTLE_MS = 1200;

/**
 * LỌC MỘT LẦN rồi CHỜ LOAD XONG — nguồn sự thật cho "member còn hay đã rời".
 *
 * Quy tắc nghiệp vụ (user 2026-07-22): *"nhập toàn bộ địa chỉ email vào ô tìm
 * kiếm 1 LẦN rồi chờ nó load thành công mà không thấy là chắc chắn email đó bị
 * xoá rồi"*. Gõ đi gõ lại 2-3 lần là thừa — nó không làm kết quả đáng tin hơn,
 * chỉ tốn thời gian (mỗi task xoá vốn chỉ có ngân sách 150s).
 *
 * Mấu chốt KHÔNG nằm ở số lần gõ mà ở chỗ **phân biệt "list đã load xong và
 * trống" với "list chưa hề chạy query"**. Tab admin chạy NỀN bị Chrome throttle
 * ~1000ms → chuỗi event `input` có khi bị nuốt → fetch lọc KHÔNG kích hoạt →
 * list đứng im ở trạng thái cũ. Khi đó "0 row khớp" KHÔNG có nghĩa là vắng mặt —
 * đây đúng là nguồn gốc bug xoá-giả tháng 6-7/2026 (mark removed cho member vẫn
 * còn → đồng bộ hồi sinh → vòng lặp). Nên ta đo bằng chứng list ĐÃ PHẢN HỒI:
 *
 *   1. Đảm bảo ô lọc trống → đếm `rows_before` (list đầy đủ).
 *   2. Gõ TOÀN BỘ email, ĐÚNG MỘT LẦN.
 *   3. Chờ tới 12s cho MỘT trong hai dấu hiệu list đã chạy query:
 *        · row khớp email xuất hiện          → `found`
 *        · số row ĐỔI khác `rows_before`     → query đã chạy; chờ ổn định 1.2s
 *          rồi soi lại lần chót (bắt ca render trễ) → vẫn không có → `absent`
 *   4. Hết 12s mà list KHÔNG hề đổi → query chưa từng chạy → `inconclusive`,
 *      caller giữ member (thà chậm còn hơn xoá-giả).
 *
 * Không có ô lọc → `inconclusive` luôn: khi đó chỉ còn scroll-scan, mà scroll-scan
 * trên list VIRTUALIZED chỉ thấy vài row gần đỉnh nên "không thấy" là vô nghĩa.
 */
export async function filterOnceAndResolve(email: string): Promise<FilterResolution> {
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
  const rowsBefore = visibleRowCount();

  // Bước 2: gõ TOÀN BỘ email — một lần duy nhất.
  await humanType(input, email);
  console.log(
    `${LOG} lọc "${email}" (1 lần) — list trước khi lọc: ${rowsBefore} row`,
  );

  // Bước 3: chờ list phản hồi.
  const deadline = Date.now() + FILTER_LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const row = findMemberRow(email);
    if (row) {
      console.log(`${LOG} ✓ thấy row "${email}" → member CÒN trong workspace`);
      return { outcome: "found", row };
    }
    if (visibleRowCount() !== rowsBefore) {
      // List ĐÃ render lại theo query ⇒ fetch lọc chạy thật. Chờ ổn định rồi soi
      // lần chót: ChatGPT có thể nháy 0 row lúc loading rồi mới đổ row khớp vào.
      await sleep(FILTER_SETTLE_MS);
      const late = findMemberRow(email);
      if (late) {
        console.log(`${LOG} ✓ row "${email}" hiện TRỄ → member CÒN (không xoá oan)`);
        return { outcome: "found", row: late };
      }
      console.log(
        `${LOG} ✓ lọc đã load xong, KHÔNG có row khớp "${email}" → đã rời workspace`,
      );
      return { outcome: "absent", rows_before: rowsBefore };
    }
    await sleep(250);
  }

  // List đứng im suốt 12s: không ra row khớp, cũng không đổi số row ⇒ query lọc
  // chưa từng chạy (event `input` bị throttle nuốt / ChatGPT đổi DOM ô lọc).
  console.warn(
    `${LOG} lọc "${email}": list KHÔNG phản hồi sau ${FILTER_LOAD_TIMEOUT_MS}ms ` +
      `(vẫn ${rowsBefore} row) → KHÔNG kết luận được`,
  );
  return {
    outcome: "inconclusive",
    reason: "filter_never_applied",
    rows_before: rowsBefore,
  };
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
