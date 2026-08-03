import { createElement, type ReactNode } from "react";

/**
 * Bản xem trước tin Telegram — dựng mẫu bằng dữ liệu mẫu rồi VẼ RA đúng như Telegram
 * hiển thị, thay vì in mã nguồn `<b>...</b>` ra màn hình.
 *
 * Lý do phải render chứ không in thô: người soạn mẫu nhìn `<code>khach@gmail.com</code>`
 * thì không hình dung được tin gửi đi trông thế nào — mà đó lại là câu hỏi duy nhất họ
 * cần trả lời trước khi bấm Lưu.
 */

/** Dữ liệu mẫu do API trả về (chính bộ đã dựng nên `preview` phía server). */
export type TemplateSample = {
  items: { email: string; expiry: string; days_left: string }[];
  count: number;
  bucket: number;
  link: string;
  owner: string;
  workspace: string;
};

/** Thay `{ten}` bằng giá trị — khớp `render_template` phía API (không dùng
 *  String.replace với regex để dấu `{` `}` người dùng gõ lung tung không làm vỡ tin). */
function renderTemplate(template: string, values: Record<string, string | number>) {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{${key}}`).join(String(value));
  }
  return out;
}

/** Dựng tin hoàn chỉnh (HTML kiểu Telegram) từ mẫu thân + mẫu dòng + dữ liệu mẫu. */
export function buildPreview(body: string, itemLine: string, sample: TemplateSample) {
  const common = { bucket: sample.bucket, owner: sample.owner };
  const items = sample.items
    .map((item) =>
      renderTemplate(itemLine, { ...item, ...common, workspace: sample.workspace }),
    )
    .join("\n");
  return renderTemplate(body, {
    ...common,
    items,
    count: sample.count,
    link: sample.link,
  });
}

// Thẻ Telegram THẬT SỰ hiểu (Bot API "HTML style") → thẻ tương đương của web. Thẻ
// ngoài danh sách này Telegram trả lỗi "can't parse entities" và tin sẽ gửi bằng mẫu
// gốc, nên bản xem trước phải in chúng ra như chữ thường + báo cho người soạn biết.
const TAGS: Record<string, string> = {
  b: "strong",
  strong: "strong",
  i: "em",
  em: "em",
  u: "u",
  ins: "u",
  s: "s",
  strike: "s",
  del: "s",
  code: "code",
  pre: "pre",
  a: "a",
};

const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
};

function decode(text: string) {
  return text.replace(/&(lt|gt|amp|quot|#39);/g, (m) => ENTITIES[m] ?? m);
}

function hrefOf(attrs: string) {
  const m = attrs.match(/href\s*=\s*("([^"]*)"|'([^']*)')/i);
  const raw = decode(m?.[2] ?? m?.[3] ?? "");
  // Chỉ scheme an toàn: mẫu là do chính chủ tài khoản gõ, nhưng không có lý do gì để
  // một bản xem trước chạy được `javascript:`.
  return /^(https?:|mailto:|tg:)/i.test(raw) ? raw : null;
}

type Node = { tag: string; attrs: string; children: (Node | string)[] };

/**
 * Bóc HTML Telegram thành cây node. `invalid` = có thẻ lạ hoặc thẻ không đóng —
 * đúng những trường hợp Telegram từ chối tin.
 */
function parse(html: string): { children: (Node | string)[]; invalid: boolean } {
  const root: Node = { tag: "", attrs: "", children: [] };
  const stack: Node[] = [root];
  const top = () => stack[stack.length - 1];
  const text = (s: string) => {
    if (s) top().children.push(decode(s));
  };

  let invalid = false;
  let last = 0;
  const re = /<(\/?)([a-zA-Z]+)([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    text(html.slice(last, m.index));
    last = m.index + m[0].length;
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    if (!(name in TAGS)) {
      invalid = true;
      text(m[0]); // thẻ lạ → hiện nguyên văn, giống thứ Telegram sẽ phàn nàn
      continue;
    }
    if (!closing) {
      stack.push({ tag: name, attrs: m[3], children: [] });
      continue;
    }
    if (stack.length === 1 || top().tag !== name) {
      invalid = true;
      text(m[0]);
      continue;
    }
    const node = stack.pop() as Node;
    top().children.push(node);
  }
  text(html.slice(last));

  // Thẻ mở mà quên đóng: vẫn vẽ ra (người soạn thấy được mình đang định dạng gì) nhưng
  // đánh dấu invalid để cảnh báo — Telegram sẽ không nhận mẫu này.
  while (stack.length > 1) {
    invalid = true;
    const node = stack.pop() as Node;
    stack[stack.length - 1].children.push(node);
  }
  return { children: root.children, invalid };
}

const CODE_STYLE = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.92em",
  background: "var(--surface-2)",
  borderRadius: 4,
  padding: "0 3px",
} as const;

function toReact(nodes: (Node | string)[]): ReactNode[] {
  return nodes.map((node, i) => {
    if (typeof node === "string") return node;
    const children = toReact(node.children);
    if (node.tag === "a") {
      const href = hrefOf(node.attrs);
      return href ? (
        <a key={i} href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      ) : (
        <span key={i}>{children}</span>
      );
    }
    const style =
      node.tag === "code" || node.tag === "pre" ? CODE_STYLE : undefined;
    return createElement(TAGS[node.tag], { key: i, style }, ...children);
  });
}

/**
 * Bong bóng chat mô phỏng tin bot gửi. Cố tình để giống Telegram (nền hội thoại, bong
 * bóng bo góc) — người soạn nhìn phát là biết khách sẽ thấy gì. KHÔNG vẽ giờ giả:
 * giờ gửi tuỳ cấu hình RENEWAL_REMINDER_HOUR, in đại một con số chỉ làm người ta tin
 * nhầm là tin gửi lúc đó.
 */
export function TelegramPreview({ html, invalidNote }: { html: string; invalidNote: string }) {
  const { children, invalid } = parse(html);
  return (
    <div>
      <div
        style={{
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 12,
        }}
      >
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "12px 12px 12px 4px",
            boxShadow: "var(--shadow-sm)",
            padding: "10px 12px",
            maxWidth: 400,
            fontSize: 13.5,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {toReact(children)}
        </div>
      </div>
      {invalid && (
        <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 6 }}>
          ⚠️ {invalidNote}
        </div>
      )}
    </div>
  );
}
