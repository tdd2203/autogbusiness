/** Điền `{tên}` trong nội dung bài hướng dẫn bằng số liệu của người đang đọc.
 *
 *  LUẬT: câu nào còn chỗ trống CHƯA có giá trị thì BỎ HẲN câu đó. Các chỗ trống ở
 *  đây là đơn giá và số tiền ví dụ của chính họ — hiện một con số sai còn tệ hơn
 *  không hiện gì, mà bỏ trống kiểu "{donGia}" thì trông như bài bị hỏng.
 *
 *  Cú pháp chỗ trống: `{tên}` (chữ, số, gạch dưới). Nội dung không có `{...}` nào
 *  thì hàm này trả lại đúng bài cũ.
 */
import type { GuideContent, GuideStep } from "./types";

const SLOT = /\{([A-Za-z0-9_]+)\}/g;

/** Đơn giá dùng để tính số trong bài: giá người đọc vừa gõ, không thì giá thật.
 *
 *  `draft` là đúng thứ đang nằm trong ô nhập (chuỗi chữ số, `null` = chưa gõ gì).
 *  Gõ dở — ô rỗng, số 0, hay chữ lạc vào — thì LÙI VỀ giá thật chứ không trả
 *  `null`: trả `null` là `fillGuideVars` bỏ luôn bước ví dụ, ô nhập biến mất
 *  theo, người đang xoá để gõ lại hết đường lùi.
 *
 *  Cố ý KHÔNG lưu lại ở đâu: đây là số để thử, giá bán thật nằm ở trang giá. */
export function readerFeeVnd(
  draft: string | null,
  walletFeeVnd: number | null,
): number | null {
  const typed = Number(draft);
  if (draft !== null && Number.isFinite(typed) && typed > 0) return typed;
  return walletFeeVnd;
}

function put(text: string, vars: Record<string, string>): string {
  return text.replace(SLOT, (whole, name: string) => vars[name] ?? whole);
}

/** Còn chỗ trống chưa điền được không. */
function unresolved(text: string): boolean {
  SLOT.lastIndex = 0;
  return SLOT.test(text);
}

/** Mọi câu chữ trong HÌNH của bước — nhãn trục, ghi chú, câu chú thích. */
function chartTexts(step: GuideStep): string[] {
  if (!step.chart) return [];
  return [
    step.chart.caption ?? "",
    ...step.chart.marks.flatMap((mark) => [mark.tick, mark.note ?? ""]),
  ];
}

/** Điền cả bảng của bước, không riêng câu chữ: số tiền ví dụ nằm trong ô bảng. */
function fillStep(step: GuideStep, vars: Record<string, string>): GuideStep {
  const next: GuideStep = {
    ...step,
    title: put(step.title, vars),
    body: put(step.body, vars),
  };
  if (step.chart) {
    // Hình cũng là chữ trên nền vẽ: bỏ qua thì một cái "{donGia}" lọt thẳng lên
    // hình, mà hình thì không ai ngờ tới lúc soát bài.
    next.chart = {
      ...step.chart,
      marks: step.chart.marks.map((mark) => ({
        ...mark,
        tick: put(mark.tick, vars),
        note: mark.note === undefined ? undefined : put(mark.note, vars),
      })),
      caption:
        step.chart.caption === undefined ? undefined : put(step.chart.caption, vars),
    };
  }
  if (step.table) {
    // Giữ nguyên các trường khác của bảng (`layout`), chỉ điền chữ trong ô.
    next.table = {
      ...step.table,
      head: step.table.head.map((cell) => put(cell, vars)),
      rows: step.table.rows.map((row) => row.map((cell) => put(cell, vars))),
    };
  }
  return next;
}

/** Bước còn chỗ trống ở BẤT KỲ đâu — kể cả một ô bảng — thì bỏ cả bước.
 *
 *  Bảng thiếu một ô tiền trông còn hỏng hơn câu văn thiếu số: hàng vẫn đứng đó
 *  với một ô trắng, người đọc tưởng chưa tính ra. */
function stepUnresolved(step: GuideStep): boolean {
  const texts = [step.title, step.body, ...chartTexts(step)];
  if (step.table) texts.push(...step.table.head, ...step.table.rows.flat());
  return texts.some(unresolved);
}

export function fillGuideVars(
  content: GuideContent,
  vars: Record<string, string>,
): GuideContent {
  const sections = content.sections
    .map((section) => ({
      ...section,
      steps: section.steps
        .map((step) => fillStep(step, vars))
        .filter((step) => !stepUnresolved(step)),
    }))
    // Phần rỗng sạch bước thì bỏ luôn, kẻo còn trơ mỗi cái tiêu đề.
    .filter((section) => section.steps.length > 0);

  return {
    ...content,
    intro: put(content.intro, vars),
    sections,
    notes: content.notes
      ?.map((note) => put(note, vars))
      .filter((note) => !unresolved(note)),
  };
}
