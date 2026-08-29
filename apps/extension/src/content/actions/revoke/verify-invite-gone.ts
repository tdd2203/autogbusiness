/**
 * SAU KHI BẤM THU HỒI: lời mời đã thực sự biến khỏi tab "Lời mời đang chờ xử lý"
 * chưa — hỏi lại ChatGPT cho ra nhẽ, chứ không đọc lại cái danh sách cũ.
 *
 * VÌ SAO TÁCH RA (ca ickj886@gmail.com, 27/8/2026 13:56):
 * Lệnh thu hồi báo *"đã click thu hồi, dialog đã tắt hẳn, nhưng lời mời VẪN còn
 * sau 3 lần tra"* — mà CẢ LỆNH chỉ chạy 20 giây. Hai chỗ sai cùng lúc:
 *
 *   1. **Cửa sổ chờ quá ngắn.** Lệnh gỡ thành viên đã học từ 12/7/2026: sau khi
 *      xoá THẬT, ChatGPT còn trả về dòng đó thêm ~34 giây mới chịu biến mất
 *      (eventual consistency). Nên gỡ để trần 60s. Thu hồi thì đóng sổ ở giây
 *      thứ 12-17 ⇒ rơi đúng vào khoảng ChatGPT chưa kịp cập nhật ⇒ báo hỏng OAN.
 *   2. **Ba lần tra mà chỉ đọc một dữ liệu.** Danh sách lời mời thường gọn trong
 *      một trang, nên `locatePendingRow` quét thẳng DOM đang hiển thị — tra ba
 *      lần là đọc lại đúng cái DOM đó ba lần, ChatGPT không hề bị hỏi lại. Lệnh
 *      gỡ làm đúng: mỗi lần đều xoá ô lọc rồi gõ lại để ép truy vấn mới.
 *
 * Ở đây làm theo đúng khuôn đã có của lệnh gỡ (`remove/member-filter.ts`):
 *   · Mỗi vòng là một lần HỎI MỚI: xoá ô tìm kiếm → chờ danh sách đầy lại → gõ
 *     lại email. "Danh sách đầy lại" chính là bằng chứng ô tìm kiếm còn sống
 *     (positive control) — thiếu nó thì "không thấy" là vô nghĩa.
 *   · Phải ĐỦ HAI VÒNG ĐỘC LẬP cùng không ra dòng nào mới dám kết luận đã thu
 *     hồi. Kết luận nhầm chiều này đắt hơn: backend sẽ đánh dấu người ta đã bị
 *     gỡ trong khi lời mời còn nguyên trên ChatGPT và vẫn ăn một suất.
 *   · Không có ô tìm kiếm (UI đổi) → ép nạp lại bằng cách nhảy sang tab "Người
 *     dùng" rồi quay lại, xong mới quét — vẫn là dữ liệu mới, không phải DOM cũ.
 */

import { humanType, querySelectorFirst, sleep, waitFor } from "../../human";
import { SELECTORS, TEXT_FALLBACKS } from "../../selectors";
import { findMemberRow } from "../member-row";
import { scrollScanForRow } from "../remove/locate-member";
import { clickTabAndWait, DEFAULT_TAB_VERIFY } from "../sync";
import { ensurePendingInvitesTab } from "./pending-tab";

const LOG = "[autogpt-revoke-verify]";

/** Chờ ChatGPT debounce ô tìm kiếm trước khi soi dòng. */
const DEBOUNCE_MS = 700;
/** Soi dòng khớp bấy nhiêu lâu sau debounce (lọc server-side, dòng về trễ). */
const ROW_WAIT_MS = 4000;
/** Danh sách đã render lại mà chưa thấy dòng → soi nốt một nhịp ngắn. */
const LATE_ROW_MS = 2000;
const POLL_MS = 200;
/** Trần chờ ô tìm kiếm render (tab vừa mở, React chưa gắn xong). */
const INPUT_WAIT_MS = 8000;
/** Trần chờ danh sách ĐẦY LẠI sau khi xoá ô tìm kiếm (positive control). */
const LIST_RESTORE_MS = 8000;
/** Danh sách phải đọc được bấy nhiêu lần liên tiếp cùng số dòng thì mới coi là đứng yên. */
const STABLE_HITS = 3;
const STABLE_POLL_MS = 400;
/** Nghỉ giữa hai vòng hỏi — để ChatGPT kịp cập nhật phía server. */
const ROUND_GAP_MS = 3000;
/** Số vòng độc lập cùng "không thấy" mới dám kết luận đã thu hồi. */
const CONFIRM_ROUNDS = 2;

export type InviteAbsence =
  /** Vẫn thấy lời mời → thu hồi CHƯA có hiệu lực. */
  | { outcome: "still_there" }
  /** Đủ số vòng độc lập cùng không thấy → đã thu hồi. */
  | { outcome: "gone"; rounds: number }
  /** Không đủ căn cứ (ô tìm kiếm chết / hết giờ) → caller đừng ghi gì. */
  | { outcome: "inconclusive"; reason: string };

/**
 * Ô "Search for invites" của tab Lời mời. Thử `pendingSearchInput` (placeholder
 * "Search for invites", thường type=text) trước, rồi mới tới `memberFilterInput`.
 */
function findPendingSearchInput(): HTMLInputElement | null {
  return (
    querySelectorFirst<HTMLInputElement>(SELECTORS.pendingSearchInput) ??
    querySelectorFirst<HTMLInputElement>(SELECTORS.memberFilterInput)
  );
}

/** Xoá ô tìm kiếm về rỗng để danh sách trở lại đầy đủ. */
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
    console.warn(`${LOG} xoá ô tìm kiếm lỗi:`, e);
  }
}

function visibleRowCount(): number {
  const seen = new Set<Element>();
  for (const sel of SELECTORS.memberRow) {
    for (const row of Array.from(document.querySelectorAll(sel))) seen.add(row);
  }
  return seen.size;
}

/**
 * Chờ danh sách ĐỨNG YÊN rồi trả số dòng. `null` khi hết hạn mà số dòng vẫn nhảy
 * (danh sách còn đang đổ) — lúc đó mọi kết luận "không thấy" đều vô giá trị.
 */
async function waitForStableRowCount(timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let hits = 0;
  while (Date.now() < deadline) {
    const n = visibleRowCount();
    if (n === last) {
      hits += 1;
      if (hits >= STABLE_HITS) return n;
    } else {
      last = n;
      hits = 1;
    }
    await sleep(STABLE_POLL_MS);
  }
  return null;
}

export type Probe = "found" | "empty" | "unresponsive";

export type RoundDeps = {
  /** Một lần hỏi ChatGPT. */
  probe: (round: number) => Promise<Probe>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

/**
 * Vòng phán xử — tách khỏi DOM để khoá bằng test.
 *
 * Luật: thấy dòng là dừng ngay (`still_there`); phải đủ `CONFIRM_ROUNDS` vòng
 * *đọc được* mà không thấy mới kết luận `gone`; vòng nào danh sách không phản
 * hồi thì KHÔNG tính về bên nào — đếm nó là "không thấy" chính là đường dẫn tới
 * đánh dấu đã thu hồi trong khi lời mời còn nguyên.
 */
export async function runAbsenceRounds(
  deadlineAt: number,
  deps: RoundDeps,
): Promise<InviteAbsence> {
  let emptyRounds = 0;
  let lastReason = "chưa hỏi được lần nào trong ngân sách";
  let round = 0;
  while (deps.now() < deadlineAt && emptyRounds < CONFIRM_ROUNDS) {
    round += 1;
    const probe = await deps.probe(round);
    console.log(`${LOG} vòng ${round}: ${probe}`);
    if (probe === "found") return { outcome: "still_there" };
    if (probe === "empty") {
      emptyRounds += 1;
      lastReason = `mới có ${emptyRounds}/${CONFIRM_ROUNDS} vòng không thấy thì hết giờ`;
    } else {
      lastReason = "danh sách lời mời không phản hồi lượt tra";
    }
    if (emptyRounds >= CONFIRM_ROUNDS) break;
    if (deps.now() + ROUND_GAP_MS >= deadlineAt) break;
    await deps.sleep(ROUND_GAP_MS);
  }
  if (emptyRounds >= CONFIRM_ROUNDS) return { outcome: "gone", rounds: emptyRounds };
  return { outcome: "inconclusive", reason: lastReason };
}

/**
 * MỘT lần hỏi ChatGPT: xoá ô tìm kiếm → chờ danh sách đầy lại → gõ email.
 *
 * `empty` chỉ được trả khi có bằng chứng danh sách đã phản hồi lượt hỏi này:
 * hoặc danh sách vừa đầy lại rồi rút xuống theo query, hoặc chính danh sách lời
 * mời đang RỖNG ỔN ĐỊNH (thu hồi cái cuối cùng thì đúng là chẳng còn dòng nào).
 */
async function probeBySearchInput(
  input: HTMLInputElement,
  email: string,
): Promise<Probe> {
  clearPendingSearch(input);
  await sleep(400);
  const restored = await waitForStableRowCount(LIST_RESTORE_MS);
  if (restored === null) {
    console.warn(`${LOG} danh sách không đứng yên sau khi xoá ô tìm kiếm`);
    return "unresponsive";
  }
  const listWasEmpty = restored === 0;
  console.log(
    `${LOG} xoá ô tìm kiếm → danh sách ${restored} dòng${listWasEmpty ? " (rỗng)" : ""}`,
  );

  await humanType(input, email);
  await sleep(DEBOUNCE_MS);

  let responded = listWasEmpty || visibleRowCount() !== restored;
  const deadline = Date.now() + ROW_WAIT_MS;
  while (Date.now() < deadline) {
    if (findMemberRow(email)) return "found";
    if (!responded && visibleRowCount() !== restored) responded = true;
    await sleep(POLL_MS);
  }
  if (!responded) {
    console.warn(`${LOG} gõ "${email}" mà danh sách không nhúc nhích ⇒ query chưa chạy`);
    return "unresponsive";
  }
  // Lọc server-side hay nháy trống trước rồi mới đổ dòng về — soi nốt một nhịp.
  const late = Date.now() + LATE_ROW_MS;
  while (Date.now() < late) {
    await sleep(POLL_MS);
    if (findMemberRow(email)) return "found";
  }
  return "empty";
}

/**
 * Đường lui khi UI không có ô tìm kiếm: nhảy sang tab "Người dùng" rồi quay lại
 * tab "Lời mời" để ép ChatGPT nạp lại danh sách, xong mới quét vị trí.
 *
 * Vẫn giữ nguyên đòi hỏi về bằng chứng: danh sách phải đứng yên mới đọc, chứ
 * quét lúc nó đang đổ thì "không thấy" chẳng nói lên điều gì.
 */
async function probeByTabBounce(email: string): Promise<Probe> {
  const backToMembers = await clickTabAndWait(
    "tab_active_members",
    TEXT_FALLBACKS.tabActiveMembers,
    800,
    DEFAULT_TAB_VERIFY,
    8000,
  );
  if (!backToMembers) return "unresponsive";
  await sleep(600);
  if (!(await ensurePendingInvitesTab())) return "unresponsive";
  if ((await waitForStableRowCount(LIST_RESTORE_MS)) === null) return "unresponsive";
  return (await scrollScanForRow(email)) ? "found" : "empty";
}

/**
 * Lời mời đã biến khỏi tab "Lời mời đang chờ xử lý" chưa.
 *
 * @param deadlineAt mốc thời gian (epoch ms) phải dừng — caller chia ngân sách
 *   cho từng email trong mẻ, xem `revoke-invites-loop.ts`.
 */
export async function verifyInviteGone(
  email: string,
  deadlineAt: number,
): Promise<InviteAbsence> {
  let input = findPendingSearchInput();
  if (!input) {
    try {
      input = await waitFor(() => findPendingSearchInput(), INPUT_WAIT_MS, 250);
    } catch {
      input = null;
    }
  }
  if (!input) {
    console.warn(`${LOG} không thấy ô "Search for invites" → ép nạp lại bằng nhảy tab`);
  }

  return runAbsenceRounds(deadlineAt, {
    now: () => Date.now(),
    sleep,
    probe: async () => {
      // Ô tìm kiếm có thể bị React thay giữa chừng → lấy lại tham chiếu mỗi vòng.
      input = findPendingSearchInput() ?? input;
      return input ? probeBySearchInput(input, email) : probeByTabBounce(email);
    },
  });
}
