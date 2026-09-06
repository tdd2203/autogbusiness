import { humanType, querySelectorFirst, sleep, waitFor } from "../../human";
import { SELECTORS } from "../../selectors";
import { readPendingSnapshot } from "../invite/pending-list-loaded";
import { findMemberRow } from "../member-row";
import { scrollScanForRow } from "../remove/locate-member";
import { findPaginationState } from "../sync/pagination";

/**
 * Ô "Search for invites" trên tab "Lời mời đang chờ xử lý". Thử
 * `pendingSearchInput` (placeholder "Search for invites", thường type=text)
 * trước, rồi fallback `memberFilterInput`.
 */
function findPendingSearchInput(): HTMLInputElement | null {
  return (
    querySelectorFirst<HTMLInputElement>(SELECTORS.pendingSearchInput) ??
    querySelectorFirst<HTMLInputElement>(SELECTORS.memberFilterInput)
  );
}

/** Clear ô search về rỗng để list pending về đầy đủ giữa các email. */
function clearPendingSearch(input: HTMLInputElement): void {
  try {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    nativeSetter?.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (e) {
    console.warn("[autogpt-revoke] clear pending search failed:", e);
  }
}

/** Danh sách phải đọc được bấy nhiêu lần liên tiếp cùng số dòng mới coi là đứng yên. */
const STABLE_HITS = 3;
const STABLE_POLL_MS = 400;
/** Trần chờ danh sách ĐẦY LẠI sau khi xoá ô tìm kiếm (positive control). */
const RESTORE_TIMEOUT_MS = 8_000;
/** Sau khi gõ, soi tiếp bấy nhiêu lâu để bắt row về TRỄ (tìm kiếm là server-side). */
const LATE_ROW_POLL_MS = 3_000;

/** Số dòng ĐANG HIỆN của danh sách lời mời — mốc so cho positive control. */
function pendingRowCount(): number {
  return readPendingSnapshot().rows;
}

/** Chờ số dòng ĐỨNG YÊN (3 lần đọc liên tiếp bằng nhau và > 0). */
async function waitForStablePendingRows(timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let hits = 0;
  while (Date.now() < deadline) {
    const n = pendingRowCount();
    if (n > 0 && n === last) {
      hits += 1;
      if (hits >= STABLE_HITS) return n;
    } else {
      hits = 0;
      last = n;
    }
    await sleep(STABLE_POLL_MS);
  }
  return null;
}

export type PendingLookup =
  /** Có row mang email này trên tab "Lời mời". */
  | { outcome: "found"; row: HTMLElement }
  /** ĐÃ CHỨNG MINH được là không có: ô tìm kiếm trống, và nó còn điều khiển được list. */
  | { outcome: "absent"; rows_before: number }
  /** Chưa chứng minh được gì (không có ô tìm kiếm / ô tìm kiếm chết). */
  | { outcome: "inconclusive"; reason: string; rows_before: number };

/**
 * Tra 1 email trên tab "Lời mời đang chờ xử lý" — BA kết cục, không phải hai.
 *
 * FAST PATH (v0.8.8): gõ email vào ô "Search for invites" → list rút còn 0-1 row
 * → đọc ngay. Đây mới là cách ĐÚNG: trước đây revoke chỉ `scrollScanForRow`
 * (cuộn list virtualized) nên dễ MISS row → kết luận nhầm `notInPending` →
 * fallback nhầm sang tab "Người dùng" (xem bug oewi@gmail.com 2026-06-17:
 * invite OK rồi revoke 27s sau lại báo "không có trên tab Lời mời").
 *
 * ⚠️ VẮNG MẶT PHẢI CHỨNG MINH ĐƯỢC (6/9/2026). Trước đây "quét không thấy" =
 * `null` = "email không có ở tab Lời mời", rồi cái kết luận đó đi thẳng vào
 * `absent_confirmed` của backend và NHẢ MỘT GHẾ. Nhưng "không thấy" có hai nghĩa
 * khác hẳn nhau, y hệt bài học của tab "Người dùng" (xem
 * [`remove/member-filter.ts`](../remove/member-filter.ts) — `filterOnceAndResolve`):
 *
 *   · đã tra và KHÔNG CÓ  → vắng mặt thật;
 *   · KHÔNG TRA ĐƯỢC (ô tìm kiếm không có / gõ vào mà list không nhúc nhích) →
 *     chẳng nói lên điều gì.
 *
 * Riêng nhánh 1 TRANG còn nguy hơn: nó `scrollScanForRow` trên list VIRTUALIZED,
 * mà cuộn thì chỉ render được phần gần viewport — đúng cái đã làm tab "Người
 * dùng" báo "chưa tham gia" oan (user 15/7/2026: *"check 6 email nhưng chỉ đúng
 * 1"*), và chỗ đó đã phải chữa bằng `preferFilter`. Nên ở đây quét-không-thấy
 * KHÔNG còn được tự kết luận: phải qua ô tìm kiếm phân xử.
 *
 * POSITIVE CONTROL (giống hệt tab "Người dùng"): gõ email → vẫn trống → XOÁ ô
 * tìm kiếm → danh sách PHẢI đầy lại. Đầy lại = ô tìm kiếm còn điều khiển được
 * list ⇒ cái "trống" vừa rồi là thật. Không đầy lại = ô tìm kiếm chết ⇒
 * `inconclusive`, để lượt sau tra lại.
 */
export async function lookupPendingRow(email: string): Promise<PendingLookup> {
  const rowsBefore = pendingRowCount();

  // Bước 1 — TÌM ĐỂ THAO TÁC. Giữ nguyên đường cũ vì nó chọn được row DÙNG ĐƯỢC:
  // 1 trang thì quét vị trí (row sau khi lọc đôi khi render menu thiếu mục "Thu
  // hồi lời mời" — user 2026-07-13), nhiều trang mới cần ô tìm kiếm để rút gọn.
  const paginated = findPaginationState() !== null;
  if (!paginated) {
    console.log(
      "[autogpt-revoke] tab Lời mời chỉ 1 trang → quét vị trí trực tiếp (bỏ search)",
    );
    const scanned = await scrollScanForRow(email);
    if (scanned) return { outcome: "found", row: scanned };
  }

  const input = findPendingSearchInput();
  if (!input) {
    // Không có ô tìm kiếm thì KHÔNG có cách nào chứng minh vắng mặt trên một list
    // virtualized. Trả `inconclusive` đúng như `filterOnceAndResolve` làm với
    // `no_filter_input` ở tab "Người dùng" — thà tra lại còn hơn nhả ghế oan.
    console.warn(
      "[autogpt-revoke] KHÔNG thấy ô 'Search for invites' → không chứng minh được vắng mặt",
    );
    return {
      outcome: "inconclusive",
      reason: "no_pending_search_input",
      rows_before: rowsBefore,
    };
  }
  console.log(
    `[autogpt-revoke] ô search OK (placeholder="${input.placeholder}") — tìm ${email}`,
  );

  // Gõ CHÍNH XÁC email ĐẦY ĐỦ 1 LẦN (user 2026-07-13: không gõ nửa rồi gõ full =
  // 2 lần tra, tốn thời gian). humanType tự clear input trước khi gõ.
  await humanType(input, email);
  await sleep(700); // chờ React Query / debounce filter
  try {
    const row = await waitFor(() => findMemberRow(email), LATE_ROW_POLL_MS, 200);
    if (row) {
      console.log(`[autogpt-revoke] ✓ search thấy ${email}`);
      return { outcome: "found", row };
    }
  } catch {
    // chưa ra row — còn phải chứng minh ô tìm kiếm còn sống mới dám kết luận.
  }

  const rowsFiltered = pendingRowCount();

  // POSITIVE CONTROL: xoá ô tìm kiếm → danh sách phải ĐẦY LẠI.
  clearPendingSearch(input);
  const restored = await waitForStablePendingRows(RESTORE_TIMEOUT_MS);
  if (restored === null || restored <= rowsFiltered) {
    console.warn(
      `[autogpt-revoke] xoá ô tìm kiếm mà danh sách KHÔNG đầy lại ` +
        `(${restored ?? "không ổn định"} ≤ ${rowsFiltered} dòng) → ô tìm kiếm không điều ` +
        `khiển được list → KHÔNG kết luận vắng mặt`,
    );
    return {
      outcome: "inconclusive",
      reason: "pending_search_dead",
      rows_before: rowsBefore,
    };
  }

  console.log(
    `[autogpt-revoke] ✓ search trống + ô tìm kiếm chứng minh còn sống ` +
      `(${rowsFiltered} → ${restored} dòng) → ${email} KHÔNG có ở tab Lời mời`,
  );
  return { outcome: "absent", rows_before: restored };
}

/**
 * Bản BOOLEAN của `lookupPendingRow` cho các đường BEST-EFFORT — nơi "không thấy"
 * chỉ dẫn tới bỏ qua một thao tác, không dẫn tới nhả ghế.
 *
 * Dùng ở tiền tố thu hồi của lệnh mời lại (`invite/execute-invite.ts`): không có
 * lời mời cũ thì khỏi thu hồi, thế thôi. Đường nào ĐEM KẾT LUẬN ĐI QUYẾT ĐỊNH
 * (`revoke-invite.ts` → `notInPending` → backend mark removed) PHẢI gọi
 * `lookupPendingRow` để còn phân biệt được `inconclusive`.
 */
export async function locatePendingRow(
  email: string,
): Promise<HTMLElement | null> {
  const r = await lookupPendingRow(email);
  return r.outcome === "found" ? r.row : null;
}
