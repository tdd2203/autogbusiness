/**
 * KHOÁ SUẤT — quyết định hai lệnh MỜI có được chạy cùng lúc trong 2 ô tab không.
 *
 * Luật do user chốt 2026-08-26:
 *
 *   "Lệnh mời: 1 workspace tại 1 thời điểm chỉ chạy 1 lệnh nếu số suất KHÔNG đủ
 *    (phải mua). Còn dư suất sẵn — không phải mua — thì cho 2 lệnh chạy song song."
 *
 * Vì sao phải phân biệt hai ca thay vì cấm tiệt như bản trước (`SEAT_EXCLUSIVE_TYPES`
 * ép mọi lệnh mời/mua chạy lần lượt):
 *
 *   - Ca PHẢI MUA là ca duy nhất dính tiền thật. Hai lệnh cùng đọc "còn 1 suất
 *     trống", cùng kết luận đủ, lệnh sau mời vào chỗ lệnh trước vừa lấy → ChatGPT
 *     bật hộp "Mua suất người dùng và gửi lời mời" (mua + mời trong MỘT cú bấm,
 *     không biết trước hết bao nhiêu tiền) — đúng cái hộp mà cả thiết kế
 *     đếm-suất-trước sinh ra để tránh.
 *   - Ca CÒN DƯ SUẤT không đụng tới tiền: hai lệnh chỉ điền email rồi bấm Gửi.
 *     Bắt chúng xếp hàng là bỏ không một ô tab, mời chậm đi gấp đôi không vì gì.
 *
 * Nên khoá này là khoá ĐỌC-GHI, không phải mutex:
 *
 *   - lease CHIA SẺ (`shared`)   — chỉ cấp khi số suất trống dashboard gửi kèm
 *     task còn dư so với số suất lệnh này cần, TRỪ ĐI phần các lease chia sẻ khác
 *     đang giữ chỗ (`reserved`). Nhiều lease chia sẻ sống cùng lúc.
 *   - lease ĐỘC QUYỀN (`exclusive`) — cho lệnh có thể phải MUA (không biết số
 *     trống, hoặc trống không đủ) và cho mọi task PURCHASE_SEAT. Chờ tới khi
 *     không còn lease nào khác, và trong lúc nó giữ thì không ai vào.
 *
 * ĐẶT CHỖ (`reserved`) là phần dễ bỏ sót: còn 1 suất trống, hai lệnh mời mỗi
 * lệnh cần 1 — xét riêng lẻ thì cả hai đều "đủ chỗ", chạy song song là đâm nhau.
 * Lease chia sẻ giữ chỗ đúng số suất nó sẽ tiêu nên lệnh thứ hai nhìn thấy chỗ
 * trống đã trừ, tự khắc rơi về độc quyền.
 *
 * Số suất trống ở đây suy từ `seat_hint` của backend — số của DASHBOARD, có thể
 * CŨ. Nó chỉ đủ để cấp quyền chạy song song, KHÔNG phải giấy phép mời: content
 * (`ensure-seats.ts`) vẫn đếm lại tận nơi bằng số trên trang. Đọc lại mà thấy
 * không đủ, lệnh đang giữ lease chia sẻ KHÔNG được tự đi mua (nó đang chạy song
 * song với lệnh khác) — nó trả về `SEAT_LOCK_REQUIRED`, runner gọi
 * `lease.upgrade()` để nâng lên độc quyền rồi chạy lại y hệt. Bước suất là bước
 * ĐẦU TIÊN của luồng mời, chưa bấm gì nên chạy lại không có tác dụng phụ.
 */

/**
 * Đòi dư thêm bằng này suất so với số cần thì mới dám cho chạy SONG SONG.
 *
 * Cùng lý do (và cùng con số) với `SEAT_HINT_SPARE` của `ensure-seats.ts`:
 * `seat_total` scrape từ trang thanh toán nên có thể CŨ theo chiều CAO khi
 * workspace hạ số suất hẹn hiệu lực kỳ sau. Dư 1 suất nuốt trọn ca đó; lệch lớn
 * hơn thì hết dư → tự khắc quay về chạy lần lượt.
 */
export const SEAT_SHARE_SPARE = 1;

export type SeatDemand = {
  /** Số suất trống suy từ `seat_hint`; null = dashboard chưa biết ⇒ độc quyền. */
  free: number | null;
  /** Số suất lệnh này sẽ chiếm. */
  need: number;
};

export type SeatLease = {
  /** true = đang chạy SONG SONG ⇒ tuyệt đối không được mua suất. */
  shared: boolean;
  /** Nâng lên độc quyền (chờ mọi lease khác nhả). Gọi nhiều lần vẫn an toàn. */
  upgrade: () => Promise<void>;
  /** Nhả lease. PHẢI gọi trong `finally` — kẹt lease là runner đứng im. */
  release: () => void;
};

type Mode = "shared" | "exclusive";

type Waiter = {
  demand: SeatDemand;
  admit: (mode: Mode) => void;
};

/** Có lease độc quyền đang giữ. */
let exclusiveHeld = false;
/** Số lease chia sẻ đang giữ. */
let sharedCount = 0;
/** Tổng suất các lease chia sẻ đang giữ chỗ. */
let reserved = 0;
/** Hàng đợi FIFO — chỉ xét TỪ ĐẦU để lệnh độc quyền không bị bỏ đói. */
const queue: Waiter[] = [];

function modeFor(demand: SeatDemand): Mode {
  if (demand.free === null || !Number.isFinite(demand.free)) return "exclusive";
  return demand.free - reserved >= demand.need + SEAT_SHARE_SPARE
    ? "shared"
    : "exclusive";
}

/**
 * Cấp lease cho những waiter ở ĐẦU hàng đợi mà điều kiện đã thoả.
 *
 * Dừng NGAY khi đầu hàng không vào được: cho waiter phía sau vượt lên là bỏ đói
 * lệnh độc quyền (nó cần `sharedCount === 0`, mà lệnh chia sẻ thì cứ nối nhau
 * vào mãi).
 */
function pump(): void {
  while (queue.length > 0 && !exclusiveHeld) {
    const head = queue[0];
    const mode = modeFor(head.demand);
    if (mode === "exclusive") {
      if (sharedCount > 0) return;
      queue.shift();
      exclusiveHeld = true;
      head.admit("exclusive");
      return;
    }
    queue.shift();
    sharedCount += 1;
    reserved += Math.max(0, head.demand.need);
    head.admit("shared");
  }
}

function makeLease(mode: Mode, demand: SeatDemand): SeatLease {
  const hold = Math.max(0, demand.need);
  let released = false;

  const dropShared = (): void => {
    sharedCount -= 1;
    reserved -= hold;
  };

  const lease: SeatLease = {
    shared: mode === "shared",
    async upgrade(): Promise<void> {
      if (released || !lease.shared) return;
      // Nhả phần chia sẻ TRƯỚC rồi mới xếp hàng đòi độc quyền. Giữ nguyên rồi
      // chờ là tự khoá chính mình: lease độc quyền đòi `sharedCount === 0`, mà
      // cái đang chờ chính là một trong số đó.
      lease.shared = false;
      dropShared();
      await new Promise<void>((resolve) => {
        // Chen lên ĐẦU hàng: lệnh này đã chạy tới nơi mới lộ ra là thiếu suất,
        // xếp lại từ cuối là để nó chạy lại thêm một vòng vô ích.
        queue.unshift({
          demand: { free: null, need: demand.need },
          admit: () => resolve(),
        });
        pump();
      });
    },
    release(): void {
      if (released) return;
      released = true;
      if (lease.shared) dropShared();
      else exclusiveHeld = false;
      pump();
    },
  };
  return lease;
}

/** Xin lease. Trả về khi đã được cấp — có thể phải CHỜ lease khác nhả. */
export function acquireSeatLease(demand: SeatDemand): Promise<SeatLease> {
  return new Promise<SeatLease>((resolve) => {
    queue.push({
      demand,
      admit: (mode) => resolve(makeLease(mode, demand)),
    });
    pump();
  });
}

/** Ảnh chụp trạng thái khoá — chỉ dùng cho log và test. */
export function seatGateState(): {
  exclusiveHeld: boolean;
  sharedCount: number;
  reserved: number;
  waiting: number;
} {
  return { exclusiveHeld, sharedCount, reserved, waiting: queue.length };
}

/** Dọn sạch — CHỈ dùng trong test. */
export function resetSeatGate(): void {
  exclusiveHeld = false;
  sharedCount = 0;
  reserved = 0;
  queue.length = 0;
}

function asCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Số suất TRỐNG suy từ `seat_hint` backend gửi kèm task mời — hoặc null khi
 * dashboard chưa biết đủ số để nói gì.
 *
 * `occupied` của hint = member chưa bị gỡ (active + pending, đã loại email của
 * chính lệnh này). Đó là cận TRÊN của số suất đang bị chiếm theo phía dashboard;
 * content còn đối chiếu tiếp với số in trên trang ChatGPT rồi lấy bên LỚN HƠN
 * (`headroomWithoutModal`), nên số ở đây chỉ có thể LẠC QUAN HƠN content. Lạc
 * quan sai thì content chặn lại bằng `SEAT_LOCK_REQUIRED` → nâng khoá, không có
 * đồng nào bị tiêu nhầm.
 */
export function hintedFreeSeats(payload: Record<string, unknown> | null): number | null {
  const hint = payload?.seat_hint;
  if (!hint || typeof hint !== "object" || Array.isArray(hint)) return null;
  const h = hint as Record<string, unknown>;
  const total = asCount(h.total);
  const occupied = asCount(h.occupied);
  if (total === null || total <= 0 || occupied === null) return null;
  return total - occupied;
}

/** Số suất MỚI lệnh mời sẽ chiếm (backend `new_seat_count`, thiếu → số email). */
export function inviteSeatNeed(payload: Record<string, unknown> | null): number {
  const fromBackend = asCount(payload?.new_seat_count);
  if (fromBackend !== null) return fromBackend;
  const emails = payload?.emails;
  if (Array.isArray(emails)) return emails.filter((e) => typeof e === "string").length;
  return typeof payload?.email === "string" ? 1 : 0;
}

/**
 * Task này cần lease suất gì — hay không cần lease nào (mọi loại task khác vẫn
 * chạy song song thoải mái như trước).
 *
 * PURCHASE_SEAT luôn `free: null` ⇒ luôn độc quyền: nó ĐANG đi tiêu tiền theo số
 * suất nó vừa đọc, không lệnh nào được xen vào giữa lúc đó.
 */
export function seatDemandForTask(task: {
  type: string;
  payload?: Record<string, unknown> | null;
}): SeatDemand | null {
  const payload = task.payload ?? null;
  if (task.type === "PURCHASE_SEAT") return { free: null, need: 0 };
  if (task.type !== "INVITE_MEMBER") return null;
  return { free: hintedFreeSeats(payload), need: inviteSeatNeed(payload) };
}
