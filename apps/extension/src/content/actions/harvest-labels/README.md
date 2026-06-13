# Logic chi tiết: `HARVEST_LABELS` action

> **Folder:** [`apps/extension/src/content/actions/harvest-labels/`](./)
> **Trigger:** background runner gửi `ExecuteActionRequest` `{ kind: "HARVEST_LABELS", taskId, locale: "vi" | "en" | "zh" }`
> **Mục đích:** crawl DOM ChatGPT trên 4 page (`/admin/members`, `/admin/billing`, `/admin/billing?tab=invoices`, `/admin/identity`) để **đọc text label của 18 control_key** cho 1 locale → upsert vào DB `ui_labels` → các action khác dùng label calibrated thay vì hardcoded text.

## 1. Public API

```ts
// harvest-labels/index.ts (barrel)
export { executeHarvestLabels } from "./execute-harvest-labels";

// execute-harvest-labels.ts
export async function executeHarvestLabels(
  taskId: string,
  locale: "vi" | "en" | "zh",
): Promise<ExecuteActionResponse>
```

- `taskId`: ID task để report progress 18 step.
- `locale`: locale ChatGPT đang dùng (admin chọn trên dashboard + đổi ChatGPT Settings thủ công trước khi harvest).

**Trả về:**
- `{ ok: true, data: { harvest: { locale, pages: HarvestPage[] }, total, elapsed_sec, timed_out } }`
- `{ ok: false, error_code: "PAGE_NOT_ADMIN" | "VERIFY_FAILED" | "UI_ELEMENT_NOT_FOUND" }`

## 2. Use case

Trước khi extension chạy được trên ChatGPT locale mới (vd dashboard support locale `ja` Japan), admin cần "harvest" tất cả text label của ChatGPT UI cho locale đó vào DB → các action sau (`INVITE`, `REMOVE`, `CHANGE_ROLE`, ...) lookup `dbLabelsFor(control_key, page, locale)` lấy label đúng → click đúng button.

Workflow:
1. Admin đổi ChatGPT Settings → Personalization → Language sang locale mới (vd `ja`).
2. F5 ChatGPT để locale apply.
3. Dashboard → Settings → UI Labels → bấm "Harvest JA".
4. Backend tạo `HARVEST_LABELS` task `{ locale: "ja" }`.
5. Extension nhận → crawl 4 page → trả về bundle 18 control_key × labels.
6. Backend upsert vào `ui_labels` table.
7. Dashboard tự refresh bundle qua bridge (v0.4.11 push) → extension content cache reload <500ms.

## 3. Cấu trúc folder (sau Pha 7)

```
harvest-labels/
├── index.ts                          # Barrel: export executeHarvestLabels
├── execute-harvest-labels.ts         # Entry + orchestrator 4 page + global 3-phút timeout (~125 dòng)
├── ctx.ts                            # Ctx + HarvestItem/HarvestPage types + step + recordIfText
│                                       + pickText + pickAria + elapsedSec + PROGRESS_PHASE
├── nav.ts                            # navigateSpaVerified (click <a> hoặc pushState + verify)
├── wait.ts                           # pressEscape + waitForDialog/Close/Menu
├── pages/                            # 4 page × 1 hàm orchestrate
│   ├── members.ts                    # harvestMembers (3 tab + invite dialog + row menu)
│   ├── billing-plan.ts               # harvestBillingPlan (2 tab Billing)
│   ├── billing-invoices.ts           # harvestBillingInvoices (tab Hoá đơn)
│   └── identity.ts                   # harvestIdentity (toggle external invites)
└── revoke-probe/                     # Auto-tạo invite probe nếu pending tab trống
    ├── harvest-revoke-flow.ts        # harvestRevokeFlow (entry)
    ├── create-probe.ts               # createProbeInvite (autogpt-probe-{ts}@example.com)
    ├── cleanup-probe.ts              # cleanupProbeInvite (revoke THẬT probe)
    └── find-pending-rows.ts          # findPendingRows helper
```

## 4. 18 Control Keys harvest

Phân bố theo page:

### `/admin/members` (14 keys)
1. `tab_active_members` — text "Người dùng" / "Active members"
2. `tab_pending_invites` — "Lời mời đang chờ xử lý" / "Pending invites"
3. `tab_pending_requests` — "Yêu cầu đang chờ xử lý" / "Pending requests"
4. `invite_button_open` — "Mời thành viên" / "Invite member"
5. `invite_submit_button` — "Gửi lời mời" / "Send invite(s)"
6. `invite_add_more_button` — "Thêm nhiều hơn" / "Add more"
7. `invite_role_owner` — "Chủ sở hữu" / "Owner"
8. `invite_role_admin` — "Quản trị viên" / "Admin"
9. `invite_role_member` — "Thành viên" / "Member"
10. `member_row_menu_button` — nút "..." (icon-only, dùng aria_label)
11. `menu_remove_member` — "Loại bỏ thành viên" / "Remove member"
12. `menu_change_role` — "Thay đổi loại giấy phép" / "Change seat type"
13. `confirm_remove_button` — "Loại bỏ" / "Remove" (trong dialog)
14. `menu_revoke_invite` — "Thu hồi lời mời" / "Revoke invite"
15. `confirm_revoke_button` — "Thu hồi" / "Revoke" (trong dialog)

### `/admin/billing` (1 key)
- `tab_billing_plan` — "Kế hoạch" / "Plan"
- (`tab_billing_invoices` cũng harvest ở đây để có context plan)

### `/admin/billing?tab=invoices` (1 key)
- `tab_billing_invoices` — "Hoá đơn" / "Invoices"

### `/admin/identity` (1 key)
- `toggle_external_invites` — "Cho phép lời mời từ miền bên ngoài" / "Allow External Domain Invites"

**Tổng 18 step** = 18 `step()` call trong orchestrator (mỗi key 1 step + step navigate).

## 5. Luồng `executeHarvestLabels` (entry)

```
┌─────────────────────────────────────────────────────────────────┐
│ executeHarvestLabels(taskId, locale)                            │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ Report "starting" 0/18      │ ← SIGNAL ngay khi inject (v0.3.2)
              │   → dashboard biết extension│   dashboard không bị im lặng 5-30s
              │     đã nhận task            │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ Check pathname /admin       │ → fail PAGE_NOT_ADMIN
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ Verify locale ChatGPT khớp  │
              │   document.documentElement  │
              │     .lang startsWith(locale)│
              │   → fail VERIFY_FAILED nếu  │
              │     mismatch                │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ pages = [4 empty pages]     │
              │ ctx = {taskId, startedAt,   │
              │   scanned:0, step:0,        │
              │   totalSteps:18}            │
              │                             │
              │ guard = setTimeout(180_000):│
              │   timedOut = true           │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ runStep helper:             │
              │   if timedOut return        │
              │   try fn() catch:           │
              │     step(ctx, "⚠ X bị lỗi") │ ← log + tăng step counter
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ runStep harvestMembers      │ ← 11 key trong page này
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ runStep harvestBillingPlan  │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ runStep harvestBilling      │
              │   Invoices                  │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ runStep harvestIdentity     │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ clearTimeout(guard)         │
              │ step("Quay về /admin/       │ ← step cuối + navigate idle
              │   members (scanned X)")     │
              │ navigateSpaVerified(        │
              │   /admin/members)           │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ total = sum(pages.labels    │
              │   .length)                  │
              │                             │
              │ if total === 0:             │
              │   → fail UI_ELEMENT         │
              │                             │
              │ return ok=true, data={      │
              │   harvest: {locale, pages}, │
              │   total, elapsed_sec,       │
              │   timed_out                 │
              │ }                           │
              └─────────────────────────────┘
```

## 6. Luồng `harvestMembers` (page lớn nhất)

```
1. navigateSpaVerified("/admin/members")
   - Skip page nếu nav fail
2. step "Đọc 3 tab Members":
   - for 3 tab → recordIfText (tab_active_members, tab_pending_invites, tab_pending_requests)
3. step "Mở dialog Mời thành viên":
   - inviteOpen = findUiControlByTexts(inviteButtonOpen)
   - recordIfText(invite_button_open, inviteOpen)
   - humanClick(inviteOpen) + waitForDialog 4s
   - Nếu dialog mở:
     a. step "Đọc nút Submit + Add-more":
        - submit = queryByAnyText("button", inviteSubmitButton, dialog)
        - addMore = queryByAnyText("button" || "a", inviteAddMoreButton, dialog)
        - recordIfText invite_submit_button + invite_add_more_button
     b. step "Mở dropdown Role → đọc 3 option":
        - roleSelect = querySelectorFirst(inviteRoleSelect, dialog)
        - Nếu Radix combobox: humanClick(roleSelect) + sleep 700ms
          for owner/admin/member: queryByAnyText [role=menuitem|option|menuitemradio|li]
          ROLE_LABELS[role] → recordIfText invite_role_<role>
          pressEscape sau khi xong
        - Nếu native <select>: iterate sel.options, match value hoặc text.includes(role)
     c. pressEscape + waitForDialogClose
   - Nếu dialog không mở: step "⚠ Dialog Invite không mở (skip)"
4. step "Tìm row member để mở menu ...":
   - rows = SELECTORS.memberRow scan
   - targetRow = rows[last]
   - Nếu có row:
     - menuBtn = findRowMenuButton(targetRow)
     - recordIfText member_row_menu_button (có aria_label)
     - humanClick(menuBtn) + waitForMenu + sleep 300ms
     - step "Đọc menu items Remove / Change role":
       - removeItem = queryByAnyText([role=menuitem], removeMenuItem)
       - changeItem = queryByAnyText([role=menuitem], changeRoleMenuItem)
       - recordIfText menu_remove_member + menu_change_role
     - Nếu có removeItem:
       - step "Mở confirm Remove (sẽ ESC để hủy)"
       - humanClick(removeItem) + waitForDialog 3s
       - confirmBtn = queryByAnyText("button", confirmRemoveButton, confirmDialog)
       - recordIfText confirm_remove_button
       - pressEscape (KHÔNG xoá thật) + waitForDialogClose
   - Nếu không có row: step "⚠ Workspace chưa có member nào (skip row menu)"
5. harvestRevokeFlow(ctx, out) — xem phần dưới
```

## 7. Luồng `harvestRevokeFlow` + probe invite

Tab "Lời mời đang chờ xử lý" có thể trống → KHÔNG có row nào để mở menu Revoke → KHÔNG harvest được `menu_revoke_invite` + `confirm_revoke_button`. **Workaround (v0.4.0):** tự tạo invite probe để có row, harvest xong rồi cleanup.

```
1. step "Switch tab Pending → đọc menu Revoke"
   - pendingTab = findUiControlByTexts(tabPendingInvites)
   - humanClick(pendingTab) + sleep 1500ms
2. pendingRows = findPendingRows()
3. Nếu pendingRows.length === 0:
   - probeEmail = createProbeInvite(ctx):
     a. step "Tạo probe invite tạm để harvest revoke labels"
     b. Switch tab Người dùng (active tab)
     c. inviteOpen + humanClick + waitForDialog
     d. input = dialog.querySelector(email/text/textarea)
     e. probeEmail = `autogpt-probe-${Date.now()}@example.com`
        (example.com là RESERVED domain — ChatGPT accept format
         nhưng email KHÔNG deliver → an toàn)
     f. humanType(input, probeEmail) + sleep 600ms
     g. submit = queryByAnyText("button", inviteSubmitButton, dialog)
     h. humanClick(submit) + sleep 2500ms
     i. pressEscape nếu dialog còn mở
     j. return probeEmail (hoặc null nếu fail)
   - Nếu probe null: step "⚠ skip" + return
   - Switch lại tab Pending + sleep 1800ms
   - pendingRows = findPendingRows()
4. pendingRow = probeRow (nếu có probeEmail match) hoặc rows[0]
5. Nếu pendingRow null:
   - step "⚠ Probe đã tạo nhưng row chưa xuất hiện"
   - cleanupProbeInvite (xem dưới)
   - return
6. pMenuBtn = findRowMenuButton(pendingRow)
7. humanClick(pMenuBtn) + waitForMenu + sleep 300ms
8. revokeItem = queryByAnyText([role=menuitem], REVOKE_MENU_ITEM_TEXTS)
   recordIfText(menu_revoke_invite, revokeItem)
9. Nếu revokeItem:
   - humanClick(revokeItem) + waitForDialog 2.5s
   - cBtn = queryByAnyText("button", REVOKE_CONFIRM_TEXTS, cDialog)
   - recordIfText(confirm_revoke_button, cBtn)
   - Nếu là probe + có cBtn:
     a. step "Cleanup: thu hồi probe (click confirm thật)"
     b. humanClick(cBtn) + sleep 1500ms  ← REVOKE THẬT để không leave probe
   - Nếu là invite thật:
     a. pressEscape (KHÔNG xoá invite của user)
     b. waitForDialogClose
10. Nếu KHÔNG có revokeItem + có probe:
    - cleanupProbeInvite(ctx, probeEmail) — vẫn cleanup
```

## 8. Luồng `harvestIdentity` — toggle "Allow External Domain Invites"

`/admin/identity` có nhiều toggle (vd "Automatic Account Creation"). Phải pick ĐÚNG cái external invites bằng best-match scoring.

```
1. navigateSpaVerified("/admin/identity") + sleep 1200ms
2. SWITCH_SEL = 'button[role="switch"], input[type="checkbox"]'
3. switches = document.querySelectorAll(SWITCH_SEL)
4. cands[] = []
5. for each switch el:
   - Walk up max 8 cấp tìm ROW (ancestor lớn nhất chỉ chứa 1 switch)
   - raw = row.textContent (lowercase, trim, normalize whitespace)
   - Nếu raw includes 1 trong EXTERNAL_INVITE_EXCLUDE_PATTERNS (vd "automatic account creation") → skip
   - Tính bestLen = max length pattern match từ EXTERNAL_INVITE_LABEL_PATTERNS
   - Nếu bestLen > 0 → cands.push({el, row, raw, hit, score:bestLen})
6. Nếu cands.length === 0 → return (không harvest)
7. Sort cands theo score desc → winner = cands[0]
8. Tách câu (split by `[.。?!？!]` hoặc `[•·]` boundary)
9. cand = sentence chứa hit, hoặc raw nếu không tách được
10. clipped = cand.slice(0, 180) nếu dài
11. out.push({
      control_key: "toggle_external_invites",
      label_text: clipped,
      aria_label: pickAria(winner.el)
    })
12. ctx.scanned += 1
```

## 9. Selectors & i18n

Phần lớn dùng helper từ [`i18n-ui.ts`](../../i18n-ui.ts):
- `findUiControlByTexts(texts)` — tìm element có text match
- `ROLE_LABELS[role]` — array text vi/en/zh cho mỗi role
- `EXTERNAL_INVITE_LABEL_PATTERNS` + `EXTERNAL_INVITE_EXCLUDE_PATTERNS`
- `REVOKE_MENU_ITEM_TEXTS` + `REVOKE_CONFIRM_TEXTS`

Selectors từ [`selectors.ts`](../../selectors.ts) `TEXT_FALLBACKS` cho 11 control:
- `tabActiveMembers`, `tabPendingInvites`, `tabPendingRequests`
- `inviteButtonOpen`, `inviteSubmitButton`, `inviteAddMoreButton`
- `tabBillingPlan`, `tabBillingInvoices`
- `removeMenuItem`, `changeRoleMenuItem`
- `confirmRemoveButton`

`SELECTORS.memberRow` + `SELECTORS.inviteRoleSelect` CSS selectors.

## 10. Backend processing (sau khi return)

Background runner [`runner.ts:reportToBackend`](../../../background/runner.ts) detect `task.type === "HARVEST_LABELS"` + `data.harvest`:
1. Gọi `postHarvestLabels(config, harvest)` → backend `POST /api/v1/ui-labels/harvest`.
2. Backend upsert mỗi `(locale, page, control_key)` row vào `ui_labels` table (unique constraint).
3. Backend trả `{locale, total, pages}` → extension store vào `task.result` cho dashboard hiển thị.
4. **Dashboard sau khi save** → post message bridge `refresh-labels` → background SW `refreshLabelBundle()` → fetch `/api/v1/ui-labels/bundle` → `chrome.storage.local` cập nhật → content script reload cache (<500ms, v0.4.11).

## 11. Lịch sử sửa lỗi & quyết định thiết kế

### Timeline đầy đủ (từ CHANGELOG)

#### **v0.2.0 (2026-05-18) — release đầu (UI Label calibration)**
- Cơ chế UI label calibration ra mắt — extension fetch `/ui-labels/bundle` định kỳ 15 phút, cache vào `chrome.storage`.
- Actions ưu tiên label đã harvest cho (locale × page) hiện tại; fallback hardcoded text patterns nếu DB rỗng.
- Tự động POST `/report-mismatch` khi tìm element fail dù DB có label → dashboard banner stale.
- Wire DB lookup: invite open/submit/add-more, tabs, role options, menu remove/change-role, confirm remove/revoke, toggle external invites.
- **Tại thời điểm này, harvest còn THỦ CÔNG:** admin paste Console snippet vào DevTools ChatGPT tab.

#### **v0.3.0 (2026-05-18) — 🔴 feature: HARVEST_LABELS auto-crawl**
- Action `HARVEST_LABELS` ra mắt — extension tự navigate 4 page (`/admin/members`, `/admin/billing`, `/admin/billing?tab=invoices`, `/admin/identity`), mở invite dialog + click `...` menu + đọc confirm dialog rồi ESC để hủy → đọc 18 control_key cho 1 locale.
- Dashboard Settings → UI Labels: nút "Harvest VI/EN/ZH" thay thế Console snippet thủ công.
- Endpoint mới `POST /api/v1/ui-labels/harvest` (X-API-KEY) cho extension bulk-upsert đa page.
- `POST /api/v1/workspaces/{id}/harvest-labels` (super-admin) tạo task qua SSE.

#### v0.3.1 (2026-05-18) — progress real-time + nav verify + 3 phút timeout
- Per-step progress (`current/total/scanned/elapsed_sec`) — dashboard hiện progress bar + step counter.
- `navigateSpaVerified`: kiểm tra `location.pathname` đổi thật sự sau pushState; **skip page** nếu nav fail thay vì hang.
- Global **3 phút** timeout (`MAX_HARVEST_MS=180_000`) — harvest tự thoát nếu kẹt.
- Trả error "không lấy được label nào" nếu `total=0` sau crawl (thường do user chưa F5 hoặc selector lệch).
- JSON.parse hardening — backend 5xx không crash extension cache refresh.

#### v0.3.2 (2026-05-18) — progress lifecycle (background) + initial signal
- Background runner báo progress sớm: `queued` → `opening_tab` → `rate_limit` **TRƯỚC** cả khi gửi tới content script. Trước đây dashboard im lặng 5–30s khi extension tự mở tab `chatgpt.com/admin` + inject content script.
- Content script báo signal `starting` ngay tại `0/18` trước locale check — dashboard có gì hiện ngay khi inject.
- Dashboard hiển thị status badge (`PENDING`/`IN_PROGRESS`), elapsed timer cục bộ ticking 1s, watchdog cảnh báo sau 20s nếu không thấy signal nào.
- Áp dụng cùng pattern progress lifecycle cho `SYNC_DATA`.

#### **v0.4.0 (2026-05-18) — 🔴 feature: probe-invite mode (100% locale coverage)**
- **Bug:** workspace chưa có pending invite → tab "Lời mời" trống → KHÔNG harvest được `menu_revoke_invite` + `confirm_revoke_button`. Coverage < 100% cho workspace mới.
- **Fix:** khi tab Pending trống, harvest **tự tạo invite probe** (`autogpt-probe-{ts}@example.com`) → harvest menu Revoke + confirm Revoke → **tự thu hồi probe** để workspace sạch.
- `example.com` là domain RESERVED (RFC 2606) → ChatGPT accept format nhưng email không deliver — an toàn không spam ai.
- Bỏ `member_row_menu_button` khỏi expected list (icon-only, không có text — CSS selector handle).
- Coverage giờ 14 control_key/page Members (thay vì 15) → 18 tổng → đạt 100% nếu probe-invite chạy được.

#### v0.4.2 (2026-05-19) — exclude "Automatic Account Creation" cho identity page
- Cùng fix với `external-invites` wrapper — `harvestIdentity` áp dụng cùng heuristic exclude pattern + best-match scoring để KHÔNG ghi nhầm label "Automatic Account Creation" vào DB.

#### v0.4.4 (2026-05-19) — text mapping mở rộng đa ngôn ngữ
- ChatGPT đổi dialog Invite layout 3-column. Update `TEXT_FALLBACKS` cho:
  - `inviteSubmitButton`: thêm plural "Send invites", "Send invitations", "发送邀请"
  - `inviteAddMoreButton`: thêm "Add another member", "Add row", "Thêm dòng"
  - `changeRoleMenuItem`: thêm "Change seat type", "Edit seat type"
- Áp dụng cho `harvestMembers` qua `TEXT_FALLBACKS.*`.

#### v0.4.11 (2026-05-19) — push-based refresh bundle (dashboard sửa DB → extension <500ms)
- **Bug cũ:** admin sửa 1 row UI label qua Settings → DB update OK nhưng extension vẫn dùng label cũ tới 15 phút sau (alarm tick mới refresh bundle). Tạo cảm giác "sửa DB không hoạt động".
- **Fix 1 — push-based:** dashboard sau save/clear-stale/harvest done → post message bridge `refresh-labels` → background SW `refreshLabelBundle()` → fetch bundle mới → `chrome.storage.local` cập nhật → content script reload cache. Thời gian: **<500ms**.
- **Fix 2 — defensive pull:** `REFRESH_INTERVAL_MIN` giảm 15 → **2 phút**. Phòng trường hợp extension chạy ở browser KHÁC dashboard (vd MoreLogin chứa extension, Edge chứa dashboard) → bridge không tồn tại → message bị drop, alarm 2 phút fallback.
- Helper mới `requestExtensionRefreshLabels()` trong [`useExtensionTrigger.ts`](../../../../../web/src/hooks/useExtensionTrigger.ts).

### Bảng tóm tắt

| Version | Loại | Tóm tắt |
|---------|------|---------|
| v0.2.0 | feature | UI Label calibration cơ chế (harvest THỦ CÔNG via Console) |
| **v0.3.0** | **🔴 feature** | **`HARVEST_LABELS` action auto-crawl 4 page × 18 key** |
| v0.3.1 | fix | Progress real-time + nav verify + 3 phút timeout |
| v0.3.2 | fix | Progress lifecycle background + initial signal |
| **v0.4.0** | **🔴 feature** | **Probe-invite mode (workspace trống vẫn 100% coverage)** |
| v0.4.2 | fix | Exclude "Automatic Account Creation" cho identity page |
| v0.4.4 | fix | Mở rộng text mapping đa ngôn ngữ (plural send invites, etc) |
| v0.4.11 | fix | Push-based refresh bundle <500ms + alarm 2 phút fallback |

> **🔥 Symptom debug nhanh:**
> - Harvest treo IN_PROGRESS > 3 phút → `MAX_HARVEST_MS=180_000` guard fail, hoặc browser tab bị suspend. Kiểm tra DevTools service worker còn alive không.
> - `VERIFY_FAILED` "locale ChatGPT đang là 'en' nhưng admin yêu cầu 'vi'" → user chưa đổi ChatGPT Settings + F5. Hướng dẫn rõ trong error message.
> - `UI_ELEMENT_NOT_FOUND` "Quét xong nhưng không lấy được label nào" → tất cả 4 page nav fail, hoặc tất cả selector miss. Check `[autogpt-harvest] DONE — scraped 0 labels`.
> - Probe invite không cleanup → workspace có row `autogpt-probe-xxx@example.com` rác. Cleanup probe trong `harvest-revoke-flow.ts` có thể fail nếu menu/dialog không mở. Admin manually revoke từ tab Lời mời.
> - Harvest coverage < 18 → 1 hoặc nhiều control miss. Check log từng step `[X/18] ⚠ ...` để biết bước nào fail. Có thể do ChatGPT đổi UI hoặc tab pending workspace không trống nhưng probe miss row.
> - `harvestIdentity` bắt nhầm toggle (vd "Automatic Account Creation" thay vì external invites) → `EXTERNAL_INVITE_EXCLUDE_PATTERNS` thiếu pattern mới. Update [`i18n-ui.ts`](../../i18n-ui.ts).
> - Dashboard sửa label DB nhưng extension chưa dùng → check (1) `chrome.storage` có data mới chưa (DevTools → Application → Storage), (2) bridge message `refresh-labels` có gửi không, (3) extension + dashboard cùng browser profile.

## 12. Fail mode & error code

| Mã | Khi nào | Cách fix |
|----|---------|----------|
| `PAGE_NOT_ADMIN` | URL không chứa `/admin` | Mở `chatgpt.com/admin/members` thủ công |
| `VERIFY_FAILED` (locale mismatch) | `document.documentElement.lang` không match `locale` param | User đổi ChatGPT Settings → Personalization → Language + F5 |
| `UI_ELEMENT_NOT_FOUND` (total=0) | 4 page nav fail hoặc selector miss toàn bộ | Verify đang ở ChatGPT admin + UI chưa đổi hoàn toàn |

> **Partial success:** task ok=true với `timed_out=true` nếu `MAX_HARVEST_MS` hit. `total` có thể < 18 — admin retry sau khi fix nguyên nhân (vd network slow).

## 13. Test thủ công

```
1. Test full coverage locale VI:
   - ChatGPT lang VI (xác minh document.documentElement.lang = "vi")
   - F5 ChatGPT admin
   - Dashboard → Settings → UI Labels → click "Harvest VI"
   - Verify DevTools Console:
     - "[autogpt-harvest] START locale=vi"
     - "[autogpt-harvest] DONE — scraped 18 labels in Xs"
   - Verify dashboard: UI Labels page hiển thị 18 row cho locale VI

2. Test workspace empty pending:
   - Workspace không có pending invite
   - Harvest VI
   - Verify Console:
     - "[autogpt-harvest] [X/18] Tạo probe invite tạm để harvest revoke labels"
     - probeEmail = autogpt-probe-1716XXX@example.com
     - "[X/18] Cleanup: thu hồi probe (click confirm thật)"
   - Verify ChatGPT /admin/members tab Lời mời: KHÔNG có row probe sau task xong

3. Test locale mismatch:
   - ChatGPT lang EN
   - Harvest VI
   - Verify error_code='VERIFY_FAILED' + message rõ hướng dẫn

4. Test partial coverage:
   - Tạo task harvest khi ChatGPT đang loading (chưa render)
   - Verify task ok=true với total < 18
   - Verify dashboard show số label scraped

5. Test push refresh:
   - Sau harvest success, mở extension popup
   - Verify Console SW: "[autogpt-bg] refresh-labels-result ok=true"
   - Verify content script log: "[autogpt-content] loaded X UI labels vY"
   - Thời gian từ harvest done → content reload < 500ms

6. Test edge case identity exclude:
   - `/admin/identity` có 2 toggle "External Invites" + "Automatic Account Creation"
   - Verify `toggle_external_invites` label = "Cho phép lời mời từ miền bên ngoài" (đúng cái external)
   - Verify KHÔNG có row với label "Automatic Account Creation"
```
