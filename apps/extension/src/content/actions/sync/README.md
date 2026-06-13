# Logic chi tiết: `SYNC_DATA` action

> **Folder:** [`apps/extension/src/content/actions/sync/`](./)
> **Trigger:** background runner gửi `ExecuteActionRequest` `{ kind: "SYNC_DATA", taskId, includePending, expectedLocale }`
> **Mục đích:** scrape toàn bộ member của workspace ChatGPT Business — 3 tab (Người dùng / Lời mời / Yêu cầu) — về dashboard. Là action **dài nhất và phức tạp nhất** của extension (5 phút hard cap).

## 1. Public API

```ts
// sync/index.ts (barrel)
export { executeSync } from "./execute-sync";
export { clickTabAndWait } from "./click-tab-and-wait";                      // dùng bởi invite, remove
export { scrapePendingInvitesAfterInvite } from "./scrape-pending-after-invite"; // dùng bởi invite Phase 2

// execute-sync.ts
export async function executeSync(
  taskId: string,
  includePending: boolean = true,
  expectedLocale: ChatGPTLocale | null = null,
): Promise<ExecuteActionResponse>
```

- `taskId`: ID task để report progress.
- `includePending`: nếu `false` chỉ scrape tab "Người dùng" (active). Default `true`.
- `expectedLocale`: `'vi' | 'en' | 'zh' | null`. Dashboard truyền lang hiện tại để extension check ChatGPT đang dùng locale gì. `null` = không check.

**Trả về:**
- `{ ok: true, data: { members: ScrapedMember[], user_info, elapsed_ms } }` khi scrape OK.
- `{ ok: false, error_code: "PAGE_NOT_ADMIN" | "LANGUAGE_MISMATCH" | "UI_ELEMENT_NOT_FOUND" | "TIMEOUT" }` khi fail.

## 2. Use case

3 nguồn trigger:
1. **Dashboard:** admin click "Sync" trên trang Members → `POST /workspaces/{id}/sync?expected_locale=vi` → backend tạo task.
2. **Initial setup:** lần đầu kết extension với workspace → auto enqueue `SYNC_DATA` để fill data.
3. **Periodic:** chưa implement auto-schedule, hiện chỉ user-triggered.

## 3. Cấu trúc folder (sau Pha 4)

```
sync/
├── index.ts                          # Barrel: 3 export (executeSync, clickTabAndWait, scrapePendingInvitesAfterInvite)
├── execute-sync.ts                   # Entry — multi-tab orchestration (~180 dòng)
├── click-tab-and-wait.ts             # clickTabAndWait + findTabButton (private)
├── scrape-current-tab.ts             # scrapeCurrentTab + scrollUntilAllLoaded + MAX_SYNC_MS const
├── scrape-all-rows.ts                # scrapeAllRows + countEmailsInSubtree (private)
├── scrape-pending-after-invite.ts    # scrapePendingInvitesAfterInvite (dùng bởi invite Phase 2)
└── row-extractors/
    ├── email.ts                      # EMAIL_FULL_RE + EMAIL_EXTRACT_RE_G + extractSingleEmail + findEmailTextNode
    ├── joined-at.ts                  # DATE_RE + EN_MONTHS_SYNC + findJoinedAtInRow + parseDateMulti + buildIso
    └── name.ts                       # findNameInRow
```

## 4. Luồng xử lý chính — `executeSync`

```
┌─────────────────────────────────────────────────────────────────┐
│ executeSync(taskId, includePending=true, expectedLocale=null)   │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ Check pathname /admin       │ → fail PAGE_NOT_ADMIN
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ detectChatGPTLocale() +     │
              │ checkLocaleMatch(expected)  │ → log warning nếu mismatch
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ Nếu pathname KHÔNG có       │
              │   /admin/members:           │
              │ → click <a href> sidebar    │
              │ → fallback pushState        │
              │ → poll findTabButton 20×500ms│
              │ → fail PAGE_NOT_ADMIN nếu   │
              │   sau 10s vẫn không thấy   │
              │   tab buttons               │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ merged = new Map<email,     │  ← Sau khi scrape 3 tab, merge
              │   ScrapedMember>()          │    theo email. Tab active scrape
              │ startedAt = Date.now()      │    CUỐI để status="active" thắng.
              │ isOverTime = () => > 5min   │
              └─────────────────────────────┘
                            │
                            ▼
                  includePending? ────── NO ──┐
                            │ YES               │
                            ▼                   │
              ┌─────────────────────────────┐  │
              │ TAB 1: "Lời mời"            │  │
              │ clickTabAndWait(            │  │
              │   "tab_pending_invites")    │  │
              │ scrapeCurrentTab(           │  │
              │   status="pending", label)  │  │
              │ → merged.set per email      │  │
              └─────────────────────────────┘  │
                            │                   │
                            ▼                   │
              ┌─────────────────────────────┐  │
              │ TAB 2: "Yêu cầu"            │  │
              │ clickTabAndWait(            │  │
              │   "tab_pending_requests")   │  │
              │ scrapeCurrentTab(           │  │
              │   status="pending")         │  │
              │ → merged.set per email      │  │
              └─────────────────────────────┘  │
                            │                   │
                            ▼                   │
                            └───────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ TAB 3: "Người dùng" (CUỐI)  │
              │ clickTabAndWait(            │
              │   "tab_active_members")     │
              │ scrapeCurrentTab(           │
              │   status="active")          │
              │ → merged.set (override      │
              │   pending nếu email trùng) │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ members = [...merged]       │
              │ elapsedMs = now - startedAt │
              │ timedOut = isOverTime()     │
              └─────────────────────────────┘
                            │
                            ▼
                   members.length === 0?
                            │
              ┌── YES ──────┴───── NO ───┐
              ▼                            ▼
   return UI_ELEMENT_NOT_FOUND     timedOut?
   (hoặc LANGUAGE_MISMATCH nếu              │
   locale mismatch)              ┌── YES ───┴──── NO ──┐
                                  ▼                       ▼
                       return TIMEOUT     return { ok: true,
                                            data: { members, user_info,
                                            elapsed_ms } }
```

## 5. Luồng `scrapeCurrentTab(taskId, status, label, isOverTime)` — scrape 1 tab

```
1. Report "discover" — "[label] Đang quét..."
2. Scroll về top (0, behavior: "auto") + sleep 400ms
3. Call scrollUntilAllLoaded()
   - Tìm scrollable containers (window + bất kỳ div nào có overflowY=auto/scroll)
   - Loop max 200 iter: scroll xuống cuối từng container
   - Stable detect: 3 lần liên tiếp scrapeAllRows().length không tăng → break
4. Scroll về top lại + sleep 400ms
5. Loop scroll-pass (200 max):
   - Check isOverTime() → break timedOut=true
   - visible = scrapeAllRows() → merge vào collected Map
   - Scroll xuống window.innerHeight * 0.8
   - Sleep 250-450ms
   - Re-scrape sau scroll → merge tiếp
   - Report progress "scraping" với current count
   - Stable detect 4+ passes: nếu count không tăng + at-bottom → break
6. return { members: [...collected], timedOut }
```

> **Tại sao 2-phase scroll (scrollUntilAllLoaded + scroll-pass loop)?**
> - Phase 1 (scrollUntilAllLoaded) đảm bảo virtualized list load hết DOM.
> - Phase 2 (loop scroll-pass) thực sự scrape qua từng viewport — vì ChatGPT virtualize, các row scroll out viewport bị unmount khỏi DOM → chỉ scrape được khi visible.
> - Phase 1 hữu ích để **trigger load** lên server-side, phase 2 thu thập từng đợt.

## 6. Luồng `scrapeAllRows()` — scrape DOM hiện tại

2 chiến lược song song:

### Strategy 1 — selector có cấu trúc (data-testid)
```
for sel of SELECTORS.memberRow:  // ["[data-testid=...]", v.v.]
  rows = document.querySelectorAll(sel)
  if rows.length === 0 continue
  for row of rows:
    found = findEmailTextNode(row)
    if found && !seen.has(email):
      seen.add(email)
      members.push({email, name, chatgpt_role, status, joined_at})
  if members.length > 0 return members
```
> Hiện ChatGPT KHÔNG có `data-testid` ổn định → strategy này thường miss. Giữ làm fallback cho future ChatGPT release.

### Strategy 2 — TreeWalker SHOW_TEXT toàn DOM (fallback chính)
```
walker = createTreeWalker(document.body, SHOW_TEXT)
while node = walker.nextNode():
  text = node.nodeValue.trim()
  if EMAIL_FULL_RE.test(text) && text.length <= 100:
    fullMatchHits += 1
    candidates.push({email: text.lowercase(), node})
  else:
    extracted = extractSingleEmail(text)  // EMAIL_EXTRACT_RE_G, length<200, exactly 1 match
    if extracted:
      extractMatchHits += 1
      candidates.push({email: extracted, node})

for {email, node} of candidates:
  if seen.has(email) continue
  seen.add(email)

  // Walk up tìm row chứa email; stop khi parent chứa >1 email
  row = node.parentElement
  for i in 0..6:
    parent = row.parentElement
    if countEmailsInSubtree(parent) > 1 break  // tránh nuốt row khác
    row = parent

  members.push({email, name, chatgpt_role, status, joined_at})

console.log diagnostic: textNodesScanned + fullMatchHits + extractMatchHits + unique
return members
```

### Row extractors (3 file riêng)
- **`row-extractors/email.ts`:** 2 regex (`EMAIL_FULL_RE` exact, `EMAIL_EXTRACT_RE_G` substring) + `extractSingleEmail` + `findEmailTextNode`.
- **`row-extractors/joined-at.ts`:** `DATE_RE` đa ngôn ngữ (vi/zh/en) + parse "17 thg 5, 2026" / "2026年5月17日" / "May 17, 2026" → ISO string.
- **`row-extractors/name.ts`:** walk text nodes, loại trừ email/date/role/license/avatar (≤3 chars), trả về first qualifying text.

## 7. Luồng `scrapePendingInvitesAfterInvite(taskId, forceReload=false)` — quick scrape sau invite

Dùng bởi `executeVerifyPendingInvite` (Phase 2 của INVITE_MEMBER) sau khi background F5 tab. **KHÔNG navigate, KHÔNG scrape các tab khác** — chỉ tab "Lời mời".

```
1. Check pathname /admin/members → empty array nếu sai
2. Nếu forceReload=true:
   - clickTabAndWait("tab_active_members", 800ms)  // bounce qua Người dùng
   - ChatGPT re-mount component → useEffect / SWR re-trigger → list mới
3. clickTabAndWait("tab_pending_invites", forceReload ? 2500 : 1500)
4. scrapeCurrentTab(status="pending", label="Map lời mời")
   - isOverTime hard cap 60s
5. CHỦ Ý không click lại "Người dùng" — extension dừng tại tab "Lời mời" để user
   mở tab admin lên thấy ngay email vừa mời (xem v0.6.2 changelog)
6. return members[]
```

## 8. Selectors & i18n

### 3 tab buttons
| Tab | DB key | Text fallback |
|-----|--------|---------------|
| Người dùng | `tab_active_members` | "Người dùng", "Active members", "Members", "用户" |
| Lời mời | `tab_pending_invites` | "Lời mời đang chờ xử lý", "Pending invites", "Invites", "待处理邀请" |
| Yêu cầu | `tab_pending_requests` | "Yêu cầu đang chờ xử lý", "Pending requests", "Requests", "待处理请求" |

### Email/date/name extractors
- Regex hardcoded — không calibrate qua DB (vì format chuẩn quốc tế).
- Locale-aware date parsing: vi `"DD thg M, YYYY"`, zh `"YYYY年M月D日"`, en `"Mon DD, YYYY"`.

## 9. Backend processing (sau khi return)

Background runner [`runner.ts:reportToBackend`](../../../background/runner.ts) detect `task.type === "SYNC_DATA"` + `data.members`:

1. Update `workspace.connected_chatgpt_user_email/name` từ `data.user_info` (best-effort).
2. Chunked `bulkUpsertMembers(workspace_id, chunk, { scrapedStatuses })`:
   - `scrapedStatuses=["active", "pending"]` nếu `includePending=true`
   - `scrapedStatuses=["active"]` nếu `includePending=false`
   - Backend reconcile: email không trong scrape → mark `status='removed'` (CHỈ trong scope `scrapedStatuses`).
3. Aggregate `rogue_pending_emails` (pending trên ChatGPT mà KHÔNG có Member record) → đưa vào `task.result` cho dashboard hiển thị.
4. Update task status `COMPLETED` với `{ total, created, updated, chunks, rogue_pending_emails }`.

## 10. Lịch sử sửa lỗi & quyết định thiết kế

### Timeline đầy đủ (từ CHANGELOG)

#### v0.1.0 (2026-05-18) — release đầu
- Action `SYNC_DATA` ra mắt. Flow đơn giản: navigate `/admin/members` → click 3 tab → scrape DOM → return.

#### v0.2.0 (2026-05-18) — wire DB label lookup cho 3 tab
- `tab_active_members`, `tab_pending_invites`, `tab_pending_requests` lookup DB trước fallback text.

#### v0.4.6 (2026-05-19) — locale mismatch detection + anchor-click navigation
- **Bug:** sync trả 0 row nhưng error message không rõ — user không biết lỗi là gì.
- **Fix:** `SYNC_DATA` nhận `expectedLocale` (`'vi'|'en'|'zh'`) từ payload. Dashboard mapping `vi→vi`, `zh-CN→zh`.
- Helper mới `detectChatGPTLocale()` đọc `document.documentElement.lang` → normalize. `checkLocaleMatch(expected)` compare + tạo hint message với instruction đổi ChatGPT Settings → Locale.
- Khi sync trả 0 row VÀ locale mismatch → error_code mới `'LANGUAGE_MISMATCH'` với message hướng dẫn cụ thể.
- **Navigation cải tiến:** ưu tiên click `<a href>` trong sidebar (Next.js router catches reliably) trước fallback `pushState` — khắc phục case admin tab đang ở `/admin/billing` mà `pushState` không trigger re-render.

#### **v0.4.7 (2026-05-19) — 🔴 FIX SCRAPER MISS EMAIL: EMAIL_EXTRACT_RE_G fallback**
- **Bug:** scraper chỉ dùng `EMAIL_FULL_RE` (text node EXACT email). ChatGPT 2026 đôi khi concat avatar+name+email vào 1 text node (vd `"B b yaakovajax0054@outlook.com"`) → miss row.
- **Fix:** thêm fallback `EMAIL_EXTRACT_RE_G` — extract email từ text node chứa email cùng tên/avatar. Constraint: chỉ extract khi có **đúng 1 match** trong text + `length < 200` để không nuốt nhiều email/paragraph.
- **Diagnostic logging:** scrape log tổng `textNodesScanned + fullMatchHits + extractMatchHits + unique` → debug dễ hơn khi sync trả 0 row.
- **Delay -70%** toàn bộ (`human.ts` `DELAY_MULTIPLIER = 0.30`): user feedback "extension cứ xoay mãi" = chậm.
- **⚠ Backend pair:** `app/main.py` tự chạy `alembic upgrade head` trên startup → khắc phục case migration 0009 chưa apply.

#### v0.4.8 (2026-05-19) — feature: scrapePendingInvitesAfterInvite reusable
- **Use case mới:** sau khi invite verify thành công, click tab "Lời mời đang chờ xử lý" → scrape pending → map về dashboard. Đây là **scope hẹp**: KHÔNG scrape các tab khác, KHÔNG đụng `status='active'` của member khác.
- Reusable export `scrapePendingInvitesAfterInvite(taskId)` trong sync.ts — caller bắt buộc đã ở `/admin/members`, hard cap 60s, không bao giờ throw.
- Phase mới `mapping` trong `reportProgress`.

#### v0.4.19 (2026-05-19) — billing scraper over-limit (không liên quan SYNC_DATA, nhưng cùng file scrapers/billing.ts)
- Xem [../sync-billing/README.md](../sync-billing/README.md) section v0.4.19.

#### v0.6.2 (2026-05-20) — KHÔNG bounce-back tab "Người dùng" sau scrapePendingInvitesAfterInvite
- **Bug:** trước v0.6.2 sau scrape pending xong, extension click lại tab "Người dùng" để idle ở trang quen thuộc. Hậu quả: user mở browser tab admin lên + click "Lời mời" → ChatGPT re-mount component + có thể serve từ React Query cache stale → **KHÔNG thấy email vừa mời, phải F5**.
- **Fix:** extension giờ DỪNG TẠI tab "Lời mời đang chờ xử lý" sau verify cuối cùng — DOM đã render data tươi (extension vừa scrape) nên user mở tab admin lên là thấy ngay.
- Task sau (REMOVE/CHANGE_ROLE) tự click tab "Người dùng" qua `findControlByKey`, không lệ thuộc end-state này.

#### v0.6.4 (2026-05-20) — bulk-upsert `isFullSync` option (fix bug a12 bị mark removed oan)
- **Bug `a12` "biến mất":** User invite `a12` (08:34) → ChatGPT nhận thật. Sau invite `g12` (08:37) extension verify scrape tab "Lời mời" tại 08:38 chỉ thấy `g12` (a12 chưa được ChatGPT index về client) → bulk-upsert với `scrapedStatuses=['pending']` → backend reconcile mark `a12=removed` oan.
- Phantom cleanup INVITE_MEMBER vẫn đúng (`verify_scrape_failed=true` → giữ); lỗi nằm ở **bulk-upsert dùng chung endpoint** cho cả full sync + verify after invite.
- **Fix 1 — Extension:** thêm option `isFullSync=false` vào `bulkUpsertMembers`, bỏ `scrapedStatuses`. Backend nhận `is_full_sync=false` → CHỈ upsert email trong payload, KHÔNG reconcile.
- **Fix 2 — Backend defense-in-depth** [`members.py:bulk_upsert_members`](../../../../../api/app/routers/members.py): reconcile `WHERE NOT (invited_by_user_id IS NOT NULL AND created_at > NOW() - INTERVAL '10 minutes')`. Nếu extension lỡ gửi `is_full_sync=true` sau khi vừa invite, member mới vẫn an toàn.
- **UX SPEEDUP — Approach của user 2026-05-20:** Phase 1 invite cuối thêm `clickTabAndWait("tab_pending_invites", ..., 1500)` NGAY trước khi return `awaiting_reload_verify=true` → URL = `/admin/members?tab=invites` khi runner F5 → ChatGPT load thẳng pending list từ server vào view.
- File đã đổi: `sync.ts` (export `clickTabAndWait` — đã có sẵn nhưng trước v0.6.4 chưa được dùng bởi invite).

### Bảng tóm tắt

| Version | Loại | Tóm tắt |
|---------|------|---------|
| v0.1.0 | feature | Release action `SYNC_DATA` |
| v0.2.0 | feature | Wire DB lookup cho 3 tab buttons |
| v0.4.6 | fix | Locale mismatch detection + anchor-click nav |
| **v0.4.7** | **🔴 fix** | **EMAIL_EXTRACT_RE_G fallback (fix miss row khi avatar+name+email cùng text node)** |
| v0.4.8 | feature | `scrapePendingInvitesAfterInvite` reusable cho INVITE Phase 2 |
| v0.6.2 | fix | KHÔNG bounce-back tab "Người dùng" sau scrape pending |
| **v0.6.4** | **🔴 fix** | **`isFullSync=false` option (fix bug a12 bị mark removed oan)** |

> **🔥 Symptom debug nhanh:**
> - Sync trả 0 row → check `[autogpt-sync] scrapeAllRows scanned X text nodes → fullMatch Y + extract Z`. Nếu `textNodesScanned = 0` thì DOM chưa render. Nếu cả `fullMatch` + `extract` đều 0 thì ChatGPT đổi format email rendering.
> - Sync trả ít row hơn ChatGPT thực có → workspace virtualized list không scroll hết. Check `scrollUntilAllLoaded()` log — số `currentCount` ổn định ở giá trị < tổng thực = ChatGPT không load thêm row khi scroll. Có thể cần scroll thêm container khác (vd inner div) — verify `scrollContainers` array.
> - Member vừa active bị mark `removed` oan trong DB sau sync → backend reconcile bug. Kiểm tra `scrapedStatuses` payload có khớp với scope thực sự scraped không. Hoặc backend race condition: invite mới < 10 phút bị reconcile mất → verify defense-in-depth ở [`members.py`](../../../../../api/app/routers/members.py).
> - Date parse miss → ChatGPT đổi format. Verify `DATE_RE` regex còn match. Locale mới chưa support thì thêm vào `parseDateMulti`.
> - Name field null → `findNameInRow` loại nhầm. Check exclusion logic (email/date/role/avatar initial).
> - Sync TIMEOUT > 5 phút → workspace có >> 1000 member, hoặc network/DOM lag. Tăng `MAX_SYNC_MS` hoặc chunk theo letter prefix.
> - `LANGUAGE_MISMATCH` error → user truyền `expectedLocale='vi'` nhưng ChatGPT đang locale khác. Hướng dẫn user đổi ChatGPT Settings → Locale.

## 11. Fail mode & error code

| Mã | Khi nào xảy ra | Cách fix |
|----|----------------|----------|
| `PAGE_NOT_ADMIN` | URL không bắt đầu `/admin`, hoặc navigate sang `/admin/members` fail sau 10s | Mở `chatgpt.com/admin/members` thủ công |
| `UI_ELEMENT_NOT_FOUND` | Scrape 3 tab xong nhưng 0 member | ChatGPT đổi format email rendering — verify scraper regex |
| `LANGUAGE_MISMATCH` | Scrape 0 member + locale ChatGPT khác expected | User đổi ChatGPT Settings → Locale matching dashboard lang |
| `TIMEOUT` | Sync > 5 phút (workspace cực lớn hoặc DOM lag) | Manual sync, hoặc tăng `MAX_SYNC_MS` |

## 12. Test thủ công

```
1. Workspace có > 50 active member + > 5 pending invite + > 0 pending request
2. Trigger SYNC_DATA từ dashboard (set lang='vi', ChatGPT lang VI)
3. Verify trong DevTools Console tab ChatGPT:
   - "[autogpt-sync] locale check: detected='vi' expected='vi' match=true"
   - "[autogpt-sync] clicking tab: Lời mời đang chờ xử lý"
   - "[autogpt-sync] [Lời mời] scroll xong: ~5 rows"
   - "[autogpt-sync] tab Lời mời: 5 entries"
   - Tương tự cho tab Yêu cầu + Người dùng
   - "[autogpt-sync] DONE: 60 members in 25000ms"
4. Verify dashboard:
   - Tab Members có đủ 50 active + 5 pending + 0 yêu cầu
   - Member nào có name + joined_at đúng
5. Edge case OVER-LIMIT (workspace 14/13 seat):
   - Verify scrape không miss email nào
6. Edge case LOCALE MISMATCH:
   - ChatGPT lang VI, dashboard lang ZH
   - Verify error_code=LANGUAGE_MISMATCH + message có hint đổi locale
```
