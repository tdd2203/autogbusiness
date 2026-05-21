import { parseChatGPTRole } from "../../../i18n-ui";
import { EMAIL_FULL_RE } from "./email";
import { DATE_RE } from "./joined-at";

/**
 * Tìm name — walk text nodes trong row, loại trừ email/date/role/license/avatar
 * initial. Trả về first qualifying text node trimmed.
 */
export function findNameInRow(row: HTMLElement, email: string): string | null {
  const emailPrefix = email.split("@")[0] ?? "";
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue ?? "").trim();
    if (!text || text.length > 80) continue;
    if (EMAIL_FULL_RE.test(text)) continue;
    if (DATE_RE.test(text)) continue;
    if (parseChatGPTRole(text)) continue;
    const lower = text.toLowerCase();
    if (lower === "chatgpt") continue;
    // Avatar initial thường ≤ 3 ký tự (vd "D", "hai", "HP")
    if (text.length < 2) continue;
    // Skip nếu trùng email prefix (vd "dhealth.220" duplicate text)
    if (lower === emailPrefix.toLowerCase()) continue;
    return text;
  }
  return null;
}
