import type { LicenseType } from "../../../../shared/messages";

// Ký tự caret/mũi tên hay đi kèm dropdown ("ChatGPT ▾") — strip trước khi so.
const CARET_RE = /[▼▾▿⌄⇣]/g;

// Log tối đa N row đầu khi KHÔNG tìm được license — đủ để user copy console
// báo lại DOM mà không spam (list dài cả trăm row).
let debugLogged = 0;

/** Text TRỰC TIẾP của 1 element (chỉ text node con, BỎ text của element con).
 *  Cô lập nhãn 1 cell — tránh nuốt text của các cell khác trong cùng row. */
function directText(el: HTMLElement): string {
  let s = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) s += node.nodeValue ?? "";
  }
  return s;
}

/**
 * Tìm loại suất cấp phép ("ChatGPT" | "Codex") trong 1 row member.
 *
 * Cột "Loại suất cấp phép" hiển thị brand gọn ("ChatGPT"/"Codex") — có thể là
 * text thường, hoặc nằm trong button/dropdown (kèm mũi tên ▾) vì admin đổi được.
 * Ta duyệt mọi element, lấy DIRECT TEXT của nó (bỏ text con), strip caret, rồi
 * so khớp chính xác — vừa bắt được nút "ChatGPT ▾", vừa tránh false-positive từ
 * email/tên (vì direct text của ô email là cả địa chỉ, không bằng "chatgpt").
 */
export function findLicenseTypeInRow(row: HTMLElement): LicenseType | null {
  const els = row.querySelectorAll<HTMLElement>("*");
  for (const el of Array.from(els)) {
    const t = directText(el)
      .replace(CARET_RE, "")
      .trim()
      .toLowerCase();
    if (!t) continue;
    if (t === "codex") return "Codex";
    if (t === "chatgpt" || t === "chat gpt") return "ChatGPT";
  }

  // Không match — log vài row đầu (text rút gọn) để debug DOM.
  if (debugLogged < 3) {
    debugLogged += 1;
    const snippet = (row.textContent ?? "").trim().slice(0, 200);
    console.warn(
      `[autogpt-sync] license-type KHÔNG tìm thấy trong row. row.text="${snippet}"`,
    );
  }
  return null;
}
