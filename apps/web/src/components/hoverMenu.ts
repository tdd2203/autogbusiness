/** Điều khiển đóng/mở cho MENU RÊ CHUỘT (nút Xuất PDF trong popup hướng dẫn).
 *
 *  Menu rê chuột hỏng theo đúng hai kiểu, và cả hai đều đã xảy ra:
 *
 *  1. CÓ KHE HỞ giữa nút và menu — chuột đi qua khe là rời vùng hover, menu tắt
 *     trước khi tay kịp tới (user báo 10/9/2026). Chỗ này chữa bằng DOM: khoảng
 *     cách phải là `padding` của một lớp bọc TRONG SUỐT, không phải `margin`.
 *  2. ĐÓNG NGAY khi chuột vừa ra khỏi mép — đi chéo từ nút xuống mục cuối là
 *     lướt ra ngoài một nhịp. Chỗ này chữa bằng TRỄ: rời đi thì hẹn giờ đóng,
 *     quay lại trong lúc chờ là huỷ hẹn.
 *
 *  Tách khỏi React để test được: môi trường test của repo là node thuần, không
 *  có DOM giả lập nên không mô phỏng nổi chuột, nhưng phần hẹn giờ thì đo được.
 */

/** Trễ trước khi đóng, tính bằng mili giây. Đủ dài cho tay đi chéo, đủ ngắn để
 *  không thành menu dính khi người ta đã bỏ đi. */
export const HOVER_CLOSE_MS = 160;

/** Khe hở giữa nút và menu, tính bằng pixel. */
export const HOVER_GAP_PX = 4;

/** Lớp bọc menu — nơi duy nhất được giữ khoảng cách tới nút.
 *
 *  Khoảng cách nằm ở `paddingTop` nên nó THUỘC vùng chuột; đặt `marginTop` cho
 *  chính menu là tạo khe thật, chuột đi qua khe là hover đứt và menu tắt trước
 *  khi tay tới. Dán liền đáy nút bằng `top: "100%"`. */
export const hoverMenuWrap: {
  position: "absolute";
  top: string;
  right: number;
  paddingTop: number;
  zIndex: number;
} = {
  position: "absolute",
  top: "100%",
  right: 0,
  paddingTop: HOVER_GAP_PX,
  zIndex: 3,
};

export type HoverMenu = {
  /** Chuột vào nút hoặc vào menu. */
  enter: () => void;
  /** Chuột rời ra — hẹn đóng, chưa đóng ngay. */
  leave: () => void;
  /** Đóng ngay, không chờ (bấm xong một mục, bấm Esc). */
  closeNow: () => void;
  /** Gỡ hẹn giờ đang treo khi popup đóng giữa chừng. */
  dispose: () => void;
};

export function createHoverMenu(
  setOpen: (open: boolean) => void,
  delayMs: number = HOVER_CLOSE_MS,
): HoverMenu {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return {
    enter() {
      clear();
      setOpen(true);
    },
    leave() {
      clear();
      timer = setTimeout(() => {
        timer = null;
        setOpen(false);
      }, delayMs);
    },
    closeNow() {
      clear();
      setOpen(false);
    },
    dispose: clear,
  };
}
