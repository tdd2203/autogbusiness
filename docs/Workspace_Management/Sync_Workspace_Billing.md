# Use Case: Sync Workspace Billing

**Description:** Tự động đồng bộ thông tin gói cước và hạn mức sử dụng (seat) từ giao diện quản trị ChatGPT Business.

**Precondition:** Admin đã đăng nhập vào Dashboard và ChatGPT Business. Extension đã được cài đặt và cấu hình API Key.

**Postcondition:** Dữ liệu Billing được đồng bộ, nếu unpaid thì Admin đã nhận được thông báo cảnh báo.

## Actors
- **Admin**
- **Dashboard UI**
- **Backend API**
- **Extension**

## Data Entities
- **ActionLogs**
- **AuditLog**
- **WorkspaceBilling**

## Flows
### ALT: Unpaid Status Detected
1. Hệ thống phát hiện billing_status là UNPAID.
2. Backend ghi nhận trạng thái PAYMENT_REQUIRED.
3. Backend kích hoạt quy trình gửi thông báo cho Admin (Email/Dashboard Alert).
4. Hệ thống yêu cầu xác nhận thủ công từ Admin để chuyển sang trang thanh toán.

### EXCEPTION: UI Changed Exception
1. Extension không tìm thấy các thành phần UI (do OpenAI thay đổi giao diện).
2. Extension dừng ngay lập tức.
3. Extension báo lỗi FAILED_UI_CHANGED về Backend.
4. Backend cập nhật trạng thái FAILED và Dashboard hiển thị cảnh báo bảo trì cho Admin.

### ALT: Rate Limit Check
1. Nếu thời gian kể từ lần sync gần nhất < 5 phút, Extension bỏ qua lượt sync này để tuân thủ quy tắc Rate limit.

### EXCEPTION: Fail-Fast on UI Change
1. Extension không tìm thấy các thành phần UI (do cấu trúc trang web thay đổi).
2. Extension dừng ngay lập tức, gửi thông báo lỗi FAILED_UI_CHANGED về Backend.
3. Backend ghi lại lỗi vào log và Dashboard hiển thị thông báo cần bảo trì Extension cho Admin.

### MAIN: MAIN
1. Extension thực hiện Polling đến Backend API (mỗi 5 phút).
2. Backend kiểm tra Rate limit (1 request/5 phút) và trả về task Sync Billing.
3. Extension điều hướng đến trang quản trị của Workspace trên ChatGPT.
4. Extension tìm kiếm và trích xuất thông tin: subscription_plan, renewal_date, seat_total, seat_used, billing_status.
5. Nếu tìm thấy thông tin: Extension gửi dữ liệu về Backend API.
6. Backend lưu vào WorkspaceBilling và tạo bản ghi AuditLog.
7. Nếu billing_status == UNPAID: Backend kích hoạt cờ PAYMENT_REQUIRED và gửi thông báo cho Admin qua Dashboard.
8. Admin nhận thông báo, nhấn nút "Thanh toán ngay" trên Dashboard.
9. Dashboard chuyển hướng (redirect) Admin đến trang thanh toán chính thức của OpenAI.

## Business Rules
- Nếu không tìm thấy element thanh toán, Extension phải dừng và báo FAILED_UI_CHANGED.
- Extension phải có độ trễ ngẫu nhiên từ 1.5s - 4s khi đọc dữ liệu billing.
- Mọi hành động thanh toán phải được Admin xác nhận thủ công trên giao diện của OpenAI.
- Nếu billing_status là UNPAID, Dashboard phải hiển thị cảnh báo đỏ và gửi thông báo cho Admin.
- Không tự động hóa các thao tác thanh toán tài chính qua Extension.
- Dữ liệu thành viên phải được kiểm tra tính hợp lệ trước khi cập nhật vào DB.
- Cơ chế Fail-Fast: Nếu không tìm thấy thành phần UI (do OpenAI thay đổi giao diện), dừng ngay lập tức và đánh dấu trạng thái FAILED_UI_CHANGED tại Backend.
- Mọi hành động đồng bộ phải tạo một bản ghi Audit Log tại Backend.
- Rate limit: 1 request mỗi 5 phút để tránh bị phát hiện spam.

## Changelog

### 2026-05-19 (v2) — Đổi nguồn fullMonthPerSlot: từ median → hoá đơn đầu chu kỳ
- **Loại**: methodology change
- **Triệu chứng**: Sau khi fix cột (commit trước), user vẫn báo "giá hiển thị vẫn sai" — ý là 2 metric card "Giá 1 slot hôm nay" (212.648 ₫) và "Giá full month/slot" (277.367 ₫).
- **Yêu cầu user**: "giá của hoá đơn ngày đầu tiên là gốc cho 1 slot để biết giá slot của tháng đó là bao nhiêu, sau đó lấy giá đó chia ra 30 ngày rồi tính" → user mental model: hoá đơn đầu chu kỳ trả gần đủ 1 tháng → coi đó là base, các hoá đơn sau là mua thêm slot mid-cycle.
- **Fix**:
  - `fullMonthPerSlot` đổi từ `median(implied_per_slot)` → `first_invoice.amount_per_slot` (= amount/slots của invoice oldest by date).
  - `price (Giá 1 slot hôm nay) = fullMonthPerSlot × (days_today / 30)` — giữ formula prorate.
  - Slot count inference (n=1..10, gần 286k nhất, range [200k,400k]) GIỮ NGUYÊN — chỉ đổi nguồn base.
  - Hint mới: "Từ hoá đơn đầu chu kỳ {date} ({amount} ÷ {slots} slot) — base 1 slot/tháng" + "{base} × {days}/30 — prorate base theo days_remaining".
- **Verify với data trong screenshot** (renewal 11/6/2026, today 19/5/2026, 23 days remaining):
  - First invoice (sorted asc) = 11/5: 573.100 ₫, 2 slots → amount_per_slot = **286.550 ₫**.
  - fullMonthPerSlot = **286.550 ₫** (trước: 277.367 — median của 8 invoice).
  - Today's price = 286.550 × 23/30 = **219.688 ₫** (trước: 212.648).
- **File đã đổi**:
  - [WorkspaceBillingPanel.tsx](../../apps/web/src/components/WorkspaceBillingPanel.tsx) — `computeTodayPerSlotPrice` rewrite + thêm `baseInvoice` field; hints mới reference base invoice cụ thể.
  - [vi.json](../../apps/web/src/i18n/locales/vi.json), [zh-CN.json](../../apps/web/src/i18n/locales/zh-CN.json) — thêm `billing.fullMonthFromFirstInvoice` + `billing.todayFromBase`.

### 2026-05-19 — Fix: cột "Giá/slot" hiển thị giá thực trả (giảm dần theo days_remaining), không phải back-calc full-month
- **Loại**: bugfix / UX
- **Triệu chứng**: Bảng lịch sử hoá đơn hiển thị cột "Giá/slot" mà các giá không phản ánh trực giác — invoice gần ngày renew lẽ ra phải có per-slot **thấp hơn** (vì prorate `days_remaining/30 < 1`), nhưng cột lại show giá fluctuate 274k–279k không có trend. User báo "trên ảnh tham chiếu giá các ngày thanh toán giảm dần nhưng tính toán đang sai".
- **Nguyên nhân**: Cột đang hiển thị `implied_per_slot = amount / (slots × days_remaining / 30)` — đây là giá **full-month back-calc**, lý thuyết constant ≈ 286k nhưng fluctuate vì rounding/tỷ giá. Đây là số dùng để tính median nội bộ, KHÔNG phải số người dùng kỳ vọng thấy ở cột invoice.
- **Fix**: Thêm field `amount_per_slot = amount / slots` (giá thực trả per-slot cho 1 invoice) vào `InvoiceBreakdown`. Cột "Giá/slot" giờ render `amount_per_slot` — giảm dần đều theo `days_remaining` (vd 11/5 = 286k → 18/5 = 221k). Tooltip giải thích cả 2 cách hiểu (raw vs full-month equivalent). Metric card "Giá full month/slot" ở trên vẫn giữ median của `implied_per_slot` — không thay đổi.
- **File đã đổi**:
  - [WorkspaceBillingPanel.tsx](../../apps/web/src/components/WorkspaceBillingPanel.tsx) — thêm `amount_per_slot` field, render cột mới, tooltip mới.
  - [vi.json](../../apps/web/src/i18n/locales/vi.json), [zh-CN.json](../../apps/web/src/i18n/locales/zh-CN.json) — thêm `billing.perSlotTooltip`.
- **Verify**: với data trong ảnh user (renewal 11/6/2026), cột mới hiển thị 286.550 → 277.427 → 277.798 → 259.109 → 242.184 → 228.373 → 230.535 → 221.128 — monotonic decrease ✅.

### 2026-05-17 — UI fix: bỏ dấu "+"/"↻" thừa khỏi label nút
- **Loại**: UI / bugfix
- **Mô tả**: Sau redesign 2026-05-17, nút "Tạo workspace" hiển thị "+ + Tạo workspace" do icon `PlusIcon` đã thêm bên cạnh label, nhưng i18n string vẫn còn prefix "+ ". Tương tự với "↻ Sync billing" → "↻ ↻ Sync billing". Bỏ prefix khỏi 4 string i18n (`workspace.createButton`, `workspace.syncBilling`, `member.inviteButton`, `member.syncButton`, `users.create`) cho cả `vi.json` và `zh-CN.json`. Icon vẫn render qua JSX, label chỉ chứa text.
- **File đã đổi**: [vi.json](../../apps/web/src/i18n/locales/vi.json), [zh-CN.json](../../apps/web/src/i18n/locales/zh-CN.json).

### 2026-05-17 — UI redesign: trang Workspaces + nút Sync billing
- **Loại**: UI / design system
- **Mô tả**: Trang Workspaces redesign — header `display-h1` + page-sub, search input filter theo name, table-card với cột `Tên / Plan / Seat / Last synced / Created / Actions`. Plan hiển thị qua `.role-tag`; nếu `billing_status == UNPAID` → kèm `.badge-danger` "Chưa thanh toán". Seat `seat_used/seat_total` font-mono. Nút "↻ Sync billing" chuyển sang `.btn .btn-ghost .btn-sm` cuối row, tooltip vẫn giải thích pipeline SYNC_BILLING.
- **Banner sau khi tạo workspace**: chuyển sang `.notice .warn` chứa code block API key + nút Copy/Close (thay panel amber cũ).
- **Logic không đổi**: `POST /api/v1/workspaces` (create), `POST /workspaces/{id}/sync-billing` (enqueue task), `triggerExtensionRun()` sau khi enqueue, polling `recent-tasks-global` 2s, `TaskCompletionBanner` cho billing completion.
- **File đã đổi**: [Workspaces.tsx](../../apps/web/src/pages/Workspaces.tsx).

### 2026-05-16 — Bugfix: dashboard auto-trigger extension
- **Bug**: Nút "↻ Sync billing" enqueue task xong **không** auto-trigger extension drain queue → user phải mở popup extension bấm "Thực hiện task đang chờ".
- **Cause**: `Workspaces.tsx` thiếu `triggerExtensionRun()` trong `onSuccess` của mutation (Members.tsx đã có cho invite/sync member).
- **Fix**: gọi `triggerExtensionRun()` ngay sau khi enqueue task ([Workspaces.tsx](../../apps/web/src/pages/Workspaces.tsx)). Bridge content script (đã có sẵn ở [dashboard-bridge.ts](../../apps/extension/src/content/dashboard-bridge.ts)) sẽ forward sang background → `runUntilIdle` chạy ngay.
- **Bỏ luôn**: `window.alert(...)` sau khi sync — đã có badge "Extension: connected/not detected" + lastRunResult ở sidebar Layout, không cần popup blocking.
- **Lưu ý**: nếu badge sidebar vẫn báo "Extension: not detected", check (a) extension đã reload sau khi build, (b) dashboard đang chạy ở `localhost:5173` hoặc `127.0.0.1:5173` (manifest content_scripts chỉ inject bridge ở 2 URL này).

### 2026-05-16 — MVP implementation (user-triggered, không auto-poll)
- **Display rule**: trên Dashboard `Workspaces`, cột Seat hiển thị `seat_used / seat_total` (vd `6/8`). Nguồn dữ liệu: trang `chatgpt.com/admin/billing`, scraping cụm "Đang dùng X/Y giấy phép".
- **Trigger**: Super-admin bấm nút "↻ Sync billing" trên hàng workspace ([Workspaces.tsx](../../apps/web/src/pages/Workspaces.tsx)). KHÔNG có auto-poll — theo nguyên tắc "thao tác như người dùng thật" đã ghi trong [background/index.ts:6-7](../../apps/extension/src/background/index.ts#L6-L7). Nếu auto-poll cần lại trong tương lai, đọc note đó trước.
- **Pipeline**:
  1. Dashboard `POST /api/v1/workspaces/{id}/sync-billing` (cần permission `WORKSPACE_SYNC_TRIGGER`) → enqueue task `SYNC_BILLING`.
  2. Extension pick task qua `GET /api/v1/queue/next`, dispatch action [`executeSyncBilling`](../../apps/extension/src/content/actions/sync-billing.ts).
  3. Action navigate `/admin/billing` (history.pushState, không full reload), gọi [`scrapeBillingFromDom`](../../apps/extension/src/content/scrapers/billing.ts).
  4. Background gọi `POST /api/v1/workspaces/billing-sync` (X-API-KEY) với data `{plan, seat_total, seat_used, billing_status, renewal_date}`.
  5. Backend cập nhật workspace + ghi audit `WORKSPACE_BILLING_SYNCED`.
- **Validation**: `seat_total` max = **999** (ChatGPT Business hard cap). Áp dụng cho cả `WorkspaceCreate`, `WorkspaceUpdate`, `BillingSyncIn` trong [schemas.py](../../apps/api/app/schemas.py).
- **Visibility**: tất cả role (super + sub-admin) đều thấy seat. Nút "Sync billing" chỉ super-admin.
- **DB**: thêm cột `billing_status`, `renewal_date`, `last_billing_synced_at` qua migration `0006_workspace_billing`.
- **Tooltip cột Seat**: hover hiển thị thời điểm `last_billing_synced_at` (hoặc "Chưa sync billing").
- **UNPAID indicator**: nếu `billing_status == "UNPAID"`, hiển thị badge đỏ "Chưa thanh toán" cạnh tên plan.
- **Chưa làm (intentional)**:
  - Chưa tự động alert/email khi `UNPAID` — chỉ hiển thị badge passive.
  - Chưa có nút "Thanh toán ngay" redirect tới OpenAI billing page.
  - Chưa rate limit per-workspace 5 phút (queue-level rate limit đã có ở runner).

