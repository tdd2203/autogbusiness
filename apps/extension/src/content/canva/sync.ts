/**
 * CANVA_SYNC — quét danh sách thành viên + lời mời đang chờ ở
 * `canva.com/settings/people`.
 *
 * Trang gộp CẢ HAI vào một bảng (xem ảnh user gửi 2026-09-01):
 *   - Thành viên thật:  "Jarron Scurry · ncub8927@outlook.com · Chủ sở hữu đội"
 *   - Lời mời đang chờ: "Lời mời của datlla1307@gmail.com còn hiệu lực trong 29 ngày
 *     nữa." + cột trạng thái "Đã mời" + nút "Gửi lại lời mời".
 *
 * Nên phân loại theo CHỮ trong dòng chứ không theo cột: cấu trúc cột của Canva đổi
 * theo bề ngang màn hình, còn chữ "Đã mời"/"Lời mời của" thì không.
 *
 * Đọc từng dòng thì đi qua TEXT NODE, không đọc `row.textContent` — lý do dài nằm ở
 * `parse-row.ts` (sự cố 2/9/2026: email vào dashboard thành "…@gmail.comteam").
 *
 * Tiêu đề trang "Thành viên (2)" KHÔNG kể lời mời chờ — đừng dùng nó làm số suất đã
 * dùng; suất thật do dashboard tự đếm (active + pending).
 */

import type { CanvaActionResponse, CanvaScrapedMember } from "../../shared/messages";
import { sleep, waitForCountStable } from "../human";
import { reportProgress } from "../progress";
import { emailIn, norm, numberIn, onPeoplePage, textNodesOf, visible } from "./dom";
import { parseMemberRow } from "./parse-row";

/** Khối này có chứa email không — lọc thô trước khi đọc kỹ từng text node.
 *  `textContent` ở đây chỉ để LỌC nên dính chữ ô bên cạnh cũng không sao. */
function hasEmail(el: HTMLElement): boolean {
  const text = el.textContent ?? "";
  return text.includes("@") && emailIn(text) !== null;
}

/** Các hàng dữ liệu đang hiện (ưu tiên <tr>, không có thì tìm khối có email). */
function memberRows(): HTMLElement[] {
  const trs = [...document.querySelectorAll<HTMLElement>("tr")].filter(
    (r) => visible(r) && hasEmail(r),
  );
  if (trs.length) return trs;
  // Canva đôi khi render bảng bằng div: lấy khối NHỎ NHẤT còn chứa trọn 1 email.
  const blocks = [...document.querySelectorAll<HTMLElement>("li, [role='row'], div")].filter(
    (el) => visible(el) && hasEmail(el),
  );
  const picked: HTMLElement[] = [];
  for (const el of blocks) {
    if (picked.some((p) => p.contains(el) || el.contains(p))) {
      // Giữ khối nhỏ hơn trong cặp lồng nhau.
      const idx = picked.findIndex((p) => p.contains(el));
      if (idx >= 0) picked[idx] = el;
      continue;
    }
    picked.push(el);
  }
  return picked;
}

/** Quét bảng thành một danh sách phẳng, email trùng thì ưu tiên bản "đã tham gia". */
export function scrapePeopleTable(): CanvaScrapedMember[] {
  const byEmail = new Map<string, CanvaScrapedMember>();
  for (const row of memberRows()) {
    const entry = parseMemberRow(textNodesOf(row));
    if (!entry) continue;
    const email = entry.email;
    const prev = byEmail.get(email);
    // Đã tham gia thắng lời mời chờ: cùng một email hiện ở hai dòng thì trạng thái
    // thật là "đã vào đội".
    if (!prev || (prev.status === "pending" && entry.status === "active")) {
      byEmail.set(email, entry);
    }
  }
  return [...byEmail.values()];
}

/** Số trong tiêu đề trang — "Thành viên (N)" / "People (N)". Chỉ đếm người ĐÃ tham
 *  gia, KHÔNG kể lời mời đang chờ: ảnh user 2026-09-01 hiện "People (2)" trong khi
 *  bảng có 3 lời mời treo. Đòi có dấu ngoặc chứa số để không vớ nhầm tiêu đề khác. */
const HEADING_MARKS = ["thanh vien", "people", "members"];

export function headerMemberCount(): number | null {
  const heading = [...document.querySelectorAll<HTMLElement>("h1, h2, [role='heading']")]
    .filter(visible)
    .find((el) => {
      const t = norm(el.textContent);
      return (
        HEADING_MARKS.some((m) => t.startsWith(m)) && /\(\s*\d/.test(el.textContent ?? "")
      );
    });
  return heading ? numberIn(heading.textContent) : null;
}

export async function executeCanvaSync(taskId?: string): Promise<CanvaActionResponse> {
  // Nhịp báo tiến độ vừa cho dashboard xem, vừa GIỮ SERVICE WORKER SỐNG trong lúc
  // chờ Canva render (xem chú thích dài ở invite.ts — lệnh chết im vì SW ngủ).
  const beat = setInterval(() => {
    if (taskId) {
      void reportProgress(
        taskId,
        { phase: "scanning", message: `Đang đọc bảng thành viên (${memberRows().length} dòng)` },
        true,
      );
    }
  }, 5000);
  try {
    return await scanAndBuild(taskId);
  } finally {
    clearInterval(beat);
  }
}

async function scanAndBuild(taskId?: string): Promise<CanvaActionResponse> {
  if (!onPeoplePage()) {
    return {
      ok: false,
      error_code: "PAGE_NOT_PEOPLE",
      error_message: `Không ở trang thành viên Canva (đang ở ${location.href}).`,
    };
  }

  // Chờ danh sách RENDER XONG thay vì ngủ một khoảng cố định: đếm số dòng tới khi
  // ổn định. Đọc sớm là quét thiếu người → dashboard tưởng họ đã rời đội.
  await waitForCountStable(() => memberRows().length, {
    timeoutMs: 20000,
    stablePolls: 4,
  });

  const members = scrapePeopleTable();
  if (taskId) {
    await reportProgress(
      taskId,
      { phase: "scanned", message: `Đọc được ${members.length} dòng` },
      true,
    );
  }
  await sleep(0);
  if (members.length === 0) {
    // Đội rỗng là chuyện không xảy ra (ít nhất có chủ đội) → nhiều khả năng chưa
    // đăng nhập hoặc trang đổi cấu trúc. Báo lỗi thay vì để backend gỡ sạch người.
    return {
      ok: false,
      error_code: "NOT_LOGGED_IN_CANVA",
      error_message:
        "Không đọc được thành viên nào trên trang Canva — kiểm tra đã đăng nhập đúng tài khoản đội chưa.",
    };
  }

  return {
    ok: true,
    data: { members, team_size: headerMemberCount() },
  };
}
