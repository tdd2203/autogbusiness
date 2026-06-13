# Use Case: Sync Workspace Data

**Description:** �?ồng bộ dữ liệu thành viên và trạng thái từ ChatGPT Business UI v�? Dashboard.

**Precondition:** Admin đã đăng nhập vào Workspace ChatGPT Business. Extension đã được cài đặt và cấu hình API Key hợp lệ.

**Postcondition:** Dữ liệu Workspace (thành viên, l�?i m�?i, seat) được cập nhật đồng bộ trong Database. Nhật ký thao tác được lưu.

## Actors
- **Backend API**
- **Extension**
- **Admin**

## Data Entities
- **ActionLog**
- **PendingInvite**
- **AuditLog**
- **Member**
- **Workspace**

## Flows
### EXCEPTION: Rate Limit Exceeded
1. Extension gửi request quá nhanh (dưới 5 phút kể từ lần cuối).
2. Backend trả v�? lỗi 429 Too Many Requests.
3. Extension dừng quá trình đồng bộ và tự động lập lịch thử lại sau 5 phút.

### EXCEPTION: Invalid/Expired API Key
1. Backend phát hiện API Key không tồn tại hoặc không hợp lệ.
2. Backend trả v�? lỗi 401 Unauthorized.
3. Extension log lỗi và dừng quá trình đồng bộ, hiển thị cảnh báo cho Admin.

### ALT: Invalid Data Format
1. Extension gửi dữ liệu thiếu các trư�?ng bắt buộc (ví dụ: email member).
2. Backend trả v�? HTTP 400 Bad Request kèm chi tiết lỗi dữ liệu.
3. Extension không cập nhật trạng thái đồng bộ và ghi log lỗi.

### EXCEPTION: Authentication Failure
1. Backend nhận request nhưng thiếu hoặc sai API Key.
2. Backend trả v�? HTTP 401 Unauthorized kèm lỗi 'Invalid or missing API Key'.
3. Extension dừng đồng bộ và ghi log lỗi cục bộ.

### EXCEPTION: Extension Disconnected
Extension không kết nối được với ChatGPT Business UI. Extension gửi thông báo lỗi v�? Backend. Dashboard hiển thị "Lỗi kết nối: Vui lòng kiểm tra trạng thái Extension". Admin cần kiểm tra lại extension trên trình duyệt.

### MAIN: Main Flow
1. Extension quét dữ liệu từ giao diện ChatGPT Business.
2. Extension đóng gói dữ liệu thành JSON theo cấu trúc quy định.
3. Extension gửi POST request tới /api/v1/workspace/sync với header X-API-KEY.
4. Backend kiểm tra tính hợp lệ của API Key và Rate Limit (1 lần/5 phút).
5. Backend kiểm tra dữ liệu payload (đặc biệt là email và seat logic).
6. Backend cập nhật các bảng workspaces, members, pending_invites với dữ liệu mới nhất.
7. Backend tạo bản ghi trong action_logs cho sự kiện 'SYNC_DATA'.
8. Backend phản hồi 200 OK v�? Extension.

## Business Rules
- Backend phải log lại m�?i yêu cầu Sync vào bảng action_logs.
- Tổng số seat sử dụng (seat_used) không được vượt quá seat_total.
- Rate limit: 1 request mỗi 5 phút.
- Tổng số seat sử dụng không được vượt quá seat_total.
- Dữ liệu thành viên phải có email hợp lệ.
- API Key là bắt buộc trong Header để xác thực request.
- Rate limit: Extension thực hiện sync tối đa 1 lần mỗi 5 phút để tránh bị phát hiện spam.
- Dữ liệu chỉ được đồng bộ khi Admin đang đăng nhập.

## Changelog

### 2026-05-19 — Fix: locale mismatch detection + anchor-click navigation (extension v0.4.6)
- **Loại**: bugfix / UX
- **Triệu chứng**: User báo "lỗi đồng bộ thành viên" với screenshot ChatGPT đang UI English (13 members visible) nhưng workspace dashboard hiển thị "Workspace chưa có thành viên nào". Dashboard locale = `vi` (Tiếng Việt), ChatGPT locale = `en`.
- **Yêu cầu user**: "Để tránh xảy ra lỗi trong tương lai, nếu dashboard để ngôn ngữ là gì thì ngay lập tức mở setting chatgpt đổi ngôn ngữ sang ngôn ngữ cùng với setting, nếu đã đổi rồi thì bỏ qua".
- **Fix**:
  1. **Locale mismatch detection** (extension):
     - Helper mới `detectChatGPTLocale()` (`apps/extension/src/content/i18n-ui.ts`) đọc `document.documentElement.lang` → normalize về `'vi'|'en'|'zh'`.
     - `checkLocaleMatch(expected)` so sánh với expected locale → trả `{match, current, expected, hint}` với hint là instructions cho user nếu mismatch.
     - `executeSync` nhận `expectedLocale` từ payload, gọi `checkLocaleMatch` ngay đầu → log warning nếu mismatch. Khi sync return 0 row VÀ locale mismatch → error_code mới `LANGUAGE_MISMATCH` với `error_message` chứa hướng dẫn cụ thể "Avatar → Settings → Locale → chọn Tiếng Việt → reload trang".
  2. **Wire `expected_locale` từ dashboard → backend → extension**:
     - Dashboard `syncMembers` mutation map `lang` (`vi`|`zh-CN`) → `expected_locale` (`vi`|`zh`) và gửi qua query param.
     - Backend `POST /workspaces/{id}/sync` nhận `expected_locale: str | None` query param, normalize, ghi vào `QueueItem.payload`.
     - Runner `taskToRequest` trích `payload.expected_locale`, gắn vào `SYNC_DATA` message với key `expectedLocale`.
     - `messages.ts` `SYNC_DATA` thêm field `expectedLocale?: 'vi'|'en'|'zh'|null`.
  3. **Sync navigation cải tiến**: ưu tiên click `<a href="/admin/members">` trong sidebar (Next.js router catches reliably) trước khi fallback `pushState`. Khắc phục case tab đang ở `/admin/billing` mà pushState không trigger re-render.
  4. **Error message giàu hơn**: include ChatGPT locale (`detectedLocale`), URL hiện tại, và locale hint nếu mismatch → user thấy đủ context để debug.
- **⚠ Auto-switch ChatGPT locale CHƯA implement** (v0.5+): DOM ChatGPT user settings dialog (avatar → Settings → Locale) chưa được map. v0.4.6 chỉ DETECT + INSTRUCT user đổi thủ công. Tự click qua DOM rủi ro cao vì ChatGPT đổi UI thường xuyên + locale picker là modal dialog không có data-testid.
- **File đã đổi**:
  - [sync.ts](../../apps/extension/src/content/actions/sync.ts) — locale check, anchor-click nav, error_code mới.
  - [i18n-ui.ts](../../apps/extension/src/content/i18n-ui.ts) — `detectChatGPTLocale`, `checkLocaleMatch`, `ChatGPTLocale` type.
  - [messages.ts](../../apps/extension/src/shared/messages.ts) — `SYNC_DATA.expectedLocale`, `LANGUAGE_MISMATCH` error_code.
  - [runner.ts](../../apps/extension/src/background/runner.ts) — extract `expected_locale` từ payload.
  - [index.ts](../../apps/extension/src/content/index.ts) — pass `expectedLocale` vào `executeSync`.
  - [workspaces.py](../../apps/api/app/routers/workspaces.py) — `trigger_sync` nhận `expected_locale` query param.
  - [WorkspaceLayout.tsx](../../apps/web/src/components/WorkspaceLayout.tsx) — `syncMembers` gửi `expected_locale` từ `useI18n().lang`.
  - [version.ts](../../apps/extension/src/version.ts), [CHANGELOG.md](../../apps/extension/CHANGELOG.md) — bump `v0.4.6`.

### 2026-05-17 — UI fix: bỏ "↻" thừa khỏi label "Đồng bộ từ ChatGPT"
- **Loại**: UI / bugfix
- **Mô tả**: i18n string `member.syncButton` còn prefix "↻ " trong khi nút mới đã có `RefreshIcon` JSX → hiển thị "↻ ↻ Đồng bộ từ ChatGPT". Bỏ prefix khỏi label cho cả `vi.json` và `zh-CN.json`. Icon vẫn render qua JSX, label chỉ chứa text.
- **File đã đổi**: [vi.json](../../apps/web/src/i18n/locales/vi.json), [zh-CN.json](../../apps/web/src/i18n/locales/zh-CN.json).

### 2026-05-17 — UI redesign: sync banner + progress + completion
- **Loại**: UI / design system
- **Mô tả**: Nút "↻ Đồng bộ từ ChatGPT" chuyển sang `.btn .btn-ghost` với refresh icon, đặt cạnh search input trong table-head. Sync-in-progress banner dùng `.notice` (info-bg) với spinner + nội dung progress (`phase`, `current`) + nút huỷ `.btn-ghost btn-sm` viền danger. Completion banner (`TaskCompletionBanner`) sang `.notice .success` / `.notice .danger` thay panel emerald/rose cũ. Rogue invite confirm dialog không đổi (vẫn dùng `confirm(...)` với `requireType: "delete"`).
- **Logic không đổi**: `POST /api/v1/workspaces/{id}/sync?include_pending=...`, polling `recent-tasks` 2s, cancel task qua `POST /queue/{id}/cancel`, stale detection (`PENDING > 60s`/`IN_PROGRESS > 90s`) giữ nguyên.
- **File đã đổi**: [Members.tsx](../../apps/web/src/pages/Members.tsx) (`SyncProgressBanner`), [TaskCompletionBanner.tsx](../../apps/web/src/components/TaskCompletionBanner.tsx).

### 2026-05-16 — Implement: extension scraper `sync_data` (Tuần 5) ⚠�? selectors cần verify
- **Loại**: extension
- **Mô tả**: [actions/sync.ts](../../apps/extension/src/content/actions/sync.ts) scroll xuống cuối page 8 lần (load infinite scroll) → query rows → extract email/name/role per row → return list. Background nhận response → g�?i `/workspaces/{id}/members/bulk-upsert` rồi báo COMPLETED. Dedup theo email (lowercase). Parse role flexible (match "owner"/"admin"/"member" trong text).
- **File đã thêm**: [actions/sync.ts](../../apps/extension/src/content/actions/sync.ts), runner xử lý SYNC_DATA flow đặc biệt (bulk-upsert trước khi update task COMPLETED).

### 2026-05-16 — Fix: CORS cho extension origin (Tuần 4 hotfix) ✅
- **Loại**: bugfix + security
- **Mô tả**: Backend CORS chỉ allow `localhost:5173`, extension popup g�?i từ `chrome-extension://<id>` bị "Failed to fetch" do preflight 400. Thêm `allow_origin_regex=r"chrome-extension://.*"` vào CORSMiddleware. Preflight gi�? trả ACAO chính xác cho extension popup.
- **Tại sao**: Popup fetch `/api/v1/workspaces/whoami` qua React → fetch() bị browser block trước khi response v�?.
- **File đã đổi**: [main.py](../../apps/api/app/main.py).
- **Test thủ công**: `curl -X OPTIONS -H "Origin: chrome-extension://x" ...` → 200 + ACAO match.

### 2026-05-16 — Add: `GET /api/v1/workspaces/whoami` cho extension verify key (Tuần 4) ✅
- **Loại**: endpoint
- **Mô tả**: Endpoint mới cho Extension verify X-API-KEY hợp lệ + lấy thông tin workspace. Popup g�?i sau khi user paste key để hiển thị "✓ Kết nối: {tên workspace}".
- **File đã đổi**: [workspaces.py](../../apps/api/app/routers/workspaces.py).

### 2026-05-15 — Implement: bulk-upsert endpoint cho Extension (Tuần 2.3 + 2.4) ✅
- **Loại**: endpoint + security
- **Mô tả**: `POST /api/v1/workspaces/{workspace_id}/members/bulk-upsert` cho Extension đẩy danh sách member sau khi scrape. Auth qua header `X-API-KEY` với key per-workspace (sinh từ DB, không phải shared env). Upsert theo `(workspace_id, email)`. Row mới (không qua dashboard invite) có `invited_by_user_id = NULL` → chỉ super-admin thấy.
- **Per-workspace auth**: Header `X-API-KEY` → DB lookup `workspaces.extension_api_key` → trả v�? `Workspace`. URL `workspace_id` phải khớp với workspace của key (mismatch → 403). Bảng `workspaces.extension_api_key` UNIQUE.
- **Tại sao**: User yêu cầu "extension cài trên trình duyệt sẽ sinh ra API riêng để kết nối vào hệ thống". Shared `EXTENSION_API_KEY` trong env bị deprecate (config vẫn nhận để không phá .env cũ, nhưng không còn được sử dụng).
- **File đã đổi**: [members.py](../../apps/api/app/routers/members.py) (`bulk_upsert_members`), [deps.py](../../apps/api/app/deps.py) (`require_extension_workspace`), [queue.py](../../apps/api/app/routers/queue.py) (filter pick_next + verify update theo workspace), [config.py](../../apps/api/app/config.py) (EXTENSION_API_KEY → optional).
- **Tests**: [test_workspace_member.py](../../apps/api/tests/test_workspace_member.py) `test_extension_bulk_upsert_requires_correct_workspace_key`, `test_extension_queue_next_isolated_per_workspace`, `test_bulk_upsert_marks_invited_by_null_for_new_members` — pass.

