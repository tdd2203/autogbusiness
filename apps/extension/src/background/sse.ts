/**
 * SSE client: subscribe `/api/v1/queue/stream` của backend để auto-execute task
 * NGAY KHI dashboard tạo task. KHÔNG cần user mở popup hay bấm nút.
 *
 * Dùng fetch streaming (không phải EventSource) vì:
 *   - EventSource không support custom header (X-API-KEY)
 *   - Fetch streaming hoạt động native trong MV3 service worker
 *
 * MV3 SW lifecycle:
 *   - Active fetch giữ SW alive
 *   - Khi connection drop (network, server restart, SW kill) → reconnect với
 *     exponential backoff (1s → 2s → 4s → ... → 30s cap)
 *   - chrome.runtime.onStartup + onInstalled trigger initial connect
 *   - Storage change (user save API key mới) → reconnect
 */

import { getConfig } from "../shared/storage";
import { runUntilIdle } from "./runner";

let abortController: AbortController | null = null;
let reconnectAttempt = 0;
let reconnectTimerId: ReturnType<typeof setTimeout> | null = null;
let isConnecting = false;

/** Backoff: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ... */
function backoffDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 30000);
}

function clearReconnectTimer(): void {
  if (reconnectTimerId !== null) {
    clearTimeout(reconnectTimerId);
    reconnectTimerId = null;
  }
}

export function disconnectSSE(): void {
  clearReconnectTimer();
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  reconnectAttempt = 0;
}

function scheduleReconnect(): void {
  clearReconnectTimer();
  reconnectAttempt += 1;
  const delay = backoffDelayMs(reconnectAttempt);
  console.log(
    `[autogpt-sse] reconnect in ${delay}ms (attempt ${reconnectAttempt})`,
  );
  reconnectTimerId = setTimeout(() => {
    void connectSSE();
  }, delay);
}

/**
 * Trong khi SSE connection còn alive (SW kept alive bởi fetch streaming),
 * setTimeout hoạt động bình thường → poll backend nhanh hơn alarms cho phép.
 * Nếu SSE chết → SW chết → setTimeout mất → chrome.alarms takeover.
 *
 * Gọi runUntilIdle mỗi 5s. Cheap nếu không có task (chỉ 1 request /queue/next
 * trả về null), ROI cao vì user thấy task chạy trong <5s thay vì <60s.
 */
let fastPollTimer: ReturnType<typeof setTimeout> | null = null;

function startFastPoll(): void {
  if (fastPollTimer !== null) return;
  const tick = () => {
    fastPollTimer = setTimeout(async () => {
      try {
        const r = await runUntilIdle();
        if (r.processed > 0) {
          console.log(`[autogpt-fastpoll] processed ${r.processed} task(s)`);
        }
      } catch (e) {
        console.warn("[autogpt-fastpoll] error", e);
      }
      tick();
    }, 5000);
  };
  tick();
  console.log("[autogpt-fastpoll] started (5s interval while SW alive)");
}

function stopFastPoll(): void {
  if (fastPollTimer !== null) {
    clearTimeout(fastPollTimer);
    fastPollTimer = null;
    console.log("[autogpt-fastpoll] stopped");
  }
}

function handleEvent(obj: Record<string, unknown>): void {
  console.log("[autogpt-sse] event:", obj);
  if (obj.type === "task-available") {
    // ⚠️ FIRE-AND-FORGET — KHÔNG await runUntilIdle ở đây.
    //
    // Lý do: nếu await, stream reader loop bị block cho tới khi runUntilIdle
    // xong (có thể vài phút cho SYNC_DATA). Trong thời gian đó:
    //   - Không read được heartbeat từ server → server tưởng client chết
    //   - Không read được event mới
    //   - MV3 SW có thể bị giới hạn 30s task lifetime kể từ event arrival
    //
    // Cách đúng: trigger runUntilIdle độc lập, return ngay để reader đọc tiếp.
    // runUntilIdle có lock in-flight nên gọi nhiều lần an toàn (concurrent
    // events sẽ share cùng execution).
    console.log(
      `[autogpt-sse] task-available ${obj.task_type ?? "?"} ${obj.task_id ?? "?"} → triggering runUntilIdle`,
    );
    runUntilIdle()
      .then((result) => {
        console.log("[autogpt-sse] runUntilIdle done:", result);
      })
      .catch((e) => {
        console.warn("[autogpt-sse] runUntilIdle failed", e);
      });
  } else if (obj.type === "connected") {
    console.log(
      `[autogpt-sse] ✓ subscribed to workspace ${obj.workspace_name ?? obj.workspace_id}`,
    );
  } else {
    console.log("[autogpt-sse] unknown event type:", obj.type);
  }
}

/**
 * Mở SSE stream tới backend. Idempotent — gọi nhiều lần sẽ cancel connection
 * cũ rồi mở mới.
 */
export async function connectSSE(): Promise<void> {
  if (isConnecting) return;
  isConnecting = true;

  try {
    // Cancel connection cũ nếu có.
    if (abortController) {
      abortController.abort();
      abortController = null;
    }

    const config = await getConfig();
    if (!config) {
      console.log("[autogpt-sse] no config, skip connect");
      return;
    }

    const controller = new AbortController();
    abortController = controller;
    const url = `${config.apiBaseUrl}/api/v1/queue/stream`;

    console.log("[autogpt-sse] connecting", url);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "GET",
        headers: {
          "X-API-KEY": config.apiKey,
          Accept: "text/event-stream",
        },
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) return;
      console.warn("[autogpt-sse] fetch failed", e);
      scheduleReconnect();
      return;
    }

    if (!resp.ok || !resp.body) {
      console.warn(`[autogpt-sse] bad response ${resp.status}`);
      scheduleReconnect();
      return;
    }

    // Reset backoff khi connection OK.
    reconnectAttempt = 0;
    startFastPoll();

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE: events separated by "\n\n".
        let sepIdx: number;
        while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);

          // Skip comment-only events (heartbeats start with ":")
          const dataLines = rawEvent
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6));
          if (dataLines.length === 0) continue;

          const payload = dataLines.join("\n");
          try {
            const obj = JSON.parse(payload) as Record<string, unknown>;
            handleEvent(obj);
          } catch (e) {
            console.warn("[autogpt-sse] bad JSON", payload, e);
          }
        }
      }
      // Stream ended cleanly (server closed) — reconnect.
      console.log("[autogpt-sse] stream closed by server");
    } catch (e) {
      if (controller.signal.aborted) return;
      console.warn("[autogpt-sse] read error", e);
    }
    scheduleReconnect();
  } finally {
    stopFastPoll();
    isConnecting = false;
  }
}
