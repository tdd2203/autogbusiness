/**
 * Email FULL match regex — toàn bộ string phải là email. Dùng cho text node
 * đứng riêng (best case: ChatGPT render email vào <span> riêng).
 */
export const EMAIL_FULL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;

/**
 * Email EXTRACT regex — substring match. Dùng fallback khi ChatGPT render
 * email cùng text node với tên/avatar (vd "B b yaakovajax0054@outlook.com").
 * Phải tránh false-match từ "x@y.x" trong URLs hay attribute name.
 *
 * Chỉ extract khi:
 *   - Có đúng 1 match trong text (để không nuốt nhiều email vào 1 row)
 *   - text.length < 200 (tránh nuốt cả paragraph)
 */
export const EMAIL_EXTRACT_RE_G = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;

export function extractSingleEmail(text: string): string | null {
  if (text.length > 200) return null;
  const matches = text.match(EMAIL_EXTRACT_RE_G);
  if (!matches || matches.length !== 1) return null;
  return matches[0].toLowerCase();
}

/**
 * Tìm trong root 1 TEXT NODE có nodeValue chính xác là email format.
 *
 * Vì sao text node (không phải element)? ChatGPT đôi khi render email như TEXT
 * NODE TRỰC TIẾP của element cha — bên cạnh <span>D</span> avatar. Nếu chỉ check
 * `el.children.length === 0`, parent có cả span và text node sẽ bị skip (children
 * count = 1), còn fallback regex sẽ thấy textContent = "Ddhealth.220@gmail.com"
 * và match toàn bộ → email sai.
 *
 * TreeWalker SHOW_TEXT đi qua text nodes trực tiếp, mỗi node là 1 string độc lập
 * → email luôn tách khỏi avatar text.
 */
export function findEmailTextNode(
  root: Node,
): { email: string; parent: HTMLElement } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue ?? "").trim();
    if (!text || text.length > 100) continue;
    if (!EMAIL_FULL_RE.test(text)) continue;
    const parent = (node.parentElement ?? root) as HTMLElement;
    return { email: text.toLowerCase(), parent };
  }
  return null;
}
