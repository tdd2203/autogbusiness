/** Điền `{tên}` trong nội dung bài hướng dẫn bằng số liệu của người đang đọc.
 *
 *  LUẬT: câu nào còn chỗ trống CHƯA có giá trị thì BỎ HẲN câu đó. Các chỗ trống ở
 *  đây là đơn giá và số tiền ví dụ của chính họ — hiện một con số sai còn tệ hơn
 *  không hiện gì, mà bỏ trống kiểu "{donGia}" thì trông như bài bị hỏng.
 *
 *  Cú pháp chỗ trống: `{tên}` (chữ, số, gạch dưới). Nội dung không có `{...}` nào
 *  thì hàm này trả lại đúng bài cũ.
 */
import type { GuideContent } from "./types";

const SLOT = /\{([A-Za-z0-9_]+)\}/g;

function put(text: string, vars: Record<string, string>): string {
  return text.replace(SLOT, (whole, name: string) => vars[name] ?? whole);
}

/** Còn chỗ trống chưa điền được không. */
function unresolved(text: string): boolean {
  SLOT.lastIndex = 0;
  return SLOT.test(text);
}

export function fillGuideVars(
  content: GuideContent,
  vars: Record<string, string>,
): GuideContent {
  const sections = content.sections
    .map((section) => ({
      ...section,
      steps: section.steps
        .map((step) => ({
          ...step,
          title: put(step.title, vars),
          body: put(step.body, vars),
        }))
        .filter((step) => !unresolved(step.title) && !unresolved(step.body)),
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
