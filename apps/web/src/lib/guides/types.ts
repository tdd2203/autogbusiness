/** Kiểu dữ liệu của MỘT bài hướng dẫn hiện trong popup đầu ngày.
 *
 *  Nội dung để trong file TS (không nhét vào `i18n/locales/*.json`) vì mỗi bài là
 *  nhiều đoạn văn dài kèm ảnh; nhồi vào từ điển phẳng thì vừa khó đọc vừa dễ lệch
 *  thứ tự bước. Từ điển i18n chỉ giữ phần khung popup (nút, ô tick).
 */
import type { Lang } from "../../i18n";

/** Một bước: tiêu đề + mô tả + ảnh minh hoạ (tuỳ chọn).
 *
 *  `body` nhận cú pháp `**đậm**` — xem `renderMarkup` trong DailyGuideModal. Đây là
 *  toàn bộ markup được phép: nội dung do mình viết nên không cần HTML thô. */
export type GuideStep = {
  title: string;
  body: string;
  /** URL ảnh do Vite sinh khi `import` file trong `src/assets/guides/...`. */
  image?: string;
  imageAlt?: string;
  caption?: string;
  /** Ảnh chụp khung hẹp (menu, hộp thoại nhỏ) phóng hết chiều ngang trông vỡ nét. */
  imageMaxWidth?: number;
};

/** Nhóm bước — dùng khi một bài có nhiều CÁCH làm (vd: trên web / trên app). */
export type GuideSection = {
  heading?: string;
  steps: GuideStep[];
};

export type GuideContent = {
  /** Nhãn nhỏ phía trên tiêu đề, vd "Hướng dẫn · 2 cách". */
  eyebrow: string;
  title: string;
  intro: string;
  sections: GuideSection[];
  notes?: string[];
};

/** Một bài hướng dẫn, có bản dịch cho MỌI ngôn ngữ dashboard đang hỗ trợ.
 *
 *  `Record<Lang, ...>` là cố ý: thêm ngôn ngữ mới cho dashboard mà quên dịch bài
 *  hướng dẫn thì TypeScript báo đỏ ngay, không để user thấy popup tiếng Việt lẫn
 *  giữa giao diện tiếng Trung. */
export type Guide = {
  id: string;
  content: Record<Lang, GuideContent>;
};
