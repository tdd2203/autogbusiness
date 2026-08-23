import { sleep } from "../../../human";
import type { SeatAvailability } from "./parse-seat-availability";

/**
 * ĐỌC LẠI hai nguồn số suất cho tới khi chúng KHỚP NHAU (hoặc hết giờ).
 *
 * Modal "Quản lý suất" có hai chỗ nói về tổng suất:
 *   - dòng tỉ lệ  "150/151 đã gán"   → tổng = 151
 *   - bộ đếm      "[−] 151 [+]"      → tổng = 151
 * Khớp nhau thì tin được. Lệch nhau nghĩa là một trong hai đọc sai → KHÔNG dám
 * dùng để quyết định mua (mời khi thiếu suất sẽ kích hoạt luồng mua-kèm-mời của
 * ChatGPT, tức tiêu tiền thật của workspace).
 *
 * ⚠️ VÌ SAO PHẢI CHỜ, KHÔNG ĐƯỢC CHỐT NGAY LẦN ĐỌC ĐẦU (ca thật 23/8/2026):
 * một khách bị mời lại hỏng vì bộ đếm đọc ra 150 trong khi dòng tỉ
 * lệ nói 151 — tức CÒN TRỐNG 1 suất, thừa sức mời. Hai chỗ này là hai component
 * React khởi tạo độc lập: code cũ chờ dòng tỉ lệ tới 8 giây (đã biết nó render
 * chậm một nhịp) nhưng đọc bộ đếm NGAY dòng kế tiếp, không chờ, không thử lại →
 * chụp trúng một trị số quá độ. Lệch đúng 1 đơn vị là chữ ký của kiểu đua này, và
 * nó chỉ nổ đúng 1 lần trong toàn bộ lịch sử — không phải số liệu ChatGPT sai.
 *
 * Chốt chặn GIỮ NGUYÊN (lệch thật vẫn chặn), chỉ thêm cho hai bên cơ hội ổn định.
 * Đọc lại CẢ HAI mỗi vòng chứ không riêng bộ đếm: bên nào chậm nhịp cũng có thể là
 * bên sai, không có lý do gì tin dòng tỉ lệ hơn.
 *
 * Khớp ngay từ lần đọc đầu (trường hợp thường gặp) → trả về luôn, KHÔNG tốn nhịp chờ.
 *
 * Trả về cặp giá trị ĐỌC ĐƯỢC CUỐI CÙNG — caller tự so lại và quyết định. Hết giờ
 * không phải lỗi ở đây; caller cần đúng hai con số cuối để báo lỗi cho người đọc.
 */
export async function settleSeatCrossCheck(
  readRatio: () => SeatAvailability | null,
  readStepper: () => number | null,
  timeoutMs: number,
  pollMs: number,
): Promise<{ availability: SeatAvailability | null; stepperTotal: number | null }> {
  let availability = readRatio();
  let stepperTotal = readStepper();

  // Không có dòng tỉ lệ thì không có gì để đối chiếu — caller đã có nhánh lỗi riêng.
  if (!availability) return { availability, stepperTotal };

  const deadline = Date.now() + timeoutMs;
  // `null` (chưa định vị được bộ đếm) cũng vào vòng chờ: bộ đếm render muộn thì
  // vòng này bắt được, còn không thì caller vẫn bỏ qua đối chiếu như trước.
  while (stepperTotal !== availability.total && Date.now() < deadline) {
    await sleep(pollMs);
    const ratioAgain = readRatio();
    // Giữ lần đọc được gần nhất: dòng tỉ lệ biến mất giữa chừng (modal đang đóng)
    // không được làm mất con số đã đọc.
    if (ratioAgain) availability = ratioAgain;
    stepperTotal = readStepper();
  }

  return { availability, stepperTotal };
}
