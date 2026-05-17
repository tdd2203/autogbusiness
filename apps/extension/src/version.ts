/**
 * Single source of truth cho version + changelog của extension.
 *
 * Quy tắc bump version (semver-like):
 *   - MAJOR (x.0.0): breaking change về protocol/storage hoặc đổi cấu trúc lớn
 *   - MINOR (0.x.0): thêm action mới (SYNC_BILLING, INVITE_MEMBER, ...) hoặc
 *                    thay đổi UI lớn (popup redesign, scraper rewrite)
 *   - PATCH (0.0.x): fix bug, sửa selectors, tune timing/regex
 *
 * Khi bump:
 *   1. Tăng `VERSION` ở dưới
 *   2. Prepend 1 entry mới ở đầu `CHANGELOG` (most recent first)
 *   3. Build lại extension, reload trong chrome://extensions
 *
 * Manifest tự đọc VERSION từ file này — KHÔNG cần sửa manifest.ts.
 * Popup hiển thị VERSION prominent + cho phép expand changelog.
 */

export const VERSION = "0.3.6";

export type ChangelogEntry = {
  version: string;
  date: string; // YYYY-MM-DD
  kind: "feature" | "fix" | "chore";
  summary: string;
  /** Bullet list chi tiết, hiển thị khi user expand. */
  details: string[];
};

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.3.6",
    date: "2026-05-17",
    kind: "fix",
    summary: "Re-inject dashboard bridge ở top-level SW — không cần F5 sau khi Reload extension",
    details: [
      "Bug: reinjectDashboardBridge() chỉ gọi trong onInstalled/onStartup. Click 'Reload' trên chrome://extensions/ KHÔNG fire 2 event đó → bridge không được tái inject → dashboard alert 'Extension chưa được nhận diện' bắt user F5",
      "Fix: gọi reinjectDashboardBridge() ở top-level SW (alongside connectSSE + setupBackupPoll) để chạy mỗi lần SW restart bất kể nguyên nhân",
    ],
  },
  {
    version: "0.3.5",
    date: "2026-05-17",
    kind: "fix",
    summary: "Thêm permission 'alarms' — SW crash 'onAlarm undefined' khiến service worker không register được",
    details: [
      "Bug: v0.3.2 thêm chrome.alarms.create + chrome.alarms.onAlarm (Layer 3 backup poll 60s) nhưng manifest permissions không có 'alarms'",
      "Hậu quả: chrome.alarms undefined → background/index.ts:58 throw TypeError → service worker registration failed (status code 15) → SW không bao giờ start → không có SSE, không có fast-poll, không có alarm",
      "Đây là root cause thực sự của triệu chứng 'extension treo task' trước đó, không phải host permission v0.3.4",
      "Fix: thêm 'alarms' vào manifest permissions array",
    ],
  },
  {
    version: "0.3.4",
    date: "2026-05-17",
    kind: "fix",
    summary: "Thêm host permission cho 127.0.0.1:8000 — SSE không kết nối được nếu apiBaseUrl dùng IP",
    details: [
      "Bug: manifest host_permissions chỉ có 'http://localhost:8000/*' — nếu user nhập apiBaseUrl='http://127.0.0.1:8000' trong popup, extension fetch SSE bị Chromium block (localhost và 127.0.0.1 là 2 origin khác nhau)",
      "Triệu chứng: service worker idle → 'Không hoạt động', dashboard tạo task → extension không phản ứng, console rỗng vì SW không khởi động được",
      "Fix: thêm 'http://127.0.0.1:8000/*' vào host_permissions; giữ luôn localhost variant để backward-compatible với config cũ",
    ],
  },
  {
    version: "0.3.3",
    date: "2026-05-16",
    kind: "feature",
    summary: "Scrape cả 3 tab (Người dùng + Lời mời + Yêu cầu) + fix invite",
    details: [
      "SYNC_DATA: click qua 3 tab /admin/members (Người dùng → active, Lời mời + Yêu cầu → pending), scrape tất cả, merge dedup theo email",
      "Backend DB giờ có đủ data → invite trùng email pending sẽ bị 409 từ backend (existing check Member.status != removed)",
      "Invite action: ưu tiên click tab 'Người dùng' trước khi tìm nút 'Mời thành viên'",
      "Invite selectors: thêm fallback [role='dialog'] input/textarea (ChatGPT có thể dùng textarea cho multi-email)",
      "Invite role combobox: map 'Quản trị viên' / 'Thành viên' / 'Chủ sở hữu' khi gặp Radix combobox",
      "Invite verify fail: parse dialog text để detect lỗi cụ thể ('đã tồn tại', 'đã được mời') thay vì 'VERIFY_FAILED' generic",
      "Mọi step trong invite log [autogpt-invite] để debug",
    ],
  },
  {
    version: "0.3.2",
    date: "2026-05-16",
    kind: "fix",
    summary: "Triple-layer auto-execute — SSE + fast poll 5s + alarms 60s backup",
    details: [
      "Vấn đề v0.3.1: task vẫn không tự chạy dù SSE supposedly hoạt động — root cause khó xác định",
      "Fix: 3 layer guarantee task chạy, không cần ấn popup",
      "Layer 1 (SSE, <1s): backend push event, extension nhận → fire-and-forget runUntilIdle",
      "Layer 2 (fast poll, 5s): setTimeout chain khi SW còn alive (SSE giữ SW alive) → mỗi 5s drain queue",
      "Layer 3 (alarms, 60s): chrome.alarms 1 phút — wake SW dù đã chết, đồng thời reconnect SSE",
      "Boot drain: runUntilIdle ngay khi SW load (covers extension vừa reload sau khi user queue task)",
      "Worst case latency: 60s. Best case: <1s. Trung bình: <5s.",
    ],
  },
  {
    version: "0.3.1",
    date: "2026-05-16",
    kind: "fix",
    summary: "SSE event nhận được nhưng task không chạy — fire-and-forget fix",
    details: [
      "Bug v0.3.0: handleEvent 'await runUntilIdle()' BLOCK stream reader loop",
      "Hậu quả: SSE event đến → SW bắt đầu runUntilIdle (có thể dài 30s-5min) → reader không read được heartbeat → server tưởng client chết → SW có thể bị MV3 kill ở 30s timeout",
      "Fix: handleEvent fire-and-forget — return ngay, runUntilIdle chạy độc lập trong background",
      "Reader loop tiếp tục read heartbeat 25s/lần → SSE stream alive → SW alive",
      "Thêm log chi tiết từng bước trong runOnce (pickNextTask, findAdminTab, sendToContent) để debug khi task chạy ngầm",
      "Cách check: chrome://extensions → Inspect views: service worker → Console — sẽ thấy '[autogpt-runner] picked task', '[autogpt-runner] found admin tab', '[autogpt-runner] content script response: ok=true'",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-05-16",
    kind: "feature",
    summary: "REAL-TIME auto-execute qua SSE — không cần user thao tác gì",
    details: [
      "Backend mở endpoint /api/v1/queue/stream (Server-Sent Events) push task event tới extension",
      "Extension SW giữ SSE connection persistent (fetch streaming + X-API-KEY header)",
      "Khi dashboard tạo task (sync/sync-billing/invite/remove/role) → backend publish event → extension nhận trong <1s → tự động chạy runUntilIdle",
      "BỎ HOÀN TOÀN phụ thuộc bridge postMessage cho auto-trigger (bridge vẫn còn dùng cho extension status badge)",
      "Reconnect exponential backoff 1s→2s→...→30s khi connection drop (server restart, network glitch, SW kill)",
      "chrome.storage.onChanged → khi user đổi API key trong popup, SSE tự reconnect với credentials mới",
      "MV3 SW lifecycle: SSE fetch giữ SW alive; onStartup/onInstalled trigger reconnect khi SW restart",
    ],
  },
  {
    version: "0.2.2",
    date: "2026-05-16",
    kind: "fix",
    summary: "Bridge detection REAL fix — isolated world bug + auto-reinject",
    details: [
      "Root cause v0.2.1: content scripts chạy trong ISOLATED WORLD nên window.__autogptExtensionInstalled KHÔNG truyền sang page → dashboard không bao giờ thấy bridge dù bridge đã inject",
      "Fix: bridge announce qua window.postMessage thay vì set global flag (postMessage cross-world OK)",
      "Dashboard listen postMessage indefinitely + ping bridge khi mount + heartbeat 3s",
      "Background SW tự gọi chrome.scripting.executeScript inject bridge vào dashboard tab đang mở khi extension reload → user KHÔNG cần F5 trang",
      "triggerExtensionRun giờ async — probe bridge bằng ping/pong (timeout 300ms) trước khi gửi run-pending; alert rõ nếu bridge missing",
      "Bridge auto re-announce 'bridge-ready' sau 500ms để cover dashboard mount muộn",
    ],
  },
  {
    version: "0.2.1",
    date: "2026-05-16",
    kind: "fix",
    summary: "Bridge detection bền hơn + alert rõ khi bridge missing",
    details: [
      "Bridge dispatch 'autogpt-extension-ready' event KÈM version (CustomEvent.detail)",
      "Bridge expose window.__autogptExtensionVersion để dashboard verify build",
      "Dashboard listen ready event INDEFINITELY (trước đây poll 5s rồi tắt) → bắt được bridge inject muộn",
      "triggerExtensionRun: nếu bridge missing → hiển thị alert hướng dẫn 'Reload extension + F5 trang'",
      "Sidebar hiển thị extension version (vd '✓ Extension v0.2.1: connected') + nút reload trang khi not detected",
      "Bridge thêm handler 'ping' → 'pong' cho dashboard chủ động verify bridge còn sống",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-05-16",
    kind: "feature",
    summary: "SYNC_BILLING + auto-trigger từ dashboard",
    details: [
      "Action SYNC_BILLING: scrape 'Đang dùng X/Y giấy phép' từ /admin/billing",
      "Parse thêm plan (business/enterprise/team), billing_status (PAID/UNPAID), renewal_date",
      "Dashboard có nút '↻ Sync billing' — auto-trigger extension drain queue, không cần mở popup",
      "Hiển thị badge UNPAID đỏ trên Dashboard khi billing chưa thanh toán",
      "seat_total validated tối đa 999 (hard cap ChatGPT Business)",
      "Bridge content script (localhost:5173) — dashboard mutation tự đẩy task xuống extension",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-05-15",
    kind: "feature",
    summary: "MVP — invite/remove/change-role/sync members",
    details: [
      "Actions: INVITE_MEMBER, REMOVE_MEMBER, CHANGE_ROLE, SYNC_DATA",
      "Anti-detection: random delay 1.5-4s, mousedown→mouseup→click, per-char typing",
      "Per-workspace API key (X-API-KEY header)",
      "Popup: kết nối backend, hiển thị workspace info, run pending tasks",
      "i18n: vi + zh-CN",
    ],
  },
];

/** Helper cho UI hiển thị badge màu theo kind. */
export const KIND_COLOR: Record<ChangelogEntry["kind"], string> = {
  feature: "#10b981", // emerald
  fix: "#f59e0b", // amber
  chore: "#94a3b8", // slate
};
