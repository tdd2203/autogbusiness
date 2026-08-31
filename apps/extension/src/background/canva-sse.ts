/**
 * SSE cho nhánh CANVA — nghe `/api/v1/queue/stream` bằng KHOÁ CANVA.
 *
 * Vì sao không sửa `sse.ts` cho nhận nhiều khoá: file đó giữ trạng thái ở cấp module
 * (một AbortController, một bộ đếm backoff, một timer poll nhanh) và đang chạy ổn cho
 * nhánh ChatGPT. Biến nó thành đa tài khoản là sửa đúng đoạn code đang gánh toàn bộ
 * việc mời/xoá thật của khách. Một bản sao gọn cho Canva rẻ hơn nhiều so với rủi ro
 * đó, và đúng tinh thần "hai nhánh tách hẳn".
 *
 * Không có khoá Canva (máy chỉ chạy ChatGPT) → không kết nối gì, im lặng thoát.
 */

import { getCanvaConfig } from "../shared/storage";
import { runCanvaUntilIdle } from "./canva-runner";

let abortController: AbortController | null = null;
let reconnectAttempt = 0;
let reconnectTimerId: ReturnType<typeof setTimeout> | null = null;
let isConnecting = false;

function backoffDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 30000);
}

function clearReconnectTimer(): void {
  if (reconnectTimerId !== null) {
    clearTimeout(reconnectTimerId);
    reconnectTimerId = null;
  }
}

export function disconnectCanvaSSE(): void {
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
  reconnectTimerId = setTimeout(() => {
    void connectCanvaSSE();
  }, backoffDelayMs(reconnectAttempt));
}

function drain(reason: string): void {
  // FIRE-AND-FORGET như nhánh ChatGPT: `await` ở đây sẽ chặn vòng đọc stream suốt
  // thời gian chạy lệnh (mời có thể mất cả phút) → server tưởng client chết.
  runCanvaUntilIdle()
    .then((r) => {
      if (r.processed > 0) {
        console.log(`[autogpt-canva-sse] ${reason}: chạy ${r.processed} lệnh`);
      }
    })
    .catch((e) => console.warn(`[autogpt-canva-sse] ${reason} lỗi`, e));
}

export async function connectCanvaSSE(): Promise<void> {
  if (isConnecting) return;
  isConnecting = true;
  try {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    const config = await getCanvaConfig();
    if (!config) return; // máy này không chạy nhánh Canva

    const controller = new AbortController();
    abortController = controller;

    let resp: Response;
    try {
      resp = await fetch(`${config.apiBaseUrl}/api/v1/queue/stream`, {
        method: "GET",
        headers: { "X-API-KEY": config.apiKey, Accept: "text/event-stream" },
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) return;
      console.warn("[autogpt-canva-sse] fetch lỗi", e);
      scheduleReconnect();
      return;
    }
    if (!resp.ok || !resp.body) {
      console.warn(`[autogpt-canva-sse] phản hồi ${resp.status}`);
      scheduleReconnect();
      return;
    }
    reconnectAttempt = 0;
    console.log("[autogpt-canva-sse] đã kết nối");
    // Lệnh tạo trong lúc mất kết nối không có sự kiện nào để phát lại → quét một
    // lượt ngay sau khi nối lại.
    drain("nối lại");

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLines = raw
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6));
          if (dataLines.length === 0) continue; // nhịp tim
          try {
            const obj = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
            if (obj.type === "task-available") drain("có lệnh mới");
          } catch {
            /* gói tin hỏng — bỏ qua, stream vẫn chạy tiếp */
          }
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) console.warn("[autogpt-canva-sse] stream đứt", e);
    }
    if (!controller.signal.aborted) scheduleReconnect();
  } finally {
    isConnecting = false;
  }
}
