# Logic chi tiết: `SYNC_BILLING` action

> **Folder:** [`apps/extension/src/content/actions/sync-billing/`](./)
> **Trigger:** background runner gửi `ExecuteActionRequest` `{ kind: "SYNC_BILLING", taskId }`
> **Mục đích:** scrape `seat_total / seat_used / plan / billing_status / renewal_date / invoices[]` từ trang `chatgpt.com/admin/billing` và trả về để backend PATCH workspace billing fields.

## 1. Public API

```ts
// sync-billing/index.ts (barrel)
export { executeSyncBilling } from "./execute-sync-billing";

// execute-sync-billing.ts
export async function executeSyncBilling(
  taskId: string,
): Promise<ExecuteActionResponse>
```

- `taskId`: ID task để report progress.

**Trả về:**
- `{ ok: true, data: { billing: { plan, seat_total, seat_used, billing_status, renewal_date, invoices[] } } }` khi thành công (kể cả partial).
- `{ ok: false, error_code: "PAGE_NOT_ADMIN" | "UI_ELEMENT_NOT_FOUND" }` khi fail.

## 2. Use case

3 nguồn trigger `SYNC_BILLING`:
1. **Dashboard:** admin click "Cập nhật giá & ngày renew" trên trang Billing → backend tạo task.
2. **Auto chain (v0.4.12):** sau mỗi `INVITE_MEMBER` / `REMOVE_MEMBER` / `REVOKE_INVITES` COMPLETED → backend auto enqueue `SYNC_BILLING` (dedup nếu đã PENDING/IN_PROGRESS) → `workspace.seat_used` cập nhật ngay, không phải đợi admin trigger.
3. **Popup nút ↻ (v0.4.16):** popup extension hiển thị "Plan: business · Seat: N/M" + nút ↻ → click gọi `POST /api/v1/queue/sync-billing` (extension auth qua `X-API-KEY`).

## 3. Cấu trúc folder

```
sync-billing/
├── index.ts                    # Barrel: export executeSyncBilling
├── execute-sync-billing.ts     # Entry point — 2-tab orchestration (~125 dòng)
├── click-billing-tab.ts        # clickBillingTab helper + POST_NAV_RENDER_MS const (~45 dòng)
└── log-diagnostic.ts           # logBillingDiagnostic dump (~32 dòng)
```

## 4. Luồng xử lý

```
┌─────────────────────────────────────────────────────────────────┐
│ executeSyncBilling(taskId)                                       │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ Check pathname /admin       │
              └─────────────────────────────┘
                            │
                            ▼ (PASS)
              ┌─────────────────────────────┐
              │ Report "navigate"           │
              │ Nếu chưa ở /admin/billing → │
              │   pushState + popstate +    │
              │   sleep 2500ms (POST_NAV_   │
              │   RENDER_MS)                │
              │ Else sleep 800ms            │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ STEP 1: TAB "KẾ HOẠCH"      │
              │ Report "scraping" (Kế hoạch)│
              │ clickBillingTab(            │
              │   "tab_billing_plan",       │
              │   TEXT_FALLBACKS.tab        │
              │   BillingPlan               │
              │ )                           │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ scrapeBillingFromDom({      │
              │   includeInvoices: false    │
              │ })                          │
              │ logBillingDiagnostic(       │
              │   "plan-tab attempt #0"     │
              │ )                           │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ RETRY loop 6 lần (700ms):   │
              │   nếu seat_total === null   │
              │   → scrape lại + log        │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ seatFromPlan = {            │
              │   plan, seat_total,         │
              │   seat_used,                │
              │   billing_status,           │
              │   renewal_date,             │
              │   invoices: []              │  ← Quan trọng: BỎ invoices từ step 1
              │ }                           │    (scrapeInvoices() hay bắt nhầm seat
              └─────────────────────────────┘    ratio làm giá trên tab Kế hoạch)
                            │
                            ▼
              ┌─────────────────────────────┐
              │ STEP 2: TAB "HOÁ ĐƠN"       │
              │ Report "scraping" (Hoá đơn) │
              │ clickBillingTab(            │
              │   "tab_billing_invoices",   │
              │   ...                       │
              │ )                           │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ RETRY loop 6 lần (700ms):   │
              │   next = scrapeBilling      │
              │     FromDom() (full)        │
              │   nếu next.invoices.length  │
              │     > 0 → merge:            │
              │       billing = {           │
              │         ...seatFromPlan,    │
              │         invoices: next      │
              │           .invoices         │
              │       }                     │
              │     break                   │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ FAIL CHECK:                 │
              │ Nếu CẢ seat_total +         │
              │     seat_used + invoices    │
              │   đều rỗng → fail UI_ELE-   │
              │   MENT_NOT_FOUND            │
              │ (partial OK nếu có invoices │
              │   nhưng thiếu seat — đẩy    │
              │   partial vẫn hơn fail)    │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ Report "uploading"          │
              │ return { ok: true,          │
              │   data: { billing } }       │
              └─────────────────────────────┘
```

> **Lưu ý quan trọng:** scrape 2 tab vì:
> - **Tab Kế hoạch:** có seat ratio (`N/M`) + plan name + chu kỳ thanh toán, nhưng KHÔNG có bảng hoá đơn.
> - **Tab Hoá đơn:** có bảng list invoices (date, amount, status), nhưng KHÔNG có seat ratio.
>
> Nếu chỉ scrape 1 tab → mất 1 trong 2 nhóm data. Merge từ 2 tab cho đầy đủ.

## 5. Backend processing (sau khi return)

Background runner [`runner.ts:reportToBackend`](../../../background/runner.ts) detect `task.type === "SYNC_BILLING"` + `response.data.billing` → gọi `pushBillingSync(config, billing)` → backend PATCH workspace fields:
- `workspace.plan` (vd `"business"`)
- `workspace.seat_total` (vd `13`)
- `workspace.seat_used` (vd `8`)
- `workspace.billing_status` (`PAID` | `UNPAID` | `UNKNOWN`)
- `workspace.renewal_date` (ISO date)
- Insert vào `workspace_invoices` table (dedup theo `(date, amount_vnd)`)

Backend trả lại updated values → extension store vào `task.result` cho dashboard hiển thị.

## 6. Selectors & i18n

### Tab "Kế hoạch"
- DB key: `tab_billing_plan`, page `/admin/billing`.
- Text fallback (`TEXT_FALLBACKS.tabBillingPlan`): "Kế hoạch", "Plan", "Plans", "套餐", "计划".

### Tab "Hoá đơn"
- DB key: `tab_billing_invoices`, page `/admin/billing?tab=invoices` (page khác vì URL sticky).
- Text fallback (`TEXT_FALLBACKS.tabBillingInvoices`): "Hoá đơn", "Hóa đơn", "Invoices", "Bills", "账单", "发票".

### Seat ratio scraping (trong `scrapers/billing.ts`)
- Pattern `N/M`: "Đang dùng 8/13", "Sử dụng 8/13", "Using 8/13", "已使用 8/13" (vi/en/zh).
- Sanity check: `total <= 999`, `used <= 999`.
- **KHÔNG còn check `used <= total`** (v0.4.19) — over-limit là state hợp lệ.

## 7. Lịch sử sửa lỗi & quyết định thiết kế

### Timeline đầy đủ (từ CHANGELOG)

#### v0.1.0 (2026-05-18) — release đầu
- Action `SYNC_BILLING` ra mắt. Flow đơn giản: navigate `/admin/billing` → scrape DOM → return.

#### v0.4.12 (2026-05-19) — auto chain sau INVITE/REMOVE/REVOKE
- **Symptom bug:** popup hiển thị "Seat: 11/12" trong khi ChatGPT thực tế **14/13** — DB stale vì `SYNC_BILLING` chưa chạy sau loạt invite. User phải bấm "Cập nhật giá & ngày renew" thủ công.
- **Fix backend:** sau mỗi `INVITE_MEMBER` / `REMOVE_MEMBER` / `REVOKE_INVITES` COMPLETED → auto enqueue `SYNC_BILLING` (dedup nếu chưa có PENDING/IN_PROGRESS) → `workspace.seat_used` cập nhật đúng ngay.

#### v0.4.16 (2026-05-19) — popup nút ↻ refresh seat
- Popup thêm nút **↻** bên cạnh "Plan: business · Seat: N/M" → click gọi `POST /api/v1/queue/sync-billing` (extension auth) → backend dedup task → publish SSE → extension fastpoll pick → scrape `/admin/billing` → DB cập nhật.
- Popup tự re-fetch `whoami` sau 6s.
- Backend endpoint mới [`/sync-billing`](../../../../../api/app/routers/queue.py) — extension-facing, dùng `X-API-KEY` thay vì admin session, dedup nếu đã có PENDING/IN_PROGRESS.

#### **v0.4.19 (2026-05-19) — 🔴 FIX SEAT RATIO sai khi over-limit**
- **Bug:** `parseSeatRatio` trong [`scrapers/billing.ts`](../../scrapers/billing.ts) có check `used <= total`. Khi ChatGPT hiển thị "Đang dùng **14/13** giấy phép" (admin invite vượt quota), pattern match được nhưng **bị reject vì 14 > 13** → scraper bỏ qua → loop tới pattern khác → pick nhầm ratio từ vùng khác trên page (vd "11/12" từ invoice/plan info).
- **Symptom user:** dashboard hiển thị **11/12** trong khi thực tế là **14/13**.
- **Fix:** BỎ check `used <= total`. Over-limit là state hợp lệ trên ChatGPT (admin được phép invite vượt seat — sẽ tính tiền phụ vào hóa đơn kế tiếp). Chỉ giữ rule `total<=999` và `used<=999` (sanity check).
- **Bonus:** thêm keyword `đang dùng` vào pattern đầu (priority cao hơn `sử dụng` generic) + `đang sử dụng` + zh `已使用`. Match trực tiếp text ChatGPT vi "Đang dùng 14/13".

### Bảng tóm tắt

| Version | Loại | Tóm tắt |
|---------|------|---------|
| v0.1.0 | feature | Release action `SYNC_BILLING` |
| v0.4.12 | feature | Auto chain `SYNC_BILLING` sau INVITE/REMOVE/REVOKE |
| v0.4.16 | feature | Popup nút ↻ + endpoint `/sync-billing` X-API-KEY |
| **v0.4.19** | **🔴 fix** | **Bỏ rule `used<=total` — fix scrape sai khi over-limit (14/13)** |

> **🔥 Symptom debug nhanh:**
> - Seat ratio sai (lệch khỏi ChatGPT thực) → check log `[autogpt-sync-billing] plan-tab attempt #X →` xem `has_seat_ratio_pattern` có true không, `text_snippet` có chứa ratio đúng không. Có thể ChatGPT đổi text "Đang dùng" sang variant mới.
> - Invoices rỗng dù tab Hoá đơn có data → check `scrapeInvoices` regex pattern còn match table cell ChatGPT 2026 không.
> - `UI_ELEMENT_NOT_FOUND` "cả seat lẫn invoices đều rỗng" → tab Hoá đơn không click được + tab Kế hoạch không có seat ratio → ChatGPT đổi UI cả 2 tab. Verify `TEXT_FALLBACKS.tabBillingPlan` / `tabBillingInvoices`.
> - Popup ↻ click không trigger sync → check `/api/v1/queue/sync-billing` endpoint còn dedup đúng không (nếu đã có PENDING/IN_PROGRESS, dedup trả 202 nhưng không enqueue thêm).
> - `billing_status` always `UNKNOWN` → check `scrapers/billing.ts` parse trạng thái "Đã thanh toán" / "Đến hạn" — có thể ChatGPT đổi text.

## 8. Fail mode & error code

| Mã | Khi nào xảy ra | Cách fix |
|----|----------------|----------|
| `PAGE_NOT_ADMIN` | URL không bắt đầu `/admin` | Mở `chatgpt.com/admin/billing` thủ công |
| `UI_ELEMENT_NOT_FOUND` | Cả seat ratio lẫn invoices rỗng sau 6 retry mỗi tab | ChatGPT đổi UI lớn → re-harvest labels + update scraper regex |

> **Partial success** (only seat hoặc only invoices) vẫn return `ok: true` — backend chỉ update fields có data, KHÔNG xoá data cũ.

## 9. Test thủ công

```
1. Mở dashboard → Workspace có billing data
2. Tạo task SYNC_BILLING (qua nút "Cập nhật giá & ngày renew")
3. Verify trong DevTools Console tab ChatGPT:
   - "[autogpt-sync-billing] plan-tab attempt #0 → { seat: '8/13', plan: 'business', ... }"
   - "[autogpt-sync-billing] click billing tab matched= Hoá đơn ..."
   - "[autogpt-sync-billing] invoices-tab attempt #0 → { invoices_count: 3, ... }"
4. Verify dashboard sau task COMPLETED:
   - workspace.seat_total + seat_used đúng
   - workspace.plan = 'business'
   - workspace.billing_status = 'PAID' / 'UNPAID'
   - workspace.renewal_date = next billing date
   - Bảng invoices có rows mới
5. Test edge case OVER-LIMIT:
   - Invite vượt seat (vd 14/13)
   - Verify scrape `seat_used=14, seat_total=13` ĐÚNG (không bị reject)
```
