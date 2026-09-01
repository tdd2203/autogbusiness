/**
 * Content script nhánh CANVA — chạy trên `canva.com/settings/*`.
 *
 * Cùng vai trò với `content/index.ts` của nhánh ChatGPT nhưng ĐỂ RIÊNG: hai trang
 * khác nhau hoàn toàn, gộp vào một file chỉ tạo ra một mớ `if` và nguy cơ một bên
 * hỏng kéo bên kia chết theo.
 *
 * Nhận `CanvaActionRequest` từ background, trả `CanvaActionResponse`.
 */

import type { CanvaActionRequest, CanvaActionResponse } from "../../shared/messages";
import { installCopyCapture } from "./clipboard-capture";
import { executeCanvaInvite } from "./invite";
import { executeCanvaRemove } from "./remove";
import { executeCanvaSync } from "./sync";

console.log("[autogpt-canva] injected vào", location.href);

/**
 * ID của LẦN NẠP NÀY — background dùng để biết mình đang nói chuyện với trang mới
 * hay với một trang cũ còn nằm trong bộ nhớ đệm back/forward (cùng lý do như nhánh
 * ChatGPT, xem `background/content-ready.ts`).
 */
const LOAD_ID =
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

// Cài sớm cái móc bắt clipboard: nút "Sao chép liên kết" của Canva chỉ ghi thẳng vào
// clipboard, cài muộn là mất luôn link của email đầu tiên.
installCopyCapture();

chrome.runtime.onMessage.addListener(
  (msg: CanvaActionRequest, _sender, sendResponse) => {
    if (!msg?.kind?.startsWith?.("CANVA_")) return undefined;
    (async () => {
      try {
        sendResponse(await dispatch(msg));
      } catch (e) {
        const response: CanvaActionResponse = {
          ok: false,
          error_code: "UNKNOWN",
          error_message: e instanceof Error ? e.message : String(e),
        };
        sendResponse(response);
      }
    })();
    return true; // trả lời bất đồng bộ
  },
);

async function dispatch(msg: CanvaActionRequest): Promise<CanvaActionResponse> {
  switch (msg.kind) {
    case "CANVA_PING":
      return { ok: true, data: { url: location.href, loadId: LOAD_ID } };
    case "CANVA_SYNC":
      return executeCanvaSync(msg.taskId);
    case "CANVA_INVITE":
      return executeCanvaInvite(msg);
    case "CANVA_REMOVE":
      return executeCanvaRemove(msg);
    default:
      return {
        ok: false,
        error_code: "UNKNOWN",
        error_message: `Lệnh Canva không hỗ trợ: ${(msg as { kind?: string }).kind}`,
      };
  }
}
