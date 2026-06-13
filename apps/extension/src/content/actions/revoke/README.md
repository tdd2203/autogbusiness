# Logic chi tiết: `REVOKE_INVITES` action

> **Folder:** [`apps/extension/src/content/actions/revoke/`](./)
> **Trigger:** background runner gửi `ExecuteActionRequest` `{ kind: "REVOKE_INVITES", taskId, emails: string[] }`
> **Mục đích:** thu hồi (revoke) các pending invite trên tab "Lời mời đang chờ xử lý" của `/admin/members`, batch nhiều email trong 1 task.

## 1. Public API

```ts
// revoke/index.ts (barrel)
export { executeRevokeInvites } from "./execute-revoke-batch";
export { revokeInvite, type RevokeResult } from "./revoke-invite";
export { revokeInvites } from "./revoke-invites-loop";
```

3 hàm public:
- `executeRevokeInvites(taskId, emails)` — **entry point từ dispatcher**. Đảm bảo navigation + tab "Lời mời" rồi gọi loop.
- `revokeInvite(email)` — revoke 1 email duy nhất. Trả `RevokeResult` (không throw).
- `revokeInvites(emails)` — loop nhiều email, gọi `revokeInvite` từng cái với delay 1-3s.

```ts
export type RevokeResult = {
  email: string;
  ok: boolean;
  reason?: string;  // có khi ok=false để debug
};
```

## 2. Use case (why)

Sync detect được **pending invite trên ChatGPT mà dashboard DB KHÔNG track** (= invite không qua dashboard, có thể do owner workspace tự mời trực tiếp trong UI ChatGPT). Dashboard là source of truth → các "rogue invite" này cần được revoke để đồng bộ.

Flow đầy đủ:
1. `SYNC_DATA` task scrape tab pending → trả về rogue email list
2. Dashboard hiển thị danh sách rogue → admin xác nhận
3. Dashboard tạo `REVOKE_INVITES` task với emails được chọn
4. Extension nhận task, gọi `executeRevokeInvites(emails)`

## 3. Luồng xử lý — `executeRevokeInvites` (entry)

```
┌─────────────────────────────────────────────────────────────────┐
│ executeRevokeInvites(taskId, emails)                            │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
                  emails.length === 0?
                            │
                ┌── YES ────┴───── NO ───┐
                ▼                          ▼
   return { ok: true,         ┌──────────────────────────────────┐
     data: { revoked: 0,      │ Check pathname /admin/members    │
     failed: 0, results: [] } │   nếu không → pushState           │
   }                          │   + sleep 1500ms                  │
                              └──────────────────────────────────┘
                                            │
                                            ▼
                              ┌──────────────────────────────────┐
                              │ findControlByKey(                │
                              │   "tab_pending_invites",          │
                              │   TEXT_FALLBACKS.tabPendingInvites,│
                              │   { page: "/admin/members" }     │
                              │ )                                │
                              └──────────────────────────────────┘
                                            │
                                            ▼
                                pendingTab === null?
                                            │
                              ┌── YES ──────┴──── NO ───┐
                              ▼                          ▼
                   return UI_ELEMENT_NOT_FOUND  ┌──────────────────────┐
                                                │ humanClick(pendingTab)│
                                                │ sleep(1500ms)         │
                                                └──────────────────────┘
                                                            │
                                                            ▼
                                                ┌──────────────────────┐
                                                │ revokeInvites(emails)│  ← loop từng cái
                                                └──────────────────────┘
                                                            │
                                                            ▼
                                                return { ok: true,
                                                  data: { revoked, failed,
                                                  results: RevokeResult[] }
                                                }
```

> **Lưu ý:** entry **KHÔNG bao giờ trả `ok: false`** trừ khi không tìm được tab pending. Mỗi email fail được capture trong `results[]` → caller (dashboard) tự decide hiển thị thế nào.

## 4. Luồng xử lý — `revokeInvite` (1 email)

```
┌─────────────────────────────────────────────────────────────────┐
│ revokeInvite(email): Promise<RevokeResult>                       │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ findMemberRow(email)        │  ← search trong DOM hiện tại
              └─────────────────────────────┘  (tab Lời mời đã active)
                            │
                            ▼
                   row === null ?
                            │
              ┌── YES ──────┴────── NO ───┐
              ▼                              ▼
   return { ok: false,            ┌──────────────────────────────┐
     reason: "Row không tìm thấy" │ findRowMenuButton(row)       │
   }                              └──────────────────────────────┘
                                              │
                                              ▼
                                     menuBtn null?
                                              │
                                  ┌── YES ────┴──── NO ──┐
                                  ▼                       ▼
                       return { ok: false }     ┌────────────────────────┐
                                                │ randomDelay(300-800)   │
                                                │ humanClick(menuBtn)    │
                                                └────────────────────────┘
                                                            │
                                                            ▼
                                                ┌────────────────────────┐
                                                │ waitFor 4000ms:        │
                                                │   findMenuItemByKey(   │
                                                │     "menu_revoke_invite"│
                                                │   )                    │
                                                └────────────────────────┘
                                                            │
                                                            ▼
                                                  revokeItem null?
                                                            │
                                            ┌── YES ────────┴──── NO ──┐
                                            ▼                            ▼
                                  document.body.click()  ┌──────────────────────────┐
                                  return { ok: false }   │ randomDelay(200-600)     │
                                                          │ humanClick(revokeItem)   │
                                                          └──────────────────────────┘
                                                                      │
                                                                      ▼
                                                          ┌──────────────────────────┐
                                                          │ sleep(800ms) + check     │
                                                          │ confirm dialog xuất hiện?│
                                                          └──────────────────────────┘
                                                                      │
                                                                      ▼
                                                          Loop qua dbConfirm + REVOKE_CONFIRM_TEXTS:
                                                          - check dialog còn không
                                                          - queryByText("button", text, dialog)
                                                          - nếu match → humanClick → break
                                                                      │
                                                                      ▼
                                                          ┌──────────────────────────┐
                                                          │ waitFor 5000ms:          │
                                                          │   findMemberRow(email)   │
                                                          │     === null             │
                                                          │   (row đã biến mất?)     │
                                                          └──────────────────────────┘
                                                                      │
                                                                      ▼
                                                          ┌── timeout ──┐
                                                          │              │
                                                          ▼              ▼
                                                  return ok: true   return { ok: false,
                                                                      reason: "row vẫn còn" }
```

## 5. Luồng xử lý — `revokeInvites` (multi-email loop)

```ts
for (const email of emails) {
  const r = await revokeInvite(email);
  results.push(r);
  if (!r.ok) console.warn(`[autogpt-revoke] FAIL ${email}: ${r.reason}`);
  await sleep(1000 + Math.floor(Math.random() * 2000));  // 1-3s anti-bot
}
return results;
```

- **KHÔNG break** khi gặp 1 email fail — vẫn tiếp tục revoke các email khác.
- Delay random 1-3s giữa các revoke để giảm pattern bot (anti-detection).
- Results trả về full list, caller tự đếm `revoked` vs `failed`.

## 6. Selectors & i18n

### Menu item "Thu hồi lời mời"
- DB key: `menu_revoke_invite`, page `/admin/members`
- Text fallback (từ [`i18n-ui.ts`](../../i18n-ui.ts) → `REVOKE_MENU_ITEM_TEXTS`):
  - VI: "Thu hồi lời mời"
  - EN: "Revoke invite", "Cancel invite"
  - ZH: "撤销邀请", "取消邀请"

### Confirm button trong dialog
- DB key: `confirm_revoke_button`, page `/admin/members`
- Text fallback (`REVOKE_CONFIRM_TEXTS`):
  - VI: "Thu hồi", "Xác nhận"
  - EN: "Revoke", "Confirm"
  - ZH: "撤销", "确认"

> Dialog confirm **có thể KHÔNG xuất hiện** với một số UI version — code handle cả 2 case: có dialog click confirm, không dialog skip thẳng tới verify row biến mất.

## 7. Code structure (sau Pha 1 refactor)

```
revoke/
├── index.ts                    # Barrel: 3 export (executeRevokeInvites + revokeInvite + revokeInvites + RevokeResult type)
├── execute-revoke-batch.ts     # executeRevokeInvites (entry, 57 dòng) — tab navigation + delegate
├── revoke-invite.ts            # revokeInvite (1 email, ~80 dòng) — menu mở + confirm dialog + verify
└── revoke-invites-loop.ts      # revokeInvites (loop, 12 dòng) — chỉ là forEach + delay
```

**Tại sao tách `revoke-invites-loop` thành file riêng?**
- File gốc `revoke-invite.ts` cũ có cả `revokeInvite` (80 dòng) lẫn `revokeInvites` (12 dòng) — 2 concern: "revoke 1 cái" vs "loop nhiều cái".
- Sau refactor, tương lai có thể thêm "revoke parallel" hoặc "revoke với rate limit" — chỉ cần thêm file mới trong folder.
- Test unit cho loop có thể mock `revokeInvite` mà không cần DOM thật.

## 8. Fail mode

| Mã / reason | Khi nào | Cách fix |
|-------------|---------|----------|
| `UI_ELEMENT_NOT_FOUND` (tab pending không có) | Trang `/admin/members` không có 3 tab Người dùng/Lời mời/Yêu cầu | Verify đang ở đúng URL, UI ChatGPT chưa đổi |
| Per-email: "Row không tìm thấy" | Email không có trong pending tab (đã được revoke trước, hoặc đã thành active member) | Bỏ qua — không phải lỗi extension |
| Per-email: "Không có nút '...'" | Row có nhưng pending invite không có menu (vd ChatGPT đổi UI) | Verify selector `findRowMenuButton` |
| Per-email: 'Menu mở nhưng không có item "Thu hồi lời mời"' | Menu mở nhưng label không match | Update `REVOKE_MENU_ITEM_TEXTS` hoặc DB `menu_revoke_invite` |
| Per-email: "Row vẫn còn sau 5s" | Click confirm nhưng ChatGPT không xoá row | Có thể ChatGPT đổi flow (vd cần OTP/2FA) → admin tự revoke thủ công |

## 9. Lịch sử sửa lỗi & quyết định thiết kế

### Timeline đầy đủ (từ CHANGELOG)

#### v0.1.0 (2026-05-18) — release đầu
- Action `REVOKE_INVITES` ra mắt cùng các action khác. Flow đơn giản: tìm row → click "..." → click "Thu hồi lời mời" → verify row biến mất.

#### v0.2.0 (2026-05-18) — wire DB label lookup
- Thêm DB lookup cho `menu_revoke_invite` và `confirm_revoke_button` qua [`dbLabelsFor`](../../../shared/ui-labels.ts).
- Trước v0.2.0: chỉ dùng hardcoded `REVOKE_MENU_ITEM_TEXTS` + `REVOKE_CONFIRM_TEXTS`.
- Sau v0.2.0: nếu DB có label (qua `HARVEST_LABELS`), prepend vào danh sách tìm — match đặc trưng hơn với locale ChatGPT hiện tại.
- Khi `dbLabels` có nhưng không match → `reportLabelMismatch` ping backend → dashboard banner "label stale, cần re-harvest".

#### v0.3.0 / v0.4.0 (2026-05-18) — HARVEST_LABELS probe-invite mode
- HARVEST_LABELS chạy trên `/admin/members` tab Pending. Nếu tab trống → harvest tự tạo **probe invite** (`autogpt-probe-{ts}@example.com`) → harvest label menu Revoke + confirm Revoke → **tự thu hồi probe** để workspace sạch.
- Lúc này REVOKE_INVITES code path được dùng làm cleanup cho probe invite của HARVEST_LABELS, ngoài use case rogue invite.

### Bảng tóm tắt

| Version | Loại | Tóm tắt |
|---------|------|---------|
| v0.1.0 | feature | Release action `REVOKE_INVITES` |
| v0.2.0 | feature | Wire DB lookup `menu_revoke_invite` + `confirm_revoke_button` |
| v0.4.0 | feature | HARVEST_LABELS dùng REVOKE flow để cleanup probe invite |

> **🔥 Symptom debug nhanh:**
> - Per-email "Row không tìm thấy" → check tab pending có scroll hết list chưa. `findMemberRow` dùng walker text node, không scroll động nếu list virtualized.
> - Per-email 'Menu mở nhưng không có item "Thu hồi lời mời"' → ChatGPT đổi text menu → cần re-harvest hoặc update `REVOKE_MENU_ITEM_TEXTS`.
> - Per-email "Row vẫn còn sau 5s" → ChatGPT có thể yêu cầu OTP/2FA cho destructive action → manual revoke.
> - **Không có bug fix lớn nào cho REVOKE từ v0.2.0 → v0.6.12** — action này stable nhất so với INVITE/CHANGE_ROLE. Có lẽ vì revoke chỉ làm 1 thao tác đơn giản: click menu → confirm → verify mất row, không có race condition phức tạp.

## 10. Test thủ công

```
1. Tạo pending invite thủ công trên ChatGPT /admin/members (mời 1 email ngoài dashboard)
2. Sync workspace → dashboard detect rogue email
3. Dashboard: chọn email rogue + tạo REVOKE_INVITES task
4. Verify trong tab ChatGPT:
   - Tab "Lời mời đang chờ xử lý" active
   - Row của email rogue biến mất sau ~5-10s
5. Verify DevTools Console:
   - "[autogpt-revoke] OK email=..."
6. Verify dashboard: pending invite bị xoá khỏi DB
```
