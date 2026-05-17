/**
 * Trigger extension auto-run sau khi user tạo task ở dashboard.
 *
 * ⚠️ KHÔNG dùng global flag (window.__autogptExtensionInstalled) để detect bridge!
 *    Content scripts chạy trong ISOLATED WORLD → flag không truyền sang page.
 *    Đây là bug fixed ở v0.2.2.
 *
 * Detection mechanism: bridge announces itself qua window.postMessage khi load
 *   { source: "autogpt-extension", type: "bridge-ready", version }
 * Dashboard listen postMessage indefinitely. Khi mount, dashboard cũng gửi ping
 *   { source: "autogpt-dashboard", type: "ping" }
 * để cover trường hợp bridge load trước React mount → bridge pong lại.
 *
 * Khi user reload extension trong chrome://extensions/, background SW tự gọi
 * chrome.scripting.executeScript inject bridge vào dashboard tab đang mở
 * (xem background/index.ts) → user KHÔNG cần F5.
 */

import { useEffect, useRef, useState } from "react";

type RunResult = {
  processed: number;
  lastStatus: string;
};

/** Bridge timeout cho `triggerExtensionRun` — đợi pong tối đa 300ms. */
const BRIDGE_PROBE_TIMEOUT_MS = 300;

/** Probe bridge bằng ping + chờ pong. Trả version nếu có bridge, null nếu không. */
function probeBridge(): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== window) return;
      const data = ev.data;
      if (data?.source !== "autogpt-extension") return;
      if (data.type !== "pong" && data.type !== "bridge-ready") return;
      if (resolved) return;
      resolved = true;
      window.removeEventListener("message", onMessage);
      resolve(typeof data.version === "string" ? data.version : "");
    };
    window.addEventListener("message", onMessage);
    window.postMessage(
      { source: "autogpt-dashboard", type: "ping" },
      window.origin,
    );
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, BRIDGE_PROBE_TIMEOUT_MS);
  });
}

function bridgeMissingMessage(): string {
  return (
    "Extension chưa được dashboard nhận diện.\n\n" +
    "Để khắc phục (chọn 1 trong 2):\n" +
    "  A) Mở chrome://extensions/ → bấm 'Reload' trên AutoGPT Admin Extension\n" +
    "     (background sẽ tự inject bridge vào tab này — không cần F5)\n\n" +
    "  B) Nếu vẫn không được: F5 trang dashboard này\n\n" +
    "Sau đó kiểm tra badge sidebar đổi thành '✓ Extension: connected'."
  );
}

/**
 * Trigger extension drain queue.
 *
 * Bắn postMessage `run-pending` qua bridge. Nếu bridge missing (probe timeout),
 * alert user hướng dẫn fix. Returns boolean tiện debug.
 */
export async function triggerExtensionRun(): Promise<boolean> {
  const version = await probeBridge();
  console.log(
    `[autogpt-dashboard] triggerExtensionRun — bridge v${version ?? "MISSING"}`,
  );

  if (version === null) {
    window.alert(bridgeMissingMessage());
    return false;
  }

  window.postMessage(
    { source: "autogpt-dashboard", type: "run-pending" },
    window.origin,
  );
  return true;
}

/**
 * Hook trả về extension status. Listen postMessage indefinitely cho cả 2 case:
 *   - Bridge load trước mount → ta send ping, bridge pong
 *   - Bridge load sau mount  → bridge auto-broadcast "bridge-ready"
 */
export function useExtensionStatus(): {
  installed: boolean;
  version: string | null;
  lastRunResult: RunResult | null;
} {
  const [installed, setInstalled] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [lastRunResult, setLastRunResult] = useState<RunResult | null>(null);
  const lastPingRef = useRef<number>(0);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== window) return;
      const data = ev.data;
      if (data?.source !== "autogpt-extension") return;

      if (data.type === "bridge-ready" || data.type === "pong") {
        setInstalled(true);
        if (typeof data.version === "string") setVersion(data.version);
      } else if (data.type === "run-pending-result") {
        setLastRunResult({
          processed: Number(data.payload?.processed ?? 0),
          lastStatus: String(data.payload?.lastStatus ?? "unknown"),
        });
      }
    };
    window.addEventListener("message", onMessage);

    function ping() {
      lastPingRef.current = Date.now();
      window.postMessage(
        { source: "autogpt-dashboard", type: "ping" },
        window.origin,
      );
    }

    // Ping ngay khi mount (covers bridge loaded trước React).
    ping();

    // Heartbeat 3s — re-detect khi bridge inject muộn (vd background SW
    // executeScript sau onInstalled). Cheap: postMessage tới chính tab.
    const heartbeat = setInterval(ping, 3000);

    // Nếu sau 1s vẫn chưa nhận pong, đánh dấu chính thức "not installed"
    // (đã từng installed thì giữ true cho tới khi tab unload).
    const probeTimer = setTimeout(() => {
      setInstalled((prev) => prev); // no-op, chỉ trigger render check
    }, 1000);

    return () => {
      window.removeEventListener("message", onMessage);
      clearInterval(heartbeat);
      clearTimeout(probeTimer);
    };
  }, []);

  return { installed, version, lastRunResult };
}
