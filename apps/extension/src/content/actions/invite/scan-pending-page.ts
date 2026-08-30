import type { ScrapedMember } from "../../../shared/messages";
import { sleep } from "../../human";
import { TEXT_FALLBACKS } from "../../selectors";
import { clickTabAndWait } from "../sync/click-tab-and-wait";
import { findPaginationState } from "../sync/pagination";
import {
  EMAIL_FULL_RE,
  extractSingleEmail,
} from "../sync/row-extractors/email";
import { isRenderedVisible, scrapeAllRows } from "../sync/scrape-all-rows";
import { searchPendingForEmails } from "./search-pending-by-email";

/**
 * Vùng DOM KHÔNG được tính là "email có trong danh sách lời mời": toast xác nhận
 * của ChatGPT ("Đã gửi lời mời tới a@b.com") và dialog mời vừa đóng/chưa đóng hẳn
 * đều CHỨA CHÍNH email vừa mời. Đọc trúng chúng = xác minh giả → bỏ luôn bước F5
 * mà email thực tế chưa hề vào danh sách.
 */
const EXCLUDE_SELECTOR =
  '[role="dialog"], [role="status"], [role="alert"], [data-testid*="toast" i], .toast, .toast-success';

export type PendingScanResult = {
  /** false = KHÔNG vào được tab "Lời mời" → caller phải fallback scrape full. */
  usable: boolean;
  /** Email vừa mời ĐÃ thấy trong danh sách (status ép về "pending"). */
  matched: ScrapedMember[];
  /** Email vừa mời CHƯA thấy (lowercase). */
  missing: string[];
  /** Có phải dùng ô tìm kiếm không (chỉ khi list ≥ 2 trang). */
  usedSearch: boolean;
  /** Tổng số trang đọc được từ thanh phân trang (1 khi không có phân trang). */
  pages: number;
};

/**
 * Email hiển thị trong VÙNG DANH SÁCH (đã loại toast/dialog) của trang hiện tại.
 *
 * Xuất khẩu cho `count-pending-invites.ts` — bước chốt suất cần ĐẾM cả tab "Lời
 * mời đang chờ", không chỉ tra vài email đã biết.
 */
export function emailsInListRegion(): Set<string> {
  const root = document.querySelector("main, [role='main']") ?? document.body;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found = new Set<string>();
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue ?? "").trim();
    if (!text || text.length > 200) continue;
    const email =
      text.length <= 100 && EMAIL_FULL_RE.test(text)
        ? text.toLowerCase()
        : extractSingleEmail(text);
    if (!email) continue;
    if (node.parentElement?.closest(EXCLUDE_SELECTOR)) continue;
    // Dòng ĐANG ẨN không phải danh sách của tab này: sang tab "Lời mời" rồi mà
    // React chưa gỡ bảng "Người dùng" thì bảng đó vẫn nằm nguyên trong DOM (ca
    // 30/8/2026 — xem `isRenderedVisible`).
    if (!isRenderedVisible(node.parentElement)) continue;
    found.add(email);
  }
  return found;
}

/**
 * Ghép email thấy trong vùng danh sách với dữ liệu row (tên/vai trò) do
 * `scrapeAllRows` đọc. Không dựng được row → vẫn tính là ĐÃ THẤY với member tối
 * thiểu (email nằm trong danh sách là đủ để coi lời mời đã đi).
 */
function collectMatches(
  wantedLower: string[],
): { matched: ScrapedMember[]; missing: string[] } {
  const visible = emailsInListRegion();
  const hits = wantedLower.filter((e) => visible.has(e));
  if (hits.length === 0) {
    return { matched: [], missing: [...wantedLower] };
  }
  const rows = scrapeAllRows({ visibleOnly: true });
  const matched = hits.map<ScrapedMember>((email) => {
    const row = rows.find((r) => r.email.toLowerCase() === email);
    return row
      ? { ...row, status: "pending" }
      : {
          email,
          name: null,
          chatgpt_role: null,
          license_type: null,
          status: "pending",
          joined_at: null,
        };
  });
  const hitSet = new Set(hits);
  return { matched, missing: wantedLower.filter((e) => !hitSet.has(e)) };
}

const POLL_INTERVAL_MS = 400;
/** Số tick liên tiếp danh sách không đổi thì coi như đã render xong. */
const SETTLE_TICKS = 4;
/** Trước mốc này KHÔNG bỏ cuộc dù list có vẻ "đứng yên" (ChatGPT index trễ vài giây). */
const MIN_WAIT_MS = 3_000;

/**
 * QUÉT tab "Lời mời đang chờ xử lý" tìm các email vừa mời — KHÔNG F5, KHÔNG gõ
 * tìm kiếm khi danh sách chỉ có 1 trang.
 *
 * Bối cảnh (user 2026-08-13): ChatGPT phản hồi dialog mời khá chậm, NHƯNG chuyển
 * sang tab "Lời mời đang chờ xử lý" là thấy người vừa mời NGAY. Vậy nên trình tự
 * đúng là: gửi lời mời xong → sang tab Lời mời → QUÉT. Thấy đủ thì thôi (khỏi F5,
 * khỏi vòng verify ~10s). Không thấy mới F5 rồi quét lại.
 *
 * MỘT TRANG thì quét DOM là đủ và nhanh nhất (gõ tìm kiếm tốn ~1s/email + thêm
 * rủi ro ô lọc đổi UI). NHIỀU TRANG thì NGƯỢC LẠI — quét là vô ích: danh sách
 * xếp theo ngày mời tăng dần nên email vừa mời nằm ở TRANG CUỐI, còn ta đang
 * đứng ở trang đầu. Thấy thanh phân trang báo ≥ 2 trang là bỏ quét, sang ô tìm
 * kiếm ngay (user chốt 30/8/2026, workspace CHAT GPT PRO có 2 trang lời mời).
 *
 * Poll tới `timeoutMs`, trả về NGAY khi thấy đủ. Nếu danh sách đã render và đứng
 * yên `SETTLE_TICKS` nhịp (sau tối thiểu `MIN_WAIT_MS`) mà vẫn thiếu → dừng sớm,
 * nhường việc cho F5 của caller thay vì chờ hết timeout.
 *
 * KHÔNG throw.
 */
export async function scanPendingForEmails(
  emails: string[],
  timeoutMs: number,
  ensureTab = true,
): Promise<PendingScanResult> {
  const wantedLower = emails.map((e) => e.trim().toLowerCase());

  if (ensureTab) {
    const onTab = await clickTabAndWait(
      "tab_pending_invites",
      TEXT_FALLBACKS.tabPendingInvites,
      1500,
      "tab=invites",
      12_000,
    );
    if (!onTab) {
      console.warn(
        "[autogpt-invite-scan] KHÔNG vào được tab Lời mời → usable=false (caller fallback)",
      );
      return {
        usable: false,
        matched: [],
        missing: wantedLower,
        usedSearch: false,
        pages: 1,
      };
    }
  }

  const start = Date.now();
  let lastCount = -1;
  let settleTicks = 0;
  let result = collectMatches(wantedLower);
  let pages = findPaginationState()?.total ?? 1;

  while (result.missing.length > 0 && Date.now() - start < timeoutMs) {
    // ── NHIỀU TRANG THÌ TÌM KIẾM, KHÔNG QUÉT (user chốt 30/8/2026) ──────────
    // Danh sách lời mời xếp theo NGÀY MỜI tăng dần, nên email vừa mời nằm ở
    // TRANG CUỐI. Quét DOM trang đang mở là quét vào chỗ chắc chắn không có:
    // hết sạch ngân sách poll rồi mới sang ô tìm kiếm. Biết có ≥2 trang là dừng
    // quét ngay, để ô tìm kiếm làm việc của nó.
    if (pages >= 2) {
      console.log(
        `[autogpt-invite-scan] danh sách có ${pages} trang — dừng quét DOM, dùng ô tìm kiếm`,
      );
      break;
    }
    await sleep(POLL_INTERVAL_MS);
    result = collectMatches(wantedLower);
    pages = findPaginationState()?.total ?? pages;
    if (result.missing.length === 0) break;

    const count = emailsInListRegion().size;
    if (count === lastCount && count > 0) {
      settleTicks += 1;
      if (settleTicks >= SETTLE_TICKS && Date.now() - start >= MIN_WAIT_MS) {
        console.log(
          `[autogpt-invite-scan] danh sách đã render & đứng yên (${count} email) sau ${Date.now() - start}ms — ` +
            `còn thiếu ${result.missing.length} email, dừng quét sớm`,
        );
        break;
      }
    } else {
      settleTicks = 0;
      lastCount = count;
    }
  }

  pages = findPaginationState()?.total ?? pages;

  // Chỉ khi danh sách THẬT SỰ nhiều trang (≥2) mới gõ email vào ô tìm kiếm —
  // email còn thiếu có thể đang nằm ở trang sau, quét DOM trang hiện tại không
  // thấy được. Danh sách 1 trang: quét là đủ, gõ tìm kiếm chỉ tốn thời gian.
  let usedSearch = false;
  if (result.missing.length > 0 && pages >= 2) {
    console.log(
      `[autogpt-invite-scan] danh sách có ${pages} trang → dùng ô tìm kiếm cho ${result.missing.length} email còn thiếu`,
    );
    const viaSearch = await searchPendingForEmails(result.missing);
    if (viaSearch !== null) {
      usedSearch = true;
      const foundSet = new Set(viaSearch.map((m) => m.email.toLowerCase()));
      result = {
        matched: [...result.matched, ...viaSearch],
        missing: result.missing.filter((e) => !foundSet.has(e)),
      };
    } else {
      console.warn(
        "[autogpt-invite-scan] không dùng được ô tìm kiếm ở tab Lời mời — giữ kết quả quét DOM",
      );
    }
  }

  console.log(
    `[autogpt-invite-scan] KẾT QUẢ: ${result.matched.length}/${wantedLower.length} email thấy trong tab Lời mời ` +
      `(${Date.now() - start}ms, pages=${pages}, search=${usedSearch})`,
    { matched: result.matched.map((m) => m.email), missing: result.missing },
  );

  return {
    usable: true,
    matched: result.matched,
    missing: result.missing,
    usedSearch,
    pages,
  };
}
