/**
 * CHỜ tab "Lời mời đang chờ xử lý" NẠP XONG rồi mới cho đọc.
 *
 * VÌ SAO PHẢI TÁCH RA (user 29/8/2026: "check lời mời đang xử lý load chưa xong
 * đã làm việc khác rồi... lâu cũng được nhưng cần phải chắc chắn"): bước chốt
 * suất đọc tab này ra NỢ SUẤT, mà nợ suất đi thẳng vào `seatsToBuy` — tức vào
 * tiền thật. Bản cũ chỉ chờ "số email đứng yên 3 nhịp (1,2s), trần 6s", không
 * phân biệt nổi ba trạng thái khác hẳn nhau mà DOM đều cho ra một con số:
 *
 *   1. Danh sách lời mời đã vẽ xong          → con số ĐÚNG.
 *   2. React chưa đổ dữ liệu tab mới         → 0 email, đứng yên hoàn hảo ⇒ bản
 *      cũ chốt "0 lời mời chờ" ⇒ ĐẾM THIẾU nợ suất ⇒ mời vào chỗ không có ⇒ đúng
 *      cái hộp "Mua suất người dùng và gửi lời mời" mà cả thiết kế sinh ra để tránh.
 *   3. Vẫn còn nguyên dòng của tab "Người dùng" (URL đã là ?tab=invites nhưng
 *      danh sách cũ chưa bị gỡ) ⇒ ĐẾM THỪA cả trăm ⇒ báo thiếu suất, lệnh mời
 *      chết oan dù workspace còn rộng chỗ.
 *
 * Cả (2) và (3) đều LỚN DẦN theo số thành viên: workspace càng đông, truy vấn
 * tab mới càng lâu, cửa sổ đọc trượt càng rộng — đúng lúc user báo lỗi.
 *
 * NGUYÊN TẮC Ở ĐÂY: chỉ trả `loaded` khi có BẰNG CHỨNG, không phải khi hết giờ.
 * Đọc không chắc thì nói thẳng là không chắc — caller quay về số của dashboard
 * (vốn đếm thừa, tức lệch về phía an toàn). Thà chờ lâu, thà đi đường vòng, chứ
 * không chốt bừa một con số tiêu tiền.
 */

import { querySelectorFirst } from "../../human";
import { SELECTORS } from "../../selectors";
import { MAX_PAGINATION_PAGES, findPaginationState } from "../sync/pagination";
import { isRenderedVisible, scrapeAllRows } from "../sync/scrape-all-rows";
import { emailsInListRegion } from "./scan-pending-page";

const LOG = "[autogpt-invite-pending-load]";

/** Nhịp soi DOM. */
export const POLL_INTERVAL_MS = 400;
/** Số nhịp LIÊN TIẾP danh sách y hệt nhau mới được coi là đã vẽ xong. */
export const STABLE_TICKS = 6;
/** Trước mốc này KHÔNG chốt, dù DOM có vẻ đứng yên ngay từ nhịp đầu. */
export const MIN_WAIT_MS = 2_500;
/**
 * Danh sách RỖNG chỉ được chấp nhận sau ngần này, và phải thấy khung danh sách
 * (ô tìm kiếm / đầu bảng / thanh trang) đã render. Rỗng là kết quả hợp lệ — thu
 * hồi hết lời mời thì đúng là chẳng còn dòng nào — nhưng nó cũng chính là hình
 * dạng của "chưa nạp", nên phải soi lâu hơn hẳn mới dám chốt.
 */
export const EMPTY_CONFIRM_MS = 8_000;
/**
 * Rỗng mà KHÔNG nhận ra khung danh sách (ChatGPT đổi UI, hoặc tab rỗng thì giấu
 * luôn ô tìm kiếm) — vẫn phải có đường chốt, kẻo workspace sạch lời mời thì lần
 * nào cũng rơi về số dashboard. Sau ngần này mà danh sách vẫn rỗng, đứng yên,
 * không dấu hiệu đang tải thì chấp nhận.
 */
export const EMPTY_HARD_MS = 20_000;
/**
 * Dấu hiệu "đang tải" chỉ CHẶN trong ngần này. Nếu ChatGPT để lại một vòng xoay
 * / khối skeleton nằm lì trong trang (hoặc selector của ta vơ nhầm một hiệu ứng
 * trang trí), chặn mãi là biến mọi lượt đọc thành "không chắc". Quá mốc này thì
 * bỏ qua dấu hiệu đó — điều kiện ĐỨNG YÊN vẫn còn nguyên, và nó mới là cái giữ
 * cho ta không đọc giữa lúc danh sách đang đổ.
 */
export const LOADING_IGNORE_MS = 15_000;
/**
 * Bao nhiêu email trùng với danh sách tab "Người dùng" thì coi là còn đang thấy
 * trang cũ. Một email trùng còn giải thích được (rác ngoài danh sách như email
 * của chính admin ở menu tài khoản, hoặc ai đó vừa bấm nhận lời mời đúng lúc);
 * từ hai trở lên thì không: người đã tham gia KHÔNG nằm ở tab "Lời mời".
 */
export const MAX_BASELINE_OVERLAP = 1;

/** Trần chờ lượt đầu. */
export const LOAD_BUDGET_MS = 30_000;
/** Trần chờ lượt sau khi đã nhảy tab ép ChatGPT nạp lại. */
export const RETRY_BUDGET_MS = 20_000;

/** URL đang đứng ở đúng tab "Lời mời đang chờ" (?tab=invites) hay không. */
export function onPendingTab(): boolean {
  return /[?&]tab=invites/.test(location.search);
}

/**
 * Vùng DOM của danh sách. Dấu hiệu "đang tải" chỉ tính trong này — vòng xoay ở
 * thanh bên hay header không nói gì về danh sách lời mời.
 */
function listRoot(): ParentNode {
  return document.querySelector("main, [role='main']") ?? document.body;
}

/**
 * Vòng xoay / khối xám chờ dữ liệu. ChatGPT không đặt data-testid cho chúng nên
 * phải bắt theo cả thuộc tính chuẩn (`role=progressbar`, `aria-busy`) lẫn tên
 * lớp Tailwind quen thuộc (`animate-spin`, `animate-pulse`, `skeleton`).
 */
const LOADING_SELECTOR = [
  '[role="progressbar"]',
  '[aria-busy="true"]',
  '[class*="skeleton" i]',
  '[class*="spinner" i]',
  '[data-testid*="skeleton" i]',
  '[data-testid*="loading" i]',
  ".animate-spin",
  ".animate-pulse",
].join(", ");

function isVisible(el: Element): boolean {
  const html = el as HTMLElement;
  return html.offsetParent !== null || el.getClientRects().length > 0;
}

function hasLoadingIndicator(): boolean {
  for (const el of Array.from(listRoot().querySelectorAll(LOADING_SELECTOR))) {
    if (isVisible(el)) return true;
  }
  return false;
}

/**
 * Khung danh sách đã render chưa — ô tìm kiếm, thanh phân trang, hay đầu bảng.
 * Dùng để phân biệt "tab rỗng thật" với "tab chưa vẽ gì".
 */
function listChromeReady(): boolean {
  if (querySelectorFirst(SELECTORS.pendingSearchInput)) return true;
  if (findPaginationState()) return true;
  return (
    listRoot().querySelector(
      "table thead, [role='rowgroup'], [role='table'], [role='columnheader']",
    ) !== null
  );
}

/**
 * Số DÒNG có email đang render (đầu bảng, dòng trống không tính).
 *
 * `visibleOnly` bỏ những dòng còn trong DOM mà đã ẩn — bảng của tab trước React
 * chưa gỡ. Đếm cả chúng là cái làm cổng "đã nạp xong" không bao giờ mở (ca
 * 30/8/2026).
 */
function countRows(visibleOnly: boolean): number {
  const seen = new Set<Element>();
  for (const sel of SELECTORS.memberRow) {
    for (const row of Array.from(document.querySelectorAll(sel))) {
      if (seen.has(row)) continue;
      if (!(row.textContent ?? "").includes("@")) continue;
      if (visibleOnly && !isRenderedVisible(row)) continue;
      seen.add(row);
    }
  }
  return seen.size;
}

/**
 * Email đang có trên tab "Lời mời đang chờ" của trang hiện tại.
 *
 * Ưu tiên `scrapeAllRows` — cùng bộ đọc mà đồng bộ dùng cho tab này, bóc theo
 * DÒNG nên không nhặt phải email lạc ngoài danh sách (tiêu đề, cột "đã mời
 * bởi"…). Bóc dòng không ra thì mới quét text cả vùng danh sách: ở đây ta ĐẾM
 * chứ không tra một email đã biết, nên nhặt thừa là đếm thừa nợ suất.
 */
export function pendingEmailsOnPage(): string[] {
  const rows = scrapeAllRows({ visibleOnly: true });
  if (rows.length > 0) {
    return [...new Set(rows.map((r) => r.email.toLowerCase()))];
  }
  return [...emailsInListRegion()];
}

/** Một lượt soi DOM. */
export type PendingSnapshot = {
  /** URL vẫn đang ở tab "Lời mời đang chờ". */
  onTab: boolean;
  /** Thấy vòng xoay / khối skeleton trong vùng danh sách. */
  loading: boolean;
  /** Khung danh sách (ô tìm kiếm / đầu bảng / thanh trang) đã render. */
  listChrome: boolean;
  /** Số dòng có email đang render. */
  rows: number;
  /** Email đọc được, đã lowercase và bỏ trùng. */
  emails: string[];
  /**
   * DOM còn dòng có email nhưng KHÔNG dòng nào đang hiện.
   *
   * Van an toàn cho phép đo hiển thị: nếu vì lý do gì đó (ChatGPT đổi cách dựng
   * bảng, trang chưa tính xong layout) mọi dòng đều bị chấm là ẩn, thì "0 email"
   * ở đây KHÔNG phải là "workspace sạch lời mời" — chốt nhầm là đếm THIẾU nợ
   * suất, tức mời vào chỗ không có. Thấy cờ này thì nói thẳng là không chắc.
   */
  hiddenOnly?: boolean;
};

export function readPendingSnapshot(): PendingSnapshot {
  const rows = countRows(true);
  return {
    onTab: onPendingTab(),
    loading: hasLoadingIndicator(),
    listChrome: listChromeReady(),
    rows,
    emails: pendingEmailsOnPage(),
    hiddenOnly: rows === 0 && countRows(false) > 0,
  };
}

export type PendingListVerdict =
  | { loaded: true; emails: string[]; waitedMs: number; ticks: number }
  | { loaded: false; reason: string; waitedMs: number; ticks: number };

export type WaitDeps = {
  read: () => PendingSnapshot;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

function overlapWith(emails: string[], baseline: ReadonlySet<string>): number {
  if (baseline.size === 0) return 0;
  let n = 0;
  for (const e of emails) if (baseline.has(e)) n += 1;
  return n;
}

/**
 * Chờ tới khi danh sách lời mời ĐỦ BẰNG CHỨNG là đã nạp xong.
 *
 * Tách khỏi DOM để khoá bằng test — đây là cái van duy nhất chặn một con số nửa
 * vời đi vào phép tính tiền.
 *
 * @param baseline email ĐỌC ĐƯỢC NGAY TRƯỚC khi bấm sang tab, tức danh sách của
 *   tab "Người dùng". Còn thấy chúng ở đây nghĩa là trang cũ chưa bị gỡ. Truyền
 *   set rỗng khi không có mốc so (vd đã đứng sẵn ở tab "Lời mời").
 */
export async function waitForPendingListLoaded(
  budgetMs: number,
  baseline: ReadonlySet<string>,
  deps: WaitDeps,
): Promise<PendingListVerdict> {
  const start = deps.now();
  const deadline = start + budgetMs;
  let lastSig = "";
  let stableTicks = 0;
  let ticks = 0;
  let reason = "chưa soi được nhịp nào";
  let loadingIgnored = false;

  for (;;) {
    const snap = deps.read();
    const elapsed = deps.now() - start;
    ticks += 1;

    if (!snap.onTab) {
      // Trang tự rời tab (React đá về tab mặc định, hoặc lượt trước chưa xong).
      // Đọc tiếp là đọc danh sách người dùng — dừng hẳn, caller vào lại tab.
      return {
        loaded: false,
        reason: "trang không còn ở tab 'Lời mời đang chờ'",
        waitedMs: elapsed,
        ticks,
      };
    }

    const sig = `${snap.rows}|${[...snap.emails].sort().join(",")}`;
    if (sig === lastSig) {
      stableTicks += 1;
    } else {
      lastSig = sig;
      stableTicks = 1;
    }

    const loadingBlocks = snap.loading && elapsed < LOADING_IGNORE_MS;
    if (snap.loading && !loadingBlocks && !loadingIgnored) {
      loadingIgnored = true;
      console.warn(
        `${LOG} vẫn thấy dấu hiệu đang tải sau ${elapsed}ms — bỏ qua dấu hiệu này, ` +
          `chỉ còn xét danh sách có đứng yên hay không`,
      );
    }

    const overlap = overlapWith(snap.emails, baseline);
    const stable = stableTicks >= STABLE_TICKS && elapsed >= MIN_WAIT_MS;
    const emptyOk =
      snap.emails.length > 0 ||
      (snap.listChrome && elapsed >= EMPTY_CONFIRM_MS) ||
      elapsed >= EMPTY_HARD_MS;

    if (loadingBlocks) {
      reason = "danh sách còn đang tải";
    } else if (snap.hiddenOnly === true) {
      reason = "DOM còn dòng nhưng không dòng nào đang hiện — chưa tách được danh sách";
    } else if (overlap > MAX_BASELINE_OVERLAP) {
      reason = `vẫn còn ${overlap} email của tab 'Người dùng' trong danh sách`;
    } else if (!stable) {
      reason = `danh sách chưa đứng yên (${stableTicks}/${STABLE_TICKS} nhịp)`;
    } else if (!emptyOk) {
      reason = "danh sách đang rỗng nhưng chưa đủ bằng chứng là rỗng thật";
    } else {
      console.log(
        `${LOG} danh sách đã nạp xong sau ${elapsed}ms: ${snap.emails.length} email, ` +
          `${snap.rows} dòng, đứng yên ${stableTicks} nhịp`,
      );
      return { loaded: true, emails: snap.emails, waitedMs: elapsed, ticks };
    }

    if (deps.now() + POLL_INTERVAL_MS >= deadline) {
      return { loaded: false, reason, waitedMs: deps.now() - start, ticks };
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

/* ────────────────────────── LẬT HẾT CÁC TRANG ──────────────────────────── */

/** Thanh phân trang rút gọn — chỉ những gì vòng lật trang cần biết. */
export type PageCursor = {
  current: number;
  total: number;
  /** Còn bấm sang trang sau được (có nút và nút không bị khoá). */
  canNext: boolean;
};

export type PageWalkDeps = {
  /**
   * Chờ TRANG HIỆN TẠI nạp xong. `baseline` là nội dung KHÔNG được phép còn thấy
   * — trang trước đó; còn thấy nghĩa là DOM chưa kịp đổi sau cú bấm next.
   */
  loadPage: (baseline: ReadonlySet<string>) => Promise<PendingListVerdict>;
  /** Thanh phân trang lúc này (null = không đọc được / không còn phân trang). */
  cursor: () => PageCursor | null;
  /** Bấm sang trang kế và chờ chỉ số nhích; false = bấm không ăn. */
  goNext: (from: number) => Promise<boolean>;
  now: () => number;
};

export type PageWalkResult =
  | { ok: true; emails: string[]; pagesRead: number }
  | { ok: false; reason: string; pagesRead: number };

/**
 * LẬT HẾT các trang của tab "Lời mời đang chờ" rồi cộng lại (user chốt 29/8/2026).
 *
 * Ba chỗ dễ ĐẾM THIẾU, mỗi chỗ một cửa:
 *
 *   1. Bấm next mà DOM chưa đổi → đọc lại đúng trang cũ. Chặn bằng cách lấy
 *      chính trang vừa đọc làm `baseline` cho trang sau: còn thấy nó thì chưa
 *      được tính.
 *   2. Trang giữa chừng chưa nạp xong → mỗi trang phải qua đúng cửa
 *      `waitForPendingListLoaded` như trang đầu.
 *   3. Dừng non (hết ngân sách, bấm không ăn, thanh phân trang biến mất) →
 *      KHÔNG trả về một tổng thiếu, mà trả `ok:false` để caller quay về số DB.
 *      Cộng nửa chừng rồi báo "đây là sự thật" là kiểu sai tệ nhất ở đây.
 *
 * Danh sách đổi ngay giữa lúc lật (ai đó nhận lời mời, admin khác thu hồi) cũng
 * rơi vào (1) hoặc (3) — tức là bỏ, dùng số DB. Đúng ý: số nửa cũ nửa mới không
 * dùng cho quyết định tiêu tiền được.
 */
export async function walkPendingPages(
  firstBaseline: ReadonlySet<string>,
  budgetMs: number,
  deps: PageWalkDeps,
): Promise<PageWalkResult> {
  const deadline = deps.now() + budgetMs;
  const all = new Set<string>();
  let baseline = firstBaseline;
  let pagesRead = 0;

  for (let guard = 0; guard < MAX_PAGINATION_PAGES; guard++) {
    const v = await deps.loadPage(baseline);
    if (!v.loaded) {
      return {
        ok: false,
        reason: `trang ${pagesRead + 1} chưa nạp xong — ${v.reason}`,
        pagesRead,
      };
    }
    for (const e of v.emails) all.add(e);
    pagesRead += 1;

    const cur = deps.cursor();
    if (!cur) {
      // Đang lật dở mà thanh phân trang biến mất = danh sách vừa đổi dưới chân.
      return {
        ok: false,
        reason: `thanh phân trang biến mất sau trang ${pagesRead}`,
        pagesRead,
      };
    }
    if (cur.current >= cur.total || !cur.canNext) {
      console.log(
        `${LOG} lật xong ${pagesRead} trang → ${all.size} lời mời đang chờ`,
      );
      return { ok: true, emails: [...all], pagesRead };
    }
    if (deps.now() >= deadline) {
      return {
        ok: false,
        reason: `lật trang quá ${Math.round(budgetMs / 1000)}s, mới xong ${pagesRead}/${cur.total} trang`,
        pagesRead,
      };
    }

    baseline = new Set(v.emails);
    if (!(await deps.goNext(cur.current))) {
      return {
        ok: false,
        reason: `bấm sang trang ${cur.current + 1} không ăn`,
        pagesRead,
      };
    }
  }

  return {
    ok: false,
    reason: `lật quá ${MAX_PAGINATION_PAGES} trang mà chưa hết`,
    pagesRead,
  };
}
