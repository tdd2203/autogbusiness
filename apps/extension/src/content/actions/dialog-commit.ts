/**
 * CHỜ CHATGPT XỬ LÝ XONG — helper dùng CHUNG cho mọi action có thao tác ghi.
 *
 * ⚠️ Quy tắc bất biến (user 2026-08-21): **mọi action phải chờ ChatGPT xử lý
 * xong rồi QUÉT LẠI để xác nhận**, không được bấm xong ngủ vài trăm ms rồi báo
 * thành công. Lý do: backend lấy `ok:true` làm sự thật và ghi thẳng vào DB
 * (`completion.py` sync `chatgpt_role` / `license_type` / `usage_limit_credits`),
 * nên một lần báo thành công GIẢ là dashboard lệch hẳn với ChatGPT, im lặng cho
 * tới lần đồng bộ sau.
 *
 * Bộ helper này tách ra từ `remove/execute-remove.ts` (v0.11.5 — action DUY NHẤT
 * làm đúng) để 4 action còn lại (revoke / change-role / change-license-type /
 * set-usage-limit) dùng lại đúng một cơ chế, không ai tự chế nhịp chờ riêng.
 *
 * Nhịp chuẩn sau khi click nút xác nhận:
 *   1. `waitForConfirmDialogClosed(ms)` — dialog phải VẮNG 4 nhịp LIÊN TIẾP mới
 *      coi là tắt hẳn (ChatGPT 2026-08 giữ dialog quay spinner tới khi server
 *      trả lời; "chớp tắt" giữa 2 lần render không tính).
 *   2. `waitForModalLockGone(ms)` — lớp phủ Radix + `data-scroll-locked` rời đi
 *      sau dialog một nhịp; gõ ô lọc trong lúc đó thì event `input` rơi vào lớp
 *      phủ, query lọc không bao giờ chạy.
 *   3. Quét lại nguồn sự thật (ô lọc / ô search) — xem từng action.
 *
 * Xen giữa bước 1 và 2 còn một nhánh: ChatGPT có thể bồi thêm hộp thoại "Gỡ suất
 * trả phí?" sau khi thao tác đã chạy xong — xem `answerPaidSeatDialog` và
 * [`paid-seat-guard.ts`](./paid-seat-guard.ts).
 */

import { humanClick, sleep } from "../human";
import { decidePaidSeatDialog } from "./paid-seat-guard";

/**
 * Hộp thoại này còn SỐNG không — đang hiện trên trang và có nội dung.
 *
 * ChatGPT (Radix) để lại trong DOM cả những khung `role="dialog"` đã chết: hộp
 * vừa đóng còn chờ hiệu ứng chạy nốt (`data-state="closed"`), khung portal dựng
 * sẵn còn rỗng, hộp bị ẩn bằng `aria-hidden`. Chúng không phải hộp thoại đang
 * chờ ai bấm gì cả.
 */
function dialogAlive(el: HTMLElement): boolean {
  if (el.getAttribute("aria-hidden") === "true") return false;
  if (el.hasAttribute("hidden")) return false;
  if (el.getAttribute("data-state") === "closed") return false;
  // CỐ Ý không đo hình học (`offsetParent` / `getClientRects`): lệnh chạy trong
  // TAB NỀN, mà tab nền thì Chrome không vẽ layout — mọi toạ độ về 0 và hộp
  // thoại thật cũng bị chấm là "ẩn" (đã dính đúng bẫy này ở luồng hoá đơn
  // Stripe). Hộp thật luôn có chữ hoặc có nút; khung ma thì rỗng không.
  return (el.textContent ?? "").trim() !== "" || el.querySelector("button") !== null;
}

/**
 * Dialog đang mở (phần tử), `null` nếu không có.
 *
 * ⚠️ KHÔNG dùng `querySelector` trơn: nó lấy CÁI ĐẦU TIÊN theo thứ tự DOM, nên
 * chỉ cần một khung ma nằm trước là "dialog chưa đóng" đúng MÃI MÃI — lệnh gỡ
 * chờ hết 30s rồi báo `VERIFY_FAILED` với lý do đoán mò "ChatGPT hỏi OTP/2FA",
 * trong khi member ĐÃ bị gỡ xong (ca khaialphauni003 10/9/2026: dialog "đứng
 * im", đọc text ra rỗng, không một cái nút nào).
 *
 * Nhiều hộp cùng sống thì lấy hộp SAU CÙNG: hộp mở sau nằm ở portal cuối, và nó
 * mới là hộp đang phủ lên trên (vd hộp "Gỡ suất trả phí?" bồi sau hộp xác nhận).
 */
function openDialogEl(): HTMLElement | null {
  const alive = Array.from(
    document.querySelectorAll<HTMLElement>('[role="alertdialog"], [role="dialog"]'),
  ).filter(dialogAlive);
  return alive.length > 0 ? alive[alive.length - 1] : null;
}

/** Hộp thoại đang mở — cho các action tự tìm nút bên trong nó. */
export function visibleDialogEl(): HTMLElement | null {
  return openDialogEl();
}

/** Dialog xác nhận (bất kỳ) đang mở không? */
export function confirmDialogOpen(): boolean {
  return openDialogEl() !== null;
}

/** Text dialog đang mở — để báo lý do khi verify fail (OTP/2FA/lỗi). */
export function openDialogText(): string {
  return (openDialogEl()?.textContent ?? "").trim();
}

/**
 * Dialog đang QUAY (nút xác nhận có spinner / disabled / `aria-busy`) — ChatGPT
 * bản 2026-08 gửi request rồi GIỮ dialog lại cho tới khi server trả lời, chứ
 * không đóng ngay như bản cũ. Chỉ dùng để log cho dễ soi, không để quyết định.
 */
export function confirmDialogBusy(): boolean {
  const d = openDialogEl();
  if (!d) return false;
  if (
    d.querySelector(
      '[aria-busy="true"], [role="progressbar"], svg.animate-spin, .animate-spin',
    )
  ) {
    return true;
  }
  return Array.from(d.querySelectorAll("button")).some(
    (b) => b.disabled || b.getAttribute("aria-disabled") === "true",
  );
}

/**
 * Modal còn KHOÁ trang không: Radix để lại lớp phủ + `pointer-events:none` trên
 * `body` (và `data-scroll-locked`) một nhịp SAU khi dialog rời DOM.
 */
export function modalLockPresent(): boolean {
  const body = document.body;
  if (!body) return false;
  if (body.hasAttribute("data-scroll-locked")) return true;
  if (body.style.pointerEvents === "none") return true;
  return document.querySelector("[data-radix-dialog-overlay]") !== null;
}

/** Text mọi nút trong dialog đang mở (thứ tự DOM). */
function openDialogButtons(): HTMLElement[] {
  const d = openDialogEl();
  return d ? Array.from(d.querySelectorAll<HTMLElement>("button")) : [];
}

/** Dialog đang mở CÓ PHẢI hộp "Gỡ suất trả phí?" — để báo lý do cho đúng. */
export function paidSeatDialogOpen(): boolean {
  const d = openDialogEl();
  if (!d) return false;
  const decision = decidePaidSeatDialog(
    d.textContent ?? "",
    openDialogButtons().map((b) => (b.textContent ?? "").trim()),
  );
  return decision.kind !== "not_paid_seat";
}

/** Kết quả một lượt xử lý hộp "Gỡ suất trả phí?". */
export type PaidSeatOutcome =
  /** Không có hộp đó (trường hợp thường). */
  | "none"
  /** Đã bấm "Giữ suất" (giữa kỳ, hoặc ngày chốt mà không thấy nút gỡ). */
  | "kept"
  /** Đã bấm "Gỡ suất" — ngày chốt chu kỳ, hoá đơn kỳ mới bớt một ghế. */
  | "released"
  /** Đúng là nó nhưng không nhận ra nút nào → KHÔNG bấm gì. */
  | "unknown";

/**
 * ChatGPT bồi hộp "Gỡ suất trả phí?" sau khi thao tác gỡ đã chạy xong (ảnh user
 * 8/9/2026) → trả lời cho hộp tắt đi, thao tác chính coi như xong.
 *
 * MẶC ĐỊNH LÀ GIỮ: suất đã trả tiền tới ngày gia hạn nên gỡ giữa kỳ không hoàn
 * lại gì, mà mất luôn chỗ trống để chuyển người sang. `release: true` chỉ được
 * truyền khi lệnh gỡ chạy trong NGÀY CHỐT chu kỳ (backend đính giờ hoá đơn kèm
 * lệnh, `executeRemove` so đồng hồ lúc hộp hiện ra) → bấm "Gỡ suất" để hoá đơn
 * kỳ mới bớt đúng ghế vừa gỡ. Lý do đầy đủ xem
 * [`paid-seat-guard.ts`](./paid-seat-guard.ts).
 *
 * Không nhận ra nút cần bấm thì KHÔNG bấm bừa: trả `"unknown"` và để caller ESC
 * (không chọn gì = suất giữ nguyên) — chậm một nhịp còn hơn mất suất.
 */
export async function answerPaidSeatDialog(
  log = "[autogpt]",
  opts: { release?: boolean } = {},
): Promise<PaidSeatOutcome> {
  const d = openDialogEl();
  if (!d) return "none";
  const btns = openDialogButtons();
  const texts = btns.map((b) => (b.textContent ?? "").trim());
  const decision = decidePaidSeatDialog(d.textContent ?? "", texts, {
    release: opts.release === true,
  });
  if (decision.kind === "not_paid_seat") return "none";
  if (decision.kind === "unknown_labels") {
    console.warn(
      `${log} hộp "Gỡ suất trả phí?" đang mở nhưng KHÔNG nhận ra nút giữ suất ` +
        `→ không bấm gì (tránh bấm nhầm nút gỡ suất). Nút trong hộp: ` +
        JSON.stringify(decision.buttons),
    );
    return "unknown";
  }
  const btn = btns[decision.index];
  if (!btn) return "unknown";
  if (decision.kind === "release") {
    console.log(
      `${log} hộp "Gỡ suất trả phí?" → NGÀY CHỐT CHU KỲ, bấm gỡ suất: ` +
        JSON.stringify(texts[decision.index]),
    );
    await humanClick(btn);
    return "released";
  }
  if (opts.release) {
    console.warn(
      `${log} hộp "Gỡ suất trả phí?" → ngày chốt nhưng không thấy nút gỡ suất, ` +
        `rơi về giữ suất. Nút trong hộp: ${JSON.stringify(texts)}`,
    );
  }
  console.log(
    `${log} hộp "Gỡ suất trả phí?" → bấm giữ suất: ${JSON.stringify(texts[decision.index])}`,
  );
  await humanClick(btn);
  return "kept";
}

/** Số lần tối đa trả lời hộp suất trong MỘT lượt chờ (chống bấm liên hồi). */
const MAX_PAID_SEAT_KEEPS = 3;

/** Poll 300ms; đòi 4 nhịp LIÊN TIẾP không thấy dialog mới coi là "tắt hẳn". */
export const DIALOG_POLL_MS = 300;
const DIALOG_GONE_STABLE_HITS = 4;

/**
 * Chờ dialog xác nhận BIẾN MẤT HẲN (không phải "chớp tắt" giữa 2 lần render).
 * Trả `true` nếu đã tắt hẳn trong hạn, `false` nếu hết hạn mà dialog vẫn còn.
 *
 * KHÔNG có dialog nào ngay từ đầu (luồng không cần xác nhận) → trả `true` sau
 * ~1.2s, coi như "không có gì phải chờ".
 */
export async function waitForConfirmDialogClosed(
  timeoutMs: number,
  log = "[autogpt]",
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let clearHits = 0;
  let loggedBusy = false;
  let keeps = 0;
  while (Date.now() < deadline) {
    if (confirmDialogOpen()) {
      clearHits = 0;
      if (!loggedBusy && confirmDialogBusy()) {
        loggedBusy = true;
        console.log(`${log} dialog xác nhận đang quay (chờ ChatGPT trả lời)...`);
      }
      // Hộp "Gỡ suất trả phí?" bồi sau khi thao tác đã xong — không bấm giữ suất
      // thì nó đứng đó tới hết hạn và lệnh báo hỏng oan. Chỉ bấm khi hộp KHÔNG
      // còn quay, và tối đa vài lần (mỗi member gỡ đi kèm một hộp).
      if (keeps < MAX_PAID_SEAT_KEEPS && !confirmDialogBusy()) {
        if ((await answerPaidSeatDialog(log)) === "kept") keeps += 1;
      }
    } else {
      clearHits += 1;
      if (clearHits >= DIALOG_GONE_STABLE_HITS) return true;
    }
    await sleep(DIALOG_POLL_MS);
  }
  return false;
}

/**
 * Dialog rời DOM rồi nhưng lớp phủ có thể còn — chờ thêm best-effort. KHÔNG
 * fail nếu lớp phủ lì: coi như hết khoá và đi tiếp (thà tra sớm 1 nhịp còn hơn
 * bỏ luôn phần xác minh chỉ vì ChatGPT quên gỡ `data-scroll-locked`).
 */
export async function waitForModalLockGone(
  maxMs: number,
  log = "[autogpt]",
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (!modalLockPresent()) return;
    await sleep(DIALOG_POLL_MS);
  }
  console.warn(`${log} lớp phủ modal chưa gỡ sau ${maxMs}ms → vẫn đi tiếp.`);
}

/** Kết quả 1 lượt chờ ChatGPT chốt thao tác. */
export type CommitWait =
  | { settled: true }
  | { settled: false; dialogText: string; busy: boolean };

/**
 * Gộp bước 1 + 2: chờ dialog tắt hẳn rồi chờ lớp phủ gỡ. Dùng NGAY SAU khi click
 * nút xác nhận, TRƯỚC khi quét lại để verify.
 *
 * `settled:false` = ChatGPT chưa chốt (dialog còn quay / bị chặn OTP-2FA / báo
 * lỗi) → caller PHẢI trả `VERIFY_FAILED`, tuyệt đối không báo thành công.
 */
export async function waitForChatGptCommit(
  log: string,
  dialogTimeoutMs = 30_000,
  lockMaxMs = 5000,
): Promise<CommitWait> {
  const closed = await waitForConfirmDialogClosed(dialogTimeoutMs, log);
  if (!closed) {
    return {
      settled: false,
      dialogText: openDialogText(),
      busy: confirmDialogBusy(),
    };
  }
  await waitForModalLockGone(lockMaxMs, log);
  return { settled: true };
}
