/** Toạ độ của hình "hoá đơn giảm dần theo ngày" trong bài hướng dẫn.
 *
 *  Chỉ TÍNH SỐ, không vẽ: popup vẽ bằng thẻ React (màu theo biến của theme, có
 *  cả nền tối), bản in vẽ bằng chuỗi HTML với màu mực cố định. Hai nơi vẽ khác
 *  nhau nhưng phải ra ĐÚNG một hình, nên phần hình học nằm chung ở đây — và nhờ
 *  là hàm thuần nên test đo được chiều cao từng cột (xem `guides.test.ts`).
 *
 *  Ý của hình: mỗi ngày trong chu kỳ một cột, cột cao bằng số tiền ChatGPT thu
 *  cho MỘT suất thêm vào đúng ngày đó. Ngày chốt trả trọn tháng ⇒ cột cao nhất;
 *  càng lùi về cuối kỳ cột càng thấp vì chỉ còn vài ngày; qua ngày chốt kế tiếp
 *  cột vọt lại trọn tháng — phần này vẽ nhạt hơn để thấy rõ là CHU KỲ SAU.
 *
 *  Phần trăm trên đầu cột tính thẳng từ chiều cao cột, không lấy chữ người viết
 *  bài gõ: hình với chữ lệch nhau thì thà đừng vẽ.
 */
import type { GuideChart } from "./types";

/** Khung vẽ. Hình co giãn theo bề ngang cột chữ nên đây chỉ là hệ toạ độ. */
const VIEW_W = 680;
const VIEW_H = 214;
const PAD_X = 14;
/** Đỉnh cột "trọn tháng" và đường trục — khoảng giữa là toàn bộ chiều cao cột. */
const TOP = 62;
const AXIS = 182;
/** Chữ dưới trục và hai dòng chữ trên đầu cột (tính ngược từ đỉnh cột). */
const TICK_DY = 20;
const PERCENT_DY = 9;
const NOTE_DY = 24;
/** Khe giữa hai cột. Cột mảnh mà sát nhau thì hình thành một khối đặc. */
const GAP = 3;
/** Nhãn sát mép thì đổi sang canh trái/phải, kẻo chữ tràn khỏi hình. */
const EDGE = 44;

export type ProrateBar = {
  /** Ngày thứ mấy tính từ ngày chốt đầu tiên trong hình. */
  day: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Cột của CHU KỲ SAU — vẽ nhạt. */
  next: boolean;
  /** Cột có nhãn — vẽ đậm hơn các cột còn lại. */
  marked: boolean;
};

export type ProrateMark = {
  x: number;
  anchor: "start" | "middle" | "end";
  /** Đỉnh cột được chỉ vào — hai dòng chữ xếp ngay trên đó. */
  barTop: number;
  percent: string;
  note?: string;
  tick: string;
};

export type ProrateModel = {
  width: number;
  height: number;
  /** Mép trái/phải phần vẽ cột, đường trục, mức "trọn tháng". */
  left: number;
  right: number;
  axisY: number;
  topY: number;
  tickY: number;
  /** Vạch đứng ngăn hai chu kỳ. */
  boundaryX: number;
  bars: ProrateBar[];
  marks: ProrateMark[];
};

/** Số ngày của chu kỳ SAU vẽ thêm vào hình: đủ để thấy cột vọt lại trọn tháng
 *  rồi tụt xuống, chứ vẽ dài nữa thì phần chính bị bóp lại. */
function tailDays(days: number): number {
  return Math.max(3, Math.round(days / 5));
}

/** Số ngày còn lại tính từ ngày `day` tới ngày chốt của chu kỳ đang ở. */
function remaining(day: number, days: number): number {
  const inCycle = day <= days ? day : day - days;
  return days - inCycle + 1;
}

export function prorateModel(chart: GuideChart): ProrateModel {
  const days = Math.max(1, Math.round(chart.days));
  const total = days + tailDays(days);
  const slot = (VIEW_W - PAD_X * 2) / total;
  const w = Math.max(4, slot - GAP);
  const full = AXIS - TOP;
  const marked = new Set(chart.marks.map((m) => m.day));

  const barTop = (day: number): number =>
    AXIS - (remaining(day, days) / days) * full;

  const bars: ProrateBar[] = [];
  for (let day = 1; day <= total; day += 1) {
    const y = barTop(day);
    bars.push({
      day,
      x: PAD_X + (day - 1) * slot,
      y,
      w,
      h: AXIS - y,
      next: day > days,
      marked: marked.has(day),
    });
  }

  const marks: ProrateMark[] = chart.marks.map((mark) => {
    const bar = bars[Math.min(bars.length, Math.max(1, mark.day)) - 1];
    const mid = bar.x + bar.w / 2;
    const anchor: ProrateMark["anchor"] =
      mid < EDGE ? "start" : mid > VIEW_W - EDGE ? "end" : "middle";
    return {
      x: anchor === "start" ? bar.x : anchor === "end" ? bar.x + bar.w : mid,
      anchor,
      barTop: bar.y,
      percent: `${Math.round((bar.h / full) * 100)}%`,
      note: mark.note,
      tick: mark.tick,
    };
  });

  return {
    width: VIEW_W,
    height: VIEW_H,
    left: PAD_X,
    right: VIEW_W - PAD_X,
    axisY: AXIS,
    topY: TOP,
    tickY: AXIS + TICK_DY,
    boundaryX: PAD_X + days * slot - GAP / 2,
    bars,
    marks,
  };
}

/** Hai dòng chữ trên đầu một cột — cùng công thức cho popup và bản in. */
export const markLabelY = (barTop: number) => ({
  percent: barTop - PERCENT_DY,
  note: barTop - NOTE_DY,
});
