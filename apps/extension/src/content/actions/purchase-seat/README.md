# Logic chi tiết: `PURCHASE_SEAT` action

> **Folder:** [`apps/extension/src/content/actions/purchase-seat/`](./)
> **Trigger:** background runner gửi `ExecuteActionRequest` `{ kind: "PURCHASE_SEAT", taskId, quantity, skipToPayment? }`
> **Mục đích:** tăng số seat workspace ChatGPT Business +`quantity` slot → CHARGE TIỀN THẬT qua payment method đã lưu (Stripe + Link).
>
> **⚠️ ACTION RỦI RO NHẤT:** charge tiền thật. Sai sót = mất tiền. Có hard cap quantity=20/task + sanity check quantity-match-modal-text + dedup.

## 1. Public API

```ts
// purchase-seat/index.ts (barrel)
export { executePurchaseSeat } from "./execute-purchase-seat";

// execute-purchase-seat.ts
export async function executePurchaseSeat(
  taskId: string,
  quantity: number,
  skipToPayment = false,
): Promise<ExecuteActionResponse>
```

- `taskId`: ID task để report progress.
- `quantity`: số seat cần thêm (cap `MAX_QUANTITY=20`).
- `skipToPayment`: nếu `true` → skip Phase 1+2 (modal flow), nhảy thẳng tới invoice + payment chain. Dùng khi invoice "Đến hạn" đã tồn tại từ task trước (retry payment).

**Trả về:**
- `{ ok: true, data: { initial_seat, target_seat, quantity, modal_advanced, confirm_charge_clicked, charge_modal_dismissed, charge_amount_text, stripe_invoice_url, payment_chain_*, note } }` — kể cả khi partial success (modal advance OK nhưng payment chain fail).
- `{ ok: false, error_code: "PAGE_NOT_ADMIN" | "UI_ELEMENT_NOT_FOUND" | "VERIFY_FAILED" }` khi fail strict (vd quantity mismatch trong modal).

## 2. Use case

Dashboard admin click "Mua thêm seat" → nhập quantity → backend tạo `PURCHASE_SEAT` task.

3 mode operation:
1. **Full mode** (default `skipToPayment=false`): từ navigate `/admin/billing?tab=plan` → modal #1 (input + button +/-) → modal #2 (review charge) → click "Thêm người dùng" → tab Hoá đơn → Stripe → Link.
2. **Skip mode** (`skipToPayment=true`): invoice "Đến hạn" đã tồn tại từ task trước → bypass modal flow, navigate `/admin/billing?tab=invoices` → tìm invoice → chain Stripe + Link.
3. **Background inline mode** (`runner.ts:handlePurchaseSeatSkipMode`): tách hẳn khỏi content script, dùng `chrome.scripting.executeScript({world:"MAIN"})` inline. Mục đích: tránh CRXJS loader fail sau extension reload. **KHÔNG document trong file này** — xem [`background/runner.ts`](../../../background/runner.ts).

## 3. Cấu trúc folder (sau Pha 6)

```
purchase-seat/
├── index.ts                          # Barrel: export executePurchaseSeat
├── execute-purchase-seat.ts          # Full mode entry (~400 dòng) — Phase 1+2 modal + invoice + chain
├── execute-payment-chain-only.ts     # Skip mode entry (~100 dòng) — chỉ invoice + chain
├── constants.ts                      # MAX_QUANTITY + 4 timeout + 2 path const
├── types.ts                          # PaymentChainResultLite
├── modal1/                           # Modal "Quản lý giấy phép" (input + +/- + Tiếp tục)
│   ├── find-user-count-input.ts      # input numeric trong dialog
│   ├── find-increment-button.ts      # nút "+" — multi-strategy (aria-label / sibling / rightmost)
│   └── find-continue-button.ts       # nút "Tiếp tục"
├── modal2/                           # Modal "Quản lý chỗ ngồi" (review charge — ⚠️ TIỀN THẬT)
│   ├── find-charge-modal.ts          # heuristic: hasSeatPhrase + no numericInput + hasConfirmButton
│   ├── find-add-user-button.ts       # nút "Thêm người dùng" + fallback noCancel button cuối
│   ├── extract-seat-count.ts         # "X suất bổ sung" — sanity check quantity
│   ├── extract-charge-amount.ts      # "Tổng đến hạn hôm nay $XX" — audit log
│   └── wait-dismiss.ts               # poll modal đóng (= ChatGPT accept charge)
└── invoice/                          # Tab Hoá đơn /admin/billing?tab=invoices
    └── find-first-unpaid.ts          # findFirstUnpaidInvoice + findFirstUnpaidInvoiceStripeUrl
```

## 4. Constants (chú thích chi tiết)

```ts
BILLING_PLAN_PATH = "/admin/billing"
BILLING_PLAN_SEARCH = "?tab=plan"
POST_NAV_RENDER_MS = 2500          // SPA render delay sau pushState
MODAL_OPEN_TIMEOUT_MS = 15_000     // đợi modal #1 mở sau click "Quản lý giấy phép"
CHARGE_MODAL_TIMEOUT_MS = 12_000   // đợi modal #2 mở sau "Tiếp tục"
CHARGE_DISMISS_TIMEOUT_MS = 10_000 // đợi modal #2 đóng = ChatGPT accept charge
MAX_QUANTITY = 20                   // hard cap mirror backend PURCHASE_SEAT_MAX_PER_TASK
```

## 5. Luồng FULL MODE (executePurchaseSeat, skipToPayment=false)

```
┌─────────────────────────────────────────────────────────────────────┐
│ executePurchaseSeat(taskId, quantity, false)                        │
└─────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ Check pathname /admin       │ → fail PAGE_NOT_ADMIN
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ qty = clamp(1, MAX_Q, qty)  │ ← cap 20, ép integer
              └─────────────────────────────┘
                            │
                            ▼
          ┌─── PHASE 1: NAVIGATE + OPEN MODAL #1 ───┐
          │                                          │
          ▼                                          │
  ┌──────────────────────────────┐                   │
  │ Step 1: navigate             │                   │
  │   /admin/billing?tab=plan    │                   │
  │   pushState + popstate +     │                   │
  │   sleep 2500ms               │                   │
  └──────────────────────────────┘                   │
                            │                         │
                            ▼                         │
  ┌──────────────────────────────┐                   │
  │ Step 2: click "Quản lý       │                   │
  │   giấy phép" link            │                   │
  │   (findControlByKey)         │                   │
  └──────────────────────────────┘                   │
                            │                         │
                            ▼                         │
  ┌──────────────────────────────┐                   │
  │ Step 3: waitFor 15s          │                   │
  │   findUserCountInput()       │                   │
  │   → fail UI_ELEMENT nếu      │                   │
  │     timeout                  │                   │
  └──────────────────────────────┘                   │
                            │                         │
                            ▼                         │
  ┌──────────────────────────────┐                   │
  │ initialSeat = parseInt(      │                   │
  │   userInput.value, 10)       │                   │
  │ targetSeat = initial + qty   │                   │
  └──────────────────────────────┘                   │
          └──────────────────────────────────────────┘
                            │
                            ▼
          ┌─── PHASE 1.5: INCREMENT QTY LẦN ────────┐
          │                                          │
          │ findIncrementButton(userInput):          │
          │   1. aria-label match (Tăng/Increment)  │
          │   2. sibling buttons[len>=2]:           │
          │      a. plusByText "+"                  │
          │      b. rightmost (vị trí > input)      │
          │      c. button cuối container           │
          │                                          │
          │ for i in 0..qty:                         │
          │   before = parseInt(value)               │
          │   humanClick(incrementBtn)               │
          │   sleep 400ms                            │
          │   after = parseInt(value)                │
          │   if after !== before + 1:               │
          │     sleep 600ms retry                    │
          │     if vẫn không tăng → fail            │
          │                                          │
          │ finalSeat = parseInt(value)              │
          │ if finalSeat !== targetSeat:             │
          │   → fail VERIFY_FAILED                   │
          └──────────────────────────────────────────┘
                            │
                            ▼
          ┌─── PHASE 1.7: CLICK "TIẾP TỤC" ─────────┐
          │                                          │
          │ continueBtn = findContinueButton()       │
          │   - in dialog scope first                │
          │   - fallback findControlByKey            │
          │                                          │
          │ Check disabled (aria-disabled / attr):   │
          │   - disabled → fail UI_ELEMENT_NOT_FOUND │
          │     "có thể thiếu payment method"       │
          │                                          │
          │ humanClick(continueBtn)                  │
          │ sleep 1500ms                             │
          └──────────────────────────────────────────┘
                            │
                            ▼
          ┌─── PHASE 2: MODAL #2 REVIEW CHARGE ─────┐
          │                                          │
          │ chargeModal = waitFor 12s findChargeModal│
          │ Nếu timeout → PARTIAL SUCCESS:          │
          │   return ok=true, modal_advanced=true,   │
          │   confirm_charge_clicked=false,          │
          │   note="modal #2 không xuất hiện"       │
          │                                          │
          │ findChargeModal heuristic:              │
          │   - hasSeatPhrase (suất/seat/bổ sung)   │
          │   - NO numericInput visible              │
          │   - hasConfirmButton (Thêm người dùng)  │
          │   - Fallback: currency + confirmButton  │
          │                                          │
          │ ⚠️ SANITY CHECK #1:                      │
          │ modalText = chargeModal.textContent      │
          │ qtyInModal = extractAdditionalSeatCount  │
          │   (4 regex multi-language)               │
          │ if qtyInModal !== null && qtyInModal !== qty:│
          │   → fail VERIFY_FAILED                   │
          │     "modal nói X suất nhưng task Y"     │
          │     STOP để TRÁNH CHARGE SAI             │
          │                                          │
          │ chargeAmount = extractChargeAmountFrom   │
          │   Modal(modalText) — audit log            │
          └──────────────────────────────────────────┘
                            │
                            ▼
          ┌─── PHASE 2.5: ⚠️ FINAL CHARGE ──────────┐
          │                                          │
          │ addUserBtn = findAddUserButton(modal)    │
          │   - text "Thêm người dùng" fallback     │
          │   - fallback: button cuối modal          │
          │     (loại Hủy/Cancel + Close)            │
          │                                          │
          │ Check disabled → PARTIAL SUCCESS         │
          │   note="nút disabled, thiếu payment?"   │
          │                                          │
          │ humanClick(addUserBtn) ⚠️ TIỀN THẬT!     │
          │                                          │
          │ dismissed = waitForChargeModalDismiss    │
          │   poll 10s: modal removed/closed/hidden  │
          │                                          │
          │ if !chargeAmount:                        │
          │   return ok=true, payment_chain=false    │
          │   note="invoice tạo nhưng KHÔNG scrape   │
          │         được amount → không chain payment│
          │         (admin tự thanh toán tab Hóa đơn)│
          └──────────────────────────────────────────┘
                            │
                            ▼
          ┌─── PHASE 3: NAVIGATE TAB HÓA ĐƠN ───────┐
          │                                          │
          │ if !location.search.includes(            │
          │     "tab=invoices"):                     │
          │   pushState /admin/billing?tab=invoices  │
          │   sleep 2500ms                           │
          │ else sleep 1500ms                        │
          │                                          │
          │ stripeUrl = waitFor 12s                  │
          │   findFirstUnpaidInvoiceStripeUrl()      │
          │                                          │
          │ Nếu timeout → ok=true với note          │
          │   "ChatGPT chưa kịp tạo invoice,         │
          │    admin retry sau 30s"                 │
          └──────────────────────────────────────────┘
                            │
                            ▼
          ┌─── PHASE 4: PAYMENT CHAIN ──────────────┐
          │                                          │
          │ chrome.runtime.sendMessage({             │
          │   type: "run-payment-chain",             │
          │   options: {                             │
          │     taskId,                              │
          │     stripeInvoiceUrl: stripeUrl,         │
          │     expectedAmountText: chargeAmount,    │
          │   }                                      │
          │ })                                       │
          │                                          │
          │ Background mở Stripe tab + chain Link    │
          │   popup (xem background/payment-chain.ts)│
          │                                          │
          │ chainResult = { stage, ok,               │
          │   stripe_result, link_result }           │
          │                                          │
          │ Nếu sendMessage throw → ok=true,         │
          │   note="lỗi gửi run-payment-chain,       │
          │         admin thanh toán thủ công"      │
          └──────────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ return ok=true, data={      │
              │   initial_seat, target_seat,│
              │   quantity,                 │
              │   modal_advanced=true,      │
              │   confirm_charge_clicked,   │
              │   charge_modal_dismissed,   │
              │   charge_amount_text,       │
              │   stripe_invoice_url,       │
              │   payment_chain_*,          │
              │   note                      │
              │ }                           │
              └─────────────────────────────┘
```

## 6. Luồng SKIP MODE (executePaymentChainOnly)

Khi `skipToPayment=true`, hàm `executePurchaseSeat` delegate ngay tới `executePaymentChainOnly`:

```
┌─────────────────────────────────────────────────────────────┐
│ executePaymentChainOnly(taskId, qty)                         │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ Report "find_invoice"       │
              │ Navigate /admin/billing     │
              │   ?tab=invoices nếu chưa    │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ invoice = waitFor 15s       │
              │   findFirstUnpaidInvoice()  │
              │ → fail UI_ELEMENT nếu       │
              │   timeout                   │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ SAFETY CHECK:               │
              │ if !invoice.amountText:     │
              │   → fail VERIFY_FAILED      │
              │   "KHÔNG chain payment để   │
              │    tránh charge sai amount" │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ Phase 4: sendMessage        │
              │   run-payment-chain         │
              │   với amount expected       │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ return ok=true, data={      │
              │   mode: "skip_to_payment",  │
              │   payment_chain_*,          │
              │   note                      │
              │ }                           │
              └─────────────────────────────┘
```

## 7. Luồng `findFirstUnpaidInvoice` — scrape tab Hoá đơn

```
1. Scan tất cả <a href="invoice.stripe.com">
2. Cho mỗi anchor:
   - Walk parent 6 cấp tìm row chứa anchor
   - Check rowText match (đa ngôn ngữ):
     - YES "đến hạn", "đến ngày", "due", "unpaid", "past due", "chưa thanh toán", "未付款", "未支付", "逾期"
     - NO "đã thanh toán", "paid", "已付款", "已支付"
   - Nếu match: extract amount regex:
     /(\d{1,3}(?:[.,]\d{3}){1,3}(?:[.,]\d{1,2})?)\s*[₫đ]/
     return { url, amountText }
3. Fallback nếu KHÔNG row nào "Đến hạn": return anchor đầu tiên với amountText=null
   (caller phải check amountText và skip nếu null)
```

## 8. Luồng `findChargeModal` — detect modal #2

```
1. Scan dialogs đang mở:
   document.querySelectorAll('[role="dialog"], [role="alertdialog"],
     [aria-modal="true"], [data-state="open"]')

2. Cho mỗi dialog, check 3 điều kiện:
   - hasSeatPhrase: regex match "suất ... bổ sung" / "additional seat"
     / "additional user" / "bổ sung" / "额外" / "附加"
   - numericInputs.length === 0 (modal #2 KHÔNG còn input số)
   - hasConfirmButton: queryByAnyText("button", billingAddUserButton, dialog)

3. Nếu cả 3 → return dialog
4. Fallback: hasCurrency (₫/đ/$/¥ + số) + hasConfirmButton + no numericInput
5. Cuối cùng: return null
```

## 9. Selectors & i18n

### Modal #1 — "Quản lý giấy phép"
- Link mở modal: DB key `billing_manage_licenses`. Text fallback: "Quản lý giấy phép", "Manage licenses", "管理许可证".
- Input numeric: scan dialog tìm `input` với `value` match `^\d{1,3}$`.
- Nút "+": multi-strategy (aria-label vi/en/zh / sibling / rightmost).
- Nút "Tiếp tục": DB key `billing_continue_button`. Text: "Tiếp tục", "Continue", "继续".

### Modal #2 — "Quản lý chỗ ngồi"
- Modal: heuristic hasSeatPhrase + no numericInput + hasConfirmButton.
- Sanity check: regex `(\d) suất bổ sung` / `(\d) additional seat` / `add (\d) seat` / `添加(\d)个用户`.
- Charge amount: regex `tổng đến hạn hôm nay (\$XX)` / `total due today (\$XX)` / fallback currency.
- Nút "Thêm người dùng": text "Thêm người dùng", "Add users", "Add seat", "添加用户".

### Tab Hoá đơn
- Tab nav: DB key `tab_billing_invoices`. Text: "Hoá đơn", "Invoices", "账单".
- Stripe URL: `<a href="invoice.stripe.com/...">`.
- Status "Đến hạn": regex đa ngôn ngữ "đến hạn|due|unpaid|past due|chưa thanh toán|未付款|未支付|逾期".

## 10. Payment Chain (Phase 4) — không thuộc folder này

Phase 4 do `background/payment-chain.ts` xử lý. Flow tổng quát:
1. `chrome.tabs.create({ url: stripeInvoiceUrl })`.
2. Content script `stripe-invoice.ts` (manifest match `invoice.stripe.com`) inject.
3. Background gửi `STRIPE_CLICK_LINK` → content tìm button "Link" + click.
4. ChatGPT mở popup `checkout.link.com`.
5. Content script `link-checkout.ts` inject.
6. Background gửi `LINK_CONFIRM_PAYMENT` với `expectedAmountText` → content sanity check amount + click "Thanh toán {amount}".
7. **TIỀN THẬT BỊ TRỪ**.

> Chi tiết Stripe + Link content scripts xem riêng — không thuộc scope folder `purchase-seat/`.

## 11. Lịch sử sửa lỗi & quyết định thiết kế

### Timeline đầy đủ (từ CHANGELOG)

#### Pre-v0.5.x — action chưa tồn tại
- Action `PURCHASE_SEAT` không có trong v0.1.0 release. Workspace admin phải mua seat thủ công trên ChatGPT.

#### v0.5.x (không thấy trong CHANGELOG hiện tại — có thể bị truncate)
- Action `PURCHASE_SEAT` ra mắt. Flow ban đầu: DỪNG sau "Tiếp tục" để admin tự confirm modal #2.
- **v0.5.1 BREAKING:** extension click luôn tới "Thêm người dùng" → flow automation hơn nhưng RỦI RO TIỀN nếu task tạo nhầm.
- Mitigation: hard cap `MAX_QUANTITY=20`, dedup, audit log, sanity check quantity-match-modal-text trước click.

#### **v0.6.0 → v0.6.2 (2026-05-20) — 🔴 Payment chain automation (Phase 4)**
- Trước v0.6.0: extension chỉ click "Thêm người dùng" → invoice tạo "Đến hạn" → ADMIN PHẢI THỦ CÔNG mở tab Hoá đơn + click "Xem" + thanh toán Stripe + click "Link" + xác nhận popup.
- **v0.6.0:** thêm Phase 3 (tab Hoá đơn scrape) + Phase 4 (chain Stripe + Link). Sau khi click "Thêm người dùng", extension tự:
  1. Navigate `/admin/billing?tab=invoices`.
  2. `findFirstUnpaidInvoiceStripeUrl()` → extract URL invoice "Đến hạn" mới tạo.
  3. Send `run-payment-chain` message → background mở Stripe tab.
  4. Stripe content script click "Link" → popup `checkout.link.com`.
  5. Link content script verify amount + click "Thanh toán" → **TIỀN THẬT BỊ TRỪ**.
- **v0.6.1:** thêm `humanClick` double-fire fix (cũng ảnh hưởng PURCHASE_SEAT: nút "+" có thể click 2 lần → seat tăng gấp đôi).
- **v0.6.2:** skip mode `skipToPayment=true` — khi invoice "Đến hạn" đã tồn tại từ task trước (vd payment chain fail), retry payment chỉ cần chạy Phase 3+4, bỏ Phase 1+2 modal.

#### Background inline mode (không bump version)
- Sau v0.6.2, phát hiện skip mode vẫn fail khi extension reload (CRXJS loader chưa inject content script kịp).
- **Fix `runner.ts:handlePurchaseSeatSkipMode`:** dùng `chrome.scripting.executeScript({ world: "MAIN" })` inline scrape invoice URL + amount → KHÔNG depend content script. Bypass hoàn toàn dispatcher.
- Code này nằm trong [`background/runner.ts:784`](../../../background/runner.ts#L784) — không thuộc folder `purchase-seat/`.

### Bảng tóm tắt

| Version | Loại | Tóm tắt |
|---------|------|---------|
| v0.5.x | feature | Release action `PURCHASE_SEAT` (DỪNG sau Tiếp tục) |
| **v0.5.1** | **🔴 BREAKING** | **Auto-click "Thêm người dùng" — full automation (rủi ro tiền)** |
| **v0.6.0** | **🔴 feature** | **Payment chain Phase 3+4 (Stripe + Link auto)** |
| v0.6.1 | fix | `humanClick` double-fire (nút "+" click 2 lần → seat 2x) |
| v0.6.2 | feature | Skip mode (retry payment chỉ Phase 3+4) |
| (post-v0.6.x) | fix | Background inline mode cho skip — bypass content script |

> **🔥 Symptom debug nhanh:**
> - Seat tăng SAI số (vd qty=5 nhưng cuối seat tăng 10) → `humanClick` double-fire regression — verify `human.ts` chỉ gọi `el.click()` native.
> - Modal #1 không mở sau click "Quản lý giấy phép" → check ChatGPT đổi text link (vd "Manage seats" thay "Manage licenses"). Update `TEXT_FALLBACKS.billingManageLicenses` hoặc DB ui_labels.
> - `VERIFY_FAILED` "modal nói X suất bổ sung nhưng task Y" → race condition: có task khác đang chạy giữa Phase 1+2 → seat trên ChatGPT đổi. STOP để tránh charge sai. Dashboard dedup nên hiếm gặp.
> - Modal #2 không mở sau Tiếp tục → ChatGPT có thể đã gộp 1 modal. Partial success returned, admin tự click "Thêm người dùng" thủ công.
> - Nút "Thêm người dùng" disabled → ChatGPT báo "thiếu payment method" hoặc cap. Admin verify payment method có chưa.
> - Payment chain fail stage="stripe_load" → CSP block extension trên `invoice.stripe.com`. Verify content_scripts manifest match domain.
> - Payment chain fail stage="link_amount_mismatch" → Stripe charge amount khác `expectedAmountText` scraped từ modal — KHÔNG click "Thanh toán" để tránh charge sai. Admin manual.
> - Invoice "Đến hạn" không tìm thấy sau Phase 2.5 → ChatGPT chưa kịp tạo invoice (1-30s lag). Admin retry với `skipToPayment=true` sau 30s.

## 12. Fail mode & error code

### Full mode
| Mã | Khi nào | Cách fix |
|----|---------|----------|
| `PAGE_NOT_ADMIN` | URL không chứa `/admin` | Mở `chatgpt.com/admin/billing` thủ công |
| `UI_ELEMENT_NOT_FOUND` (no manage link) | Link "Quản lý giấy phép" không có | Verify URL `?tab=plan` + text fallback |
| `UI_ELEMENT_NOT_FOUND` (no input numeric) | Modal #1 không mở sau 15s | ChatGPT đổi UI dialog |
| `UI_ELEMENT_NOT_FOUND` (no increment) | Không tìm thấy nút "+" | Update `findIncrementButton` strategies |
| `UI_ELEMENT_NOT_FOUND` (no continue) | Nút "Tiếp tục" không có | Update `TEXT_FALLBACKS.billingContinueButton` |
| `UI_ELEMENT_NOT_FOUND` (continue disabled) | Thiếu payment method hoặc vượt cap | Admin add payment method |
| `VERIFY_FAILED` (final seat mismatch) | Sau qty click "+", seat không đạt target | Race condition hoặc nút "+" tìm sai element |
| **`VERIFY_FAILED` (quantity mismatch in modal #2)** | **Sanity check fail — modal nói X nhưng task Y** | **🛑 STOP — KHÔNG charge. Verify dashboard task quantity** |

### Skip mode
| Mã | Khi nào | Cách fix |
|----|---------|----------|
| `UI_ELEMENT_NOT_FOUND` (no invoice) | Invoice "Đến hạn" không có sau 15s | Invoice đã paid, hoặc ChatGPT đổi UI |
| `VERIFY_FAILED` (no amount) | Tìm thấy URL Stripe nhưng KHÔNG scrape amount | KHÔNG chain để tránh charge sai. Admin manual thanh toán |

### Partial success (ok=true với note)
- Modal #2 không mở sau Tiếp tục → admin tự click
- Nút "Thêm người dùng" disabled → admin verify payment method
- `chargeAmount` không scrape được → admin tự thanh toán tab Hoá đơn
- Invoice không tìm thấy sau click → admin retry sau 30s
- `sendMessage` payment chain throw → admin manual thanh toán

## 13. Test thủ công

```
1. Test full mode 1 seat:
   - Workspace business plan với payment method valid
   - Dashboard tạo PURCHASE_SEAT task quantity=1
   - Verify console:
     - "[autogpt-purchase-seat] initial=13, target=14 (+1)"
     - "[autogpt-purchase-seat] modal#2 sẵn sàng: qty_in_modal=1, amount=$XX"
   - Verify ChatGPT /admin/billing?tab=plan: seat tăng từ 13 → 14
   - Verify ChatGPT /admin/billing?tab=invoices: invoice "Đến hạn" mới
   - Verify Stripe tab mở rồi đóng (Link popup hoàn tất)
   - Verify dashboard task COMPLETED với charge_amount_text + payment_chain_ok=true

2. Test cap quantity:
   - Dashboard tạo task quantity=999
   - Verify backend reject hoặc extension clamp về 20

3. Test sanity check quantity mismatch:
   - Tạo task quantity=3
   - Trước khi modal #2 mở, manually click "+" 2 lần trên ChatGPT
   - Verify VERIFY_FAILED "modal nói 5 suất bổ sung nhưng task yêu cầu 3"

4. Test skip mode:
   - Task trước fail ở Phase 4, invoice "Đến hạn" tồn tại
   - Tạo task PURCHASE_SEAT với skipToPayment=true, quantity (ignore)
   - Verify executePaymentChainOnly chạy → Stripe + Link

5. Test payment chain fail:
   - Block invoice.stripe.com bằng firewall
   - Verify task ok=true với payment_chain_ok=false + stage info
   - Verify invoice vẫn "Đến hạn" — admin retry với skipToPayment

6. Test partial success:
   - Click "Tiếp tục" nhưng manually đóng modal #2 trước extension click
   - Verify task ok=true với confirm_charge_clicked=false + note rõ ràng
```
