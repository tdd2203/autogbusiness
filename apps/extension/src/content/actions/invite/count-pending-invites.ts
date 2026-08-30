/**
 * ĐẾM lời mời đang chờ THẬT trên ChatGPT — dùng cho bước chốt suất của luồng mời.
 *
 * VÌ SAO KHÔNG TIN DB: bước chốt suất trừ "nợ suất" = số lời mời đang chờ, và
 * con số đó vốn lấy từ dashboard (`seatHint.pending`). Dashboard chỉ là bản sao,
 * và bản sao đó có đúng MỘT chiều không tự lành được: một bản ghi "Chờ tham gia"
 * mà lời mời trên ChatGPT đã chết (bị thu hồi, hoặc treo tới mức ChatGPT bỏ) sẽ
 * nằm lại mãi. Đồng bộ scope 'members' CỐ Ý không được phép xoá pending — một
 * pending rời tab "Lời mời" có hai nguyên nhân không phân biệt được nếu chỉ nhìn
 * một tab (xem `reconcile.py`). Chỉ scope 'both' mới dọn được.
 *
 * Nợ suất đếm thừa không vô hại: mỗi bản ghi thừa ăn một suất trong phép tính,
 * và workspace sát trần thì đó là chênh lệch giữa "mời được" và "báo thiếu suất
 * rồi dừng". Bước chốt suất không có lý do gì phải chờ lượt đồng bộ kế tiếp: nó
 * đang đứng ngay trên /admin/members, tab "Lời mời đang chờ" cách một cú click.
 * Đọc thẳng ở đó là SỰ THẬT tại đúng thời điểm quyết định.
 *
 * ⚠️ Đây là LƯỚI ĐỠ ở bước chốt suất, KHÔNG phải sửa tận gốc — gốc nằm ở đồng bộ
 * (scope 'both', commit 2e39bf4). Và nó chỉ sửa chiều đếm THỪA: đọc ra con số
 * đúng không làm workspace có thêm suất nào. Workspace đầy thật thì vẫn đầy.
 *
 * Sai số về phía nào cũng phải an toàn: đọc không được ⇒ trả `authoritative:false`
 * để caller quay về con số của DB. Đếm THIẾU nợ suất là mời vào chỗ không có —
 * đúng cái hộp "Mua suất người dùng và gửi lời mời" mà cả thiết kế đếm-suất-trước
 * sinh ra để tránh.
 *
 * NHIỀU TRANG thì LẬT HẾT rồi cộng lại (user chốt 29/8/2026). Bản trước bỏ cuộc
 * ngay khi thanh phân trang báo ≥ 2 trang — workspace càng đông thì càng hay rơi
 * vào đó, và rơi vào là mất luôn con số thật, phải quay về số DB vốn đếm thừa.
 * Lật trang chậm hơn, nhưng mỗi trang vẫn phải qua đúng cửa "đã nạp xong" như
 * trang đầu, và trang sau còn phải KHÁC trang trước mới được tính — bấm next mà
 * DOM chưa kịp đổi thì đọc lại đúng trang cũ, cộng vào là đếm thiếu.
 *
 * ĐIỀU KIỆN ĐỌC (user 29/8/2026): chỉ đọc khi danh sách đã NẠP XONG, và "nạp
 * xong" phải có bằng chứng chứ không phải hết giờ chờ — toàn bộ luật nằm ở
 * [`pending-list-loaded.ts`](./pending-list-loaded.ts). Chưa chắc thì nhảy tab
 * ép ChatGPT nạp lại một lượt nữa; vẫn chưa chắc thì thà chờ lâu rồi quay về số
 * dashboard, chứ không chốt một con số nửa vời đi vào phép tính tiền.
 */

import { sleep } from "../../human";
import { TEXT_FALLBACKS } from "../../selectors";
import { DEFAULT_TAB_VERIFY, clickTabAndWait } from "../sync/click-tab-and-wait";
import {
  clickNextPage,
  findPaginationState,
  goToFirstPage,
  isDisabled,
  waitForPageAdvance,
} from "../sync/pagination";
import { ensurePendingInvitesTab } from "../revoke/pending-tab";
import {
  LOAD_BUDGET_MS,
  POLL_INTERVAL_MS,
  RETRY_BUDGET_MS,
  onPendingTab,
  pendingEmailsOnPage,
  readPendingSnapshot,
  waitForPendingListLoaded,
  walkPendingPages,
  type PageCursor,
  type PageWalkResult,
} from "./pending-list-loaded";

const LOG = "[autogpt-invite-pending-count]";

/**
 * Trần MẶC ĐỊNH cho cả bước đếm, khi caller không đặt trần riêng.
 *
 * VÌ SAO PHẢI CÓ (ca thật 30/8/2026): mọi trần ở đây trước là trần của TỪNG
 * chặng — chờ nạp 30s, nhảy tab, chờ lại 20s, lật trang 90s. Cộng dồn lại một
 * lệnh mời đứng im tới 250s cho một phép đếm mà lần nào cũng bỏ cuộc, rồi phần
 * mua suất phía sau không còn chỗ trong ngân sách 300s ⇒ `CONTENT_TIMEOUT`.
 * Bước này là LƯỚI ĐỠ chứ không phải việc chính: hết trần thì về số dashboard
 * (vốn đếm thừa, tức lệch về phía an toàn) và trả quyền lại cho việc mời.
 */
const DEFAULT_TOTAL_BUDGET_MS = 45_000;

/** Dưới ngần này thì đừng bắt đầu một chặng chờ mới — chờ hụt cũng không ra gì. */
const MIN_STAGE_MS = 4_000;

export type CountPendingOptions = {
  /** Trần cho TOÀN BỘ bước đếm (mặc định `DEFAULT_TOTAL_BUDGET_MS`). */
  budgetMs?: number;
  /**
   * Báo nhịp ra ngoài (dashboard). Bước này im lặng hàng chục giây, mà im lặng
   * là thứ backend đọc thành "lệnh treo" — xem `stuck_verdict` bên API.
   */
  onNote?: (message: string) => void | Promise<void>;
};

export type PendingInviteCount = {
   /**
   * true = đọc được TOÀN BỘ danh sách (vào được tab + mọi trang đều nạp xong)
   * ⇒ con số dùng thay cho DB được. false = caller PHẢI quay về
   * `seatHint.pending`.
   */
  authoritative: boolean;
  /** Email đang chờ trên ChatGPT, đã loại các email của chính lệnh mời này. */
  emails: string[];
  /** Số trang thanh phân trang báo (1 khi không có phân trang). */
  pages: number;
  /** Vì sao không tin được (null khi `authoritative`). */
  reason: string | null;
};

/** Bộ đọc DOM thật cho vòng chờ (test tiêm bộ đọc giả). */
const domDeps = {
  read: readPendingSnapshot,
  now: () => Date.now(),
  sleep,
};

/** Nhịp báo tiến độ trong lúc chờ — thưa hơn thì backend đọc ra "đang treo". */
const NOTE_EVERY_MS = 5_000;

/**
 * Bộ đọc DOM có KÈM báo nhịp: mỗi `NOTE_EVERY_MS` nhả một dòng ra dashboard.
 *
 * Vòng chờ nằm trong `pending-list-loaded.ts` và cố ý không biết gì về tiến độ
 * (để test khoá được nó bằng deps giả), nên móc nhịp vào đúng chỗ nó ngủ.
 */
function notingDeps(onNote: ((m: string) => void | Promise<void>) | undefined, label: string) {
  if (!onNote) return domDeps;
  let lastNote = Date.now();
  return {
    ...domDeps,
    sleep: async (ms: number) => {
      await sleep(ms);
      const now = Date.now();
      if (now - lastNote >= NOTE_EVERY_MS) {
        lastNote = now;
        await onNote(label);
      }
    },
  };
}

/**
 * Nhảy sang tab "Người dùng" rồi quay lại tab "Lời mời" để ÉP ChatGPT gọi lại
 * truy vấn danh sách.
 *
 * Cùng mẹo mà `verify-invite-gone.ts` dùng khi danh sách không phản hồi: chờ
 * thêm không cứu được một truy vấn đã bị nuốt (tab admin chạy nền bị Chrome
 * throttle), phải bắt React gắn lại component thì nó mới fetch lượt mới.
 */
async function bounceIntoPendingTab(): Promise<boolean> {
  const backToMembers = await clickTabAndWait(
    "tab_active_members",
    TEXT_FALLBACKS.tabActiveMembers,
    800,
    DEFAULT_TAB_VERIFY,
    8_000,
  );
  if (!backToMembers) return false;
  await sleep(600);
  return ensurePendingInvitesTab();
}

/** Trần chờ MỘT trang nạp xong khi đang lật (trang đầu đã có trần riêng). */
const PAGE_LOAD_BUDGET_MS = 15_000;
/**
 * Trần cho CẢ vòng lật trang. Phải nằm gọn trong `CONTENT_TIMEOUTS.INVITE_MEMBER`
 * (300s) cùng với phần mua suất phía sau — quá giờ thì bỏ, dùng số DB.
 */
const WALK_BUDGET_MS = 90_000;

/** Thanh phân trang lúc này, rút gọn cho vòng lật trang. */
function readCursor(): PageCursor | null {
  const st = findPaginationState();
  if (!st) return null;
  return {
    current: st.current,
    total: st.total,
    canNext: st.nextButton !== null && !isDisabled(st.nextButton),
  };
}

/**
 * Lật hết mọi trang của tab "Lời mời" rồi cộng lại.
 *
 * `firstBaseline` là danh sách của tab "Người dùng" — dùng cho TRANG ĐẦU, vì
 * `goToFirstPage` có thể không phải bấm gì (đang đứng sẵn ở trang 1) nên không
 * được lấy "phải khác trang trước" làm điều kiện cho nó. Từ trang thứ hai trở đi
 * `walkPendingPages` tự lấy trang vừa đọc làm mốc.
 */
async function collectAllPages(
  firstBaseline: ReadonlySet<string>,
  pages: number,
  budgetMs: number,
  onNote?: (message: string) => void | Promise<void>,
): Promise<PageWalkResult> {
  console.log(`${LOG} tab 'Lời mời' có ${pages} trang — lật hết rồi cộng lại`);
  await goToFirstPage();
  let page = 0;
  const deps = notingDeps(onNote, `Đang đọc danh sách lời mời đang chờ (${pages} trang)...`);
  return walkPendingPages(firstBaseline, budgetMs, {
    loadPage: async (baseline) => {
      page += 1;
      await onNote?.(`Đang đọc lời mời đang chờ — trang ${page}/${pages}...`);
      return waitForPendingListLoaded(
        Math.min(PAGE_LOAD_BUDGET_MS, budgetMs),
        baseline,
        deps,
      );
    },
    cursor: readCursor,
    goNext: async (from) => {
      const st = findPaginationState();
      if (!st || !(await clickNextPage(st))) return false;
      return waitForPageAdvance(from);
    },
    now: () => Date.now(),
  });
}

/**
 * Vào tab "Lời mời đang chờ xử lý", CHỜ DANH SÁCH NẠP XONG, trả về danh sách
 * email đang chờ (đã loại `excludeEmails` — email của chính lệnh mời này, vốn đã
 * được đếm một lần trong `need`; để nguyên là đếm hai lần ⇒ mua thừa tiền thật).
 *
 * KHÔNG throw. Để trang ở tab "Lời mời" — caller tự đưa về tab "Người dùng".
 */
export async function countPendingInvites(
  excludeEmails: string[],
  opts: CountPendingOptions = {},
): Promise<PendingInviteCount> {
  const excluded = new Set(excludeEmails.map((e) => e.trim().toLowerCase()));
  const start = Date.now();
  const onNote = opts.onNote;
  const budgetMs = opts.budgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
  // Trần chung đã cạn ngay từ đầu (hai lượt đọc số phía trước ăn hết): ĐỪNG bắt
  // đầu — riêng cú sang tab "Lời mời" đã có thể tốn 12s, tức tiêu vào đúng phần
  // ngân sách mà bước mua suất cần.
  if (budgetMs < MIN_STAGE_MS) {
    console.warn(`${LOG} không còn giờ trong trần bước chốt suất → giữ số của DB`);
    return {
      authoritative: false,
      emails: [],
      pages: 1,
      reason: "không còn giờ trong trần bước chốt suất",
    };
  }
  const deadline = start + budgetMs;
  /** Còn bao nhiêu mili giây trong trần chung. */
  const left = (): number => deadline - Date.now();
  const waitDeps = notingDeps(onNote, "Đang chờ ChatGPT nạp xong danh sách lời mời...");
  await onNote?.("Đang đếm lời mời đang chờ trên ChatGPT...");

  // MỐC SO của bước chống đọc trang cũ: danh sách đang hiện TRƯỚC cú bấm, tức
  // của tab "Người dùng". Còn thấy chúng sau khi sang tab "Lời mời" nghĩa là
  // React chưa gỡ danh sách cũ — đọc lúc đó là đếm cả trăm thành viên thành nợ
  // suất. Đang đứng sẵn ở tab "Lời mời" thì không có mốc nào để so: để rỗng,
  // lúc đó chỉ còn luật đứng-yên gác cửa.
  const baseline = onPendingTab()
    ? new Set<string>()
    : new Set(pendingEmailsOnPage());

  const onTab = await ensurePendingInvitesTab();
  if (!onTab) {
    console.warn(`${LOG} KHÔNG vào được tab 'Lời mời đang chờ' → giữ số của DB`);
    return {
      authoritative: false,
      emails: [],
      pages: 1,
      reason: "không vào được tab 'Lời mời đang chờ'",
    };
  }

  let verdict = await waitForPendingListLoaded(
    Math.min(LOAD_BUDGET_MS, left()),
    baseline,
    waitDeps,
  );
  // Nhảy tab ép nạp lại CHỈ khi trần chung còn đủ chỗ cho cả cú nhảy lẫn lượt
  // chờ sau nó. Hết chỗ mà vẫn cố là ăn nốt ngân sách của bước mua suất.
  if (!verdict.loaded && left() > MIN_STAGE_MS) {
    console.warn(
      `${LOG} sau ${verdict.waitedMs}ms vẫn chưa chắc danh sách đã nạp xong ` +
        `(${verdict.reason}) → nhảy tab ép ChatGPT nạp lại rồi chờ tiếp`,
    );
    await onNote?.("Danh sách lời mời nạp chưa xong — nhảy tab ép ChatGPT nạp lại...");
    if (await bounceIntoPendingTab()) {
      verdict = await waitForPendingListLoaded(
        Math.min(RETRY_BUDGET_MS, left()),
        baseline,
        waitDeps,
      );
    }
  }
  if (!verdict.loaded) {
    console.warn(
      `${LOG} danh sách lời mời KHÔNG nạp xong sau ${Date.now() - start}ms ` +
        `(${verdict.reason}) → giữ số của DB`,
    );
    return {
      authoritative: false,
      emails: [],
      pages: 1,
      reason: `danh sách lời mời chưa nạp xong — ${verdict.reason}`,
    };
  }

  // Thanh phân trang chỉ được đọc SAU khi danh sách đã nạp xong: đọc lúc trang
  // còn đang vẽ thì thanh chưa render ⇒ tưởng 1 trang ⇒ chốt "authoritative"
  // trên đúng một trang đầu ⇒ ĐẾM THIẾU nợ suất.
  const pageState = findPaginationState();
  const pages = pageState?.total ?? 1;
  if (pages >= 2) {
    // Lật trang là chặng đắt nhất. Còn quá ít giờ thì đừng bắt đầu: lật dở dang
    // cũng bị `walkPendingPages` bỏ, mà thời gian thì đã tiêu mất.
    if (left() <= MIN_STAGE_MS) {
      console.warn(`${LOG} hết trần trước khi lật ${pages} trang → giữ số của DB`);
      return {
        authoritative: false,
        emails: [],
        pages,
        reason: `hết trần ${Math.round((Date.now() - start) / 1000)}s trước khi lật ${pages} trang`,
      };
    }
    const all = await collectAllPages(
      baseline,
      pages,
      Math.min(WALK_BUDGET_MS, left()),
      onNote,
    );
    if (!all.ok) {
      console.warn(
        `${LOG} lật ${pages} trang KHÔNG xong (${all.reason}) → giữ số của DB`,
      );
      return { authoritative: false, emails: [], pages, reason: all.reason };
    }
    const emails = all.emails.filter((e) => !excluded.has(e)).sort();
    console.log(
      `${LOG} ChatGPT đang có ${emails.length} lời mời chờ trên ${all.pagesRead}/${pages} ` +
        `trang (đã loại ${excluded.size} email của lệnh này) sau ${Date.now() - start}ms`,
      emails,
    );
    return { authoritative: true, emails, pages, reason: null };
  }

  // Đọc kiểm một nhịp nữa NGAY TRƯỚC KHI CHỐT: giữa lượt đọc cuối và lúc này còn
  // một cú `findPaginationState` quét cả DOM. Số phải y hệt — lệch nghĩa là danh
  // sách vẫn đang nhúc nhích, không phải lúc chốt con số tiêu tiền.
  await sleep(POLL_INTERVAL_MS);
  const recheck = readPendingSnapshot();
  const same =
    recheck.onTab &&
    recheck.emails.length === verdict.emails.length &&
    [...recheck.emails].sort().join(",") === [...verdict.emails].sort().join(",");
  if (!same) {
    console.warn(
      `${LOG} lượt đọc kiểm cuối lệch (${verdict.emails.length} → ` +
        `${recheck.emails.length} email) → giữ số của DB`,
    );
    return {
      authoritative: false,
      emails: [],
      pages,
      reason: "danh sách còn đổi ở lượt đọc kiểm cuối",
    };
  }

  const emails = verdict.emails.filter((e) => !excluded.has(e)).sort();
  console.log(
    `${LOG} ChatGPT đang có ${emails.length} lời mời chờ (đã loại ${excluded.size} email của lệnh này) ` +
      `sau ${Date.now() - start}ms`,
    emails,
  );
  return { authoritative: true, emails, pages, reason: null };
}
