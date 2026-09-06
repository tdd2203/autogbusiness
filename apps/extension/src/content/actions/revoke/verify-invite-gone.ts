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
 *   · MỘT vòng đọc được mà không ra dòng nào là đủ kết luận đã thu hồi, và hỏi
 *     nhiều nhất hai lượt (user 6/9/2026). Vòng nào cũng đã tự chứng minh ô tìm
 *     kiếm còn sống trước khi gõ, nên hỏi lại lần ba chỉ nhận đúng câu trả lời
 *     cũ mà người dùng thì nhìn thấy máy gõ đi gõ lại một email.
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
/**
 * Số vòng *đọc được* cùng "không thấy" mới dám kết luận đã thu hồi.
 *
 * 2 → 1 (user 6/9/2026: *"thực tế chỉ cần nhập 1 hoặc 2 lần là đủ"*). Một vòng ở
 * đây KHÔNG phải một cú liếc: nó tự xoá ô tìm kiếm, chờ danh sách đầy lại (bằng
 * chứng ô tìm kiếm còn sống), gõ email rồi soi 6 giây. Cộng thêm cú click thu
 * hồi + hộp thoại đã tắt hẳn ngay trước đó, chừng ấy đủ để chốt.
 */
const CONFIRM_ROUNDS = 1;
/**
 * TRẦN số lượt hỏi — hết trần thì `inconclusive`, KHÔNG hỏi nữa dù còn ngân sách.
 *
 * Trước đây vòng lặp chỉ dừng khi đủ vòng trống hoặc hết 60s, nên một danh sách
 * câm kéo theo 5-6 lần gõ lại cùng một email trong một phút — đúng cái mà người
 * dùng nhìn thấy ở ca hieuthanh7478 (6/9/2026). Hỏi lần thứ ba trở đi cũng chỉ
 * nhận lại đúng câu trả lời của lần thứ hai.
 */
const MAX_PROBES = 2;

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

/** Các dòng đang render (dedupe theo phần tử). */
function renderedRows(): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  for (const sel of SELECTORS.memberRow) {
    for (const row of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      seen.add(row);
    }
  }
  return Array.from(seen);
}

function visibleRowCount(): number {
  return renderedRows().length;
}

/** Bắt chuỗi email đầu tiên trong text của một dòng. */
const EMAIL_IN_ROW = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/**
 * Danh sách lời mời có ĐANG RỖNG không — đo bằng CÓ EMAIL NÀO HIỆN RA KHÔNG,
 * chứ không đo bằng số dòng.
 *
 * Vì sao không đếm dòng: selector dòng còn khớp cả dòng tiêu đề của bảng lẫn
 * dòng "chưa có lời mời nào", nên danh sách rỗng vẫn đếm ra 1-2 dòng. Gõ email
 * vào một danh sách như thế thì số dòng KHÔNG đổi ⇒ vòng nào cũng bị chấm "danh
 * sách không phản hồi" ⇒ gõ lại tới hết giờ rồi báo hỏng, trong khi lời mời đã
 * thu hồi xong (ca hieuthanh7478 6/9/2026: thu hồi ăn thật, lệnh vẫn FAILED).
 */
function listHasNoEmail(): boolean {
  return !renderedRows().some((row) => EMAIL_IN_ROW.test(row.textContent ?? ""));
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
 *
 * Hỏi nhiều nhất `MAX_PROBES` lượt: hết trần là dừng, dù ngân sách còn. Ngân
 * sách để dành cho MỘT lượt hỏi được chạy trọn vẹn, không phải để gõ lại nhiều
 * lần cho hết giờ.
 */
export async function runAbsenceRounds(
  deadlineAt: number,
  deps: RoundDeps,
): Promise<InviteAbsence> {
  let emptyRounds = 0;
  let lastReason = "chưa hỏi được lần nào trong ngân sách";
  let round = 0;
  while (deps.now() < deadlineAt && emptyRounds < CONFIRM_ROUNDS && round < MAX_PROBES) {
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
    if (emptyRounds >= CONFIRM_ROUNDS || round >= MAX_PROBES) break;
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
 * mời đang RỖNG ỔN ĐỊNH (thu hồi cái cuối cùng thì đúng là chẳng còn lời mời
 * nào để mà đổi) — xem `listHasNoEmail` về chuyện đo rỗng bằng email chứ không
 * bằng số dòng.
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
  const listWasEmpty = listHasNoEmail();
  console.log(
    `${LOG} xoá ô tìm kiếm → danh sách ${restored} dòng${listWasEmpty ? " (không còn lời mời nào)" : ""}`,
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
