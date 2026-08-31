/** Xuất một bài hướng dẫn ra PDF — dựng trang HTML in được rồi gọi hộp thoại in.
 *
 *  Không thêm thư viện PDF: hộp thoại in của trình duyệt nào cũng có sẵn mục
 *  "Save as PDF", đủ dùng mà không phải kéo về jsPDF + html2canvas cả megabyte
 *  cho đúng một cái nút.
 *
 *  Vì sao dựng trang riêng chứ không in thẳng popup: popup cuộn trong khung, ảnh
 *  `loading="lazy"` chưa tải hết, màu lại chạy theo theme — in ra là bản cụt và
 *  nền đen. Trang riêng đặt màu in cố định, chờ MỌI ảnh tải xong mới `print()`,
 *  nên bản PDF luôn đủ bước và đọc được trên giấy.
 *
 *  `guidePrintHtml` là hàm thuần để test được — xem `guides.test.ts`.
 */
import type { GuideContent, GuideStep } from "./types";

export type GuidePrintOptions = {
  /** Ngôn ngữ đang xem, đặt vào `<html lang>` cho ngắt dòng đúng tiếng Trung. */
  lang: string;
  /** Nhãn mục "Lưu ý" — lấy từ i18n để khớp ngôn ngữ của bài. */
  notesLabel: string;
  /** Gốc để đổi URL ảnh sang tuyệt đối. Cửa sổ in là `about:blank` nên đường
   *  dẫn tương đối kiểu `/assets/...` sẽ không tải được ảnh nào. */
  baseUrl?: string;
};

/** Bản Inter mỏng (chỉ 4 độ đậm dùng tới) cho trang in — chờ font đầy đủ chỉ
 *  làm hộp thoại in mở chậm. */
const FONT_HREF =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap";

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `**đậm**` → `<strong>`, chạy SAU khi escape nên không có đường cho HTML thô. */
function markup(text: string): string {
  return esc(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function absUrl(url: string, base?: string): string {
  if (!base) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function stepHtml(step: GuideStep, index: number, base?: string): string {
  const num = String(index).padStart(2, "0");
  const parts = [
    `<div class="step">`,
    `<div class="step-row"><span class="step-num">${esc(num)}</span>`,
    `<div class="step-text"><div class="step-title">${markup(step.title)}</div>`,
    `<p class="step-body">${markup(step.body)}</p></div></div>`,
  ];
  if (step.image) {
    const cap = step.caption ? `<figcaption>${esc(step.caption)}</figcaption>` : "";
    const css = step.imageMaxWidth ? ` style="max-width:${step.imageMaxWidth}px"` : "";
    parts.push(
      `<figure><img src="${esc(absUrl(step.image, base))}" alt="${esc(
        step.imageAlt ?? step.title,
      )}"${css}>${cap}</figure>`,
    );
  }
  parts.push(`</div>`);
  return parts.join("");
}

/** Script chạy trong CỬA SỔ IN: chờ ảnh + font rồi mới mở hộp thoại in.
 *
 *  Có hạn 8 giây: một ảnh hỏng hoặc font Google bị chặn thì vẫn phải in ra được,
 *  chờ mãi là nút thành nút chết. Đóng cửa sổ sau khi in để user quay lại đúng
 *  chỗ đang đọc. */
const PRINT_SCRIPT = `
(function () {
  var fired = false;
  function go() {
    if (fired) return;
    fired = true;
    try { window.focus(); } catch (e) {}
    window.print();
  }
  function whenFonts() {
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(go, go);
    else go();
  }
  var imgs = Array.prototype.slice.call(document.images);
  var left = imgs.length;
  function tick() { if (--left <= 0) whenFonts(); }
  imgs.forEach(function (img) {
    if (img.complete) tick();
    else { img.addEventListener('load', tick); img.addEventListener('error', tick); }
  });
  if (!imgs.length) whenFonts();
  setTimeout(go, 8000);
  window.addEventListener('afterprint', function () { window.close(); });
})();
`;

const STYLE = `
@page { size: A4; margin: 14mm 12mm 16mm; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; }
body {
  font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  color: #1c1a17; font-size: 11pt; line-height: 1.6;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.wrap { max-width: 186mm; margin: 0 auto; padding: 6mm 4mm 10mm; }
.eyebrow { font-size: 8pt; letter-spacing: .12em; text-transform: uppercase; color: #0f7b57; font-weight: 600; }
h1 { font-size: 20pt; line-height: 1.25; letter-spacing: -.02em; margin: 4pt 0 8pt; }
.intro { margin: 0; color: #3f3b36; }
.section { margin-top: 9mm; }
.section-head { display: flex; align-items: center; gap: 10px; margin-bottom: 2mm; }
.section-head span { font-size: 8pt; letter-spacing: .12em; text-transform: uppercase; font-weight: 700; }
.section-head i { display: block; flex: 1; height: 1px; background: #e2ddd5; }
.step { margin-top: 6mm; break-inside: avoid; page-break-inside: avoid; }
.step-row { display: flex; gap: 10px; align-items: baseline; }
.step-num { font-size: 9.5pt; font-weight: 700; color: #0f7b57; width: 16pt; flex: none; }
.step-text { min-width: 0; }
.step-title { font-size: 12pt; font-weight: 700; letter-spacing: -.01em; }
.step-body { margin: 2pt 0 0; color: #3f3b36; }
figure { margin: 3mm 0 0 26pt; break-inside: avoid; page-break-inside: avoid; }
figure img { display: block; width: 100%; border: 1px solid #e2ddd5; border-radius: 6px; }
figcaption { margin-top: 2mm; font-size: 8.5pt; color: #6c655c; }
.notes { margin-top: 9mm; padding: 4mm 5mm; border: 1px solid #e2ddd5; border-radius: 8px; background: #faf8f5; break-inside: avoid; page-break-inside: avoid; }
.notes-head { font-size: 8pt; letter-spacing: .12em; text-transform: uppercase; font-weight: 600; color: #a06a12; margin-bottom: 2mm; }
.notes ul { margin: 0; padding-left: 16pt; }
.notes li + li { margin-top: 2mm; }
strong { font-weight: 600; }
`;

/** Trang HTML hoàn chỉnh của bài hướng dẫn, dùng để in ra PDF. */
export function guidePrintHtml(
  content: GuideContent,
  opts: GuidePrintOptions,
): string {
  const sections = content.sections
    .map((section) => {
      const head = section.heading
        ? `<div class="section-head"><span>${esc(section.heading)}</span><i></i></div>`
        : "";
      const steps = section.steps
        .map((step, i) => stepHtml(step, i + 1, opts.baseUrl))
        .join("");
      return `<div class="section">${head}${steps}</div>`;
    })
    .join("");

  const notes =
    content.notes && content.notes.length > 0
      ? `<div class="notes"><div class="notes-head">${esc(
          opts.notesLabel,
        )}</div><ul>${content.notes
          .map((note) => `<li>${markup(note)}</li>`)
          .join("")}</ul></div>`
      : "";

  return `<!doctype html>
<html lang="${esc(opts.lang)}">
<head>
<meta charset="utf-8">
<title>${esc(content.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONT_HREF}">
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<div class="eyebrow">${esc(content.eyebrow)}</div>
<h1>${esc(content.title)}</h1>
<p class="intro">${markup(content.intro)}</p>
${sections}
${notes}
</div>
<script>${PRINT_SCRIPT}</script>
</body>
</html>`;
}

/** In qua iframe ẩn — đường lui khi cửa sổ bật lên bị chặn.
 *
 *  Chỉ là đường lui vì tên file PDF gợi ý sẽ lấy theo tiêu đề trang dashboard
 *  chứ không phải tên bài; đổi lại thì trình chặn popup không cản được. */
function printViaIframe(html: string): boolean {
  try {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText =
      "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    document.body.appendChild(frame);
    const win = frame.contentWindow;
    if (!win) {
      frame.remove();
      return false;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    // Gỡ khung sau khi in xong, KHÔNG gỡ ngay: hộp thoại in vẫn đang đọc nội
    // dung của nó. Hẹn giờ dọn phòng khi user bấm Huỷ mà trình duyệt im lặng.
    win.addEventListener("afterprint", () => frame.remove());
    setTimeout(() => frame.remove(), 120_000);
    return true;
  } catch {
    return false;
  }
}

/** Mở hộp thoại in cho bài hướng dẫn. `false` = không mở nổi, hãy báo người dùng. */
export function openGuidePrint(
  content: GuideContent,
  opts: GuidePrintOptions,
): boolean {
  const html = guidePrintHtml(content, opts);
  // KHÔNG truyền `noopener`: Chrome trả về null, mất luôn tay cầm để ghi nội dung.
  const win = window.open("", "_blank");
  if (!win) return printViaIframe(html);
  win.document.open();
  win.document.write(html);
  win.document.close();
  return true;
}
