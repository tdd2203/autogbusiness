import type { ScrapedMember } from "../../../shared/messages";
import { parseChatGPTRole } from "../../i18n-ui";
import { SELECTORS } from "../../selectors";
import { EMAIL_FULL_RE, extractSingleEmail, findEmailTextNode } from "./row-extractors/email";
import { findJoinedAtInRow } from "./row-extractors/joined-at";
import { findLicenseTypeInRow } from "./row-extractors/license-type";
import { findNameInRow } from "./row-extractors/name";
import { findRoleInRow } from "./row-extractors/role";

/**
 * Vai trò của 1 row.
 *
 * `findRoleInRow` so KHỚP CHÍNH XÁC nhãn của từng ô (direct text) nên không thể
 * nhặt nhầm chữ trong tên/email. `parseChatGPTRole` trên `row.textContent` là
 * so CHỨA trên cả dòng — "admin" trong địa chỉ mail cũng thành vai trò admin —
 * nên chỉ dùng làm lưới đỡ khi cách chính xác không đọc được nhãn nào.
 */
function readRole(row: HTMLElement) {
  return findRoleInRow(row) ?? parseChatGPTRole(row.textContent ?? null);
}

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

/**
 * Phần tử này CÓ ĐANG HIỆN trên trang không (không phải chỉ nằm trong DOM).
 *
 * VÌ SAO CẦN (ca thật 30/8/2026): bấm sang tab "Lời mời đang chờ" xong, React
 * vẫn giữ nguyên bảng của tab "Người dùng" trong DOM ở dạng ẩn. `scrapeAllRows`
 * quét thẳng `document` nên đọc trúng cả trăm dòng đã ẩn ⇒ bước đếm lời mời chờ
 * lần nào cũng thấy "vẫn còn 25 email của tab Người dùng" ⇒ chờ hết trần rồi bỏ
 * cuộc. Mỗi lệnh mời mất 50-250s cho một phép đếm không bao giờ ra.
 *
 * Đo bằng hình học chứ không bằng CSS: `display:none` (kể cả qua thuộc tính
 * `hidden`) thì không có hình chữ nhật nào. Thêm cửa `aria-hidden` cho lớp phủ
 * vẫn chiếm chỗ. Tab chạy NỀN vẫn tính layout bình thường nên cách đo này không
 * hắt oan cả trang.
 */
export function isRenderedVisible(el: Element | null): boolean {
  if (!el) return false;
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;
  if ((el as HTMLElement).offsetParent !== null) return true;
  return el.getClientRects().length > 0;
}

export type ScrapeRowsOptions = {
  /**
   * true = BỎ QUA mọi dòng đang ẩn. Dùng cho chỗ phải phân biệt "danh sách của
   * tab này" với "danh sách tab cũ React chưa gỡ" — xem `isRenderedVisible`.
   * Mặc định false để giữ nguyên hành vi của mọi caller cũ.
   */
  visibleOnly?: boolean;
};

export function scrapeAllRows(opts: ScrapeRowsOptions = {}): ScrapedMember[] {
  const visibleOnly = opts.visibleOnly === true;
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
      if (visibleOnly && !isRenderedVisible(row)) continue;
      const found = findEmailTextNode(row);
      if (!found || seen.has(found.email)) continue;
      seen.add(found.email);
      members.push({
        email: found.email,
        name: findNameInRow(row, found.email),
        chatgpt_role: readRole(row),
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

    // Walk up tìm row chứa email; stop khi parent chứa >1 email
    let row: HTMLElement | null = textNode.parentElement;
    for (let i = 0; i < 6 && row?.parentElement; i++) {
      const parent = row.parentElement;
      const emailCountInParent = countEmailsInSubtree(parent);
      if (emailCountInParent > 1) break;
      row = parent;
    }
    if (!row) continue;
    // Lọc "đang hiện" ở mức DÒNG, không phải mức text node.
    //
    // `isRenderedVisible` đọc `offsetParent`/`getClientRects` — mỗi lần gọi là ép
    // trình duyệt tính lại bố cục. Hỏi ở vòng quét text node nghĩa là hàng nghìn
    // lần tính bố cục cho MỘT lượt đọc, mà một lượt cuộn gọi tới ba lượt đọc:
    // trên workspace 300+ dòng thì chính cái lọc này làm trang ì. Hỏi ở đây chỉ
    // tốn đúng một lần cho mỗi dòng, và dòng mới là thứ caller quan tâm.
    //
    // Cũng vì vậy mà chốt `seen` dời xuống SAU: đánh dấu trước rồi mới loại dòng
    // ẩn thì một email vừa nằm ở bảng ẩn vừa nằm ở bảng đang hiện sẽ bị bảng ẩn
    // "chiếm chỗ" rồi mất hẳn khỏi kết quả.
    if (visibleOnly && !isRenderedVisible(row)) continue;
    seen.add(email);

    members.push({
      email,
      name: findNameInRow(row, email),
      chatgpt_role: readRole(row),
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
