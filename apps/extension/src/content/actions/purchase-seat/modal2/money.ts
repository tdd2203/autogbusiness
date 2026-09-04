/**
 * Đọc tiền trong modal "Xem lại giao dịch mua" (UI ChatGPT Business 2026-08-22,
 * locale vi).
 *
 * Vì sao tách riêng: modal in nhiều con số cạnh nhau, mỗi con số một ý nghĩa —
 * bắt nhầm là ghi audit sai khoản tiền vừa trừ. Text thật (đã gộp whitespace):
 *
 *   Thêm 1 suất Tiêu chuẩn   Có hiệu lực ngay lập tức   + 649.000 đ/tháng
 *   Hóa đơn hằng tháng hiện tại   12.243.500 đ + thuế   47 ghế Tiêu chuẩn
 *   Hóa đơn mới hằng tháng        12.504.000 đ + thuế   48 ghế Tiêu chuẩn
 *   Tạm tính theo tỷ lệ           24.698 đ
 *   Thuế bán hàng (10,001%)        2.470 đ
 *   Tổng phải trả hôm nay         27.168 đ
 *
 * Con số ĐÁNG TIỀN NHẤT không phải "Tổng phải trả hôm nay" (chỉ là phần lẻ
 * prorate tới cuối chu kỳ) mà là chênh lệch "Hóa đơn mới" − "Hóa đơn hiện tại"
 * = khoản CỐ ĐỊNH bị trừ MỖI THÁNG về sau. Cả hai đều được đọc.
 *
 * ⚠️ DÒNG ĐƠN GIÁ ("649.000 đ/tháng", "+ 1.298.000 đ/tháng") KHÔNG PHẢI GIÁ
 * THẬT và KHÔNG được dùng vào bất cứ đâu — workspace này có GIẢM GIÁ. Đối chiếu
 * 2 ảnh user 2026-08-22:
 *
 *              đơn giá niêm yết   hiệu 2 hoá đơn   tạm tính tỷ lệ   → tỷ lệ
 *   47 ghế →   649.000/suất       260.500/suất     24.698 đ           9,48%
 *   53 ghế →   649.000/suất       260.500/suất     48.027 đ           9,22%
 *
 * Lấy giá niêm yết thì tỷ lệ prorate ra 3,8% và lệch nhau giữa 2 workspace;
 * lấy giá sau giảm thì cả hai ra ~9,3%, khớp cùng một chu kỳ. Vậy giá thật là
 * 260.500 đ/suất/tháng, và "Tạm tính theo tỷ lệ" tính từ giá đó.
 *
 * Hệ quả cho thiết kế: TUYỆT ĐỐI không đặt chốt kiểu "mức tăng phải bằng đơn
 * giá × số suất" — chốt đó sẽ chặn oan mọi lần mua của workspace có giảm giá.
 *
 * ⚠️ VÀ 260.500 CŨNG CHƯA PHẢI CHI PHÍ THẬT. Hai dòng hoá đơn hằng tháng ghi rõ
 * "+ thuế" ⇒ là số TRƯỚC THUẾ. Ngoài ra còn phí ngân hàng / phí quy đổi ngoại tệ
 * mà ChatGPT không hề hiển thị. Vậy:
 *   - "Tổng phải trả hôm nay" = tạm tính + thuế bán hàng, CHƯA có phí ngân hàng;
 *   - mức tăng hằng tháng = TRƯỚC thuế, chưa có thuế lẫn phí ngân hàng.
 * Mọi số ở đây là số ChatGPT khai, dùng để đối chiếu — chi phí thật chốt theo
 * hoá đơn ngân hàng (user sẽ cập nhật sau). Đừng đặt chốt so khớp tuyệt đối với
 * bất kỳ nguồn tiền nào bên ngoài.
 *
 * ⚠️ "Tạm tính theo tỷ lệ" ĐỔI theo từng lần mở modal (user quan sát 3 lần:
 * 27.311đ / 27.191đ / 27.168đ vì tính theo số giây còn lại của chu kỳ). Nên mọi
 * hàm ở đây là PURE — đọc từ text truyền vào, KHÔNG cache, KHÔNG so sánh giữa
 * các lần đọc. Caller phải đọc lại DOM ngay trước khi bấm xác nhận.
 */

/** Gộp whitespace. Giữ nguyên ký tự — dùng làm bản gốc để cắt ra text audit. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Bản thường hoá dùng để KHỚP nhãn, dài BẰNG ĐÚNG chuỗi vào (1 ký tự → 1 ký
 * tự) nên index khớp được trên bản này cắt thẳng ra bản gốc.
 *
 * Vì sao phải tự viết thay vì `normalize("NFD").replace(marks)`: `đ` (U+0111)
 * KHÔNG bị NFD tách, nên "đơn" ra "đon" — regex `hoa\s*don` trượt hết, không
 * đọc được dòng "Hóa đơn hằng tháng hiện tại". Ở đây `đ` được ánh xạ thẳng
 * sang `d`; ký hiệu tiền `đ` cũng thành `d` và MONEY_RE có tính tới.
 */
function normalizeAligned(collapsed: string): string {
  let out = "";
  for (const ch of collapsed.toLowerCase()) {
    if (ch === "đ") {
      out += "d";
      continue;
    }
    // Bỏ dấu: lấy ký tự nền của dạng NFD. Chữ Việt luôn ra đúng 1 ký tự nền.
    const base = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    out += base.length === 1 ? base : ch;
  }
  return out;
}

/** Thường hoá để khớp text (dùng chung với extract-seat-count). */
export function normalizeForMatch(text: string): string {
  return normalizeAligned(collapse(text));
}

/**
 * Một cụm tiền, khớp trên text GỐC (còn `đ`) chứ KHÔNG khớp trên bản thường
 * hoá. Lý do: bản thường hoá biến `đ` thành `d`, mà `d` lại là chữ cái bình
 * thường → "5 days" thành cụm tiền giả, còn `27.168 đVISA •••• 4481`
 * (textContent nối 2 element liền nhau, không có space) thì phải chấp nhận —
 * hai ràng buộc này triệt tiêu nhau. Giữ `đ` nguyên là hết mập mờ.
 *
 * Chấp nhận cả 2 thứ tự vì UI cũ in `đ2080.24` còn UI mới in `27.168 đ`.
 */
const MONEY_RE = /[₫đ$¥]\s*\d[\d.,]*|\d[\d.,]*\s*(?:[₫đ¥]|VND|USD)/i;

/**
 * Nhãn mở đầu một dòng khác trong bảng tổng kết. Dùng làm HÀNG RÀO: cụm tiền
 * của dòng này phải nằm TRƯỚC nhãn của dòng kế, nếu không thì coi như dòng này
 * không có tiền (trả null) chứ KHÔNG mượn số của dòng dưới.
 */
const SECTION_BOUNDARY =
  /hoa\s*don|tam\s*tinh|thue\s*ban\s*hang|tong\s*phai\s*tra|tong\s*den\s*han|tong\s*thanh\s*toan|current\s*monthly|new\s*monthly|prorated|sales\s*tax|total\s*due|月度账单|按比例|销售税|应付总额/i;

/**
 * Cắt đoạn text nằm SAU `label`, dừng tại nhãn dòng kế tiếp. Trả cả bản gốc
 * (để lấy text hiển thị) lẫn bản thường hoá (để khớp chữ).
 *
 * Phạm vi quét rộng (90 ký tự) vì thứ tự DOM của cột tiền và dòng phụ
 * ("53 ghế Tiêu chuẩn") không chắc chắn — số tiền có thể đứng sau dòng phụ.
 * Nhưng phạm vi bị CẮT tại nhãn dòng kế tiếp, nên rộng cũng không mượn nhầm
 * số của dòng dưới.
 */
function tailAfter(
  collapsed: string,
  norm: string,
  label: RegExp,
  window = 90,
): { tail: string; tailNorm: string } | null {
  const m = norm.match(label);
  if (m?.index === undefined) return null;
  const from = m.index + m[0].length;
  // norm dài BẰNG ĐÚNG collapsed → cùng một cặp index cắt được cả hai bản.
  let end = Math.min(from + window, norm.length);
  const boundary = norm.slice(from, end).match(SECTION_BOUNDARY);
  if (boundary?.index !== undefined) end = from + boundary.index;
  return { tail: collapsed.slice(from, end), tailNorm: norm.slice(from, end) };
}

function moneyAfter(
  collapsed: string,
  norm: string,
  label: RegExp,
  window = 90,
): string | null {
  const seg = tailAfter(collapsed, norm, label, window);
  if (!seg) return null;
  // Nhãn khớp trên bản thường hoá, nhưng TIỀN khớp trên bản gốc (xem MONEY_RE).
  const money = seg.tail.match(MONEY_RE);
  return money ? money[0].trim() : null;
}

/** Số ghế ghi kèm một dòng hoá đơn: "53 ghế Tiêu chuẩn" → 53. */
function seatsAfter(
  collapsed: string,
  norm: string,
  label: RegExp,
  window = 90,
): number | null {
  const seg = tailAfter(collapsed, norm, label, window);
  if (!seg) return null;
  // "316 标准 · 0 高级" (zh) và "360 Standard · 0 Premium" (en, ảnh user
  // 4/9/2026): dòng hoá đơn KHÔNG lặp lại chữ "ghế"/"seat", số ghế đứng ngay
  // trước TÊN LOẠI SUẤT. Nhận thêm tên loại, nếu không hai bản ngôn ngữ đó
  // không ra số ghế nào và chốt "số ghế sau − trước = số suất mua" mất hiệu lực.
  const m = seg.tailNorm.match(
    /(\d{1,4})\s*(?:ghe|cho\s*ngoi|suat|seat|tieu\s*chuan|cao\s*cap|standard|premium|席位|标准|高级)/i,
  );
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 0 && n <= 9999 ? n : null;
}

/**
 * Đổi cụm tiền sang số nguyên VND.
 *
 * Chỉ nhận VND (`đ`/`₫`/`vnd`) VÀ chỉ khi con số viết dạng nhóm nghìn
 * (`12.504.000`) hoặc số nguyên trần. Dạng `đ2080.24` (UI cũ, `.` là thập
 * phân) trả null — đoán bừa là ra số sai 100 lần. `$`/`¥` cũng trả null.
 */
export function parseVndAmount(moneyText: string | null): number | null {
  if (!moneyText) return null;
  if (!/[₫đ]|vnd/i.test(moneyText)) return null;
  const core = moneyText.replace(/[^\d.,]/g, "").trim();
  if (!core) return null;
  const grouped = /^\d{1,3}(?:\.\d{3})+$|^\d{1,3}(?:,\d{3})+$/.test(core);
  const plain = /^\d+$/.test(core);
  if (!grouped && !plain) return null;
  const n = parseInt(core.replace(/[.,]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * "Tổng phải trả hôm nay" (UI mới) / "Tổng đến hạn hôm nay" (UI cũ) /
 * "Total due today". Đây là khoản prorate bị trừ NGAY khi bấm xác nhận.
 *
 * KHÔNG có fallback kiểu "lấy cụm tiền đầu tiên thấy trong text" như bản cũ:
 * cụm đầu tiên của modal mới là `649.000 đ/tháng` (đơn giá 1 suất) → bản cũ ghi
 * audit sai gấp ~24 lần số tiền thật vừa trừ. Không đọc được thì trả null để
 * caller biết là KHÔNG đọc được.
 */
export function extractChargeAmountFromModal(text: string): string | null {
  const collapsed = collapse(text);
  const norm = normalizeAligned(collapsed);
  const labels: RegExp[] = [
    /tong\s*so\s*tien\s*phai\s*tra\s*hom\s*nay/i,
    /tong\s*phai\s*tra\s*hom\s*nay/i,
    /tong\s*den\s*han\s*hom\s*nay/i,
    /tong\s*thanh\s*toan\s*hom\s*nay/i,
    /total\s*due\s*today/i,
    /due\s*today/i,
    /total\s*today/i,
    // zh: "今日应付总额" (ảnh user 2026-09-01) và biến thể "今天应付总额".
    /今[天日]\s*应付\s*总额/,
    /今天?\s*应付?总额/,
  ];
  for (const label of labels) {
    const money = moneyAfter(collapsed, norm, label);
    if (money) return money;
  }
  return null;
}

/**
 * Dòng "Thuế bán hàng (10,001%)" → số tiền thuế + tỷ lệ ghi trong ngoặc.
 *
 * Tách riêng để đối soát về sau: hoá đơn hằng tháng trong modal là TRƯỚC thuế
 * ("13.806.500 đ + thuế"), nên muốn ra con số sau thuế phải cộng phần này.
 */
export function extractSalesTax(text: string): {
  text: string | null;
  percent: string | null;
} {
  const collapsed = collapse(text);
  const norm = normalizeAligned(collapsed);
  const labels: RegExp[] = [
    /thue\s*ban\s*hang/i,
    /thue\s*gtgt/i,
    /thue\s*vat/i,
    /sales\s*tax/i,
    /\bvat\b/i,
    /销售税/,
  ];
  for (const label of labels) {
    const m = norm.match(label);
    if (m?.index === undefined) continue;
    const from = m.index + m[0].length;
    const money = moneyAfter(collapsed, norm, label);
    const pct = collapsed.slice(from, from + 20).match(/\(?\s*(\d+(?:[.,]\d+)?)\s*%/);
    if (money) return { text: money, percent: pct ? pct[1] : null };
  }
  return { text: null, percent: null };
}

/**
 * Khoản "Tạm tính theo tỷ lệ" — phần chưa gồm thuế của tổng hôm nay.
 *
 * ⚠️ KHÔNG được có fallback lỏng kiểu `/theo\s*ty\s*le/`: PHỤ ĐỀ của modal là
 * "Các suất mới được tính phí THEO TỶ LỆ đến chu kỳ thanh toán tiếp theo." —
 * nhãn lỏng khớp trúng phụ đề, rồi cụm tiền gần nhất phía sau lại chính là dòng
 * ĐƠN GIÁ NIÊM YẾT ("+ 1.298.000 đ/tháng"). Bản trước thoát nạn chỉ vì cửa sổ
 * quét 90 ký tự cắt đúng giữa "1.298.000" và chữ "đ"; phụ đề ngắn đi vài chữ là
 * đọc ra giá niêm yết thay vì phần prorate. Chỉ nhận nhãn ĐẦY ĐỦ.
 */
export function extractProrationSubtotal(text: string): string | null {
  const collapsed = collapse(text);
  const norm = normalizeAligned(collapsed);
  const labels: RegExp[] = [
    /tam\s*tinh\s*theo\s*ty\s*le/i,
    /tam\s*tinh\s*ty\s*le/i,
    /prorated\s*(?:subtotal|amount|total|charge)/i,
    // zh: "按比例计费小计" — nhãn ĐẦY ĐỦ, KHÔNG rút thành /按比例/ vì phụ đề hộp
    // ("新增席位将按比例计费至下个账单周期") cũng chứa cụm đó, y hệt bẫy của bản vi.
    /按比例计费小计/,
    /按比例\s*小计/,
  ];
  for (const label of labels) {
    const money = moneyAfter(collapsed, norm, label);
    if (money) return money;
  }
  return null;
}

export type MonthlyBills = {
  /** "Hóa đơn hằng tháng hiện tại" — vd "13.806.500 đ". */
  currentText: string | null;
  currentVnd: number | null;
  /** "Hóa đơn mới hằng tháng" — vd "14.327.500 đ". */
  newText: string | null;
  newVnd: number | null;
  /**
   * newVnd − currentVnd. Đây là khoản CỐ ĐỊNH tăng thêm mỗi tháng.
   *
   * ⚠️ KHÁC với dòng đơn giá "+ 1.298.000 đ/tháng" in ở đầu modal. Ảnh user
   * 2026-08-22: đơn giá nói +1.298.000 (2 × 649.000) nhưng hoá đơn thật đi từ
   * 13.806.500 lên 14.327.500 = +521.000 (2 × 260.500) — lệch 2,5 lần vì
   * workspace có chiết khấu. Hiệu hai hoá đơn mới là số thật.
   */
  deltaVnd: number | null;
  /** "53 ghế Tiêu chuẩn" ở dòng hoá đơn hiện tại. */
  currentSeats: number | null;
  /** "55 ghế Tiêu chuẩn" ở dòng hoá đơn mới. */
  newSeats: number | null;
  /** newSeats − currentSeats. Phải bằng đúng số suất đang mua. */
  seatDelta: number | null;
};

/**
 * Đọc cặp "Hóa đơn hằng tháng hiện tại" / "Hóa đơn mới hằng tháng".
 *
 * Hai nhãn này đều chứa "hoa don ... hang thang" nên PHẢI phân biệt bằng từ
 * riêng: "hien tai" (hiện tại) vs "moi" (mới).
 */
export function extractMonthlyBills(text: string): MonthlyBills {
  const collapsed = collapse(text);
  const norm = normalizeAligned(collapsed);
  /**
   * Đọc CẢ tiền LẪN số ghế của một dòng từ CÙNG MỘT nhãn đã khớp.
   *
   * Vì sao không dò tiền và ghế độc lập: mỗi vế có danh sách nhãn dự phòng
   * riêng, nên tiền có thể lấy từ nhãn #1 còn ghế lấy từ nhãn #2 — tức ghép số
   * của hai DÒNG KHÁC NHAU rồi đem đi so với số suất đang mua. Chốt so ghế khi
   * đó vừa vô nghĩa vừa có thể chặn oan (hoặc tệ hơn: cho qua nhầm).
   */
  const readRow = (
    labels: RegExp[],
  ): { money: string | null; seats: number | null } => {
    for (const label of labels) {
      const money = moneyAfter(collapsed, norm, label);
      if (money) return { money, seats: seatsAfter(collapsed, norm, label) };
    }
    for (const label of labels) {
      const seats = seatsAfter(collapsed, norm, label);
      if (seats !== null) return { money: null, seats };
    }
    return { money: null, seats: null };
  };

  const CURRENT_LABELS = [
    /hoa\s*don\s*hang\s*thang\s*hien\s*tai/i,
    /hoa\s*don\s*hien\s*tai/i,
    /current\s*monthly\s*(?:bill|invoice|total)/i,
    /current\s*bill/i,
    // zh: "当前月度账单" (ảnh user 2026-09-01).
    /当前\s*月度\s*账单/,
    /当前\s*账单/,
  ];
  const NEW_LABELS = [
    /hoa\s*don\s*moi\s*hang\s*thang/i,
    /hoa\s*don\s*hang\s*thang\s*moi/i,
    /hoa\s*don\s*moi/i,
    /new\s*monthly\s*(?:bill|invoice|total)/i,
    /new\s*bill/i,
    // zh: "新的月度账单".
    /新的?\s*月度\s*账单/,
    /新\s*账单/,
  ];

  const currentRow = readRow(CURRENT_LABELS);
  const newRow = readRow(NEW_LABELS);
  const currentText = currentRow.money;
  const newText = newRow.money;
  const currentSeats = currentRow.seats;
  const newSeats = newRow.seats;

  const currentVnd = parseVndAmount(currentText);
  const newVnd = parseVndAmount(newText);
  const deltaVnd =
    currentVnd !== null && newVnd !== null ? newVnd - currentVnd : null;
  const seatDelta =
    currentSeats !== null && newSeats !== null ? newSeats - currentSeats : null;

  return {
    currentText,
    currentVnd,
    newText,
    newVnd,
    deltaVnd,
    currentSeats,
    newSeats,
    seatDelta,
  };
}
