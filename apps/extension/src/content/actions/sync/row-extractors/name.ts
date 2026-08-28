import { parseChatGPTRole } from "../../../i18n-ui";
import { EMAIL_FULL_RE } from "./email";
import { DATE_RE } from "./joined-at";

/**
 * Bỏ dấu + hạ chữ thường để so nhãn không phụ thuộc cách gõ dấu.
 * `normalize("NFD")` không tách được Đ/đ nên phải thay tay.
 */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Nhãn của các CỘT KHÁC trong row — không bao giờ là tên người.
 *
 * Vì sao cần (dữ liệu thật 28/8/2026, workspace GPT1): cột "Loại suất" in
 * "Tiêu chuẩn"/"Cao cấp". Row nào KHÔNG có tên hiển thị (mọi row ở tab "Lời mời
 * đang chờ xử lý" đều vậy) thì vòng quét cả-row đi tới cột đó và lấy luôn nhãn
 * làm tên — 15 thành viên trong dashboard mang tên "Tiêu chuẩn".
 */
const COLUMN_LABEL_RE =
  /^(tieu chuan|standard|cao cap|premium|chatgpt|chat gpt|codex)$/;

/**
 * Chữ viết tắt trong ô avatar ("A", "NN", "ĐH") — KHÔNG phải tên.
 *
 * Chỉ chặn 1-2 chữ cái LATIN VIẾT HOA: tên tiếng Trung/Nhật hai ký tự ("林曦")
 * không có khái niệm hoa/thường nên vẫn lọt qua, còn tên Latin thật thì gần như
 * không bao giờ viết hoa toàn bộ ở độ dài này.
 */
const AVATAR_INITIALS_RE = /^[A-ZÀ-ÖØ-ÞĐ]{1,2}$/;

/**
 * Text này có đủ tư cách làm TÊN người không.
 *
 * Xuất khẩu để test được — đây là chốt chặn cho hai lỗi đã vào tới dữ liệu thật:
 * nhãn cột "Tiêu chuẩn" và chữ viết tắt avatar bị ghi làm tên thành viên.
 */
export function isNameText(text: string, emailPrefix: string): boolean {
  if (!text || text.length > 80) return false;
  if (EMAIL_FULL_RE.test(text)) return false;
  if (DATE_RE.test(text)) return false;
  if (parseChatGPTRole(text)) return false;
  const folded = fold(text);
  if (COLUMN_LABEL_RE.test(folded)) return false;
  if (AVATAR_INITIALS_RE.test(text)) return false;
  if (text.length < 2) return false;
  if (folded === fold(emailPrefix)) return false;
  return true;
}

/** Mọi text node trong `root`, theo thứ tự tài liệu. */
function textNodesIn(root: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) out.push(node as Text);
  return out;
}

/**
 * Tên nằm CÙNG Ô với email (ChatGPT xếp tên trên, email dưới, chung một khối).
 * Leo dần từ node email lên tối đa 3 mức và lấy text node hợp lệ GẦN NHẤT — nên
 * không bao giờ với sang được cột "Vai trò"/"Loại suất"/"Ngày thêm" ở xa hơn.
 *
 * Trả null khi ô danh tính chỉ có mỗi email (row lời mời đang chờ): KHÔNG có tên
 * là một sự thật, chép nhãn cột khác vào chỗ đó mới là bịa.
 */
function findNameNearEmail(row: HTMLElement, email: string): string | null {
  const emailPrefix = email.split("@")[0] ?? "";
  const emailNode = textNodesIn(row).find((n) =>
    (n.nodeValue ?? "").toLowerCase().includes(email),
  );
  if (!emailNode) return null;

  // Ca ChatGPT gộp avatar + tên + email vào MỘT text node
  // (vd "B b yaakovajax0054@outlook.com"): tên nằm ngay trong chính node đó.
  // Cắt email khỏi chuỗi bằng chỉ số, KHÔNG dựng RegExp từ email: dấu "." và
  // "+" trong địa chỉ là ký tự đặc biệt của regex.
  const raw = emailNode.nodeValue ?? "";
  const at = raw.toLowerCase().indexOf(email);
  const inline = (
    raw.slice(0, at) +
    " " +
    raw.slice(at + email.length)
  ).trim();
  if (inline && isNameText(inline, emailPrefix)) return inline;

  let container: HTMLElement | null = emailNode.parentElement;
  for (let up = 0; up < 3 && container && container !== row; up++) {
    for (const node of textNodesIn(container)) {
      if (node === emailNode) continue;
      const text = (node.nodeValue ?? "").trim();
      if (isNameText(text, emailPrefix)) return text;
    }
    container = container.parentElement;
  }
  return null;
}

/**
 * Tìm name của 1 row member.
 *
 * Ưu tiên ô danh tính (cùng khối với email); chỉ khi không đọc được mới quét cả
 * row — và lúc đó vẫn loại nhãn cột + chữ viết tắt avatar.
 */
export function findNameInRow(row: HTMLElement, email: string): string | null {
  const nearby = findNameNearEmail(row, email);
  if (nearby) return nearby;

  const emailPrefix = email.split("@")[0] ?? "";
  for (const node of textNodesIn(row)) {
    const text = (node.nodeValue ?? "").trim();
    if (isNameText(text, emailPrefix)) return text;
  }
  return null;
}
