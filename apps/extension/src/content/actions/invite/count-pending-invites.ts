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
 * Sai số về phía nào cũng phải an toàn: đọc không được / danh sách nhiều trang
 * (không thấy hết) ⇒ trả `authoritative:false` để caller quay về con số của DB.
 * Đếm THIẾU nợ suất là mời vào chỗ không có — đúng cái hộp "Mua suất người dùng
 * và gửi lời mời" mà cả thiết kế đếm-suất-trước sinh ra để tránh.
 */

import { sleep } from "../../human";
import { findPaginationState } from "../sync/pagination";
import { scrapeAllRows } from "../sync/scrape-all-rows";
import { ensurePendingInvitesTab } from "../revoke/pending-tab";
import { emailsInListRegion } from "./scan-pending-page";

const LOG = "[autogpt-invite-pending-count]";

const POLL_INTERVAL_MS = 400;
/** Số nhịp liên tiếp danh sách không đổi thì coi như đã render xong. */
const SETTLE_TICKS = 3;
/** Trần thời gian chờ danh sách đứng yên. */
const SETTLE_TIMEOUT_MS = 6_000;

/**
 * Email đang có trên tab "Lời mời đang chờ" của trang hiện tại.
 *
 * Ưu tiên `scrapeAllRows` — cùng bộ đọc mà đồng bộ dùng cho tab này, bóc theo
 * DÒNG nên không nhặt phải email lạc ngoài danh sách (tiêu đề, cột "đã mời
 * bởi"…). Bóc dòng không ra thì mới quét text cả vùng danh sách: ở đây ta ĐẾM
 * chứ không tra một email đã biết, nên nhặt thừa là đếm thừa nợ suất.
 */
function pendingEmailsOnPage(): Set<string> {
  const rows = scrapeAllRows();
  if (rows.length > 0) {
    return new Set(rows.map((r) => r.email.toLowerCase()));
  }
  return emailsInListRegion();
}

export type PendingInviteCount = {
  /**
   * true = đọc được TOÀN BỘ danh sách (vào được tab + chỉ 1 trang) ⇒ con số
   * dùng thay cho DB được. false = caller PHẢI quay về `seatHint.pending`.
   */
  authoritative: boolean;
  /** Email đang chờ trên ChatGPT, đã loại các email của chính lệnh mời này. */
  emails: string[];
  /** Số trang thanh phân trang báo (1 khi không có phân trang). */
  pages: number;
  /** Vì sao không tin được (null khi `authoritative`). */
  reason: string | null;
};

/**
 * Vào tab "Lời mời đang chờ xử lý", chờ danh sách đứng yên, trả về danh sách
 * email đang chờ (đã loại `excludeEmails` — email của chính lệnh mời này, vốn đã
 * được đếm một lần trong `need`; để nguyên là đếm hai lần ⇒ mua thừa tiền thật).
 *
 * KHÔNG throw. Để trang ở tab "Lời mời" — caller tự đưa về tab "Người dùng".
 */
export async function countPendingInvites(
  excludeEmails: string[],
): Promise<PendingInviteCount> {
  const excluded = new Set(excludeEmails.map((e) => e.trim().toLowerCase()));

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

  // Danh sách render dần → chờ tới khi số email đứng yên. Đứng yên ở 0 cũng là
  // một kết quả hợp lệ (hết lời mời chờ), nên vòng lặp không đòi count > 0.
  const start = Date.now();
  let lastCount = -1;
  let settleTicks = 0;
  let visible = pendingEmailsOnPage();
  while (Date.now() - start < SETTLE_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    visible = pendingEmailsOnPage();
    if (visible.size === lastCount) {
      settleTicks += 1;
      if (settleTicks >= SETTLE_TICKS) break;
    } else {
      settleTicks = 0;
      lastCount = visible.size;
    }
  }

  const pageState = findPaginationState();
  const pages = pageState?.total ?? 1;
  if (pages >= 2) {
    // Nhiều trang: quét DOM chỉ thấy trang hiện tại ⇒ ĐẾM THIẾU. Không lật trang
    // ở đây (chậm + là đường ít chạy): thà quay về số của DB, vốn đếm thừa.
    console.warn(
      `${LOG} tab 'Lời mời' có ${pages} trang — quét DOM không thấy hết → giữ số của DB`,
    );
    return {
      authoritative: false,
      emails: [],
      pages,
      reason: `danh sách lời mời có ${pages} trang`,
    };
  }

  const emails = [...visible].filter((e) => !excluded.has(e)).sort();
  console.log(
    `${LOG} ChatGPT đang có ${emails.length} lời mời chờ (đã loại ${excluded.size} email của lệnh này) ` +
      `sau ${Date.now() - start}ms`,
    emails,
  );
  return { authoritative: true, emails, pages, reason: null };
}
