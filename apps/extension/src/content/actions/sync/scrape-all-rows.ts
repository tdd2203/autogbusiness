import type { ScrapedMember } from "../../../shared/messages";
import { parseChatGPTRole } from "../../i18n-ui";
import { SELECTORS } from "../../selectors";
import { EMAIL_FULL_RE, extractSingleEmail, findEmailTextNode } from "./row-extractors/email";
import { findJoinedAtInRow } from "./row-extractors/joined-at";
import { findLicenseTypeInRow } from "./row-extractors/license-type";
import { findNameInRow } from "./row-extractors/name";

/**
 * Đếm số email-format text nodes trong subtree (không bao gồm root chính nó
 * nếu root chỉ có 1 text node email — vẫn count 1).
 */
function countEmailsInSubtree(root: Node): number {
  let count = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue ?? "").trim();
    if (EMAIL_FULL_RE.test(text)) count += 1;
    if (count > 1) break;
  }
  return count;
}

export function scrapeAllRows(): ScrapedMember[] {
  const members: ScrapedMember[] = [];
  const seen = new Set<string>();
  let textNodesScanned = 0;
  let fullMatchHits = 0;
  let extractMatchHits = 0;

  // 1) Thử selectors có cấu trúc (data-testid v.v.) — hiện ChatGPT KHÔNG có,
  // sẽ fall qua bước 2. Giữ làm fallback nếu có Future ChatGPT release.
  for (const sel of SELECTORS.memberRow) {
    const rows = document.querySelectorAll<HTMLElement>(sel);
    if (rows.length === 0) continue;
    for (const row of Array.from(rows)) {
      const found = findEmailTextNode(row);
      if (!found || seen.has(found.email)) continue;
      seen.add(found.email);
      members.push({
        email: found.email,
        name: findNameInRow(row, found.email),
        chatgpt_role: parseChatGPTRole(row.textContent ?? null),
        license_type: findLicenseTypeInRow(row),
        status: "active",
        joined_at: findJoinedAtInRow(row),
      });
    }
    if (members.length > 0) {
      console.log(
        `[autogpt-sync] scrapeAllRows: ${members.length} rows via selector "${sel}"`,
      );
      return members;
    }
  }

  // 2) Fallback: TreeWalker SHOW_TEXT toàn DOM. Hai chiến lược song song:
  //    a) EMAIL_FULL_RE — text node CHỈ chứa email (best case, chính xác).
  //    b) EMAIL_EXTRACT_RE_G — text node chứa email cùng tên/avatar
  //       (vd "B b yaakovajax0054@outlook.com" — UI ChatGPT 2026 đôi khi
  //       concat avatar initial + name + email vào 1 text node).
  //
  // Chiến lược (a) ưu tiên — nếu cùng email match cả 2, dedupe qua `seen`.
  const allCandidates: Array<{ email: string; node: Node }> = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodesScanned += 1;
    const text = (node.nodeValue ?? "").trim();
    if (!text) continue;
    if (text.length <= 100 && EMAIL_FULL_RE.test(text)) {
      fullMatchHits += 1;
      allCandidates.push({ email: text.toLowerCase(), node });
      continue;
    }
    const extracted = extractSingleEmail(text);
    if (extracted) {
      extractMatchHits += 1;
      allCandidates.push({ email: extracted, node });
    }
  }

  for (const { email, node: textNode } of allCandidates) {
    if (seen.has(email)) continue;
    seen.add(email);

    // Walk up tìm row chứa email; stop khi parent chứa >1 email
    let row: HTMLElement | null = textNode.parentElement;
    for (let i = 0; i < 6 && row?.parentElement; i++) {
      const parent = row.parentElement;
      const emailCountInParent = countEmailsInSubtree(parent);
      if (emailCountInParent > 1) break;
      row = parent;
    }
    if (!row) continue;

    members.push({
      email,
      name: findNameInRow(row, email),
      chatgpt_role: parseChatGPTRole(row.textContent ?? null),
      license_type: findLicenseTypeInRow(row),
      status: "active",
      joined_at: findJoinedAtInRow(row),
    });
  }

  console.log(
    `[autogpt-sync] scrapeAllRows scanned ${textNodesScanned} text nodes → ` +
      `${fullMatchHits} full-match + ${extractMatchHits} extract-match → ` +
      `${members.length} unique rows`,
  );

  return members;
}
