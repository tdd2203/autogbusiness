# AutoGPT Admin Extension — Changelog

Mọi thay đổi đáng kể của extension được ghi tại đây. File này là **mirror text-only** của [`src/version.ts`](src/version.ts) — version.ts là single source of truth (manifest + popup UI đọc từ đó).

## Quy tắc bump version (semver-like)

- **MAJOR (`x.0.0`)** — breaking change: đổi protocol message với backend, đổi cấu trúc storage, refactor lớn buộc reload toàn bộ workspace.
- **MINOR (`0.x.0`)** — thêm action/scraper mới (SYNC_BILLING, INVITE_MEMBER…) hoặc redesign UI lớn.
- **PATCH (`0.0.x`)** — bug fix, sửa selectors khi ChatGPT đổi UI, tune regex/timing.

## Quy trình mỗi lần bump

1. Cập nhật `VERSION` trong [`src/version.ts`](src/version.ts).
2. Prepend entry mới vào đầu mảng `CHANGELOG` cùng file (most recent first).
3. Mirror entry đó vào file này (cũng most recent first).
4. Rebuild extension, reload trong `chrome://extensions/`.
5. Popup sẽ tự hiển thị version + changelog từ `version.ts` — không cần sửa manifest hay popup.

---

## v0.3.6 — 2026-05-17 — fix

**Re-inject dashboard bridge ở top-level SW — không cần F5 sau khi Reload extension**

- **Bug:** `reinjectDashboardBridge()` chỉ gọi trong `chrome.runtime.onInstalled` và `onStartup`. Khi user click "Reload" trên `chrome://extensions/`, Chromium chỉ restart SW và chạy top-level code — **không fire** 2 event đó. Hậu quả: bridge ở các tab dashboard đang mở vẫn là bản cũ (hoặc không có nếu vừa mới load extension lần đầu) → dashboard popup `Extension chưa được nhận diện` bắt user F5 thủ công.
- **Fix:** gọi `reinjectDashboardBridge()` ở top-level SW (alongside `connectSSE()` + `setupBackupPoll()`) để chạy mỗi lần SW restart bất kể nguyên nhân (install / update / browser startup / manual reload / SW wake từ idle).

## v0.3.5 — 2026-05-17 — fix

**Thêm permission `alarms` — SW crash khiến không register được**

- **Bug:** v0.3.2 thêm `chrome.alarms.create` + `chrome.alarms.onAlarm.addListener` (Layer 3 backup poll 60s) nhưng manifest `permissions` không khai báo `"alarms"`.
- **Hậu quả:** `chrome.alarms` là `undefined` → [`background/index.ts:58`](src/background/index.ts#L58) throw `TypeError: Cannot read properties of undefined (reading 'onAlarm')` → Service worker registration failed (status code 15) → SW không bao giờ start → không có SSE, không có fast-poll, không có alarm, dashboard tạo task không ai nghe.
- **Đây là root cause thực sự** của triệu chứng "extension treo task" mà v0.3.4 chưa fix được (v0.3.4 chỉ sửa host permission cho 127.0.0.1:8000, đáng làm nhưng không phải nguyên nhân chính).
- **Fix:** thêm `"alarms"` vào `permissions` array trong [`src/manifest.ts`](src/manifest.ts).

## v0.3.4 — 2026-05-17 — fix

**Thêm host permission cho `127.0.0.1:8000` — SSE không kết nối được nếu apiBaseUrl dùng IP**

- **Bug:** manifest `host_permissions` chỉ có `http://localhost:8000/*`. Nếu user nhập `apiBaseUrl=http://127.0.0.1:8000` trong popup → extension fetch SSE bị Chromium block (localhost và 127.0.0.1 là 2 origin khác nhau).
- **Triệu chứng:** service worker idle → "Không hoạt động", dashboard tạo task → extension không phản ứng, console rỗng vì SW không khởi động được.
- **Fix:** thêm `http://127.0.0.1:8000/*` vào `host_permissions`; giữ luôn `localhost` variant để backward-compatible với config cũ.

## v0.3.3 — 2026-05-16 — feature

**Scrape cả 3 tab + fix invite**

- **SYNC_DATA** giờ click qua 3 tab `/admin/members`:
  - "Người dùng" → status `active`
  - "Lời mời đang chờ xử lý" → status `pending`
  - "Yêu cầu đang chờ xử lý" → status `pending`
- Merge dedup theo email; tab "Người dùng" scrape cuối cùng nên status `active` thắng nếu trùng.
- Backend DB giờ có đủ data → invite trùng email pending sẽ bị 409 (existing check `Member.status != removed`).
- **Invite action fix:**
  - Ưu tiên click tab "Người dùng" trước khi tìm nút "Mời thành viên" (nút chỉ hiện ở tab này).
  - Selectors fallback: `[role='dialog'] input/textarea` (ChatGPT có thể dùng textarea cho multi-email).
  - Role combobox Radix UI: map `Quản trị viên` / `Thành viên` / `Chủ sở hữu`.
  - Verify fail giờ parse dialog text → detect lỗi cụ thể ("đã tồn tại", "đã được mời") thay vì VERIFY_FAILED generic.
  - Mọi step log `[autogpt-invite]` để debug.

## v0.3.2 — 2026-05-16 — fix

**Triple-layer auto-execute — SSE + fast poll 5s + alarms 60s backup**

- **Vấn đề v0.3.1:** task vẫn không tự chạy dù SSE supposedly hoạt động — root cause khó xác định không debug được realtime.
- **Fix:** 3 layer guarantee task chạy, không cần ấn popup:
  - **Layer 1 — SSE (<1s):** backend `publish_task_event` → extension fire-and-forget `runUntilIdle`
  - **Layer 2 — fast poll (5s):** setTimeout chain khi SW còn alive (SSE giữ SW alive) → mỗi 5s drain queue
  - **Layer 3 — alarms (60s):** `chrome.alarms` 1 phút — wake SW dù đã chết, đồng thời reconnect SSE
- **Boot drain:** `runUntilIdle` ngay khi SW load (covers case extension vừa reload sau khi user queue task).
- **Worst case latency:** 60s. **Best case:** <1s. **Trung bình:** <5s.

## v0.3.1 — 2026-05-16 — fix

**SSE event nhận được nhưng task không chạy — fire-and-forget fix**

- **Bug v0.3.0:** `handleEvent` `await runUntilIdle()` block stream reader loop. Hậu quả: SSE event đến → SW bắt đầu `runUntilIdle` (có thể dài 30s–5min) → reader không read được heartbeat → server tưởng client chết → SW có thể bị MV3 kill ở 30s timeout → task không chạy xong.
- **Fix:** `handleEvent` fire-and-forget — return ngay, `runUntilIdle` chạy độc lập trong background. Reader loop tiếp tục read heartbeat 25s/lần → SSE stream alive → SW alive.
- Thêm log chi tiết từng bước trong `runOnce` (`pickNextTask`, `findAdminTab`, `sendToContent`) để debug.
- Check log: `chrome://extensions/` → AutoGPT Admin Extension → "Inspect views: service worker" → Console:
  - `[autogpt-sse] task-available SYNC_DATA <id> → triggering runUntilIdle`
  - `[autogpt-runner] picked task SYNC_DATA <id>`
  - `[autogpt-runner] found admin tab <id> https://chatgpt.com/admin/...`
  - `[autogpt-runner] sending SYNC_DATA to content script...`
  - `[autogpt-runner] content script response: ok=true`

## v0.3.0 — 2026-05-16 — feature

**REAL-TIME auto-execute qua SSE — KHÔNG CẦN USER THAO TÁC GÌ**

- Backend mở endpoint `/api/v1/queue/stream` (Server-Sent Events) push task event tới extension.
- Extension SW giữ SSE connection persistent (fetch streaming + `X-API-KEY` header).
- Khi dashboard tạo task (sync/sync-billing/invite/remove/role) → backend `publish_task_event` → extension nhận event trong **<1s** → tự động chạy `runUntilIdle`.
- **BỎ HOÀN TOÀN phụ thuộc bridge postMessage** cho auto-trigger (bridge vẫn còn dùng cho extension status badge).
- Reconnect exponential backoff 1s→2s→4s→8s→16s→30s khi connection drop (server restart, network glitch, SW kill).
- `chrome.storage.onChanged` → khi user đổi API key trong popup, SSE tự reconnect với credentials mới.
- MV3 SW lifecycle: SSE fetch giữ SW alive; `onStartup`/`onInstalled` trigger reconnect khi SW restart.

## v0.2.2 — 2026-05-16 — fix

**Bridge detection REAL fix — isolated world bug + auto-reinject**

- **Root cause v0.2.1:** content scripts chạy trong **ISOLATED WORLD** nên `window.__autogptExtensionInstalled = true` trong bridge KHÔNG truyền sang page's window → dashboard không bao giờ thấy bridge dù bridge đã inject. v0.2.1 fix nhầm chỗ.
- **Fix v0.2.2:** bridge announce qua `window.postMessage` thay vì set global flag (postMessage là cross-world).
- Dashboard listen postMessage indefinitely + ping bridge khi mount + heartbeat 3s.
- Background SW tự gọi `chrome.scripting.executeScript` inject bridge vào dashboard tab đang mở khi extension reload → **user KHÔNG cần F5 trang**.
- `triggerExtensionRun` giờ `async` — probe bridge bằng ping/pong (timeout 300ms) trước khi gửi `run-pending`; alert rõ nếu bridge missing.
- Bridge auto re-announce `bridge-ready` sau 500ms để cover dashboard mount muộn.

## v0.2.1 — 2026-05-16 — fix

**Bridge detection bền hơn + alert rõ khi bridge missing**

- Bridge dispatch `autogpt-extension-ready` event **KÈM version** (CustomEvent.detail).
- Bridge expose `window.__autogptExtensionVersion` để dashboard verify build.
- Dashboard listen ready event **indefinitely** (trước đây poll 5s rồi tắt) → bắt được bridge inject muộn.
- `triggerExtensionRun`: nếu bridge missing → hiển thị alert hướng dẫn "Reload extension + F5 trang".
- Sidebar hiển thị extension version (vd `✓ Extension v0.2.1: connected`) + nút reload trang khi not detected.
- Bridge thêm handler `ping` → `pong` cho dashboard chủ động verify bridge còn sống.

## v0.2.0 — 2026-05-16 — feature

**SYNC_BILLING + auto-trigger từ dashboard**

- Action `SYNC_BILLING`: scrape "Đang dùng X/Y giấy phép" từ `/admin/billing`.
- Parse thêm `plan` (business/enterprise/team), `billing_status` (PAID/UNPAID), `renewal_date`.
- Dashboard có nút "↻ Sync billing" — auto-trigger extension drain queue, không cần mở popup.
- Hiển thị badge UNPAID đỏ trên Dashboard khi billing chưa thanh toán.
- `seat_total` validated tối đa **999** (hard cap ChatGPT Business).
- Bridge content script (`localhost:5173`) — dashboard mutation tự đẩy task xuống extension.

## v0.1.0 — 2026-05-15 — feature

**MVP — invite / remove / change-role / sync members**

- Actions: `INVITE_MEMBER`, `REMOVE_MEMBER`, `CHANGE_ROLE`, `SYNC_DATA`.
- Anti-detection: random delay 1.5–4s, `mousedown → mouseup → click`, per-char typing.
- Per-workspace API key (`X-API-KEY` header).
- Popup: kết nối backend, hiển thị workspace info, run pending tasks.
- i18n: `vi` + `zh-CN`.
