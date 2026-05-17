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

export const VERSION = "0.3.17";

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
    version: "0.3.17",
    date: "2026-05-17",
    kind: "fix",
    summary: "SYNC_BILLING click tab thay vì URL — fix UI_ELEMENT_NOT_FOUND khi ?tab=invoices sticky",
    details: [
      "Bug v0.3.16: history.pushState('/admin/billing') không reset tab về Kế hoạch — ChatGPT giữ ?tab=invoices sticky → seat scrape fail trên trang Hoá đơn → UI_ELEMENT_NOT_FOUND",
      "Fix: click button 'Kế hoạch' rồi 'Hoá đơn' theo text — không phụ thuộc URL query",
      "Nới yêu cầu fail: chỉ trả UI_ELEMENT_NOT_FOUND khi CẢ seat lẫn invoices đều rỗng. Partial data (vd có invoices mà thiếu seat) vẫn push lên backend",
      "Progress message rõ hơn 2 phase: 'Đang đọc tab Kế hoạch' → 'Đang đọc tab Hoá đơn'",
    ],
  },
  {
    version: "0.3.16",
    date: "2026-05-17",
    kind: "fix",
    summary: "SYNC_BILLING navigate sang ?tab=invoices để scrape giá per-slot từ bảng Hoá đơn",
    details: [
      "Bug: ChatGPT đặt list hoá đơn ở /admin/billing?tab=invoices (tab riêng), không phải trên trang summary mặc định → trước đây invoices array luôn rỗng",
      "Fix sync-billing 2 bước: (1) /admin/billing scrape seat/plan/renewal cycle (text 'Chu kỳ hiện tại: 11 thg 5 - 11 thg 6'); (2) /admin/billing?tab=invoices scrape list hoá đơn",
      "Merge kết quả: giữ field nào có giá trị, ưu tiên step 2 cho invoices",
    ],
  },
  {
    version: "0.3.15",
    date: "2026-05-17",
    kind: "fix",
    summary: "FIX THẬT scrape email — dùng TreeWalker SHOW_TEXT thay vì children.length",
    details: [
      "Bug v0.3.13: ChatGPT đôi khi render email là TEXT NODE TRỰC TIẾP cạnh <span>avatar</span> trong cùng div (mixed content). Code cũ kiểm tra el.children.length===0 sẽ skip vì element có 1 child <span> → fallback regex greedy lại nuốt 'D'+'dhealth.220' → email sai",
      "Fix: dùng TreeWalker(SHOW_TEXT) walk text nodes trực tiếp. Mỗi text node là 1 string độc lập, email luôn tách khỏi avatar text node bên cạnh",
      "Cùng cách áp dụng cho name + joined_at (findNameInRow, findJoinedAtInRow)",
    ],
  },
  {
    version: "0.3.14",
    date: "2026-05-17",
    kind: "feature",
    summary: "SYNC_BILLING scrape thêm lịch sử hoá đơn — dashboard tính giá per-slot hôm nay",
    details: [
      "Bug nghiệp vụ: per-slot price prorated theo days_remaining_until_renewal — giảm dần từng ngày. Admin cần biết giá hôm nay nếu thêm member mới",
      "Scraper extension đọc bảng hoá đơn /admin/billing: extract list {date, amount_vnd, status}",
      "Backend lưu billing_invoices JSONB (migration 0007), trả qua WorkspaceOut",
      "Dashboard hiển thị bảng lịch sử + tính giá hôm nay = invoice gần nhất × (days_until_renewal_hôm_nay / days_until_renewal_lúc_đó)",
    ],
  },
  {
    version: "0.3.13",
    date: "2026-05-17",
    kind: "fix",
    summary: "Fix scrape email/name sai do regex greedy nuốt name avatar — thêm Ngày thêm",
    details: [
      "Bug nghiêm trọng: row ChatGPT render 'D dhealth.220@gmail.com' (avatar + tên + email). row.textContent = 'Ddhealth.220@gmail.com' → regex greedy match toàn bộ → email sai 'Ddhealth.220@gmail.com' thay vì 'dhealth.220@gmail.com'",
      "Hậu quả: backend tạo records mới với email sai (dddhealth, nkieutanthanh, hhaisocialwork...) → dhealth thật giữ trạng thái pending; name/role NULL vì không match được Member record",
      "Fix scrape:",
      "- findEmailLeaf: tìm element leaf có textContent ĐÚNG là email format (không nuốt name)",
      "- findNameLeaf: walk up từ email element tìm leaf khác (không phải email/date/role/license) làm name",
      "- findJoinedAtLeaf: parse 'DD thg M, YYYY' từ cột Ngày thêm trên ChatGPT → ISO date",
      "- ScrapedMember nhận thêm field optional joined_at",
    ],
  },
  {
    version: "0.3.12",
    date: "2026-05-17",
    kind: "fix",
    summary: "Drain pending tasks ngay sau SSE subscribe — fix task tạo lúc disconnect bị miss",
    details: [
      "Bug: nếu user tạo task TRONG LÚC SSE đang disconnect (vd backend restart, network glitch), task nằm PENDING trong DB nhưng SSE event task-available bị mất (SSE không replay history)",
      "Hậu quả: extension subscribe lại OK nhưng không biết có task đang chờ → task treo cho tới khi fast-poll 5s kế tiếp đụng tới (hoặc backup alarm 60s)",
      "Fix: ngay sau khi SSE subscribe thành công → gọi runUntilIdle() 1 lần để drain mọi task PENDING còn sót. Idempotent với fast-poll/alarms (có lock in-flight)",
    ],
  },
  {
    version: "0.3.11",
    date: "2026-05-17",
    kind: "fix",
    summary: "Fix reinject path sai sau build — đọc manifest runtime thay vì hardcode src/.ts",
    details: [
      "Bug: chrome.scripting.executeScript({files: ['src/content/dashboard-bridge.ts']}) thất bại với 'Không thể tải tệp' sau build, vì vite rename thành assets/dashboard-bridge.ts-loader-<hash>.js (hash đổi mỗi build)",
      "Cùng bug ở runner.ts ensureContentInjected — file 'src/content/index.ts' không tồn tại trong dist",
      "Fix: lookup content_scripts trong chrome.runtime.getManifest() để lấy đúng bundled path. Match theo URL pattern (':5173/' cho dashboard-bridge, 'chatgpt.com/admin' cho content)",
    ],
  },
  {
    version: "0.3.10",
    date: "2026-05-17",
    kind: "feature",
    summary: "SYNC chọn scope (include_pending) + rogue invite detection + revoke batch action + invite skip role click khi member",
    details: [
      "SYNC_DATA payload nhận include_pending (default true). Nếu false → chỉ scrape tab 'Người dùng', bỏ qua 'Lời mời' + 'Yêu cầu' (~3x nhanh)",
      "bulk_upsert nhận scraped_statuses → backend chỉ reconcile (mark removed) status trong scope đã scrape; tránh wipe pending khi user chọn sync chỉ active",
      "Rogue invite detection: backend trả rogue_pending_emails (invite trên ChatGPT mà KHÔNG có Member record trong DB hoặc record status=removed) → đẩy vào task.result",
      "New action REVOKE_INVITES + revoke-invite.ts: click ... menu → 'Thu hồi lời mời' → confirm. Batch handler navigate /admin/members?tab=invites trước khi loop",
      "New backend endpoint POST /workspaces/{wid}/revoke-invites — dashboard queue REVOKE_INVITES task sau khi admin xác nhận rogue list",
      "Invite: nếu role='member' (default) thì SKIP click role select — giảm pattern bot, nhanh hơn",
    ],
  },
  {
    version: "0.3.9",
    date: "2026-05-17",
    kind: "feature",
    summary: "INVITE_MEMBER tự bật 'Cho phép lời mời từ miền bên ngoài' trước invite, tự tắt sau khi xong",
    details: [
      "Bug bảo mật: nếu để toggle 'Cho phép lời mời từ miền bên ngoài' ở ON lâu dài, mọi member workspace có thể tự mời email từ bất kỳ domain → rất rủi ro",
      "Yêu cầu: dashboard mời được email ngoài domain, nhưng toggle phải về OFF ngay sau invite",
      "Fix: helper withExternalInvitesEnabled() — navigate /admin/identity, đọc state toggle, bật ON nếu OFF, navigate về /admin/members, chạy invite, navigate về /admin/identity tắt lại (try/finally đảm bảo restore kể cả khi invite fail)",
      "Selectors toggle heuristic: button[role='switch'] hoặc input[type='checkbox'] có label text 'Cho phép lời mời từ miền bên ngoài' / 'external'. Fallback aria-checked + data-state cho Radix UI",
      "Nếu không control được toggle → vẫn chạy invite + warn log, không phá flow",
    ],
  },
  {
    version: "0.3.8",
    date: "2026-05-17",
    kind: "feature",
    summary: "Auto-mở admin tab khi nhận task mà không có tab chatgpt.com/admin/*",
    details: [
      "Trước: nếu user không mở sẵn chatgpt.com/admin → task FAILED với NOT_LOGGED_IN_CHATGPT, bắt user mở tab thủ công",
      "Sau: runner tự tabs.create({url: 'chatgpt.com/admin/members', active: false}) (background tab, không steal focus), đợi tab load complete tối đa 30s, verify URL vẫn ở /admin",
      "Chỉ trả NOT_LOGGED_IN_CHATGPT khi tab tự mở bị redirect khỏi /admin (= chưa login ChatGPT)",
      "Cộng thêm waitForTabComplete helper dùng chrome.tabs.onUpdated.status='complete'",
    ],
  },
  {
    version: "0.3.7",
    date: "2026-05-17",
    kind: "fix",
    summary: "SYNC auto-navigate sang /admin/members — fix 'tab not found' khi admin tab đang ở /admin/billing",
    details: [
      "Bug: executeSync chỉ check pathname.includes('/admin') — pass cho cả /admin/billing, /admin/settings,...; tabs Người dùng/Lời mời/Yêu cầu chỉ tồn tại trên /admin/members",
      "Triệu chứng: [autogpt-sync] tab not found cho cả 3 tab; fallback scrape DOM hiện tại đánh nhãn 'active' → DB chứa dữ liệu sai (vd: user dhealth đã bị xoá khỏi pending invites trên ChatGPT vẫn còn ở dashboard)",
      "Fix: nếu pathname không phải /admin/members → history.pushState + dispatchEvent('popstate') để SPA Router điều hướng → poll tối đa 10s đợi tab 'Người dùng' render",
      "Nếu sau 10s vẫn không tìm thấy tab → trả PAGE_NOT_ADMIN với hint mở /admin/members thủ công",
    ],
  },
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
