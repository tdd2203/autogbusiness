/**
 * Bắt chuỗi mà trang Canva vừa CHÉP VÀO CLIPBOARD.
 *
 * VÌ SAO PHẢI LÀM THẾ NÀY: nút "Sao chép liên kết duy nhất" của Canva không hiện
 * link ra DOM — nó chỉ ghi thẳng vào clipboard. Mà đọc clipboard từ content script
 * lại cần quyền `clipboardRead` và cần tab đang được focus; tab chạy nền (đúng cách
 * extension làm việc) thì đọc hỏng, hoặc tệ hơn là đọc ra nội dung người dùng đang
 * copy cho việc khác.
 *
 * Cách ở đây: chèn một đoạn script chạy trong NGỮ CẢNH TRANG (world MAIN) bọc
 * `navigator.clipboard.writeText` và `document.execCommand('copy')`, ghi lại chuỗi
 * cuối cùng trang tự chép rồi bắn ra ngoài bằng `postMessage`. Không xin quyền nào,
 * không phụ thuộc focus, và chỉ thấy đúng thứ TRANG chép — không đụng clipboard thật
 * của người dùng.
 *
 * Content script (world ISOLATED) không sửa được `navigator.clipboard` của trang nên
 * bắt buộc phải qua thẻ <script> chèn vào DOM.
 */

const BRIDGE_EVENT = "autogpt-canva-copy";
const FLAG = "__autogptCanvaCopyHooked";

let lastCopied: string | null = null;
let listening = false;

function pageHook(): void {
  // Chạy TRONG trang. Không dùng biến ngoài — hàm này được stringify.
  const w = window as unknown as Record<string, unknown>;
  if (w.__autogptCanvaCopyHooked) return;
  w.__autogptCanvaCopyHooked = true;

  const report = (text: unknown) => {
    if (typeof text !== "string" || !text) return;
    window.postMessage({ source: "autogpt-canva-copy", text }, "*");
  };

  try {
    const clip = navigator.clipboard;
    if (clip && typeof clip.writeText === "function") {
      const original = clip.writeText.bind(clip);
      clip.writeText = (text: string) => {
        report(text);
        return original(text);
      };
    }
  } catch {
    /* trang chặn ghi đè → còn đường execCommand bên dưới */
  }

  // Đường cũ: một số nút vẫn chép bằng textarea ẩn + execCommand('copy').
  document.addEventListener(
    "copy",
    (e) => {
      const sel = window.getSelection?.()?.toString();
      const viaEvent = (e as ClipboardEvent).clipboardData?.getData("text/plain");
      report(viaEvent || sel);
    },
    true,
  );
}

/** Cài hook vào trang (idempotent) và bắt đầu nghe chuỗi trang chép. */
export function installCopyCapture(): void {
  if (listening) return;
  listening = true;

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const data = e.data as { source?: string; text?: string } | null;
    if (data?.source === "autogpt-canva-copy" && typeof data.text === "string") {
      lastCopied = data.text;
    }
  });

  if ((window as unknown as Record<string, unknown>)[FLAG]) return;
  const el = document.createElement("script");
  el.textContent = `(${pageHook.toString()})();`;
  (document.head ?? document.documentElement).appendChild(el);
  el.remove();
}

/** Quên chuỗi đang giữ — gọi TRƯỚC mỗi lần bấm nút sao chép. */
export function resetCopyCapture(): void {
  lastCopied = null;
}

/**
 * Chờ trang chép xong và trả chuỗi bắt được.
 *
 * Trả `null` khi hết thời gian: lấy link là việc "có thì tốt", KHÔNG được phép làm
 * hỏng cả lệnh mời đã gửi thành công.
 */
export async function waitForCopiedText(
  timeoutMs = 4000,
  pollMs = 100,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lastCopied) return lastCopied;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

export { BRIDGE_EVENT };
