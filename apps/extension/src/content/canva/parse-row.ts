/**
 * Dựng một dòng của bảng `canva.com/settings/people` thành thành viên — đọc CHỮ
 * CỦA TỪNG TEXT NODE trong dòng, không đọc `row.textContent`.
 *
 * VÌ SAO KHÔNG DÙNG `textContent`: Canva nối các ô lại KHÔNG có khoảng trắng, nên
 * chuỗi cả dòng ra thế này —
 *
 *   "JS" + "Jarron Scurry" + "ncub8927@outlook.com" + "Team owner"
 *   → "JSJarron Scurryncub8927@outlook.comTeam owner"
 *
 * Bóc email bằng regex trên chuỗi đó thì nuốt cả đuôi tên ở TRƯỚC @ lẫn nhãn vai
 * trò ở SAU tên miền. Sự cố 2/9/2026: cả ba thành viên của Canva Team vào
 * dashboard thành "scurryncub8927@outlook.comteam", "inoueinouengoc@gmail.comteam",
 * "anhnguyenanhtu22117@gmail.comteam", tên thì kèm nguyên email. Email sai làm lượt
 * đồng bộ kế tiếp không còn thấy email THẬT trong đội nữa và gỡ nó ra
 * (`removed_reason='sync_missing'`), mang theo chu kỳ 12 tháng khách đã trả tiền.
 *
 * Text node thì mỗi ô là một chuỗi độc lập: email đứng riêng một node nên khớp
 * trọn được, còn tên là node ngay TRƯỚC node email — chữ viết tắt trong avatar
 * ("JS", "Tú") đứng trước nữa nên không tranh chỗ.
 */

import type { CanvaScrapedMember } from "../../shared/messages";
import { emailIn, norm } from "./dom";

/** Toàn bộ chuỗi là một email — dùng cho text node đứng riêng (ô Email). */
const EMAIL_FULL_RE = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,24}$/i;

/**
 * Dấu hiệu một dòng là LỜI MỜI ĐANG CHỜ chứ không phải thành viên đã tham gia.
 * Bản tiếng Anh (ảnh user 2026-09-01): cột trạng thái ghi "Invited", dòng mô tả là
 * "<email>'s invite is valid for 29 more days.", nút "Resend invite".
 * Bản tiếng Việt: "Đã mời", "Lời mời của <email> còn hiệu lực…", "Gửi lại lời mời".
 */
export const PENDING_MARKS = [
  "da moi",
  "loi moi cua",
  "gui lai loi moi",
  "invited",
  "invite is valid",
  "resend invite",
];

/** Chữ của bảng — nhãn vai trò, trạng thái, nút thao tác. Không bao giờ là tên. */
const LABEL_MARKS = [
  ...PENDING_MARKS,
  "chu so huu doi",
  "quan tri vien doi",
  "thanh vien doi",
  "nha thiet ke thuong hieu",
  "team owner",
  "team admin",
  "team member",
  "brand designer",
  "sao chep lien ket",
  "copy link",
  "copy unique link",
  "con hieu luc",
  "chua tham gia",
  "groups",
  "nhom",
];

/** Chữ trong cột vai trò → vai trò chuẩn hoá (Việt + Anh). */
export function roleOf(rowText: string): CanvaScrapedMember["role"] {
  const t = norm(rowText);
  if (t.includes("chu so huu") || t.includes("team owner")) return "owner";
  if (t.includes("quan tri vien") || t.includes("team admin")) return "admin";
  if (t.includes("thiet ke thuong hieu") || t.includes("brand designer")) {
    return "brand_designer";
  }
  if (t.includes("thanh vien doi") || t.includes("team member")) return "member";
  return null;
}

function isLabel(text: string): boolean {
  const t = norm(text);
  return LABEL_MARKS.some((m) => t.includes(m));
}

/** Node này dùng làm TÊN được không: không phải email, không phải nhãn của bảng. */
function nameCandidate(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && !t.includes("@") && !isLabel(t);
}

/** Vị trí node chứa email + email đọc được. Ưu tiên node khớp TRỌN. */
function findEmail(nodes: string[]): { index: number; email: string } | null {
  for (let i = 0; i < nodes.length; i += 1) {
    if (EMAIL_FULL_RE.test(nodes[i])) return { index: i, email: nodes[i].toLowerCase() };
  }
  // Dòng lời mời chờ: email nằm GIỮA câu ("…@gmail.com's invite is valid…").
  for (let i = 0; i < nodes.length; i += 1) {
    const email = emailIn(nodes[i]);
    if (email) return { index: i, email };
  }
  return null;
}

/**
 * Tên hiển thị: node hợp lệ CUỐI CÙNG đứng trước email (cột Tên nằm bên trái cột
 * Email, avatar đứng trước nữa). Không có thì lấy node hợp lệ đầu tiên sau email —
 * phòng khi Canva đổi thứ tự cột. Không có nữa thì để trống, thà thiếu tên còn hơn
 * nhét nhãn vai trò vào làm tên.
 */
function nameOf(nodes: string[], emailIndex: number): string | null {
  for (let i = emailIndex - 1; i >= 0; i -= 1) {
    if (nameCandidate(nodes[i])) return nodes[i].trim();
  }
  for (let i = emailIndex + 1; i < nodes.length; i += 1) {
    if (nameCandidate(nodes[i])) return nodes[i].trim();
  }
  return null;
}

/** Một dòng → thành viên. `nodes` là chữ của từng text node, theo thứ tự trên trang. */
export function parseMemberRow(nodes: string[]): CanvaScrapedMember | null {
  const clean = nodes.map((n) => n.trim()).filter((n) => n.length > 0);
  const found = findEmail(clean);
  if (!found) return null;
  const joined = norm(clean.join(" "));
  return {
    email: found.email,
    name: nameOf(clean, found.index),
    status: PENDING_MARKS.some((m) => joined.includes(m)) ? "pending" : "active",
    role: roleOf(joined),
  };
}
