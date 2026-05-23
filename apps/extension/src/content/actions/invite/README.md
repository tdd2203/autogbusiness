# Logic chi tiết: `INVITE_MEMBER` action

> **Folder:** [`apps/extension/src/content/actions/invite/`](./)
> **Trigger:** background runner gửi 2 message:
> - **Phase 1:** `{ kind: "INVITE_MEMBER", taskId, emails: string[], role: ChatGPTRole }`
> - **Phase 2 (sau F5 background):** `{ kind: "VERIFY_PENDING_INVITE", taskId, emails, role }`
>
> **Mục đích:** mời 1 hoặc nhiều email vào workspace ChatGPT Business + verify ChatGPT đã thực sự nhận. Đây là action **phức tạp nhất** với 2 phase split bởi background F5.

## 1. Public API

```ts
// invite/index.ts (barrel)
export { executeInvite } from "./execute-invite";                          // Phase 1
export { executeVerifyPendingInvite } from "./execute-verify-pending";    // Phase 2

// execute-invite.ts (Phase 1)
export async function executeInvite(
  taskId: string,
  emails: string[],
  role: ChatGPTRole,
): Promise<ExecuteActionResponse>

// execute-verify-pending.ts (Phase 2 — sau F5)
export async function executeVerifyPendingInvite(
  taskId: string,
  emails: string[],
  role: ChatGPTRole,
): Promise<ExecuteActionResponse>
```

**Phase 1 trả về:**
- `{ ok: true, data: { emails, count, role, awaiting_reload_verify: true } }` — báo background F5 + gọi Phase 2.
- `{ ok: false, error_code: "PAGE_NOT_ADMIN" | "UI_ELEMENT_NOT_FOUND" | "VERIFY_FAILED" }` khi fail.

**Phase 2 trả về:**
- `{ ok: true, data: { emails, count, role, pending_members: ScrapedMember[], verified_emails: string[], unverified_emails: string[], verify_scrape_failed: boolean } }`.
- `{ ok: false, error_code: "VERIFY_FAILED" }` khi 0 email verified (strict v0.4.14).

## 2. Use case

Dashboard admin chọn workspace + nhập email(s) + role (default `member`) → backend tạo `INVITE_MEMBER` task → extension nhận qua SSE.

Spec mời:
- **Role mặc định = member** (per Memory `feedback_invite_role_member_only.md`). Dashboard CHỈ invite `member` — muốn admin/owner/analytics_viewer thì user tự đổi trên ChatGPT.
- **Multi-email:** ChatGPT 2026 UI mỗi email 1 ROW riêng với input riêng. Loop: type email[0] → click "Add more" → đợi row mới render → type email[i] → repeat.
- **Email ngoài domain verify:** wrap trong [`withExternalInvitesEnabled`](../external-invites/README.md) — tạm bật toggle workspace, sau invite force OFF (v0.6.6).

## 3. Cấu trúc folder (sau Pha 5)

```
invite/
├── index.ts                          # Barrel: 2 export (executeInvite + executeVerifyPendingInvite)
├── execute-invite.ts                 # Phase 1 entry — wrap external-invites + chuyển tab Lời mời (~95 dòng)
├── execute-invite-inner.ts           # Logic dialog: mở/type/submit (~270 dòng, private)
├── execute-verify-pending.ts         # Phase 2 entry — sau F5 background, scrape pending + retry (~150 dòng)
├── wait-for-pending-list-stable.ts   # Poll DOM stable trước F5 (v0.6.6)
├── click-add-more.ts                 # clickAddMoreIfNeeded — multi-email row mới
├── set-role.ts                       # setRole — native SELECT + Radix combobox
└── finders/
    ├── find-invite-open-button.ts    # findInviteOpenButton + isToggleOrSwitchOrTab filter
    ├── find-email-input.ts           # findInviteEmailInput + countDialogEmailInputs + findLastEmptyEmailInput
    └── find-submit-button.ts         # findInviteSubmitButton
```

## 4. Flow tổng thể 2-phase

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          BACKGROUND RUNNER                                    │
│                                                                                │
│  INVITE_MEMBER task picked                                                    │
│           │                                                                    │
│           ▼                                                                    │
│  send {kind:"INVITE_MEMBER", emails, role}                                    │
│           │                                                                    │
└───────────┼────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                     CONTENT SCRIPT — PHASE 1                                  │
│                                                                                │
│  executeInvite(taskId, emails, role)                                          │
│    1. Check pathname /admin                                                   │
│    2. withExternalInvitesEnabled(() => executeInviteInner(...)):              │
│       a. setExternalInvites(true) — toggle ON nếu OFF                         │
│       b. navigate /admin/members                                              │
│       c. taskFn = executeInviteInner:                                         │
│          - click tab "Người dùng" (đảm bảo active)                            │
│          - waitFor findInviteOpenButton 8s → click 2x retry                   │
│          - waitFor findInviteEmailInput 20s                                   │
│          - humanType email[0] → loop add-more + type email[i]                 │
│          - setRole (skip nếu member default)                                  │
│          - click submit → wait toast/dialog close 15s                         │
│          - return {ok:true, data:{awaiting_reload_verify:true}}               │
│       d. finally: setExternalInvites(false) FORCE OFF + nav /admin/members    │
│    3. clickTabAndWait("tab_pending_invites", 3000ms)                          │
│    4. waitForPendingListStable(emails, 8000ms) — đợi React Query render xong  │
│    5. return inviteResult với awaiting_reload_verify=true                     │
└───────────┬──────────────────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          BACKGROUND RUNNER                                    │
│                                                                                │
│  Detect response.data.awaiting_reload_verify === true                         │
│           │                                                                    │
│           ▼                                                                    │
│  chrome.tabs.reload(tab) — HARD F5 thật                                       │
│           │                                                                    │
│           ▼                                                                    │
│  waitForTabComplete 20s                                                       │
│           │                                                                    │
│           ▼                                                                    │
│  ensureContentInjected re-inject content script                               │
│           │                                                                    │
│           ▼                                                                    │
│  send {kind:"VERIFY_PENDING_INVITE", emails, role}                            │
│           │                                                                    │
└───────────┼────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                     CONTENT SCRIPT — PHASE 2                                  │
│                                                                                │
│  executeVerifyPendingInvite(taskId, emails, role)                             │
│    1. sleep 2500ms — ChatGPT re-fetch + render pending list                   │
│    2. Defensive: nếu URL không ở /admin/members → navigate                    │
│    3. Retry loop 3 attempts với delays [0, 3000, 6000]ms:                     │
│       - scrapePendingInvitesAfterInvite(taskId, attempt>0)                    │
│       - intersect invited emails ∩ scraped → verified[]                       │
│       - break sớm nếu tất cả verified                                         │
│    4. Strict v0.4.14: nếu verifiedCount=0 && !scrapeFailed → VERIFY_FAILED    │
│    5. return {ok:true, data:{pending_members, verified, unverified, scrape}}  │
└───────────┬──────────────────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          BACKGROUND RUNNER                                    │
│                                                                                │
│  reportToBackend → bulkUpsertMembers(workspace_id, pending_members,           │
│    {isFullSync: false}) — chunked 200/lần (v0.6.4 fix bug a12)               │
│           │                                                                    │
│           ▼                                                                    │
│  updateTask {status: COMPLETED, result: {data, mapped_pending,                │
│    verified_count, unverified_count, unverified_emails,                       │
│    verify_scrape_failed}}                                                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 5. Luồng `executeInvite` (Phase 1)

```
executeInvite(taskId, emails, role)
  │
  ├── Check pathname /admin → fail PAGE_NOT_ADMIN
  ├── Check emails.length === 0 → fail UI_ELEMENT_NOT_FOUND
  │
  ├── withExternalInvitesEnabled(() => executeInviteInner(taskId, emails, role)):
  │     ├── setExternalInvites(true) — bật toggle ON nếu OFF
  │     ├── navigateTo(/admin/members, predicate)
  │     ├── try: executeInviteInner(...)
  │     └── finally:
  │           ├── setExternalInvites(false) — FORCE OFF (v0.6.6 spec bảo mật)
  │           └── navigateTo(/admin/members) — UX nhất quán
  │
  ├── inviteResult.ok? (chỉ tiếp tục nếu submit OK)
  │     ├── sleep 500ms — DOM ổn định sau finally
  │     ├── clickTabAndWait("tab_pending_invites", 3000ms)
  │     │     │
  │     │     ├── switched? (tab tồn tại?)
  │     │     │     ├── YES: waitForPendingListStable(emails, 8000ms)
  │     │     │     │     - Poll DOM mỗi 500ms
  │     │     │     │     - Break khi all expectedEmails có trong DOM
  │     │     │     │     - HOẶC stable 2 ticks liên tiếp
  │     │     │     │     - Cap 8s
  │     │     │     └── NO: log warn, Phase 2 sẽ tự navigate
  │     │     │
  │     │     └── ⚠ QUAN TRỌNG (v0.6.5+): trình tự PHẢI là 'tắt toggle TRƯỚC,
  │     │         chuyển tab Lời mời SAU'. Nếu đảo lại, URL mất ?tab=invites
  │     │         do navigation /admin/identity → /admin/members của wrapper.
  │
  └── return inviteResult với awaiting_reload_verify=true
```

## 6. Luồng `executeInviteInner` (logic dialog, private)

```
executeInviteInner(taskId, emails, role)
  │
  ├── Report "opening-dialog"
  │
  ├── 1. Click tab "Người dùng" (đảm bảo active) — best-effort
  │
  ├── 2. Mở dialog:
  │     ├── openBtn = waitFor(findInviteOpenButton, 8000ms)
  │     │     ├── findInviteOpenButton:
  │     │     │     - Scope: main, [role=main] (không scan sidebar)
  │     │     │     - Strategy 1: SELECTORS.inviteButtonOpen CSS selector
  │     │     │     - Strategy 2: text fallback từ DB + TEXT_FALLBACKS
  │     │     │     - Filter: KHÔNG là toggle/switch/tab/menu
  │     │     ├── Timeout 8s → fail UI_ELEMENT_NOT_FOUND
  │     ├── humanClick(openBtn) lần 1
  │     ├── sleep 800ms, check dialog mở chưa
  │     └── Nếu chưa → humanClick(openBtn) lần 2 (Radix DialogTrigger miss event)
  │
  ├── 3. Đợi dialog + input email xuất hiện:
  │     ├── waitFor(findInviteEmailInput, 20000ms) — tăng 10→20s sau v0.4.17 auto-reload
  │     ├── Timeout 20s → DIAGNOSTIC dump dialog HTML + return UI_ELEMENT_NOT_FOUND
  │
  ├── 4. Multi-email loop (ChatGPT 2026 = mỗi email 1 row riêng):
  │     ├── humanType email[0] vào input đầu
  │     │
  │     └── for i in 1..emails.length:
  │           ├── Report "add-row"
  │           ├── inputsBefore = countDialogEmailInputs(dialog)
  │           ├── clickAddMoreIfNeeded() → click "Thêm nhiều hơn"
  │           ├── Nếu KHÔNG click được:
  │           │     └── FALLBACK: join các email còn lại bằng "\n" vào input cuối,
  │           │         break loop (cho trường hợp UI chấp nhận multi-line)
  │           ├── waitFor row mới render (input count tăng), 4s
  │           ├── newInput = findLastEmptyEmailInput(dialog)
  │           └── humanType(newInput, email[i])
  │
  ├── 5. randomDelay 800-1800ms
  │     setRole(role):
  │     ├── Nếu role === "member" → SKIP click (default + giảm bot pattern)
  │     ├── Nếu native <select>: nativeSetter + dispatch change event
  │     └── Nếu Radix combobox: humanClick(selectEl) → findRoleOption → humanClick
  │
  ├── 6. Click Submit:
  │     ├── findInviteSubmitButton():
  │     │     - Strategy 1: SELECTORS.inviteSubmitButton CSS
  │     │     - Strategy 2: text fallback CHỈ trong dialog (tránh click nhầm
  │     │       nút "Mời" mở dialog)
  │     ├── Nếu null → fail UI_ELEMENT_NOT_FOUND
  │     └── humanClick(submitBtn)
  │
  ├── 7. Verify success:
  │     ├── waitFor 15s: toast || dialog đóng
  │     └── Timeout → check INVITE_ERROR_HINTS trong dialog (vd "email đã tồn tại"),
  │         return VERIFY_FAILED với hint
  │
  └── return {ok:true, data:{emails, count, role, awaiting_reload_verify:true}}
```

## 7. Luồng `executeVerifyPendingInvite` (Phase 2)

```
executeVerifyPendingInvite(taskId, emails, role)
  │
  ├── sleep 2500ms — ChatGPT re-fetch + render pending list sau F5
  │
  ├── Defensive: nếu pathname KHÔNG /admin/members:
  │     ├── click sidebar <a href="/admin/members">
  │     └── fallback pushState
  │     └── sleep 2000ms
  │
  ├── Report "mapping"
  │
  ├── RETRY LOOP 3 attempts với delays [0, 3000, 6000]ms:
  │     ├── if delay > 0: sleep + report progress "retry K/3"
  │     │
  │     ├── try scrapedPending = scrapePendingInvitesAfterInvite(taskId, attempt>0)
  │     │     - attempt > 0 → forceReload=true (bounce qua "Người dùng" để ép re-fetch)
  │     │     - scrape full tab "Lời mời"
  │     │
  │     ├── catch scrapeFailed = true, continue
  │     │
  │     ├── scrapedEmailSet = scraped emails (lowercase)
  │     ├── verifiedEmails = invited ∩ scrapedEmailSet
  │     ├── unverifiedEmails = invited \ scrapedEmailSet
  │     │
  │     └── Break sớm nếu unverifiedEmails.length === 0
  │
  ├── pendingMembersForUpsert = scrapedPending.filter(m => invited.includes(m.email))
  │
  ├── Strict v0.4.14: nếu !scrapeFailed && verifiedEmails.length === 0 && emails.length > 0:
  │     └── return VERIFY_FAILED với explain message 3 nguyên nhân khả dĩ
  │
  └── return {ok:true, data:{
        emails, count, role,
        pending_members,         // chỉ scrape của email mời (chunked upsert)
        verified_emails,         // ChatGPT đã nhận
        unverified_emails,       // có thể active/từ chối/domain không verify
        verify_scrape_failed     // scrape lỗi 3 lần → giữ data, không fail
      }}
```

## 8. Selectors & i18n

### Nút "Mời thành viên" mở dialog
- DB key: `invite_button_open`, page `/admin/members`.
- Text fallback: "Mời thành viên", "Invite member", "Invite", "邀请成员", "Mời", "+Mời".
- Filter: loại button có role `switch`/`tab`/`menuitem`, data-state `checked`/`unchecked`.

### Input email
- Selector: `SELECTORS.inviteEmailInput` — `input[type="email"]` trong `[role="dialog"]`, fallback `textarea`.

### Nút "Add more"
- DB key: `invite_add_more_button`, page `/admin/members`.
- Text fallback: "Thêm nhiều hơn", "Add more", "Add another", "Add another member", "Add a member", "Add row", "Add many", "Thêm thành viên", "Thêm dòng", "添加成员", "添加一行".

### Role dropdown
- Selector: `SELECTORS.inviteRoleSelect` — `<select>` hoặc `[role="combobox"]` trong dialog.
- Role labels (i18n-ui.ts `ROLE_LABELS`):
  - owner: "Chủ sở hữu" / "Owner" / "所有者"
  - admin: "Quản trị viên" / "Admin" / "管理员"
  - member: "Thành viên" / "Member" / "成员"
  - analytics_viewer: "Trình xem dữ liệu phân tích" / "Analytics viewer" / "分析查看者"

### Nút Submit
- DB key: `invite_submit_button`, page `/admin/members`.
- Text fallback (ưu tiên plural): "Send invites", "Send invitations", "发送邀请", "Gửi các lời mời", "Gửi lời mời", "Send invite", "Invite", "Mời".

### Toast success
- Selector: `SELECTORS.inviteSuccessToast` — `[role="status"]`, `.toast`, etc.

### Error hints trong dialog (INVITE_ERROR_HINTS)
- "Email already exists", "Đã có lời mời", "Insufficient seats", "Không đủ ghế", "Outside your organization", "Miền bên ngoài", "Domain not verified", "席位不足", "外部域".

## 9. Lịch sử sửa lỗi & quyết định thiết kế

### Timeline đầy đủ (từ CHANGELOG)

#### v0.1.0 (2026-05-18) — release đầu
- Action `INVITE_MEMBER` ra mắt. Flow đơn giản 1 phase: mở dialog → nhập email → submit → verify toast.

#### v0.2.0 (2026-05-18) — wire DB label lookup
- Các DB keys: `invite_button_open`, `invite_submit_button`, `invite_add_more_button`, `invite_role_owner/admin/member`.

#### v0.4.2 (2026-05-19) — chọn đúng toggle external invites
- Liên quan đến wrapper [`external-invites`](../external-invites/README.md) — invite cần wrapper đó để mời email ngoài domain. Xem doc external-invites cho chi tiết fix exclude "Automatic Account Creation".

#### v0.4.3 (2026-05-19) — sidebar-link nav + INVITE_ERROR_HINTS
- `INVITE_ERROR_HINTS` thêm: seat limit (`insufficient seats`, `không đủ ghế`, `席位不足`) + external domain (`outside your organization`, `miền bên ngoài`, `外部域`). Dialog ChatGPT báo lỗi loại này sẽ được surface rõ ràng thay vì raw text.

#### v0.4.4 (2026-05-19) — multi-email row-based UI 2026
- **Bug:** ChatGPT đổi dialog Invite sang layout 3-column (`Email | Role | Seat type`) với mỗi email là **1 ROW riêng** có input riêng. UI cũ là 1 input + textarea expand sau khi click "Add more".
- **Multi-email cũ:** join các email bằng `\n` vào 1 input duy nhất → 1 input không nhận newline → ChatGPT reject toàn bộ.
- **Multi-email mới:** type `email[0]` vào input đầu → loop "Add more" → đợi row mới render (input count tăng) → type `email[i]` vào input rỗng cuối → repeat. Fallback dồn email vào 1 input nếu Add more fail.
- Helpers mới: `countDialogEmailInputs(dialog)`, `findLastEmptyEmailInput(dialog)`.
- Text mapping `inviteSubmitButton`: thêm plural "Send invites", "Send invitations".
- Text mapping `inviteAddMoreButton`: thêm "Add another member", "Add row", "Thêm dòng".

#### v0.4.5 (2026-05-19) — progress chi tiết hơn
- Thêm `current`/`total` vào mọi `reportProgress` call — banner dashboard hiển thị "1/4", "2/4"…
- Phase `add-row` mới trước khi click "Add more".

#### v0.4.7 (2026-05-19) — delay -70%
- `human.ts` `DELAY_MULTIPLIER = 0.30` — giảm 70% per-char typing + randomDelay. User feedback "extension cứ xoay mãi".

#### v0.4.8 (2026-05-19) — feature: map lời mời về dashboard
- Sau khi invite verify thành công, **bước MỚI**: click tab "Lời mời đang chờ xử lý" → scroll-and-scrape pending invites → return về background → backend chunked `bulkUpsertMembers` với `scrapedStatuses=['pending']`.
- Reusable export `scrapePendingInvitesAfterInvite(taskId)` trong sync.ts.
- Phase mới `mapping` trong `reportProgress`.

#### v0.4.9 (2026-05-19) — UI_ELEMENT_NOT_FOUND khi click "Mời thành viên" sau toggle
- **Bug:** sau khi wrap external-invites BẬT toggle tại `/admin/identity` → navigate về `/admin/members` → gọi `findInviteOpenButton()` ngay, nhưng SPA render content cần thêm vài trăm ms tới vài giây → button chưa tồn tại → invite fail `UI_ELEMENT_NOT_FOUND`.
- **Fix:** `findInviteOpenButton` chạy trong `waitFor()` poll loop tới **8s** thay vì gọi 1 lần. Error message rõ hơn: list 3 điểm cần check.

#### v0.4.10 (2026-05-19) — verify pending TRƯỚC khi update dashboard
- Quy trình mới: scrape tab "Lời mời" → tính giao của (email vừa mời) ∩ (email scrape được) = `verified_emails`. **Chỉ verified emails** mới được bulk-upsert lên dashboard.
- Unverified emails (mời nhưng KHÔNG xuất hiện trong pending — vd ChatGPT từ chối thầm, email đã active sẵn) report tách riêng vào `task.result.unverified_emails`.
- Task result mới include: `verified_count`, `unverified_count`, `unverified_emails[]`, `verify_scrape_failed`.
- Edge case: scrape pending **fail toàn bộ** (DOM lạ, locale mismatch, timeout 60s) → `verify_scrape_failed=true`, KHÔNG update dashboard records, task vẫn `COMPLETED`.

#### v0.4.13 (2026-05-19) — phantom email cleanup + content script inject retry
- **Fix A — phantom email (backend):** `bulk_invite` vẫn tạo `Member`+`Invite` up-front (optimistic UI). `update_task` PATCH có handler MỚI xoá phantom:
  - FAILED → xoá toàn bộ records
  - COMPLETED với `unverified_emails` → xoá chỉ những email đó
  - `verify_scrape_failed=true` → giữ lại (không có info để decide)
  - Chỉ xoá `Member` `status='pending'` + `joined_at IS NULL` (an toàn không xoá nhầm active)
- **Fix B — content script inject retry:** trước v0.4.13 chỉ wait 300ms rồi ping 1 lần. CRXJS loader pattern cần thời gian dynamic import (500ms-2s) → false-negative thường xuyên. Giờ retry 5 lần với delay `[250,500,700,800,800]` (~3s tổng).

#### **v0.4.14 (2026-05-19) — 🔴 strict invite: 0 email verified → FAILED (không phải COMPLETED)**
- **Bug:** trước v0.4.14, extension click submit OK + scrape pending tab. Nếu pending KHÔNG có email nào trong list invite → vẫn return `ok=true` với `verified_count=0`. Task `COMPLETED` nhưng tất cả records bị xoá (phantom cleanup). Banner "Đã verify 0/N" gây nhầm lẫn.
- **Fix:** nếu scrape pending OK và `verified_count=0` → return `{ok:false, error_code:'VERIFY_FAILED'}` với explanation 3 nguyên nhân khả dĩ. Task **FAILED** visibility rõ ràng.
- **KHÔNG** áp dụng khi `verify_scrape_failed=true` — vẫn return `ok=true` vì submit có thể đã success.

#### v0.4.17 (2026-05-19) — AUTO-RELOAD tab ChatGPT khi CONTENT_NOT_INJECTED
- Liên quan tới `background/runner.ts:ensureContentInjected` — sau khi reload extension, content script cũ stale. Auto-reload tab + executeScript explicit để re-inject. User KHÔNG cần F5 thủ công.
- Phía invite ảnh hưởng: `waitFor` dialog email input từ 10s → **20s** (sau v0.4.17 SPA cần thời gian rehydrate).

#### v0.4.20 (2026-05-19) — DOM diagnostic + bỏ Step 3 NUCLEAR (regression invite)
- **Bug REGRESSION:** Step 3 NUCLEAR (`tabs.remove + tabs.create`) trong `ensureContentInjected` quá aggressive, đóng tab user khi không cần, gây dialog Invite không mở được sau khi tab vừa recreate.
- **Fix:** bỏ Step 3 NUCLEAR. Step 1 (executeScript) + Step 2 (tabs.reload) đã cover 99% case.
- **DOM diagnostic:** khi `waitFor` dialog email input timeout → dump dialog innerHTML + list tất cả input/textarea vào console (prefix `[autogpt-invite] DIAGNOSTIC`). Error message kèm input summary.

#### **v0.6.0 → v0.6.2 (2026-05-20) — 🔴 F5 thật trang admin sau submit (Phase 1 + Phase 2 split)**
- **Bug:** ChatGPT React Query cache pending list theo workspace_id — click tab không invalidate cache, chỉ trigger refetch nếu staleTime expire. Sau invite scrape pending có thể trả stale data → false-negative VERIFY_FAILED.
- **Fix tách INVITE_MEMBER thành 2 phase:**
  - **Phase 1** (content): chỉ submit invite + verify toast/dialog đóng → return `ok=true` với `awaiting_reload_verify=true`.
  - **Phase 2** (background orchestrate): `chrome.tabs.reload(tab)` HARD F5 → wait tab complete → `ensureContentInjected` re-inject → gửi `VERIFY_PENDING_INVITE` message mới → content's new instance scrape pending (đã load fresh từ server).
- `chrome.tabs.reload` là F5 thật ở level browser → toàn bộ JS context destroy + reload → React Query cache xoá sạch → fetch fresh từ `/api/.../invites`.
- Message protocol mới: `VERIFY_PENDING_INVITE { taskId, emails, role }` — dùng riêng cho Phase 2, không submit lại invite.
- Runner detect `response.data.awaiting_reload_verify=true` → vào branch F5+verify. Nếu F5 fail / inject fail / verify message throw → fallback `ok=true` với `verify_scrape_failed=true`.
- Retry trong Phase 2 vẫn giữ (3 attempts với delay 0/3/5s) — phòng ChatGPT backend chậm index.

#### v0.6.1 (2026-05-20) — fix humanClick double-fire
- **Bug nghiêm trọng:** `humanClick` dispatch synthetic `MouseEvent('click')` RỒI gọi `el.click()` native → mỗi lần "click" fire **2 lần**.
- **Symptom invite:** Submit invite click 1 lần → ChatGPT submit 2 lần → **2 toast "Đã gửi lời mời"**.
- **Fix:** chỉ gọi `el.click()` native. Synthetic event chỉ là fallback.
- Cùng version: verify pending sleep 1500ms→**2000ms** trước scrape (cho ChatGPT index time), retry 3 lần `[0, 2.5s, 4s]`, forceReload bounce qua tab "Người dùng" để ép re-fetch.
- Bug #3 (phải F5 thấy email): extension giờ DỪNG tại tab "Lời mời" sau verify cuối — DOM đã render data tươi, user mở tab admin lên thấy ngay.

#### v0.6.3 (2026-05-20) — re-thêm Step 3 NUCLEAR (recreate tab) + Step 2 inject 2x
- Sau v0.6.2 invite đã tách Phase 1+2, regression cũ KHÔNG còn áp dụng → an toàn re-thêm Step 3 NUCLEAR cho `ensureContentInjected`.
- Step 3 NUCLEAR mới: `chrome.tabs.remove` tab cũ → `chrome.tabs.create` mới hoàn toàn (URL `/admin/members`) → `waitForTabComplete` 20s → `executeScript` explicit → 5 retry ping.

#### **v0.6.4 (2026-05-20) — 🔴 fix bug `a12` bị mark `removed` oan + UX SPEEDUP**
- **Bug `a12` "biến mất":** User invite `a12` (08:34) → ChatGPT nhận thật. Sau invite `g12` (08:37) extension verify scrape tab "Lời mời" tại 08:38 chỉ thấy `g12` (a12 chưa được ChatGPT index về client) → bulk-upsert với `scrapedStatuses=['pending']` → backend reconcile mark `a12=removed` oan.
- Phantom cleanup INVITE_MEMBER vẫn đúng (`verify_scrape_failed=true` → giữ); lỗi nằm ở **bulk-upsert dùng chung endpoint** cho cả full sync + verify after invite.
- **Fix 1 — Extension:** thêm option `isFullSync=false` vào `bulkUpsertMembers`, bỏ `scrapedStatuses`. Backend nhận → CHỈ upsert email trong payload, KHÔNG reconcile.
- **Fix 2 — Backend defense-in-depth:** reconcile `WHERE NOT (invited_by_user_id IS NOT NULL AND created_at > NOW() - INTERVAL '10 minutes')`. Nếu extension lỡ gửi `is_full_sync=true` sau khi vừa invite, member mới vẫn an toàn.
- **UX SPEEDUP** (user 2026-05-20): "sau khi mời xong chuyển sang tab Lời mời đang xử lý, chờ load rồi reload trang là thấy toàn bộ". Phase 1 cuối thêm `clickTabAndWait("tab_pending_invites", 1500)` NGAY trước khi return → URL = `/admin/members?tab=invites` khi runner F5 → ChatGPT load thẳng pending list từ server vào view.
- **Phase 2 simplify:** initial sleep 1500ms → 800ms (DOM đã ở đúng tab), retry chain `[0, 3000, 5000]` → `[0, 2500]`. Tiết kiệm ~3-5s mỗi invite.

#### **v0.6.5 (2026-05-20) — 🔴 trình tự "tắt toggle TRƯỚC, chuyển tab Lời mời SAU"**
- **Bug v0.6.4:** trình tự cũ: chuyển tab Lời mời TRƯỚC → restore toggle SAU. Restore toggle navigate qua `/admin/identity` → khi quay về `/admin/members` thì **mất URL `?tab=invites`** → F5 load tab "Người dùng" mặc định → Phase 2 fail.
- **Fix:** đảo trình tự — `withExternalInvitesEnabled` finally cuối navigate về `/admin/members` (không có `?tab=invites`). SAU đó `executeInvite` mới click tab "Lời mời" — URL = `?tab=invites` được giữ cho F5 verify.

#### **v0.6.6 (2026-05-20) — 🔴 LUÔN tắt OFF + waitForPendingListStable + retry [0,3000,6000]**
- **Bug 1:** v0.6.5 chỉ restore toggle khi `changed=true` → nếu prev=ON, finally bỏ qua → toggle giữ ON → vi phạm spec bảo mật.
- **Fix 1:** finally LUÔN gọi `setExternalInvites(false)` (force OFF) — kể cả prev=ON. User bật lại thủ công nếu cần.
- **Bug 2:** sau Phase 1 cuối click tab "Lời mời" + return ngay → background F5 → ngắt giữa fetch ChatGPT React Query → sau F5 có thể serve cache cũ → scrape miss email (user report v0.6.5 "load thiếu").
- **Fix 2:** thêm `waitForPendingListStable(emails, 8000ms)` SAU click tab + TRƯỚC return. Poll DOM mỗi 500ms, break sớm khi all expectedEmails có trong DOM, hoặc stable 2 ticks liên tiếp. Đảm bảo F5 chạy ở state ổn định.
- **Fix 3:** Phase 2 retry chain `[0, 2500]` → `[0, 3000, 6000]` — handle case ChatGPT index pending list chậm. clickTabAndWait postClickWait 1500 → 3000ms.

#### v0.6.7 (2026-05-20) — ensureContentInjected propagate diag step-by-step
- Liên quan đến `background/runner.ts`, không phải invite code. Khi 3 step ensureContentInjected fail → propagate diag chi tiết vào `error_message` của task → dashboard hiển thị thẳng, user không cần mở DevTools service worker.

### Bảng tóm tắt

| Version | Loại | Tóm tắt |
|---------|------|---------|
| v0.1.0 | feature | Release action `INVITE_MEMBER` (1 phase) |
| v0.2.0 | feature | Wire DB lookup cho 6 invite control keys |
| v0.4.3 | fix | INVITE_ERROR_HINTS (seat limit + external domain) |
| **v0.4.4** | **🔴 fix** | **Multi-email row-based UI 2026 (mỗi email 1 input)** |
| v0.4.5 | fix | Progress chi tiết (current/total/phase) |
| v0.4.8 | feature | Map lời mời về dashboard sau verify |
| v0.4.9 | fix | `waitFor findInviteOpenButton` 8s (sau navigate cần render time) |
| v0.4.10 | feature | Verify pending TRƯỚC khi update dashboard (verified vs unverified) |
| **v0.4.14** | **🔴 fix** | **Strict invite: 0 verified → VERIFY_FAILED (không COMPLETED)** |
| v0.4.17 | fix | waitFor dialog 10→20s (sau auto-reload tab) |
| **v0.6.0-v0.6.2** | **🔴 BREAKING** | **Tách Phase 1 (submit) + Phase 2 (F5 background + verify)** |
| v0.6.1 | fix | `humanClick` double-fire (submit 2 lần → 2 toast) |
| **v0.6.4** | **🔴 fix** | **`isFullSync=false` + UX speedup chuyển tab Lời mời ở Phase 1** |
| **v0.6.5** | **🔴 fix** | **Trình tự "tắt toggle TRƯỚC, chuyển tab Lời mời SAU"** |
| **v0.6.6** | **🔴 fix** | **`waitForPendingListStable` 8s + retry [0,3000,6000]ms + force OFF toggle** |
| v0.6.7 | fix | Diag propagate `error_message` (background ensureContentInjected) |

> **🔥 Symptom debug nhanh:**
> - `VERIFY_FAILED` "0 email verified" sau v0.4.14 → 3 nguyên nhân: (a) email đã active sẵn, (b) domain không verify (cần bật external invites — đã wrap), (c) ChatGPT từ chối silently (rate limit?). Check ChatGPT thủ công.
> - `UI_ELEMENT_NOT_FOUND` "Không tìm thấy nút Mời thành viên sau 8s" → SPA chưa render. Check `findInviteOpenButton` scope còn match `main, [role="main"]` không. Verify đang ở `/admin/members`.
> - `UI_ELEMENT_NOT_FOUND` "Dialog không mở sau 20s" → check DOM dump trong console (`[autogpt-invite] DIAGNOSTIC dialog HTML`). Có thể ChatGPT đổi role từ `dialog` sang khác.
> - Dialog mở nhưng add-more fail multi-email → check `clickAddMoreIfNeeded` text fallback còn match UI mới không (`Add another member`, `Add row`...).
> - Submit 2 toast = `humanClick` regression — kiểm tra `human.ts` chỉ gọi `el.click()` native.
> - Verify scrape miss email (`unverified_emails` có nhưng ChatGPT đã nhận) → có thể React Query cache stale. Verify `waitForPendingListStable` chạy đủ + Phase 2 retry chain `[0, 3000, 6000]`.
> - Bug "a12 biến mất" trong DB sau invite g12 → bulk-upsert reconcile bug. Verify backend `members.py` defense-in-depth `WHERE NOT created_at > NOW() - INTERVAL '10 minutes'`. Verify extension gửi `is_full_sync=false`.

## 10. Fail mode & error code

### Phase 1
| Mã | Khi nào | Cách fix |
|----|---------|----------|
| `PAGE_NOT_ADMIN` | URL không chứa `/admin` | Mở `chatgpt.com/admin/members` thủ công |
| `UI_ELEMENT_NOT_FOUND` (emails rỗng) | Backend gửi `emails: []` | Bug backend — không nên enqueue |
| `UI_ELEMENT_NOT_FOUND` (no open button) | `findInviteOpenButton` timeout 8s | SPA chưa render — verify đang ở `/admin/members` + tab Người dùng |
| `UI_ELEMENT_NOT_FOUND` (no email input) | Dialog không mở hoặc input không tìm thấy sau 20s | ChatGPT đổi UI dialog — check DOM dump |
| `UI_ELEMENT_NOT_FOUND` (no submit) | Submit button không match | Update `SELECTORS.inviteSubmitButton` hoặc DB ui_labels |
| `VERIFY_FAILED` (toast/close fail) | 15s không thấy toast và dialog không đóng | ChatGPT báo error trong dialog (check INVITE_ERROR_HINTS) hoặc UI mới |

### Phase 2
| Mã | Khi nào | Cách fix |
|----|---------|----------|
| `VERIFY_FAILED` (0 verified strict) | Submit OK + scrape pending OK nhưng 0 email match | Kiểm tra 3 nguyên nhân (active sẵn / domain / silent reject) |

## 11. Test thủ công

```
1. Test single email:
   - Dashboard invite 1 email mới
   - Verify console: "[autogpt-invite] START 1 email(s) role=member"
   - Verify: clicking tab Lời mời + waitForPendingListStable
   - Verify: F5 background + Phase 2 starts
   - Verify: "[autogpt-invite-verify] attempt 1: scraped X pending invite(s)"
   - Verify dashboard: email xuất hiện với status='pending'

2. Test multi email (4 email):
   - Verify console log từng email "typed email 1/4", "2/4", ...
   - Verify clickAddMoreIfNeeded chạy 3 lần
   - Verify dialog có 4 row sau type
   - Verify tất cả 4 email verified ở Phase 2

3. Test email ngoài domain:
   - Workspace verify chỉ "company.com"
   - Invite "test@gmail.com"
   - Verify console: setExternalInvites(true) trước, force OFF sau
   - Verify ChatGPT /admin/identity: toggle TẮT sau task

4. Test race condition (a12 bug):
   - Invite a12@x.com (đợi 30s)
   - Invite g12@x.com ngay sau
   - Verify a12 KHÔNG bị mark removed trong DB sau invite g12

5. Test VERIFY_FAILED:
   - Invite email đã active trong workspace
   - Verify task FAILED với error_code='VERIFY_FAILED'
   - Verify dashboard: record đã bị xoá (phantom cleanup)

6. Test scrape fail:
   - Disconnect network giữa Phase 1 và Phase 2
   - Verify `verify_scrape_failed=true`, task vẫn COMPLETED
   - Records giữ nguyên (không xoá phantom vì không có info)
```
