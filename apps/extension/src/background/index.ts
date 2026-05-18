import { runUntilIdle } from "./runner";
import { connectSSE, disconnectSSE } from "./sse";
import {
  handleLabelMismatchReport,
  isLabelsAlarm,
  refreshLabelBundle,
  setupLabelsRefreshAlarm,
} from "./labels-sync";
import { updateProgress } from "../shared/api";
import { getConfig } from "../shared/storage";

/**
 * Backup poll alarm: dù SSE có rớt (Chrome MV3 SW kill, network glitch, ...)
 * thì cứ ~1 phút SW tự wake, gọi runUntilIdle drain queue.
 * SSE primary (real-time), polling này chỉ là safety net.
 */
const BACKUP_POLL_ALARM = "autogpt-backup-poll";

const DASHBOARD_MATCHES = [
  "http://localhost:17173/*",
  "http://127.0.0.1:17173/*",
];

/**
 * Re-inject dashboard bridge vào các tab đang mở.
 *
 * Lý do: content_scripts trong manifest chỉ inject lúc PAGE LOAD. Nếu user
 * reload extension trong chrome://extensions/ thì tab dashboard đang mở
 * vẫn chạy bridge của bản cũ (hoặc không có bridge nếu user vừa cài).
 * Phải F5 thủ công — UX kém.
 *
 * Fix: mỗi lần extension install/reload/update, query tab khớp dashboard
 * matches và bắn executeScript để inject bridge mới NGAY LẬP TỨC.
 */
/**
 * Lấy danh sách bundled JS files của content script dashboard-bridge từ
 * manifest. Sau khi vite build, file source `.ts` được đóng gói thành
 * `assets/dashboard-bridge.ts-loader-<hash>.js` (hash đổi mỗi lần build) →
 * không thể hardcode path. Đọc trực tiếp từ manifest.content_scripts là cách
 * duy nhất chính xác cả ở dev lẫn prod.
 */
function getDashboardBridgeFiles(): string[] {
  const manifest = chrome.runtime.getManifest();
  const scripts = (manifest.content_scripts ?? []) as Array<{
    matches?: string[];
    js?: string[];
  }>;
  const entry = scripts.find((cs) =>
    (cs.matches ?? []).some((m) => m.includes(":17173/")),
  );
  return entry?.js ?? [];
}

async function reinjectDashboardBridge(): Promise<void> {
  const files = getDashboardBridgeFiles();
  if (files.length === 0) {
    console.warn(
      "[autogpt] không tìm thấy content_script dashboard-bridge trong manifest — skip reinject",
    );
    return;
  }
  try {
    const tabs = await chrome.tabs.query({ url: DASHBOARD_MATCHES });
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files,
        });
        console.log(
          `[autogpt] reinjected bridge into tab ${tab.id} (${tab.url})`,
        );
      } catch (e) {
        console.warn(`[autogpt] reinject bridge failed for tab ${tab.id}`, e);
      }
    }
  } catch (e) {
    console.warn("[autogpt] dashboard tab query failed", e);
  }
}

// ⚠️ KHÔNG poll tự động — extension chỉ chạy khi user bấm "Thực hiện task đang chờ"
// trong popup HOẶC dashboard postMessage qua bridge. Tránh hành vi bot, theo
// nguyên tắc "thao tác như người dùng thật". (Trước đây có chrome.alarms 30s;
// đã bỏ theo yêu cầu user 2026-05-16.)
function setupBackupPoll(): void {
  // delayInMinutes=0.1 (~6s) cho lần đầu sau install/startup để bắt task ngay.
  // periodInMinutes=1 (min cho phép trong prod Chrome 117+).
  chrome.alarms.create(BACKUP_POLL_ALARM, {
    delayInMinutes: 0.1,
    periodInMinutes: 1,
  });
  console.log("[autogpt] backup poll alarm scheduled (every 1 min)");
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (isLabelsAlarm(alarm.name)) {
    void refreshLabelBundle();
    return;
  }
  if (alarm.name !== BACKUP_POLL_ALARM) return;
  console.log("[autogpt-poll] backup tick — checking pending tasks");
  runUntilIdle()
    .then((r) => {
      if (r.processed > 0) {
        console.log(
          `[autogpt-poll] processed ${r.processed} task(s) via backup poll`,
        );
      }
    })
    .catch((e) => console.warn("[autogpt-poll] failed", e));
  // Cũng thử reconnect SSE nếu connection chết.
  void connectSSE();
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[autogpt] onInstalled reason=${details.reason}`);
  void reinjectDashboardBridge();
  setupBackupPoll();
  setupLabelsRefreshAlarm();
  void refreshLabelBundle();
  // Auto-connect SSE — backend sẽ push task event tới đây, KHÔNG cần user
  // thao tác gì trên extension.
  void connectSSE();
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[autogpt] onStartup");
  void reinjectDashboardBridge();
  setupBackupPoll();
  setupLabelsRefreshAlarm();
  void refreshLabelBundle();
  void connectSSE();
});

// User save/clear API key trong popup → reconnect SSE với credentials mới.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!("autogpt.config" in changes)) return;
  const newConfig = changes["autogpt.config"].newValue;
  console.log("[autogpt] config changed, reconnecting SSE");
  if (newConfig) {
    void connectSSE();
    void refreshLabelBundle();
  } else {
    disconnectSSE();
  }
});

// Watchdog: nếu SW vừa wake từ idle mà SSE chưa kết nối, thử connect ngay.
// (chrome.runtime.onStartup chỉ fire 1 lần khi browser khởi động.)
void connectSSE();
setupBackupPoll();
setupLabelsRefreshAlarm();
void refreshLabelBundle();
// Manual reload từ chrome://extensions/ KHÔNG fire onInstalled/onStartup,
// chỉ SW restart và chạy top-level code. Phải re-inject bridge ở đây nữa để
// các tab dashboard đang mở không cần F5 sau mỗi lần reload extension.
void reinjectDashboardBridge();

// Cũng drain queue ngay khi SW load (covers case SSE chưa connect xong nhưng
// có task đang chờ — vd extension vừa reload sau khi user đã queue task).
runUntilIdle()
  .then((r) => {
    if (r.processed > 0) {
      console.log(`[autogpt-boot] drained ${r.processed} task(s) on SW load`);
    }
  })
  .catch((e) => console.warn("[autogpt-boot] failed", e));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "run-pending") {
    // User-triggered: drain task queue cho đến khi không còn PENDING
    (async () => {
      const result = await runUntilIdle();
      sendResponse({ ok: true, ...result });
    })();
    return true;
  }
  if (msg?.type === "task-progress" && typeof msg.taskId === "string") {
    (async () => {
      const config = await getConfig();
      if (!config) return;
      try {
        await updateProgress(config, msg.taskId, msg.progress ?? {});
      } catch (e) {
        console.warn("[autogpt-progress] failed", e);
      }
    })();
    return false;
  }
  if (msg?.type === "report-label-mismatch" && msg.body) {
    void handleLabelMismatchReport(msg.body);
    return false;
  }
  return undefined;
});

console.log("[autogpt] background service worker booted");
