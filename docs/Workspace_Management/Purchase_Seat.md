# Use Case: Purchase Seat

**Description:** Admin yêu cầu Extension tăng số seat của workspace ChatGPT Business thêm `quantity` slot (mặc định 1) bằng cách tự thao tác trên trang `/admin/billing?tab=plan` qua 2 modal review liên tiếp. Từ ext v0.5.1, extension **tự click final-charge button** ("Thêm người dùng") để hoàn tất giao dịch — KHÔNG còn dừng ở "Tiếp tục" như v0.5.0. Sanity check `quantity` trong modal trước khi click để tránh charge sai.

**Precondition:** Admin đã login Dashboard với permission `BILLING_PAY` (super-admin). ChatGPT Business workspace đã được kết nối và admin đã đăng nhập ChatGPT trong cùng browser với extension. Payment method đã được setup trên ChatGPT.

**Postcondition:** Modal review trên ChatGPT đã hiển thị tổng tiền và đã chuyển sang trang xác nhận thanh toán (sau click "Tiếp tục"). Admin xác nhận thủ công → ChatGPT charge tiền. Seat sẽ cập nhật trên dashboard ở chu kỳ `SYNC_BILLING` kế tiếp.

## Actors
- **Admin (super-admin với BILLING_PAY)**
- **Dashboard UI**
- **Backend API**
- **Extension**
- **ChatGPT Business UI** (out-of-band: admin xác nhận payment cuối)

## Data Entities
- **QueueItem** (type=`PURCHASE_SEAT`, payload `{quantity}`)
- **AuditLog** (action=`PURCHASE_SEAT_QUEUED`)
- **WorkspaceBilling** (cập nhật seat_total sau SYNC_BILLING kế tiếp)

## Flows

### MAIN
1. Admin bấm nút "Mua thêm seat" trên Dashboard, nhập `quantity` (1-20).
2. Dashboard POST `/api/v1/workspaces/{id}/purchase-seat` body `{quantity}`.
3. Backend kiểm tra permission `BILLING_PAY`. Dedup: nếu đã có task PURCHASE_SEAT `PENDING`/`IN_PROGRESS` cho workspace → trả task hiện tại (`deduplicated: true`).
4. Backend tạo `QueueItem` type=`PURCHASE_SEAT`, payload `{quantity}`, log `PURCHASE_SEAT_QUEUED`. Publish SSE `task-available` cho extension.
5. Extension nhận SSE → pick task → mở admin tab (hoặc auto-create background tab) → inject content script.
6. Content script (`purchase-seat.ts`):
   1. Navigate `/admin/billing?tab=plan` (SPA pushState + popstate).
   2. Click control `billing_manage_licenses` ("Quản lý giấy phép" / "Manage licenses" / "管理许可证") → mở **modal review #1 ("Xem xét")**.
   3. Đợi modal #1 mở. Tìm input numeric (giá trị hiện tại `N`).
   4. Click nút "+" đúng `quantity` lần. Verify input tăng đều sau mỗi click — nếu không tăng sau retry → FAILED `UI_ELEMENT_NOT_FOUND`.
   5. Verify tổng cuối = `N + quantity`. Nếu mismatch → FAILED `VERIFY_FAILED`.
   6. Click control `billing_continue_button` ("Tiếp tục"). Nếu nút bị disabled → FAILED.
   7. Đợi **modal review #2 ("Quản lý chỗ ngồi")** xuất hiện (timeout 12s). Modal này hiển thị tổng tiền + breakdown + nút "Thêm người dùng".
   8. **SANITY CHECK qty**: scan text modal regex `/(\d+) suất.{0,30}bổ sung/i` (vi/en/zh). Nếu modal nói số khác với `quantity` task → STOP với `VERIFY_FAILED`, KHÔNG click charge.
   9. SCRAPE `charge_amount_text` ("Tổng đến hạn hôm nay" vd `đ2080.24`) vào task.result để audit.
   10. Click control `billing_add_user_button` ("Thêm người dùng" / "Add user" / "添加用户") — ⚠️ **CHARGE TIỀN THẬT** qua Stripe.
   11. Đợi modal đóng (10s). Nếu modal đóng → `charge_modal_dismissed: true`. Nếu còn mở → có thể ChatGPT mở 3D Secure/OTP, ghi note "admin hoàn tất xác minh thủ công".
7. Extension trả task COMPLETED với `result.data` đầy đủ field (xem API Contract).
8. Sau vài phút, admin trigger `SYNC_BILLING` từ dashboard để scrape `seat_total` mới (ChatGPT có thể cần thời gian cập nhật billing record).

### EXCEPTION: UI Changed
1. Extension không tìm thấy link "Quản lý giấy phép", input số người dùng, nút "+", hoặc nút "Tiếp tục".
2. Trả `error_code=UI_ELEMENT_NOT_FOUND` kèm hint URL hiện tại để admin debug.
3. Backend mark task `FAILED`. Dashboard hiển thị error banner. Admin có thể chạy `HARVEST_LABELS` để re-calibrate label rồi retry.

### EXCEPTION: Payment Method Missing
1. Extension đã tăng được seat trong modal nhưng nút "Tiếp tục" bị disabled (`aria-disabled=true` hoặc thuộc tính `disabled`).
2. Trả `error_code=UI_ELEMENT_NOT_FOUND` với message giải thích — thường do ChatGPT chưa có payment method hoặc tài khoản vượt cap 999 seat.
3. Admin mở ChatGPT thủ công, bổ sung payment method, rồi tạo lại task.

### EXCEPTION: Modal Did Not Open
1. Click "Quản lý giấy phép" thành công nhưng sau `MODAL_OPEN_TIMEOUT_MS` (15s) không thấy input số người dùng.
2. Trả `error_code=UI_ELEMENT_NOT_FOUND`.
3. Có thể do: (a) ChatGPT đổi UI, (b) bị chặn bởi popup khác (vd "Re-authenticate"), (c) network chậm. Admin retry.

### ALT: Concurrent Trigger Dedup
1. Admin double-click nút "Mua thêm seat" hoặc 2 admin trigger đồng thời.
2. Backend dedup: chỉ task đầu tiên được tạo, task thứ 2 trả về `{deduplicated: true, queue_item_id: <existing>}`.
3. Dashboard hiển thị cảnh báo "Đã có task mua seat đang chạy" + link tới task cũ.

## Business Rules
- **Permission:** chỉ super-admin với `BILLING_PAY` (super-admin-only permission) mới được trigger. Sub-admin KHÔNG bao giờ được mua seat.
- **Hard cap per task:** `quantity` ∈ [1, 20]. Mua nhiều hơn → chia nhiều task. Cap chống fat-finger gây overcharge (vd lỡ nhập 100 seat).
- **Auto-charge với sanity check (v0.5.1+):** Extension click luôn nút "Thêm người dùng" ở modal review #2 để hoàn tất charge — nhưng PHẢI pass sanity check `qty match modal text` trước, nếu không → STOP. Trước v0.5.1 quy tắc cũ là "TUYỆT ĐỐI KHÔNG tự confirm" đã được nới lỏng vì admin yêu cầu flow tự động trọn vẹn.
- **Dedup mandatory:** 1 workspace chỉ có 1 task PURCHASE_SEAT chạy/chờ tại 1 thời điểm. Tránh user double-click → double-charge.
- **Audit log:** mọi lần trigger ghi `PURCHASE_SEAT_QUEUED` với `actor_id`, `quantity`, `queue_item_id`. Mọi state change ghi qua `QUEUE_UPDATED:PURCHASE_SEAT`. Khi COMPLETED, `result.charge_amount_text` lưu lại số tiền charge để trace.
- **3D Secure / OTP:** nếu ChatGPT yêu cầu xác minh (mở popup mới sau click "Thêm người dùng"), modal #2 không đóng trong 10s → task vẫn COMPLETED với `charge_modal_dismissed: false` + note. Admin phải hoàn tất xác minh trên ChatGPT thủ công.
- **Anti-detection:** dùng `humanClick` + delay `400ms` giữa các click "+" để mô phỏng thao tác người dùng thật.
- **Verify mỗi click:** sau mỗi click "+", verify `input.value` đã tăng 1 — nếu kẹt 2 nhịp → fail thay vì spam click.
- **Sync sau payment:** seat_total trong DB chỉ cập nhật khi admin chạy `SYNC_BILLING` sau khi đã charge thành công. Backend KHÔNG auto-chain SYNC_BILLING sau PURCHASE_SEAT (ChatGPT cần vài phút để cập nhật billing record sau Stripe webhook).

## API Contract

### Request
```
POST /api/v1/workspaces/{workspace_id}/purchase-seat
Authorization: Bearer <admin_jwt>
Content-Type: application/json

{ "quantity": 1 }
```

### Response (201 Accepted)
```json
{
  "queue_item_id": "uuid",
  "status": "queued",
  "quantity": 1,
  "deduplicated": false
}
```

### Response (Dedup)
```json
{
  "queue_item_id": "uuid-of-existing",
  "status": "PENDING",
  "deduplicated": true
}
```

### Extension Response (qua `/queue/{id}` PATCH) — v0.5.1+
```json
{
  "status": "COMPLETED",
  "result": {
    "data": {
      "initial_seat": 13,
      "target_seat": 14,
      "quantity": 1,
      "modal_advanced": true,
      "confirm_charge_clicked": true,
      "charge_modal_dismissed": true,
      "charge_amount_text": "đ2080.24",
      "note": "Đã click 'Thêm người dùng' và modal đóng. Charge đ2080.24 đã gửi tới ChatGPT. SYNC_BILLING sau vài phút để verify seat_total mới."
    }
  }
}
```

### Response edge cases (vẫn `ok: true` để task không retry)
- **Modal #2 không xuất hiện**: `confirm_charge_clicked=false, charge_modal_dismissed=false, charge_amount_text=null`.
- **Nút "Thêm người dùng" disabled (thiếu payment method)**: `confirm_charge_clicked=false, charge_amount_text` đã scrape OK.
- **Modal #2 không đóng sau 10s (3D Secure popup)**: `confirm_charge_clicked=true, charge_modal_dismissed=false`. Admin hoàn tất xác minh thủ công.

### Response qty mismatch — `ok: false` để admin retry sau khi sync
```json
{
  "status": "FAILED",
  "error_code": "VERIFY_FAILED",
  "error_message": "Modal charge nói '2 suất bổ sung' nhưng task yêu cầu 1. Có thể seat trên ChatGPT đã đổi..."
}
```

## Files

| Layer | File | Purpose |
|-------|------|---------|
| Backend schema | [schemas.py](../../apps/api/app/schemas.py) | `PurchaseSeatIn`, `PURCHASE_SEAT_MAX_PER_TASK = 20`, `QueueType` thêm `PURCHASE_SEAT` |
| Backend router | [workspaces.py](../../apps/api/app/routers/workspaces.py) | `POST /workspaces/{id}/purchase-seat` |
| Backend permission | [queue.py](../../apps/api/app/routers/queue.py) | `_TYPE_TO_PERMISSION["PURCHASE_SEAT"] = BILLING_PAY` |
| Extension action | [purchase-seat.ts](../../apps/extension/src/content/actions/purchase-seat.ts) | DOM automation (modal + click "+") |
| Extension dispatch | [index.ts](../../apps/extension/src/content/index.ts), [runner.ts](../../apps/extension/src/background/runner.ts) | Wire task → action |
| Extension i18n | [i18n-ui.ts](../../apps/extension/src/content/i18n-ui.ts) | `billingManageLicenses`, `billingContinueButton`, `billingIncrementButton` |
| Extension messages | [messages.ts](../../apps/extension/src/shared/messages.ts) | `ExecuteActionRequest` thêm `PURCHASE_SEAT` |
| Extension version | [version.ts](../../apps/extension/src/version.ts) | v0.5.0 changelog |

## Testing

### Manual smoke test (no real money)
```powershell
# 1) Backend running on :18000, dashboard login as super-admin → có JWT.
# 2) Trigger task qua curl (substitute <jwt> + <workspace_id>):
curl.exe -X POST "http://localhost:18000/api/v1/workspaces/<workspace_id>/purchase-seat" `
  -H "Authorization: Bearer <jwt>" `
  -H "Content-Type: application/json" `
  -d '{"quantity": 1}'

# 3) Extension popup hiển thị "Đang chạy: PURCHASE_SEAT" → tab ChatGPT mở
#    /admin/billing?tab=plan → modal "Xem xét" mở → seat 13→14 → click "Tiếp tục".
# 4) Trang ChatGPT lúc này dừng ở bước xác nhận payment. KHÔNG bấm.
# 5) Cancel task hoặc đóng modal trên ChatGPT để tránh charge tiền.
```

### Edge cases cần verify (regression)
- Modal không mở sau 15s → `UI_ELEMENT_NOT_FOUND`.
- Click "+" không tăng (button disabled vì đã đạt 999 seat) → `UI_ELEMENT_NOT_FOUND` sau retry.
- Nút "Tiếp tục" bị disabled (chưa có payment method) → `UI_ELEMENT_NOT_FOUND` với message rõ ràng.
- Double-trigger trong vòng 1s → request 2 trả `deduplicated: true`.
- `quantity=21` → backend reject 422 (ge=1, le=20).
- Sub-admin không có `BILLING_PAY` → 403.

## Changelog

- **2026-05-20** (ext v0.5.0): Initial release. Backend endpoint + extension action + i18n labels + audit log. Hard cap 20/task. Dừng trước nút payment cuối (admin tự confirm).
- **2026-05-20** (ext v0.5.1): Mở rộng flow — extension tự click luôn "Thêm người dùng" ở modal #2. Thêm sanity check qty + scrape charge_amount_text.
- **2026-05-20** (ext v0.6.0): FULL payment chain cross-origin. Sau modal #2 (chỉ tạo invoice 'Đến hạn'), extension tiếp tục: navigate `?tab=invoices` → tìm row 'Đến hạn' → extract Stripe URL → background mở Stripe tab → content/stripe-invoice.ts click button 'Link' → background đợi popup checkout.link.com → content/link-checkout.ts verify amount (tolerance ±50đ) + click 'Thanh toán {amount}'. Detect OTP/3DS để stop. Manifest update: 2 content_scripts + host_permissions cho Stripe + Link.
