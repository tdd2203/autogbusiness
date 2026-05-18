/**
 * Bridge content script: chạy trên dashboard (localhost:17173 / 127.0.0.1:17173).
 *
 * ⚠️ CONTENT SCRIPT CHẠY TRONG ISOLATED WORLD.
 *    Nghĩa là `window.__autogptExtensionInstalled = true` trong file này
 *    KHÔNG set lên page's window mà chỉ set lên window sandboxed của
 *    content script → dashboard không bao giờ thấy.
 *
 *    Lý do: bug v0.2.1 — bridge tưởng inject thành công nhưng dashboard vẫn
 *    "not detected" vì flag bị isolation chặn.
 *
 *    Cách đúng: dùng `window.postMessage` — message tới shared window, page
 *    listen được. Không dùng global flags.
 *
 * Protocol:
 *   Bridge → dashboard:  { source: "autogpt-extension", type: "bridge-ready", version }
 *                        { source: "autogpt-extension", type: "pong",         version }
 *                        { source: "autogpt-extension", type: "run-pending-result", payload }
 *   Dashboard → bridge:  { source: "autogpt-dashboard", type: "ping" }
 *                        { source: "autogpt-dashboard", type: "run-pending" }
 */

import { VERSION } from "../version";

function announceReady(): void {
  window.postMessage(
    { source: "autogpt-extension", type: "bridge-ready", version: VERSION },
    window.origin,
  );
}

// Announce immediately on load. Dashboard có thể đã mount React trước hoặc sau —
// hook useExtensionStatus sẽ gửi ping khi mount để đảm bảo bắt được.
announceReady();

// Announce thêm 1 lần sau ngắn để cover edge case dashboard mount muộn hơn.
setTimeout(announceReady, 500);

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "autogpt-dashboard") return;

  if (data.type === "ping") {
    window.postMessage(
      { source: "autogpt-extension", type: "pong", version: VERSION },
      window.origin,
    );
    return;
  }

  if (data.type === "run-pending") {
    chrome.runtime
      .sendMessage({ type: "run-pending" })
      .then((resp) => {
        window.postMessage(
          {
            source: "autogpt-extension",
            type: "run-pending-result",
            payload: resp,
          },
          window.origin,
        );
      })
      .catch((e) => {
        console.warn("[autogpt-bridge] forward failed", e);
      });
  }
});

console.log(`[autogpt-bridge] v${VERSION} ready on`, location.href);
