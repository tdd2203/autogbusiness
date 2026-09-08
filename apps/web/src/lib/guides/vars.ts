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

function put(text: string, vars: Record<string, string>): string {
  return text.replace(SLOT, (whole, name: string) => vars[name] ?? whole);
}

/** Còn chỗ trống chưa điền được không. */
function unresolved(text: string): boolean {
  SLOT.lastIndex = 0;
  return SLOT.test(text);
}

/** Điền cả bảng của bước, không riêng câu chữ: số tiền ví dụ nằm trong ô bảng. */
function fillStep(step: GuideStep, vars: Record<string, string>): GuideStep {
  const next: GuideStep = {
    ...step,
    title: put(step.title, vars),
    body: put(step.body, vars),
  };
  if (step.table) {
    next.table = {
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
  if (unresolved(step.title) || unresolved(step.body)) return true;
  if (!step.table) return false;
  return [...step.table.head, ...step.table.rows.flat()].some(unresolved);
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
