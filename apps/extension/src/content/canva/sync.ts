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
 * Tiêu đề trang "Thành viên (2)" KHÔNG kể lời mời chờ — đừng dùng nó làm số suất đã
 * dùng; suất thật do dashboard tự đếm (active + pending).
 */

import type { CanvaActionResponse, CanvaScrapedMember } from "../../shared/messages";
import { waitForCountStable } from "../human";
import { emailIn, norm, numberIn, onPeoplePage, visible } from "./dom";

/** Dấu hiệu một dòng là LỜI MỜI ĐANG CHỜ chứ không phải thành viên đã tham gia. */
const PENDING_MARKS = ["da moi", "loi moi cua", "gui lai loi moi", "invited", "pending"];

/** Chữ trong cột vai trò → vai trò chuẩn hoá. */
function roleOf(rowText: string): CanvaScrapedMember["role"] {
  const t = norm(rowText);
  if (t.includes("chu so huu")) return "owner";
  if (t.includes("quan tri vien")) return "admin";
  if (t.includes("thiet ke thuong hieu")) return "brand_designer";
  if (t.includes("thanh vien doi")) return "member";
  return null;
}

/** Tên hiển thị của dòng: bỏ email, bỏ các nhãn trạng thái/vai trò. */
function nameOf(rowText: string, email: string): string | null {
  const cleaned = rowText
    .replace(email, " ")
    .replace(/Lời mời của|còn hiệu lực trong.*|Đã mời|Gửi lại lời mời|Sao chép liên kết.*/gi, " ")
    .replace(/Chủ sở hữu đội|Quản trị viên đội|Thành viên đội|Nhà thiết kế thương hiệu của đội/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

/** Các hàng dữ liệu đang hiện (ưu tiên <tr>, không có thì tìm khối có email). */
function memberRows(): HTMLElement[] {
  const trs = [...document.querySelectorAll<HTMLElement>("tr")].filter(
    (r) => visible(r) && emailIn(r.textContent) !== null,
  );
  if (trs.length) return trs;
  // Canva đôi khi render bảng bằng div: lấy khối NHỎ NHẤT còn chứa trọn 1 email.
  const blocks = [...document.querySelectorAll<HTMLElement>("li, [role='row'], div")].filter(
    (el) => visible(el) && emailIn(el.textContent) !== null,
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
    const text = row.textContent ?? "";
    const email = emailIn(text);
    if (!email) continue;
    const t = norm(text);
    const pending = PENDING_MARKS.some((m) => t.includes(m));
    const entry: CanvaScrapedMember = {
      email,
      name: nameOf(text, email),
      status: pending ? "pending" : "active",
      role: roleOf(text),
    };
    const prev = byEmail.get(email);
    // Đã tham gia thắng lời mời chờ: cùng một email hiện ở hai dòng thì trạng thái
    // thật là "đã vào đội".
    if (!prev || (prev.status === "pending" && entry.status === "active")) {
      byEmail.set(email, entry);
    }
  }
  return [...byEmail.values()];
}

/** Số trong tiêu đề "Thành viên (N)" — chỉ đếm người ĐÃ tham gia. */
export function headerMemberCount(): number | null {
  const heading = [...document.querySelectorAll<HTMLElement>("h1, h2, [role='heading']")]
    .filter(visible)
    .find((el) => norm(el.textContent).startsWith("thanh vien"));
  return heading ? numberIn(heading.textContent) : null;
}

export async function executeCanvaSync(): Promise<CanvaActionResponse> {
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
