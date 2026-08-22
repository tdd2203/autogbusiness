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
 */

import { sleep } from "../human";

/** Dialog xác nhận (bất kỳ) đang mở không? */
export function confirmDialogOpen(): boolean {
  return (
    document.querySelector('[role="alertdialog"], [role="dialog"]') !== null
  );
}

/** Text dialog đang mở — để báo lý do khi verify fail (OTP/2FA/lỗi). */
export function openDialogText(): string {
  const d = document.querySelector('[role="alertdialog"], [role="dialog"]');
  return (d?.textContent ?? "").trim();
}

/**
 * Dialog đang QUAY (nút xác nhận có spinner / disabled / `aria-busy`) — ChatGPT
 * bản 2026-08 gửi request rồi GIỮ dialog lại cho tới khi server trả lời, chứ
 * không đóng ngay như bản cũ. Chỉ dùng để log cho dễ soi, không để quyết định.
 */
export function confirmDialogBusy(): boolean {
  const d = document.querySelector('[role="alertdialog"], [role="dialog"]');
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
  while (Date.now() < deadline) {
    if (confirmDialogOpen()) {
      clearHits = 0;
      if (!loggedBusy && confirmDialogBusy()) {
        loggedBusy = true;
        console.log(`${log} dialog xác nhận đang quay (chờ ChatGPT trả lời)...`);
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
