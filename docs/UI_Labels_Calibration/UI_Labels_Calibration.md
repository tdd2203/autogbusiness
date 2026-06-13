# UI Labels — Calibrate label ChatGPT (3 locale × 4 page)

> Spec cho tính năng "harvest UI labels" — lưu cố định text hiển thị của ChatGPT
> Admin vào DB để extension automation chạy chính xác ở vi/en/zh, kèm self-heal
> khi ChatGPT đổi UI.

## Mục đích

Trước đây extension dùng `TEXT_FALLBACKS` hardcoded trong [i18n-ui.ts](../../apps/extension/src/content/i18n-ui.ts) — mỗi lần ChatGPT đổi text hoặc bổ sung locale mới phải sửa code + rebuild + reinstall extension. Tính năng này:

- Tách text label ra khỏi code, lưu DB.
- Cho admin **harvest 1 lần** mỗi (locale × page), bấm Save → extension dùng ngay.
- Khi ChatGPT đổi UI → extension tự báo stale → dashboard hiện banner → admin re-harvest chỉ đúng cell bị lỗi.

## Phạm vi

- **3 locale:** `vi`, `en`, `zh` (normalize từ `document.documentElement.lang`).
- **4 page:**
  - `/admin/members` — 15 control_key (tabs, invite dialog, row menu, confirm)
  - `/admin/billing` — 2 tab
  - `/admin/billing?tab=invoices` — 1 tab
  - `/admin/identity` — 1 toggle (external invites)
- **18 control_key × 3 locale ≈ 54 dòng DB** (kèm scrape notes optional).

Danh sách `control_key` đầy đủ tham chiếu [chatgpt-admin-label-harvest.md](../chatgpt-admin-label-harvest.md).

## Components

### Backend (`apps/api`)

- Bảng `ui_labels(locale, page, control_key, label_text, aria_label, notes, stale, stale_reason, stale_count, version, updated_by_id, …)` — unique `(locale, page, control_key)`.
- Bảng `ui_label_history(label_id, version, …)` — snapshot mỗi version cũ để rollback.
- Router `app.routers.ui_labels`:
  - `GET /api/v1/ui-labels?locale&page&stale` — list (super-admin).
  - `GET /api/v1/ui-labels/coverage` — matrix 4 page × 3 locale.
  - `POST /api/v1/ui-labels/bulk` — upsert nhiều label cho 1 (locale, page).
  - `PATCH /api/v1/ui-labels/{id}` — edit single.
  - `POST /{id}/clear-stale` — admin acknowledge sau khi sửa.
  - `GET /{id}/history` + `POST /{id}/rollback/{version}` — rollback.
  - `GET /api/v1/ui-labels/bundle` — extension fetch (auth X-API-KEY).
  - `POST /api/v1/ui-labels/report-mismatch` — extension báo stale (auth X-API-KEY).
- Permission mới: `UI_LABEL_MANAGE` — super-admin only.
- Alembic migration `0008_ui_labels`.

### Dashboard (`apps/web`)

- Settings → tab mới **"UI Labels ChatGPT"** (chỉ super-admin thấy):
  - Banner đỏ liệt kê stale labels (auto-refresh 30s) — click jump tới đúng cell.
  - Coverage matrix: 4 page × 3 locale, mỗi ô show `filled/total ⚠stale`. Click → select cell.
  - Bảng inline edit 15 control_key cho cell đang chọn. Save bulk → backend audit log.
  - "🛠 Công cụ harvest" — collapse panel với Console snippet generator: chọn workspace → reveal X-API-KEY → snippet được render với base URL + API key prefilled. Admin copy paste vào DevTools Console của chatgpt.com để quét text label.

### Extension (`apps/extension`)

- `shared/ui-labels.ts`:
  - `fetchLabelBundle(config)` GET bundle.
  - `postLabelMismatch(config, body)` POST report.
  - `loadBundleFromStorage()` / `saveBundleToStorage()` — chrome.storage.local cache.
  - `dbLabelsFor(controlKey, page?)` — sync access, return `[label_text, aria_label]` cho locale hiện tại.
  - `reportLabelMismatch(controlKey, expected, page?)` — fire-and-forget tới background.
- `background/labels-sync.ts` — alarm 15 phút refresh bundle; handle `report-label-mismatch` message từ content script.
- `content/i18n-ui.ts` — helper mới:
  - `findControlByKey(controlKey, fallback, opts)` — merge DB labels + fallback + auto-report on miss.
  - `findMenuItemByKey(...)` — variant cho menuitem/option.
- `content/index.ts` — load bundle vào memory cache khi content boot; reload khi storage thay đổi.
- Actions đã wire DB lookup: `invite` (open/submit/add-more, tab active), `sync` (3 tab), `sync-billing` (2 tab), `revoke-invite` + `revoke-invites-batch`, `remove`, `change-role`, `external-invites`, `findRoleOption`.

## Flow tổng

### Harvest lần đầu

1. Super-admin mở Settings → UI Labels.
2. Chọn locale (vi/en/zh) trong ChatGPT, F5 lại 4 page.
3. (Optional) Click "🛠 Công cụ harvest", chọn workspace, copy snippet, paste DevTools Console trên ChatGPT để quét text.
4. Quay lại Settings, click cell (page × locale), nhập label_text vào 15 ô, bấm "Lưu trang này".
5. Lặp 3 locale × 4 page → tổng ~18 control_key × 3 = 54 dòng.

### Run-time

1. Extension SW: fetch `/bundle` mỗi 15 phút → cache chrome.storage.
2. Content script: `loadBundleFromStorage()` ngay khi inject; mỗi action gọi `findControlByKey('invite_button_open', TEXT_FALLBACKS.inviteButtonOpen)` — merge DB + hardcoded.

### Self-heal

1. ChatGPT đổi UI → element không match → `findControlByKey` fire `reportLabelMismatch`.
2. Background POST `/api/v1/ui-labels/report-mismatch` với `dom_sample`.
3. Backend mark `stale=true`, `stale_count++`, audit log `UI_LABEL_MISMATCH_REPORTED`.
4. Dashboard banner đỏ — admin click → mở đúng cell → sửa text → bấm "Lưu" hoặc "OK" (clear-stale).

## Changelog

### 2026-05-18 — v0.2 (auto-harvest)

- Action `HARVEST_LABELS` mới ở extension v0.3.0 — tự navigate 4 page, mở dialog/menu, đọc text 18 control_key + ESC để rollback an toàn.
- Endpoint mới `POST /api/v1/ui-labels/harvest` (X-API-KEY) — bulk upsert đa page; `POST /api/v1/workspaces/{id}/harvest-labels` (super-admin) tạo task qua SSE.
- Settings → UI Labels: thay Console snippet thủ công bằng 3 nút "🤖 Harvest VI/EN/ZH" với progress real-time qua queue poll.
- Bảo toàn nhập tay làm fallback — admin vẫn sửa được từng ô khi auto-harvest miss.

### 2026-05-18 — v0.1 (initial)

- Tạo bảng `ui_labels` + `ui_label_history` + migration `0008_ui_labels`.
- Thêm permission `UI_LABEL_MANAGE`.
- Router `/api/v1/ui-labels` với 9 endpoint (list, coverage, bulk, patch, clear-stale, history, rollback, bundle, report-mismatch).
- Settings → tab "UI Labels ChatGPT" với coverage matrix, inline edit, stale banner, harvest snippet.
- Extension v0.2.0 — wire DB lookup vào 10+ helper sites; self-heal mismatch report; alarm refresh 15 phút.
