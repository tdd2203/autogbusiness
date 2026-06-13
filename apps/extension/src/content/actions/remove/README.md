# Logic chi tiết: `REMOVE_MEMBER` action

> **Folder:** [`apps/extension/src/content/actions/remove/`](./)
> **Trigger:** background runner gửi `ExecuteActionRequest` `{ kind: "REMOVE_MEMBER", taskId, email }`
> **Mục đích:** xoá (remove) 1 thành viên đang active khỏi workspace ChatGPT Business.

## 1. Public API

```ts
// remove/index.ts (barrel)
export { executeRemove } from "./execute-remove";

// execute-remove.ts
export async function executeRemove(
  taskId: string,
  email: string,
): Promise<ExecuteActionResponse>
```

- `taskId`: ID task để report progress.
- `email`: email member cần xoá.

**Trả về:**
- `{ ok: true, data: { email } }` khi thành công.
- `{ ok: false, error_code, error_message }` khi fail (mã: `PAGE_NOT_ADMIN`, `UI_ELEMENT_NOT_FOUND`, `VERIFY_FAILED`).

## 2. Use case

Dashboard admin chọn member → action "Xoá khỏi workspace" → backend tạo `REMOVE_MEMBER` task với email → extension nhận qua SSE → thực thi.

**Chỉ áp dụng cho member status `active`** (đang trong tab "Người dùng"). Pending invite (tab "Lời mời") dùng `REVOKE_INVITES` action riêng — xem [`../revoke/README.md`](../revoke/README.md).

## 3. Luồng xử lý

```
┌─────────────────────────────────────────────────────────────────┐
│ executeRemove(taskId, email)                                    │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ Check pathname /admin       │
              └─────────────────────────────┘
                            │
                            ▼ (PASS)
              ┌─────────────────────────────┐
              │ Report "navigating"         │
              │ clickTabAndWait(            │  ← (v0.6.11) đảm bảo tab "Người dùng" active
              │   "tab_active_members",     │    REMOVE chỉ làm được trên active list,
              │   ..., 800ms)               │    KHÔNG phải tab Lời mời/Yêu cầu
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ Report "searching"          │
              │ filterAndFindRow(email)     │  ← (v0.6.11) type email vào ô "Lọc theo tên"
              │                             │    → đợi 600ms debounce → waitFor row 4s
              └─────────────────────────────┘
                            │
                            ▼
                   row === null ?
                            │
              ┌── YES ──────┴────── NO ───┐
              ▼                              ▼
   return UI_ELEMENT_NOT_FOUND   ┌─────────────────────────────┐
                                  │ findRowMenuButton(row)      │  ← từ ../member-row
                                  └─────────────────────────────┘
                                              │
                                              ▼
                                     menuBtn null?
                                              │
                                  ┌── YES ────┴──── NO ──┐
                                  ▼                       ▼
                       return UI_ELEMENT_NOT_FOUND  ┌──────────────────────┐
                                                     │ humanClick(menuBtn)  │
                                                     └──────────────────────┘
                                                                │
                                                                ▼
                                                     ┌──────────────────────────────┐
                                                     │ waitFor 5000ms:              │
                                                     │   removeItem =               │
                                                     │     querySelectorFirst(      │
                                                     │       SELECTORS.removeMenuItem│
                                                     │     )                        │
                                                     │     ?? queryByText menuitem  │
                                                     │     theo dbRemove + fallback │
                                                     └──────────────────────────────┘
                                                                │
                                                                ▼
                                                       removeItem null?
                                                                │
                                                  ┌── YES ──────┴──── NO ──┐
                                                  ▼                          ▼
                                       reportLabelMismatch       ┌──────────────────────┐
                                       return UI_ELEMENT         │ humanClick(removeItem)│
                                                                  └──────────────────────┘
                                                                              │
                                                                              ▼
                                                                  ┌──────────────────────────┐
                                                                  │ waitFor 5000ms:          │
                                                                  │   confirmBtn = button    │
                                                                  │   trong dialog confirm    │
                                                                  │   theo dbConfirm +        │
                                                                  │   fallback                │
                                                                  └──────────────────────────┘
                                                                              │
                                                                              ▼
                                                                  ┌──────────────────────────┐
                                                                  │ Report "confirming"      │
                                                                  │ humanClick(confirmBtn)   │
                                                                  └──────────────────────────┘
                                                                              │
                                                                              ▼
                                                                  ┌──────────────────────────┐
                                                                  │ Report "verifying"       │
                                                                  │ waitFor 10s:             │
                                                                  │   findMemberRow(email)   │
                                                                  │     === null             │
                                                                  │   (row biến mất?)        │
                                                                  └──────────────────────────┘
                                                                              │
                                                                              ▼
                                                                       verifyOk?
                                                                              │
                                                                  ┌── YES ────┴──── NO ────┐
                                                                  ▼                          ▼
                                                          clearMemberFilter()   ┌──────────────────────┐
                                                          return ok: true       │ clearMemberFilter()  │
                                                                                  │ return VERIFY_FAILED │
                                                                                  └──────────────────────┘
```

> **Lưu ý quan trọng (v0.6.11):**
> Filter input vẫn đang giữ giá trị search trong lúc verify → nếu row biến mất khỏi DOM khi filter đang active = xoá thật sự thành công (KHÔNG phải do scroll out viewport). Nếu chỉ scroll-find như trước v0.6.11, row có thể bị scroll out → verify false-positive.
>
> Sau verify (success hay fail), LUÔN `clearMemberFilter` để list về trạng thái đầy đủ — UX nhất quán cho user mở tab admin lên không bị stuck ở filter "yaakovajax0054".

## 4. Cấu trúc folder

```
remove/
├── index.ts                # Barrel: export executeRemove
├── execute-remove.ts       # Entry point — tab nav + filter + menu + confirm + verify (~155 dòng)
└── member-filter.ts        # Helpers v0.6.11 cho ô "Lọc theo tên" (~60 dòng)
                            #   - findMemberFilterInput (private)
                            #   - filterAndFindRow (export, fallback scroll-find nếu input null)
                            #   - clearMemberFilter (export, best-effort)
```

**Imports chính:**
- `humanClick`, `humanType`, `querySelectorFirst`, `waitFor`, `queryByText` từ [`../../human.ts`](../../human.ts)
- `SELECTORS`, `TEXT_FALLBACKS` từ [`../../selectors.ts`](../../selectors.ts)
- `clickTabAndWait` từ `../sync` (folder sync sẽ tạo ở Pha 4)
- `findMemberRow`, `findRowMenuButton` từ `../member-row.ts` (shared)
- `dbLabelsFor`, `reportLabelMismatch` từ [`../../../shared/ui-labels.ts`](../../../shared/ui-labels.ts)

## 5. Selectors & i18n

### Ô "Lọc theo tên" (v0.6.11 mới)
- DB key: chưa calibrate (selector hardcoded trong `SELECTORS.memberFilterInput`).
- Pattern: `input[type="search"]` + placeholder/aria-label `Lọc`/`Filter`/`筛选`/`过滤` (vi/en/zh).
- Fallback theo placeholder attribute vì ChatGPT chưa có `data-testid` trên input này.

### Menu item "Loại bỏ thành viên"
- DB key: `menu_remove_member`, page `/admin/members`.
- Text fallback (`TEXT_FALLBACKS.removeMenuItem`): "Loại bỏ thành viên", "Remove member", "Remove", "Xoá", "Xóa thành viên", "移除成员", "删除成员".

### Confirm button trong dialog
- DB key: `confirm_remove_button`, page `/admin/members`.
- Text fallback (`TEXT_FALLBACKS.confirmRemoveButton`): "Loại bỏ", "Remove", "Confirm", "Xác nhận", "Đồng ý", "移除", "确认".

## 6. Lịch sử sửa lỗi & quyết định thiết kế

### Timeline đầy đủ (từ CHANGELOG)

#### v0.1.0 (2026-05-18) — release đầu
- Action `REMOVE_MEMBER` ra mắt. Flow đơn giản: `findMemberRow` → click "..." → click "Remove" → confirm → verify.
- Phụ thuộc vào DOM hiện tại — không scroll động.

#### v0.2.0 (2026-05-18) — wire DB label lookup
- Thêm DB lookup cho `menu_remove_member` + `confirm_remove_button` qua [`dbLabelsFor`](../../../shared/ui-labels.ts).

#### v0.4.4 (2026-05-19) — text mapping mới
- ChatGPT đổi UI invite dialog 3-column → row menu chỉ còn `"Change seat type"` + `"Remove member"`.
- Update `TEXT_FALLBACKS.removeMenuItem` thêm variant: `"Remove member"`, `"移除成员"`, `"删除成员"`.

#### v0.4.20 (2026-05-19) — DB sync sau REMOVE_MEMBER COMPLETED
- **Bug:** trước v0.4.20, extension xoá member trên ChatGPT thành công nhưng **DB không update** → dashboard hiển thị member vẫn active tới khi `SYNC_DATA` chạy.
- **Fix backend** [`update_task`](../../../../../api/app/routers/queue.py): khi `REMOVE_MEMBER` chuyển sang `COMPLETED` → `Member.status = 'removed'` ngay.

#### **v0.6.11 (2026-05-20) — 🔴 FIX MISS ROW: search qua ô "Lọc theo tên"**
- **User request (kèm ảnh ChatGPT `/admin/members` tab Người dùng):**
  > "khi thực hiện xóa bất kì user nào thì tìm kiếm người dùng xong rồi thực hiện xóa loại bỏ thành viên"
- **Root cause:** `executeRemove` cũ chỉ gọi `findMemberRow(email)` trên DOM hiện tại. Khi workspace > 50 member, row cần xoá có thể chưa scroll vào viewport (ChatGPT virtualize list) → trả `null` → `UI_ELEMENT_NOT_FOUND`. User phải tự cuộn tới row trước khi extension chạy được.
- **Fix:** thêm 2 bước **TRƯỚC** flow cũ:
  1. `clickTabAndWait('tab_active_members')` — đảm bảo đang ở tab Người dùng. Best-effort, không fail nếu tab button không có (có thể đã active sẵn).
  2. `filterAndFindRow(email)` — type **local-part email** (phần trước `@`) vào input "Lọc theo tên" → đợi ChatGPT debounce filter (~600ms) → `waitFor` row khớp tới 4s. Filter zoom thẳng vào 1 row duy nhất, **KHÔNG cần scroll**.
- Sau khi xoá xong verify (member biến mất khỏi list đã filter), **CLEAR filter input** để list về full state (user mở tab admin lên thấy toàn bộ member, không bị stuck ở state filter).
- **Tại sao type local-part chứ không full email?** ChatGPT filter match trên cả tên + email; dùng prefix `yaakovajax0054` đủ unique mà tránh case input có maxlength giới hạn ký tự đặc biệt (`@` / `.`).
- **Fallback** (nếu không tìm được filter input — vd workspace < 10 member ChatGPT không render filter): rơi về scroll-find cũ (`findMemberRow` trực tiếp). KHÔNG hard-fail.
- File đã đổi: [`selectors.ts`](../../selectors.ts) (thêm `memberFilterInput`), [`remove.ts` cũ](./) (`filterAndFindRow` + `clearMemberFilter` + tab navigate).

### Bảng tóm tắt

| Version | Loại | Tóm tắt |
|---------|------|---------|
| v0.1.0 | feature | Release action `REMOVE_MEMBER` |
| v0.2.0 | feature | Wire DB lookup `menu_remove_member` + `confirm_remove_button` |
| v0.4.4 | fix | Text mapping "Remove member" (UI mới) |
| v0.4.20 | fix | DB sync `Member.status='removed'` sau COMPLETED |
| **v0.6.11** | **🔴 fix** | **Filter qua ô "Lọc theo tên" trước khi xoá (fix miss row list dài)** |

> **🔥 Symptom debug nhanh:**
> - `UI_ELEMENT_NOT_FOUND` "Không tìm thấy row của member X" trên workspace > 50 member → có thể `findMemberFilterInput` không match được ô filter mới. Kiểm tra `SELECTORS.memberFilterInput` (`input[type="search"]` + placeholder vi/en/zh) còn đúng không.
> - Filter input dirty sau task xong (UI ChatGPT vẫn show filter applied) → `clearMemberFilter` không xoá được vì dùng nativeSetter không match React state. Có thể cần fire thêm `keydown`/`keyup` events.
> - `REMOVE_MEMBER` COMPLETED nhưng dashboard vẫn show active → backend handler `update_task` không update `Member.status='removed'` — kiểm tra [`queue.py`](../../../../../api/app/routers/queue.py).
> - Menu mở nhưng không có item "Remove" → ChatGPT đổi text menu hoặc đổi role attribute từ `menuitem` sang khác → cần update `SELECTORS.removeMenuItem` hoặc DB ui_labels.
> - `VERIFY_FAILED` "Member vẫn còn trong danh sách" sau confirm Remove → ChatGPT có thể yêu cầu OTP/2FA cho destructive action → manual remove.

## 7. Fail mode & error code

| Mã | Khi nào xảy ra | Cách fix |
|----|----------------|----------|
| `PAGE_NOT_ADMIN` | URL hiện tại không chứa `/admin` | Mở `chatgpt.com/admin/members` thủ công |
| `UI_ELEMENT_NOT_FOUND` (no row) | Email không có trong list (đã xoá, đang ở tab khác, hoặc workspace lớn + filter input miss) | Sync trước → verify member còn active. Update filter selector nếu cần. |
| `UI_ELEMENT_NOT_FOUND` (no menu button) | Row có nhưng không có "..." menu | ChatGPT đổi UI row → check `findRowMenuButton` |
| `UI_ELEMENT_NOT_FOUND` (no remove item) | Menu mở nhưng item "Remove" không match | Update DB `menu_remove_member` qua HARVEST_LABELS hoặc text fallback |
| `UI_ELEMENT_NOT_FOUND` (no confirm) | Dialog confirm không có button match | Update DB `confirm_remove_button` qua HARVEST_LABELS hoặc text fallback |
| `VERIFY_FAILED` | Click confirm nhưng row vẫn còn sau 10s | OTP/2FA challenge, hoặc ChatGPT throttle → manual remove |

## 8. Test thủ công

```
1. Mở dashboard → Workspace có > 50 member (để test filter)
2. Tạo task REMOVE_MEMBER cho 1 member ở vị trí cuối list (sẽ KHÔNG scroll thấy)
3. Verify trong DevTools Console tab ChatGPT:
   - "[autogpt-remove] không tìm được filter input — fallback scroll-find" (case workspace nhỏ)
   - HOẶC log của humanType vào filter input + sleep 600ms + waitFor row
4. Verify trên UI ChatGPT:
   - Filter input có giá trị local-part email
   - List chỉ còn 1 row match
   - Dialog confirm xuất hiện
   - Row biến mất sau confirm
   - Filter input clear, list về full
5. Verify dashboard: member status = 'removed' sau task COMPLETED (không cần đợi SYNC_DATA)
```
