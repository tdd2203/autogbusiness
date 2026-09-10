/** Kiểu dữ liệu của MỘT bài hướng dẫn hiện trong popup đầu ngày.
 *
 *  Nội dung để trong file TS (không nhét vào `i18n/locales/*.json`) vì mỗi bài là
 *  nhiều đoạn văn dài kèm ảnh; nhồi vào từ điển phẳng thì vừa khó đọc vừa dễ lệch
 *  thứ tự bước. Từ điển i18n chỉ giữ phần khung popup (nút, ô tick).
 */
import type { Lang } from "../../i18n";

/** Bảng nhỏ trong một bước — dùng cho phần TÍNH TIỀN.
 *
 *  Hai ca mua đặt cạnh nhau trong bảng đọc nhanh hơn hẳn một đoạn văn nhồi cả bốn
 *  con số vào (chốt user 8/9/2026). Không phải bảng dữ liệu: chỉ vài dòng cố định
 *  do người viết bài gõ tay.
 *
 *  Giữ TỐI ĐA 3 CỘT với bảng thường — cột chữ của bài chỉ rộng cỡ một trang
 *  sách, cột thứ tư là mọi ô vỡ dòng. Ngoại lệ là bảng so sánh gói (`layout:
 *  "compare"`): quá 3 cột thì thành bảng RỘNG, thoát khỏi cột chữ, chữ nhỏ hơn,
 *  màn hẹp cuộn ngang — ô phải ngắn (một dấu ✓, một con số, vài chữ). Ô nhận
 *  cùng cú pháp `**đậm**` và cùng chỗ trống `{tên}` như `body`, nên số tiền
 *  trong bảng cũng theo đơn giá của người đang đọc. */
export type GuideTable = {
  head: string[];
  rows: string[][];
  /** `"compare"` = bảng SO SÁNH kiểu quen mắt: cột đầu là tiêu chí, hai cột sau
   *  là hai gói đặt cạnh nhau, cột cuối là gói được khuyên (tô nền nhẹ). Ô nào
   *  cũng được xuống dòng — khác bảng tính tiền mặc định, nơi cột đầu/cuối là
   *  ngày tháng ngắn nên bị ép một dòng. */
  layout?: "compare";
  /** Cột được tô nền trong bảng so sánh, đếm từ 0. Mặc định là cột cuối; đặt
   *  khi gói được khuyên không đứng cuối (vd Business giữa 6 gói). */
  highlight?: number;
};

/** Một bước: tiêu đề + mô tả + bảng/ảnh minh hoạ (tuỳ chọn).
 *
 *  `body` nhận cú pháp `**đậm**` — xem `renderMarkup` trong DailyGuideModal. Đây là
 *  toàn bộ markup được phép: nội dung do mình viết nên không cần HTML thô. */
export type GuideStep = {
  title: string;
  body: string;
  /** Bảng ngay dưới `body`, trước ảnh nếu có cả hai. */
  table?: GuideTable;
  /** URL ảnh do Vite sinh khi `import` file trong `src/assets/guides/...`. */
  image?: string;
  imageAlt?: string;
  caption?: string;
  /** Ảnh chụp khung hẹp (menu, hộp thoại nhỏ) phóng hết chiều ngang trông vỡ nét. */
  imageMaxWidth?: number;
  /** Hiện ô cho người đọc gõ ĐƠN GIÁ khác ngay dưới đoạn văn của bước này.
   *
   *  Gõ vào thì mọi con số của bài (và bản PDF in ra) tính lại theo giá đó —
   *  đại lý hay phải báo giá cho khách theo một mức khác mức của chính mình.
   *  Chỉ là số để xem: KHÔNG lưu, đóng popup là về đơn giá thật. Đặt cờ này ở
   *  bước có ví dụ, chứ đặt ở bước không dùng số thì ô nhập đứng đó vô duyên. */
  feeInput?: boolean;
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

/** Dữ liệu của NGƯỜI ĐANG ĐỌC để bài hướng dẫn điền vào chỗ trống.
 *
 *  `feeVnd` = đơn giá tháng hiệu lực của chính họ (ví trả về), `null` khi chưa
 *  biết. Bài nào cần số này thì tự lo phần tính; popup chỉ đưa dữ liệu vào. */
export type GuideVarContext = {
  feeVnd: number | null;
};

/** Một bài hướng dẫn, có bản dịch cho MỌI ngôn ngữ dashboard đang hỗ trợ.
 *
 *  `Record<Lang, ...>` là cố ý: thêm ngôn ngữ mới cho dashboard mà quên dịch bài
 *  hướng dẫn thì TypeScript báo đỏ ngay, không để user thấy popup tiếng Việt lẫn
 *  giữa giao diện tiếng Trung. */
export type Guide = {
  id: string;
  /** Giá trị cho các chỗ `{tên}` trong nội dung (vd đơn giá của người đang đọc).
   *
   *  Trả về thiếu key nào thì CÂU chứa key đó bị bỏ khỏi bài — xem
   *  `fillGuideVars`. Thà mất một câu còn hơn hiện một con số sai về tiền. */
  vars?: (ctx: GuideVarContext) => Record<string, string>;
  content: Record<Lang, GuideContent>;
};
