# AutoGPT Admin Extension — Changelog

Mọi thay đổi đáng kể của extension được ghi tại đây. File này là **mirror text-only** của [`src/version.ts`](src/version.ts) — version.ts là single source of truth (manifest + popup UI đọc từ đó).

## Quy tắc bump version (semver-like)

- **MAJOR (`x.0.0`)** — breaking change: đổi protocol message với backend, đổi cấu trúc storage, refactor lớn buộc reload toàn bộ workspace.
- **MINOR (`0.x.0`)** — thêm action/scraper mới (SYNC_BILLING, INVITE_MEMBER…) hoặc redesign UI lớn.
- **PATCH (`0.0.x`)** — bug fix, sửa selectors khi ChatGPT đổi UI, tune regex/timing.

## Quy trình mỗi lần bump

1. Cập nhật `VERSION` trong [`src/version.ts`](src/version.ts).
2. Prepend entry mới vào đầu mảng `CHANGELOG` cùng file (most recent first).
3. Mirror entry đó vào file này (cũng most recent first).
4. Rebuild extension, reload trong `chrome://extensions/`.
5. Popup sẽ tự hiển thị version + changelog từ `version.ts` — không cần sửa manifest hay popup.

---

## v0.6.13 — 2026-05-21 — chore

**Mỗi action có README.md riêng kèm code — AI mở folder action là đọc được logic + history; user sửa dễ**

- Move 9 file `Logic_<action>.md` từ `docs/Extension_Refactor/` (gitignored) vào [`apps/extension/src/content/actions/<action>/README.md`](src/content/actions/) (tracked trong source tree).
- **Mục đích**: (1) AI khi navigate vào folder action thấy README ngay → context đầy đủ về logic/flow/history mà không phải tìm doc folder riêng; (2) user sửa doc cạnh code, không phải nhảy file xa.
- Thêm [`apps/extension/src/content/actions/README.md`](src/content/actions/README.md) làm **index 9 actions** + quy tắc code structure pattern cho người mới.
- **Path đã fix relative** để link đúng từ vị trí mới: refs tới `../human.ts`, `../../../shared/`, `../<other-action>/README.md`, `../../../../../web/src/...` và `../../../../../api/app/...`
- **QUY TẮC MỚI**: mỗi action **PHẢI** có README.md kế bên code, mỗi bug fix **PHẢI** append entry vào section "Lịch sử sửa lỗi" của README tương ứng — không chỉ JSDoc trong code.
- **KHÔNG đổi behavior code** — chỉ thêm 10 file `.md`.

---

## v0.6.12 — 2026-05-20 — chore

**Refactor (Pha 0): chuẩn bị tách action mỗi hàm 1 file riêng — chưa đổi behavior**

- Tạo branch `refactor/extension-actions-split` để chia nhỏ các file [`src/content/actions/*.ts`](src/content/actions/) đang quá fat: [invite.ts](src/content/actions/invite.ts) 802 dòng, [purchase-seat.ts](src/content/actions/purchase-seat.ts) 894 dòng, [harvest-labels.ts](src/content/actions/harvest-labels.ts) 738 dòng, [sync.ts](src/content/actions/sync.ts) 648 dòng.
- Kế hoạch chi tiết tại `docs/Extension_Refactor/Plan_Split_Actions_Per_File.md` (gitignored, local-only — file dài 280 dòng list từng pha + cấu trúc target + checklist verify).
- **Mục tiêu**: mỗi action thành 1 folder, mỗi hàm public 1 file riêng, helper theo concern (`finders/`, `pages/`, `modal1/`, `modal2/`, `row-extractors/`). Tổng ~58 file mới thay cho 10 file fat.
- **Quy tắc refactor**: PURE FILE-SPLIT, KHÔNG đổi logic/behavior. JSDoc copy nguyên si để giữ context lịch sử (v0.6.4 vì sao bỏ `scrapedStatuses`, v0.6.6 vì sao force OFF, …).
- Public API contract giữ nguyên qua barrel `index.ts` mỗi folder — [content/index.ts](src/content/index.ts) dispatcher chỉ đổi 1 import (`./actions/revoke-invites-batch` → `./actions/revoke`).
- **9 pha tiếp theo** (1 commit/pha): change-role+revoke → external-invites → remove+sync-billing → sync → invite → purchase-seat → harvest-labels → smoke test.
- **Pha 0 này CHƯA tách file nào** — chỉ bump version + ghi entry để các pha sau có baseline rõ ràng.

---

## v0.6.11 — 2026-05-20 — fix

**REMOVE_MEMBER: search qua ô "Lọc theo tên" trước khi mở menu "..." → "Loại bỏ thành viên" — fix miss row khi list dài**

- **USER REQUEST 2026-05-20** (kèm ảnh ChatGPT `/admin/members` tab Người dùng): "khi thực hiện xóa bất kì user nào thì tìm kiếm người dùng xong rồi thực hiện xóa loại bỏ thành viên". Ảnh tham chiếu thứ 2 cho thấy menu "..." mở ra hiển thị "Thay đổi loại giấy phép" + "Loại bỏ thành viên" (đỏ).
- **ROOT CAUSE**: [`executeRemove`](src/content/actions/remove.ts) cũ chỉ gọi `findMemberRow(email)` trên DOM hiện tại. Khi workspace > 50 member, row cần xoá có thể chưa scroll vào viewport (ChatGPT virtualize list) → trả `null` → `UI_ELEMENT_NOT_FOUND`. User phải tự cuộn tới row trước khi extension chạy được.

**FIX** ([remove.ts](src/content/actions/remove.ts)): thêm 2 bước trước flow cũ:

1. `clickTabAndWait('tab_active_members')` — đảm bảo đang ở tab Người dùng (REMOVE chỉ làm được trên active list, không phải tab Lời mời/Yêu cầu). Best-effort, không fail nếu tab button không có.
2. `filterAndFindRow(email)` — type local-part email (phần trước `@`) vào input "Lọc theo tên" → đợi ChatGPT debounce filter (~600ms) → `waitFor` row khớp tới 4s. Filter zoom thẳng vào 1 row duy nhất, KHÔNG cần scroll.

- Sau khi xoá xong verify (member biến mất khỏi list đã filter), **CLEAR filter input** để list về full state (user mở tab admin lên thấy toàn bộ member, không bị stuck ở state filter `yaakovajax0054` chẳng hạn).
- Selector mới `SELECTORS.memberFilterInput`: `input[type="search"]` + placeholder/aria-label `Lọc`/`Filter`/`筛选`/`过滤` (vi/en/zh). Fallback theo placeholder attribute vì ChatGPT chưa có `data-testid` trên input này.
- **Tại sao type local-part chứ không full email**: ChatGPT filter match trên cả tên + email; dùng prefix `yaakovajax0054` đủ unique mà tránh case input có maxlength giới hạn ký tự đặc biệt (`@` / `.`).
- **Fallback** (nếu không tìm được filter input — vd UI mới đổi): rơi về scroll-find cũ (`findMemberRow` trực tiếp). KHÔNG hard-fail vì có thể workspace nhỏ < 10 member thì filter không xuất hiện.
- File đã đổi: [selectors.ts](src/content/selectors.ts) (thêm `memberFilterInput`), [remove.ts](src/content/actions/remove.ts) (`filterAndFindRow` + `clearMemberFilter` + tab navigate).

---

## v0.6.10 — 2026-05-20 — chore

**Bỏ nút ↻ sync billing trong popup — dashboard "Cập nhật giá & ngày renew" là single source of truth, popup tự refresh khi task xong**

- **USER REQUEST 2026-05-20**: "bỏ cái mũi tên sync billing đi, từ giờ chạy ở dashboard lệnh cập nhật giá thì cũng update cả extension luôn".
- **Bối cảnh**: popup có 2 chỗ trigger SYNC_BILLING — (a) nút ↻ bên cạnh "Plan/Seat" trong popup (thêm ở v0.4.16), (b) nút "Cập nhật giá & ngày renew" trong dashboard ([WorkspaceLayout](../../web/src/components/WorkspaceLayout.tsx)). Cả 2 đều tạo cùng `QueueItem type=SYNC_BILLING` → trùng UX.
- **Decision**: xoá nút popup, giữ nút dashboard. Popup ĐÃ có sẵn auto-refresh `useEffect` (v0.4.16, [App.tsx](src/popup/App.tsx) lines 74-101) detect khi `SYNC_BILLING` terminal `COMPLETED` → re-fetch `whoami` → popup hiển thị seat mới. **Logic này hoạt động bất kể task được trigger từ đâu** (popup hay dashboard) — chỉ cần xoá nút popup, không cần đổi logic auto-refresh.

**Files đã xoá:**

- [popup/App.tsx](src/popup/App.tsx): nút ↻ + state `syncingBilling` + handler `onSyncBilling` + import `triggerSyncBilling`
- [shared/api.ts](src/shared/api.ts): hàm `triggerSyncBilling` (chỉ popup dùng)
- [i18n vi.json](src/i18n/locales/vi.json) + [zh-CN.json](src/i18n/locales/zh-CN.json): key `popup.syncBillingTooltip`
- Backend [queue.py](../api/app/routers/queue.py): endpoint `POST /api/v1/queue/sync-billing` (chỉ extension dùng)

**Flow MỚI:**

```
User click "Cập nhật giá & ngày renew" trên dashboard
  → POST /workspaces/{id}/sync-billing
  → QueueItem PENDING
  → SSE push tới extension
  → extension scrape /admin/billing → seat_used/seat_total mới
  → updateTask COMPLETED + DB update
  → popup polling fetchActiveTask 1.5s thấy recent_completed.type=SYNC_BILLING
  → re-fetch whoami → popup hiển thị seat mới (≤ 2-3s sau khi task xong)
```

- Không có functional regression: nếu popup ĐÓNG khi task chạy, lần mở sau `verify(config)` trên mount sẽ fetch whoami → seat mới tự xuất hiện.

---

## v0.6.7 — 2026-05-20 — fix

**CONTENT_NOT_INJECTED: propagate diag step-by-step vào error_message — dashboard hiển thị thẳng step nào fail**

- **USER REPORT**: liên tục 5+ task fail với `CONTENT_NOT_INJECTED` (INVITE/SYNC_DATA/REVOKE_INVITES). Error message generic: "Tab chatgpt.com/admin không thể inject content script sau 3 bước fallback" — KHÔNG nói step nào fail, vì sao fail. User mù → phải mở `chrome://extensions/` → Service Worker → DevTools mới biết.
- **ROOT CAUSE visibility**: [`ensureContentInjected`](src/background/runner.ts) chỉ `console.warn` từng step nội bộ, không truyền lý do ra ngoài. 3 step thử inject (executeScript / tabs.reload / tabs.remove+create) đều có thể fail vì nhiều lý do khác nhau (tab redirect khỏi `/admin`, executeScript permission, ping timeout, ChatGPT logout giữa chừng, ...) — message generic không phân biệt được.
- **FIX** ([`runner.ts ensureContentInjected`](src/background/runner.ts)): thêm array `diag: string[]` collect 1 dòng mỗi event (ping attempt, executeScript resolve/throw, tabs.reload result, tab URL sau mỗi bước). Mỗi dòng có prefix `+{elapsed}ms` để thấy timing. Return type đổi `{ok, tabId}` → `{ok, tabId, diag}`. KHÔNG đổi logic 3 step.
- **FIX** ([`sendToContent`](src/background/runner.ts)): khi `!ready.ok` → append `\n\nChi tiết từng bước:\n{diag.join('\n')}` vào `error_message`. Dashboard hiển thị toàn bộ trace — biết ngay step nào fail.
- **Diag bao gồm**: tab state snapshot ban đầu (`url` + `status`), kết quả mỗi `executeScript` (resolved / THREW + message), URL sau mỗi `tabs.reload` + `tabs.create`, ping retry count cụ thể, abort reasons.

**Ví dụ output mới (FAILED task):**

```
Cách khắc phục thường gặp: (1) F5 ChatGPT tab thủ công, (2) chrome://extensions/ → reload AutoGPT, (3) đảm bảo extension + ChatGPT cùng browser profile + đã login.

Chi tiết từng bước:
+0ms tab 123 state: status=complete url=https://chatgpt.com/auth/login
+15ms ⚠ tab URL không chứa /admin — có thể đã logout/redirect
+18ms initial ping fail — content script chưa response
+25ms Step 1: executeScript files=[assets/index.ts-loader-...]
+87ms Step 1 executeScript resolved
+3115ms Step 1 ping fail toàn bộ 5 retry
+3120ms Step 2: tabs.reload + executeScript lại
+5230ms Step 2 reload done, url=https://chatgpt.com/auth/login status=complete
+5235ms ⚠ Step 2 ABORT: sau reload tab redirect khỏi /admin (url=https://chatgpt.com/auth/login) — likely logged out
...
```

- **Hành động đề xuất user (sau khi update)**: chạy 1 task SYNC_DATA test, nếu vẫn fail thì copy diag vào issue — sẽ biết chính xác problem để fix dứt điểm (vs guess như 5 lần trước).
- **Khả năng cao root cause hiện tại**: ChatGPT tab đã logout giữa chừng (session expired) → `tab.url=/auth/login` → 3 step đều redirect → all fail. Diag mới sẽ confirm trong 1 task test.

---

## v0.6.6 — 2026-05-20 — fix

**FORCE tắt toggle external invites sau invite (không restore prev) + Phase 1 đợi DOM list pending stable trước F5 + Phase 2 retry tăng cường**

- **USER REPORT v0.6.5**: (a) sau invite, toggle "Cho phép lời mời ngoài tên miền" không tự tắt. (b) Email trong tab "Lời mời đang chờ xử lý" load thiếu trên dashboard so với ChatGPT thật.
- **ROOT CAUSE (a)**: `withExternalInvitesEnabled` finally chỉ restore khi `setResult.changed=true` (= extension đã click bật ON). Nếu user manually bật ON từ trước → `prev=ON, changed=false` → finally **SKIP restore** → toggle giữ ON. Vi phạm spec user "sau mời xong phải tắt mời ngoài".
- **FIX 1 ([external-invites.ts](src/content/actions/external-invites.ts))**: **LUÔN force OFF** sau invite (kể cả `prev` đã ON). Spec mới: "Cho phép lời mời ngoài" là rủi ro bảo mật — sau mỗi invite extension phải tắt OFF, user có thể bật lại thủ công nếu cần. Bỏ điều kiện `if changed` trong finally.
- **ROOT CAUSE (b)**: Phase 1 click tab "Lời mời đang chờ xử lý" (v0.6.5) với `postClickWait` 1500ms, sau đó return ngay → background F5. ChatGPT React Query fetch pending list mất 2-5s; nếu F5 ngắt giữa fetch → sau F5 có thể serve cache cũ → Phase 2 scrape miss email vừa mời.
- **FIX 2 ([invite.ts executeInvite](src/content/actions/invite.ts))**: Sau `clickTabAndWait` (tăng 1500→3000ms), thêm `waitForPendingListStable(emails, 8s)` — poll DOM email-text-node count tới khi: (i) tất cả email vừa mời xuất hiện, HOẶC (ii) count stable 2 tick liên tiếp. Đảm bảo F5 chạy ở state DOM ổn định.
- **FIX 3 ([invite.ts executeVerifyPendingInvite](src/content/actions/invite.ts))**: Tăng initial sleep sau F5 từ 800ms → 2500ms. Retry chain `[0, 2500]` (v0.6.5) → `[0, 3000, 6000]` (v0.6.6) — 3 attempt với gap dài hơn, xử lý case ChatGPT backend index pending list chậm.
- **Tradeoff**: invite ~3-7s chậm hơn v0.6.5 nhưng độ chính xác cao hơn nhiều. User "load thiếu" > user "chậm".

**Sequence chính xác (v0.6.6):**

```
1. withExternalInvitesEnabled — check state toggle
   ├─ Nếu OFF → bật ON
   └─ Nếu đã ON → skip click (giữ prev=ON, ghi log)
2. Nav /admin/members
3. executeInviteInner — open dialog → type email → set role → submit → wait toast close
4. finally: FORCE tắt toggle về OFF (LUÔN, không restore prev) ← v0.6.6
5. Nav /admin/members
6. clickTabAndWait("tab_pending_invites", 3000ms) — URL = /admin/members?tab=invites
7. waitForPendingListStable(emails, 8000ms) ← v0.6.6 NEW: đợi DOM render list ổn định
8. Runner F5 → ChatGPT load pending list từ server
9. Phase 2 executeVerifyPendingInvite:
   ├─ sleep 2500ms (đợi DOM render sau F5)
   ├─ retry chain [0, 3000, 6000] — 3 attempt
   └─ Mỗi attempt: click tab + scrape pending list (forceReload từ attempt 2)
10. Runner bulk-upsert (isFullSync=false) → DB → dashboard hiển thị
```

---

## v0.6.5 — 2026-05-20 — fix

**Fix thứ tự bước trong invite flow: TẮT toggle external invites TRƯỚC khi chuyển tab "Lời mời"**

- **BUG v0.6.4**: thêm `clickTabAndWait("tab_pending_invites")` vào CUỐI `executeInviteInner` — sai thứ tự. Trình tự thực tế: bật toggle → invite → click tab Lời mời (URL có `?tab=invites`) → finally của `withExternalInvitesEnabled` nav `/admin/identity` tắt toggle → nav `/admin/members` (URL MẤT `?tab=invites`) → F5 ở URL không có tab param → ChatGPT load tab "Người dùng" default thay vì "Lời mời" → Phase 2 phải tự click lại tab → vô hiệu hoá tối ưu v0.6.4.
- **User correct (2026-05-20)**: "bật mời ngoài → mời thành viên → tắt mời ngoài → chuyển tab lời chờ xử lý → F5 → verify → ghi DB". Trình tự đúng: restore toggle PHẢI chạy TRƯỚC khi chuyển tab Lời mời.
- **FIX**: Move `clickTabAndWait("tab_pending_invites")` từ cuối `executeInviteInner` ra scope ngoài của `executeInvite`, đặt SAU `withExternalInvitesEnabled` return (= sau khi finally đã restore toggle + nav `/admin/members`). URL khi runner F5 sẽ chính xác `/admin/members?tab=invites` → ChatGPT load thẳng pending list.
- `executeInviteInner` giờ CHỈ làm submit invite + return `awaiting_reload_verify=true` (single responsibility). Tab management là concern của `executeInvite` (scope ngoài).

**Sequence chính xác (v0.6.5):**

```
1. withExternalInvitesEnabled — nav /admin/identity → check state
   ├─ Nếu OFF → bật ON (lưu prev=false)
   └─ Nếu đã ON → skip click (prev=true)
2. Nav /admin/members
3. executeInviteInner — open dialog → type email → set role → submit → wait toast/dialog close → return
4. finally: nếu prev=false → nav /admin/identity tắt OFF → nav /admin/members
5. (NEW v0.6.5) clickTabAndWait("tab_pending_invites") → URL = /admin/members?tab=invites
6. Runner F5 → ChatGPT load pending list từ server
7. Phase 2 executeVerifyPendingInvite scrape → verified emails
8. Runner bulk-upsert (isFullSync=false) → DB → dashboard hiển thị
```

- **File đã đổi**: [invite.ts](src/content/actions/invite.ts) (`executeInvite` + `executeInviteInner` refactor).

---

## v0.6.4 — 2026-05-20 — fix

**Verify pending nhanh hơn (chuyển tab "Lời mời" TRƯỚC F5) + fix bug `a12` bị mark `removed` oan do bulk-upsert reconcile**

- **BUG (`a12` "biến mất")**: User invite `a12` (08:34) → ChatGPT nhận thật. Sau invite `g12` (08:37) extension verify scrape tab "Lời mời" tại 08:38 chỉ thấy `g12` (a12 chưa được ChatGPT index về client) → bulk-upsert với `scraped_statuses=['pending']` → backend reconcile mark `a12=removed` oan. Phantom cleanup INVITE_MEMBER vẫn đúng (`verify_scrape_failed=true` → giữ); lỗi nằm ở **bulk-upsert dùng chung endpoint** cho cả full sync + verify after invite.
- **FIX 1 — Extension (`runner.ts` INVITE_MEMBER `reportToBackend`)**: thêm option `isFullSync=false` vào `bulkUpsertMembers`, bỏ `scrapedStatuses`. Backend nhận `is_full_sync=false` → CHỈ upsert email trong payload, KHÔNG reconcile. Verify chỉ là "confirm những email này đang pending", không nói gì về email khác.
- **FIX 2 — Backend (`members.py:bulk_upsert_members`) defense-in-depth**: reconcile `WHERE NOT (invited_by_user_id IS NOT NULL AND created_at > NOW() - INTERVAL '10 minutes')`. Nếu extension lỡ gửi `is_full_sync=true` sau khi vừa invite, member mới vẫn an toàn.
- **UX SPEEDUP — Approach của user 2026-05-20**: "sau khi mời xong chuyển sang tab Lời mời đang xử lý, chờ load rồi reload trang là thấy toàn bộ". Phase 1 (`invite.ts:executeInviteInner`) cuối: thêm `clickTabAndWait("tab_pending_invites", ..., 1500)` NGAY trước khi return `awaiting_reload_verify=true` → URL = `/admin/members?tab=invites` khi runner F5 → ChatGPT load thẳng pending list từ server vào view (không cần navigate phụ).
- **Phase 2 (`executeVerifyPendingInvite`) simplify**: initial sleep 1500ms → 800ms (DOM đã ở đúng tab), retry chain `[0, 3000, 5000]` → `[0, 2500]` (data tươi hơn sau F5 đúng URL). Tiết kiệm ~3-5s mỗi invite.
- **Lợi ích kép**: nhanh hơn + né được race của bug `a12` (scrape data từ server response của F5 thay vì DOM stale của tab cũ).
- **File đã đổi**: [invite.ts](src/content/actions/invite.ts) (Phase 1+2), [sync.ts](src/content/actions/sync.ts) (export `clickTabAndWait`), [api.ts](src/shared/api.ts) (`bulkUpsertMembers` thêm `isFullSync`), [runner.ts](src/background/runner.ts) (INVITE_MEMBER no-reconcile), [members.py](../api/app/routers/members.py) (reconcile skip recent invite).

---

## v0.6.3 — 2026-05-20 — fix

**Re-thêm Step 3 NUCLEAR (recreate tab) + Step 2 inject thêm lần 2 — fix `CONTENT_NOT_INJECTED` hiếm gặp**

- User report: invite `tamnm@ibcgroup.vn` FAILED với `CONTENT_NOT_INJECTED` dù tab ChatGPT đang ở `/admin` và đã login. v0.4.20 bỏ Step 3 NUCLEAR vì gây regression INVITE (tab recreate phá dialog state). Sau v0.6.2 invite đã tách thành Phase 1 (submit) + Phase 2 (F5 + verify), regression cũ KHÔNG còn áp dụng → an toàn re-thêm Step 3.
- **Step 3 NUCLEAR mới**: `chrome.tabs.remove` tab cũ → `chrome.tabs.create` tab mới hoàn toàn (URL = `/admin/members`) → `waitForTabComplete` 20s → `chrome.scripting.executeScript` explicit phòng auto-inject lỗi → 5 retry ping (800/1200/1500/2000/2000ms). `sendToContent` đã có sẵn logic dùng `tabId` mới nếu Step 3 đổi tab.
- **Step 2 strengthen**: sau khi `chrome.tabs.reload` + tab load complete, GỌI THÊM `chrome.scripting.executeScript` một lần nữa (belt-and-suspenders). Manifest auto-inject ở `document_idle` thường ok nhưng đôi khi CRXJS loader fail do CSP/timing — `executeScript` explicit là backup. Cộng thêm 2 retry delay (2000ms x2) nâng tổng wait sau reload từ ~5.8s → ~9.8s.
- Sửa **error message** `CONTENT_NOT_INJECTED`: text cũ nói "sau 3 bước fallback" nhưng v0.4.20 chỉ còn 2 bước → vô lý. Giờ code có thật 3 bước, text đúng sự thật.

---

## v0.6.2 — 2026-05-20 — fix

**F5 thật trang admin sau khi submit invite — ép ChatGPT load lại pending list từ server (không dùng cache stale)**

- Tách `INVITE_MEMBER` thành 2 phase:
  - **Phase 1** (content): chỉ submit invite + verify toast/dialog đóng → return `ok=true` với `awaiting_reload_verify=true`.
  - **Phase 2** (background orchestrate): `chrome.tabs.reload(tab)` hard F5 → wait tab complete → `ensureContentInjected` re-inject → gửi `VERIFY_PENDING_INVITE` message mới → content's new instance scrape pending list (đã load fresh từ server) → return verify result.
- **Vì sao F5 chrome.tabs.reload chứ không phải click tab + force fetch?** ChatGPT React Query cache pending list theo workspace_id — click tab không invalidate cache, chỉ trigger refetch nếu staleTime expire. `chrome.tabs.reload` là F5 thật ở level browser → toàn bộ JS context destroy + reload → React Query cache xoá sạch → fetch fresh từ `/api/.../invites`.
- Message protocol mới: `VERIFY_PENDING_INVITE { taskId, emails, role }` — dùng riêng cho Phase 2, không submit lại invite. Content dispatcher [content/index.ts](src/content/index.ts) route → `executeVerifyPendingInvite` trong [invite.ts](src/content/actions/invite.ts).
- Runner [background/runner.ts](src/background/runner.ts) detect `response.data.awaiting_reload_verify=true` → vào branch F5+verify. Nếu F5 fail / inject fail / verify message throw → fallback `ok=true` với `verify_scrape_failed=true` (user-facing: "mở tab Lời mời thủ công để check"), KHÔNG fail invite (vì submit đã OK).
- Phase `f5-verify` mới trong `reportRunnerProgress` → dashboard banner show "Submit invite OK — F5 trang admin để ChatGPT load lại pending list..." giữa submit và verify.
- Retry trong Phase 2 vẫn giữ (3 attempts với delay 0/3/5s) — phòng ChatGPT backend chậm index invite vừa POST. Tổng thời gian Phase 2 tối đa ~25s (F5 ~3-5s + 3 attempts ~10-15s + final navigate ~2s).

---

## v0.6.1 — 2026-05-20 — fix

**Fix `humanClick` double-fire (2 toast ChatGPT / click toggle 2 lần) + verify pending: delay 2s + retry 3 lần đến ~10s tổng**

- **BUG #1 (DOUBLE-CLICK)**: [`humanClick`](src/content/human.ts) trước v0.6.1 dispatch synthetic `MouseEvent('click')` RỒI gọi LUÔN `el.click()` native → mỗi lần "click" thực ra fire **2 lần**. Hậu quả user-reported:
  - (a) Toggle "Cho phép lời mời từ miền bên ngoài" click 1 lần → ChatGPT nhận 2 toggle event → **2 toast "Đã cập nhật"**.
  - (b) Submit invite click 1 lần → ChatGPT submit 2 lần → **2 toast "Đã gửi lời mời"**.
- **Fix**: chỉ gọi `el.click()` native (Radix/React `onClick` đều catch được). Dispatch synthetic `MouseEvent('click')` chỉ là **fallback** khi `el.click` không phải function hoặc throw. Các pointer/mouse `down`+`up` phía trên vẫn được dispatch để giữ hover/active state (UX cũ).
- **BUG #2 (VERIFY QUÁ NHANH → false-negative VERIFY_FAILED)**: sau khi submit invite + toast OK, code v0.6.0 click ngay tab "Lời mời đang chờ xử lý" + chờ 1.5s rồi scrape. ChatGPT backend cần 1-5s để invite mới xuất hiện trong pending list → scrape thấy **0 email** vừa mời → strict v0.4.14 trả `VERIFY_FAILED` → phantom cleanup xoá record dashboard, NHƯNG thực tế ChatGPT đã nhận invite OK.
- **Fix #2A**: sau khi xác nhận toast/dialog đóng, đợi thêm **2s** rồi mới gọi `scrapePendingInvitesAfterInvite`.
- **Fix #2B**: nếu attempt đầu KHÔNG verify được hết list email vừa mời → retry tới **3 lần** (sleep `0s, 2.5s, 4s` giữa các attempt), tổng tối đa ~10s. Sleep ngắn cho attempt đầu, dài cho attempt sau (giảm thiểu cho case hiếm).
- **Fix #2C**: mỗi retry > attempt #1 dùng `forceReload=true`: bounce qua tab "Người dùng" 800ms rồi click lại "Lời mời" với postClickWait 2.5s → ép ChatGPT re-mount component + re-fetch pending list (fix luôn cache stale).
- Progress message mới khi retry: "Pending list chưa có N email — đợi ChatGPT cập nhật (retry K/3)..." → dashboard banner show ngay, user biết extension đang đợi (không phải treo).
- **BUG #3 (phải F5 thấy email trong tab "Lời mời" trên ChatGPT)**: trước v0.6.1 sau verify xong extension click lại tab "Người dùng" để idle ở trang quen thuộc. Hậu quả: user mở browser tab admin lên + click "Lời mời" → ChatGPT re-mount component + có thể serve từ React Query cache stale → **KHÔNG thấy email vừa mời, phải F5**.
- **Fix #3**: extension giờ DỪNG TẠI tab "Lời mời đang chờ xử lý" sau verify cuối cùng — DOM đã render data tươi (extension vừa scrape) nên user mở browser tab admin lên là thấy ngay. Task sau (REMOVE/CHANGE_ROLE) tự click tab "Người dùng" qua `findControlByKey`, không lệ thuộc end-state.

---

## v0.4.20 — 2026-05-19 — fix

**Bỏ Step 3 NUCLEAR (regression INVITE) + tăng waitFor dialog 20s + DOM diagnostic + DB sync CHANGE_ROLE/REMOVE**

- **REGRESSION FIX**: bỏ Step 3 NUCLEAR (`tabs.remove + tabs.create`) trong `ensureContentInjected` — quá aggressive, đóng tab user khi không cần, gây dialog Invite không mở được sau khi tab vừa recreate. Step 1 (executeScript) + Step 2 (tabs.reload) đã cover 99% case.
- Invite `waitFor` dialog email input: **10s → 20s**. Sau v0.4.17 auto-reload, SPA cần thời gian rehydrate + dialog animate open. 10s đôi khi không đủ.
- Invite **DOM diagnostic**: khi `waitFor` timeout → dump dialog innerHTML + list tất cả input/textarea trong dialog vào console (prefix `[autogpt-invite] DIAGNOSTIC`). Error message kèm input summary để dashboard banner show ngay (vd: `Inputs: INPUT[type=text,name=email_0,ph=Enter email address]`).
- Backend `update_task`: thêm **DB sync sau CHANGE_ROLE COMPLETED** → `Member.chatgpt_role = new_role`. Trước v0.4.20 extension đổi role trên ChatGPT thành công nhưng DB không update → dashboard hiển thị role cũ tới khi SYNC_DATA chạy.
- Backend `update_task`: thêm **DB sync sau REMOVE_MEMBER COMPLETED** → `Member.status = 'removed'`. Cùng lý do.

---

## v0.4.19 — 2026-05-19 — fix

**Billing scraper: cho phép case "Đang dùng 14/13" (over-limit) — bỏ rule `used<=total`**

- **BUG**: trong [parseSeatRatio](src/content/scrapers/billing.ts) có check `used <= total` → khi ChatGPT hiển thị "Đang dùng **14/13** giấy phép" (admin invite vượt quota), pattern match được nhưng bị reject vì 14 > 13 → scraper bỏ qua → loop tới pattern khác → pick nhầm ratio từ vùng khác trên page (vd "11/12" từ invoice/plan info). Dashboard hiển thị **11/12** trong khi thực tế là **14/13**.
- **Fix**: BỎ check `used <= total`. Over-limit là state hợp lệ trên ChatGPT (admin được phép invite vượt seat — sẽ tính tiền phụ vào hóa đơn kế tiếp). Chỉ giữ rule `total<=999` và `used<=999` (sanity check).
- Bonus: thêm keyword `đang dùng` vào pattern đầu (priority cao hơn `sử dụng` generic) + `đang sử dụng` + zh `已使用`. Match trực tiếp text ChatGPT vi "Đang dùng 14/13".

---

## v0.4.18 — 2026-05-19 — fix

**Step 3 NUCLEAR (recreate tab) + ẨN HOÀN TOÀN banner CONTENT_NOT_INJECTED khỏi popup**

- v0.4.17 thêm auto-reload (Step 2) nhưng vẫn fail cho 1 số case (CSP / dirty state / extension hot-swap). Bổ sung **Step 3 NUCLEAR**: `chrome.tabs.remove` tab cũ + `chrome.tabs.create` tab mới hoàn toàn → wait load → retry ping. Tab mới fresh state 100% — fix mọi case còn lại trừ ChatGPT chưa login.
- `ensureContentInjected` giờ trả về `{ok, tabId}` thay vì boolean — `sendToContent` dùng `tabId` MỚI (nếu Step 3 đổi) để gửi message, tránh gửi vào tab đã đóng.
- Popup `ActiveTaskPanel`: **ẨN HOÀN TOÀN** error `CONTENT_NOT_INJECTED` và `NOT_LOGGED_IN_CHATGPT` khỏi recent_completed banner. Đây là lỗi infrastructure được background tự recovery — user KHÔNG cần thấy/thao tác.
- Cũng bỏ luôn nút manual "Mở/F5 tab ChatGPT Admin" — tất cả automatic.
- Total fallback time vẫn ~30s nhưng 99% case xong dưới 5s (Step 1). Step 2 ~10s. Step 3 ~15s. Sau Step 3 mà vẫn fail = ChatGPT chưa login (`NOT_LOGGED_IN_CHATGPT`) — case này extension không thể fix tự động.

---

## v0.4.17 — 2026-05-19 — fix

**AUTO-RELOAD tab ChatGPT khi gặp CONTENT_NOT_INJECTED — không cần user F5 thủ công**

- **BUG cũ**: reload extension trong `chrome://extensions/` tạo manifest mới với file hash mới, nhưng tab ChatGPT đang load vẫn giữ content script CŨ → background SW gửi message → tab cũ không nhận → `CONTENT_NOT_INJECTED` → task FAILED → user thấy "liên tục lỗi".
- Sau v0.4.17 [`ensureContentInjected`](src/background/runner.ts) có **2 step fallback hoàn toàn TỰ ĐỘNG**:
  1. `chrome.scripting.executeScript` inject loader rồi retry ping ~3s
  2. NẾU step 1 thất bại → **`chrome.tabs.reload`** (auto F5) → wait `tab.status='complete'` (timeout 15s) → retry ping ~5s để content script đã được manifest auto-inject ở `document_idle`
- Tổng cap ~25s nhưng 99% xong trong ~5s. **User KHÔNG cần thao tác F5 thủ công nữa.**
- Popup vẫn show fallback hint + nút "Mở/F5 tab ChatGPT Admin" phòng case auto-reload cũng thất bại (vd: ChatGPT chưa login → redirect `/auth/login`).
- i18n 2 string mới: `popup.contentNotInjectedHint` + `popup.openOrReloadAdminTab` (vi + zh).

---

## v0.4.16 — 2026-05-19 — feature

**Role dropdown chỉ 2 lựa chọn (member + analytics_viewer); popup có nút ↻ refresh seat**

- Dashboard [Members.tsx](apps/web/src/pages/Members.tsx) role dropdown **CHỈ** hiển thị "Thành viên" + "Xem dữ liệu" (analytics_viewer). Member đã là admin/owner KHÔNG cho đổi qua dashboard — hiển thị label với icon 🔒 và tooltip "thao tác trên ChatGPT".
- Schema mở rộng: `ChatGPTRole` + `DASHBOARD_ALLOWED_ROLES`. Backend [schemas.py](apps/api/app/schemas.py) thêm `analytics_viewer` vào `Literal`. Extension [messages.ts](src/shared/messages.ts) + [i18n-ui.ts](src/content/i18n-ui.ts) thêm `ROLE_LABELS` + `ROLE_KEYWORDS` cho `analytics_viewer` (vi: "Trình xem dữ liệu phân tích", en: "Analytics viewer", zh: "分析查看器").
- Popup thêm nút **↻** bên cạnh "Plan: business · Seat: N/M" → click gọi `POST /api/v1/queue/sync-billing` (extension auth) → backend dedup task → publish SSE → extension fastpoll pick → scrape `/admin/billing` → DB cập nhật. Popup tự re-fetch `whoami` sau 6s.
- Backend endpoint mới [queue.py /sync-billing](apps/api/app/routers/queue.py) — extension-facing, dùng `X-API-KEY` thay vì admin session, dedup nếu đã có PENDING/IN_PROGRESS.
- i18n 4 string: `popup.syncBillingTooltip` (vi/zh), `member.roleAnalyticsViewer` + `member.roleEditOnChatGPT` (vi/zh). `member.roleOwner/Admin/Member` đổi từ tiếng Anh sang i18n đúng.

---

## v0.4.15 — 2026-05-19 — fix

**Fix CHANGE_ROLE treo IN_PROGRESS (UI 2026 inline dropdown) + dashboard tự reload member list không cần F5**

- **Fix CHANGE_ROLE (extension)**: UI ChatGPT 2026 đổi role qua **dropdown INLINE** trên row ("Thành viên ▼" trực tiếp trong cột Vai trò) — KHÔNG còn ẩn trong "..." menu như UI cũ. Code v0.4.14 vẫn dùng flow cũ → click "..." → tìm "Change role" item → không có → treo `IN_PROGRESS` vĩnh viễn. Sau v0.4.15: tìm inline dropdown theo text role hiện tại + label match, click → menu mở → click target role option.
- Helper mới `findRowRoleDropdown(row, currentRole?)` trong [member-row.ts](src/content/actions/member-row.ts) — multi-strategy: (1) match text role label (Thành viên / Member / 成员); (2) fallback `aria-haspopup=menu/listbox` (loại trừ seat type "ChatGPT"/"Codex").
- Dispatcher [index.ts](src/content/index.ts) pass `old_role` từ task payload → helper lọc dropdown theo role hiện tại chính xác hơn.
- **Fix dashboard auto-reload** ([apps/web/Members.tsx](apps/web/src/pages/Members.tsx)): trước v0.4.15 query `members` chỉ refetch lúc mount + window focus, dẫn tới sau khi extension xong task (CHANGE_ROLE/REMOVE/INVITE) list không update → user phải F5. Sau v0.4.15: `useEffect` watch `recentTasks` (đã poll 2s); khi phát hiện task `INVITE_MEMBER`/`REMOVE_MEMBER`/`CHANGE_ROLE`/`REVOKE_INVITES`/`SYNC_DATA` mới chuyển sang COMPLETED/FAILED → `invalidateQueries(['members'])` → list refresh tự động trong **<2s**.

---

## v0.4.14 — 2026-05-19 — fix

**Strict invite: 0 email verified trong pending tab → return FAILED (không phải COMPLETED)**

- Trước v0.4.14: extension click submit thành công + toast OK → verify pending tab. Nếu tab pending KHÔNG có email nào trong list invite → vẫn return `ok=true` với `verified_count=0`. Task COMPLETED nhưng tất cả records bị xoá. Banner hiển thị "Đã verify 0/N" dễ gây nhầm lẫn.
- Sau v0.4.14: nếu scrape pending OK và `verified_count=0` → return `{ok:false, error_code:'VERIFY_FAILED'}` với message giải thích 3 nguyên nhân khả dĩ (email đã active, domain không verify, ChatGPT từ chối silent). Task **FAILED** visibility. Phantom cleanup vẫn chạy trong backend `update_task` FAILED handler.
- Logic strict này **KHÔNG** áp dụng khi `verify_scrape_failed=true` — vẫn return `ok=true` vì click submit có thể đã thành công ở ChatGPT nhưng extension không scrape được tab Lời mời để verify.

---

## v0.4.13 — 2026-05-19 — fix

**Phantom email: dashboard chỉ hiện email ChatGPT thực sự nhận; content script inject retry tới 3s**

- **Fix A — phantom email (backend)**: `bulk_invite` vẫn tạo `Member`+`Invite` up-front (optimistic UI) nhưng `update_task` PATCH có handler **MỚI** xoá phantom:
  - **FAILED** → xoá toàn bộ records của queue task
  - **COMPLETED** với `unverified_emails` → xoá chỉ những email đó
  - `verify_scrape_failed=true` → giữ lại (an toàn — không có thông tin để quyết định)
  - Chỉ xoá `Member` `status='pending'` + `joined_at IS NULL` (không xoá nhầm record đã active)
- **Fix B — content script inject retry**: trước v0.4.13 chỉ wait 300ms rồi ping 1 lần. CRXJS loader pattern cần thời gian dynamic import (500ms-2s) → false-negative thường xuyên. Giờ retry 5 lần với delay `[250,500,700,800,800]` (~3s tổng), success ngay khi ping được. Error code đổi `UNKNOWN` → `CONTENT_NOT_INJECTED` rõ ràng hơn.
- **Kết hợp**: nếu Fix B vẫn fail (3s vẫn không inject), Fix A đảm bảo dashboard tự xoá phantom email — không bao giờ thấy email mà ChatGPT chưa nhận trong list.

---

## v0.4.12 — 2026-05-19 — feature

**Popup: panel "Task đang chạy" + progress bar; auto SYNC_BILLING sau invite để seat đúng**

- **Popup overhaul**: BỎ nút "Không có task chờ" + dòng tip "Khi tạo task ở dashboard..." (gây confusion). Thay bằng `ActiveTaskPanel` — chỉ hiện khi có task đang chạy / chờ / vừa xong.
- Component `ActiveTaskPanel` 3 trạng thái:
  - **IN_PROGRESS**: badge "ĐANG CHẠY" + task type + progress message + thanh % + elapsed_sec
  - **PENDING > 0**: "{n} task chờ pick" gray
  - **Recent COMPLETED/FAILED trong 60s**: ✓/✗ badge + status
- Poll mỗi 1.5s khi popup mở (useEffect cleanup khi đóng) — UI cập nhật real-time. Khi popup ẩn → ngừng poll → không tốn API quota.
- Backend endpoint mới `GET /api/v1/queue/active` trả `{in_progress, pending_count, recent_completed}` — gọn cho 1 lần fetch popup.
- **Auto chain SYNC_BILLING** sau `INVITE_MEMBER`/`REMOVE_MEMBER`/`REVOKE_INVITES` COMPLETED → `workspace.seat_used` cập nhật đúng ngay sau invite, không phải đợi user bấm "Cập nhật giá & ngày renew". Dedup: chỉ enqueue nếu chưa có `SYNC_BILLING` PENDING/IN_PROGRESS.
- Fix bug user thấy: popup hiển thị "Seat: 11/12" trong khi ChatGPT thực tế 14/13 — DB stale vì `SYNC_BILLING` chưa chạy sau loạt invite. Giờ tự chạy.

---

## v0.4.11 — 2026-05-19 — fix

**UI Labels: dashboard sửa DB → extension refresh bundle ngay (không phải chờ 15 phút)**

- **BUG cũ**: admin sửa 1 row UI label qua Settings → DB update OK nhưng extension vẫn dùng label cũ tới 15 phút sau (`chrome.alarms` tick mới refresh bundle). Tạo cảm giác "sửa DB không hoạt động".
- **Fix 1 — push-based**: dashboard sau khi save/clear-stale/harvest done → post message `{source:'autogpt-dashboard', type:'refresh-labels'}` qua dashboard-bridge → background SW gọi `refreshLabelBundle()` → fetch `/ui-labels/bundle` mới → `chrome.storage.local` cập nhật → content script reload cache. Thời gian: **<500ms**.
- **Fix 2 — defensive pull**: `REFRESH_INTERVAL_MIN` giảm 15 → 2 phút. Phòng trường hợp extension chạy ở browser **KHÁC** dashboard (vd MoreLogin chứa extension, Edge chứa dashboard) → bridge không tồn tại → message bị drop, alarm 2 phút fallback.
- Helper mới `requestExtensionRefreshLabels()` trong [useExtensionTrigger.ts](apps/web/src/hooks/useExtensionTrigger.ts) — best-effort, không throw, không await. Gọi trong `UiLabelsManager` `onSuccess` của 3 mutation (save bulk, clear stale, harvest complete).
- Bridge protocol thêm 1 cặp message: dashboard→bridge `refresh-labels` và bridge→dashboard `refresh-labels-result` (payload `{ok,error}`).

---

## v0.4.10 — 2026-05-19 — feature

**Verify invite ở tab "Lời mời đang chờ xử lý" TRƯỚC khi update dashboard**

- Quy trình mới sau invite verify success: scrape tab "Lời mời đang chờ xử lý" → tính giao của (email vừa mời) ∩ (email scrape được) = `verified_emails`. **Chỉ verified emails** mới được bulk-upsert lên dashboard.
- Unverified emails (mời nhưng KHÔNG xuất hiện trong pending — vd ChatGPT từ chối thầm, email đã active sẵn, đã removed bị block) được report tách riêng vào `task.result.unverified_emails` → admin biết để check thủ công.
- Task result mới include: `verified_count`, `unverified_count`, `unverified_emails[]`, `verify_scrape_failed`. `TaskCompletionBanner` dashboard hiển thị message rõ hơn: "Đã verify X/Y email" hoặc "Chỉ verify được X, KHÔNG verified: ...".
- Edge case: scrape pending **fail toàn bộ** (DOM lạ, locale mismatch, timeout 60s) → `verify_scrape_failed=true`, KHÔNG update dashboard records, banner hiển thị "mở tab Lời mời thủ công để check". Task vẫn `COMPLETED` vì ChatGPT đã nhận click invite.
- i18n: 3 string mới `sync.completedInviteVerified` / `Partial` / `VerifyFailed` cho `vi` + `zh-CN`.

---

## v0.4.9 — 2026-05-19 — fix

**Fix UI_ELEMENT_NOT_FOUND khi click "Mời thành viên" sau toggle external invites**

- **Bug**: sau khi wrap external-invites BẬT toggle tại `/admin/identity` → navigate về `/admin/members` → gọi `findInviteOpenButton()` ngay, nhưng SPA render content sau navigation cần thêm vài trăm ms tới vài giây → button chưa tồn tại trong DOM → invite fail `UI_ELEMENT_NOT_FOUND`.
- **Fix 1** ([invite.ts](src/content/actions/invite.ts)): `findInviteOpenButton` giờ chạy trong `waitFor()` poll loop tới 8s thay vì gọi 1 lần. Error message rõ hơn: list 3 điểm cần check.
- **Fix 2** ([external-invites.ts](src/content/actions/external-invites.ts)): wrap `navigateTo` predicate mạnh hơn — không chỉ chờ `location.pathname.includes('/admin/members')` mà còn chờ DOM có `<main>` + ≥2 button elements (= page content đã render xong). Timeout từ 5s → 10s.
- **Symptom user thấy**: extension xoay/hang ở trang `/admin/members` nhưng KHÔNG mở dialog Invite. Task FAILED với `error_code=UI_ELEMENT_NOT_FOUND`.

---

## v0.4.8 — 2026-05-19 — feature

**Invite flow trọn vẹn: bật toggle external invites → mời → MAP lời mời về dashboard → tắt toggle**

- Sau khi invite verify thành công, thêm bước **mới**: click tab "Lời mời đang chờ xử lý" → scroll-and-scrape pending invites → return về background. Sau đó tab "Người dùng" được click lại để extension idle ở trang quen thuộc.
- Background runner ([`runner.ts`](src/background/runner.ts)) detect `INVITE_MEMBER` COMPLETED có `data.pending_members` → chunked `bulkUpsertMembers` với `scrapedStatuses=['pending']` → dashboard reconcile **chỉ** pending tab (KHÔNG đụng tới `status='active'` của member khác).
- Mapping là **best-effort**: nếu scrape pending fail (DOM lạ, locale mismatch, timeout 60s) → log warning + invite vẫn `COMPLETED`. KHÔNG bao giờ rollback invite chỉ vì mapping fail.
- External invites toggle wrap ([`external-invites.ts`](src/content/actions/external-invites.ts)) **không đổi**: vẫn bật ON trước invite, restore (thường OFF) trong `finally`. Mapping chạy giữa 2 bước → toggle OFF chỉ sau khi mapping xong.
- Phase mới `mapping` trong `reportProgress` → dashboard banner hiển thị "Đang map lời mời mới về dashboard..." giữa invite success và task COMPLETED.
- Reusable export `scrapePendingInvitesAfterInvite(taskId)` trong [`sync.ts`](src/content/actions/sync.ts) — caller bắt buộc đã ở `/admin/members`, hard cap 60s, không bao giờ throw.

---

## v0.4.7 — 2026-05-19 — fix

**Sync scraper lenient hơn (EMAIL_EXTRACT_RE fallback) + giảm 70% delay**

- Scraper `sync.ts`: thêm fallback `EMAIL_EXTRACT_RE_G` — extract email từ text node chứa email cùng tên/avatar (vd `"B b yaakovajax0054@outlook.com"`). Trước v0.4.7 chỉ dùng `EMAIL_FULL_RE` (text node phải EXACT email) — miss khi ChatGPT 2026 concat avatar+name+email vào 1 text node.
- Diagnostic logging: scrape log tổng text nodes scanned + full-match count + extract-match count + final unique rows → debug dễ hơn khi sync trả 0 row.
- **Delay -70%** toàn bộ (`human.ts` `DELAY_MULTIPLIER = 0.30`): `randomDelay` default 1500-4000ms → 450-1200ms; `microDelay` 60-140ms → 18-42ms; per-char typing 40-120ms → 12-36ms. Theo yêu cầu user "extension cứ xoay mãi" = chậm. Tradeoff: anti-detection nhẹ hơn nhưng vẫn realistic.
- **⚠ Backend pair**: backend `app/main.py` giờ tự chạy `alembic upgrade head` trên startup (lifespan). Khi pull code mới + restart backend, schema DB sẽ auto-upgrade — không cần lệnh thủ công. Khắc phục case "không có user nào ở dashboard" do migration 0009 chưa apply → SQL fail trên `SELECT FROM members`.

---

## v0.4.6 — 2026-05-19 — fix

**Sync: locale mismatch detection + anchor-click navigation cho /admin/members**

- `SYNC_DATA` action nhận `expectedLocale` (`'vi'|'en'|'zh'`) từ payload — dashboard truyền lang hiện tại (mapping `vi→vi`, `zh-CN→zh`) để extension check ChatGPT đang dùng locale gì.
- Helper mới `detectChatGPTLocale()` đọc `document.documentElement.lang` → normalize về `'vi'|'en'|'zh'`. `checkLocaleMatch(expected)` compare + tạo hint message với instructions đổi ChatGPT settings → Locale.
- Khi sync trả 0 row VÀ locale mismatch → error_code mới `'LANGUAGE_MISMATCH'` với `error_message` chứa hướng dẫn cụ thể. Dashboard `TaskCompletionBanner` show full message → user biết chính xác cần làm gì.
- `sync.ts` navigation cải tiến: ưu tiên click `<a href>` trong sidebar (Next.js router catches reliably) trước khi fallback `pushState` — khắc phục case admin tab đang ở `/admin/billing` mà `pushState` không trigger re-render.
- Backend `POST /workspaces/{id}/sync` nhận query param `expected_locale` → ghi vào `QueueItem.payload`. Dashboard `syncMembers` mutation gửi `expected_locale` mapped từ i18n state hiện tại.
- Log diagnostic: phase `discover` giờ kèm locale info trong console.

⚠ Auto-switch ChatGPT locale (tự click Settings → Locale) **không** implement và **không** lên kế hoạch tự động khi đổi ngôn ngữ dashboard. Ngôn ngữ sidebar dashboard (vi/zh-CN) chỉ đổi UI web; ChatGPT Settings đổi thủ công nếu cần. Sync không gửi `expected_locale` từ dashboard lang.

---

## v0.4.5 — 2026-05-19 — fix

**Invite progress chi tiết hơn (phase, current/total) để dashboard banner hiển thị tiến trình**

- Thêm `current` + `total` (= `emails.length`) vào mọi `reportProgress` call trong invite — banner Members hiển thị "1/4", "2/4", … real-time.
- Phase `add-row` mới: trước khi click "Add more" cho email `i`, báo phase này → user thấy ngay extension đang ở bước nào.
- Phase `opening-dialog` giờ kèm tổng số email trong message → debug dễ hơn khi banner hiển thị.
- Dashboard (`apps/web`) cập nhật banner invite — hiển thị per-task: email, status badge, phase, `current/total`, elapsed seconds, stale warning nếu > 90s không có phase. Banner FAILED riêng cho invite vừa fail (60s gần nhất) hiển thị `error_code` + `error_message`.

---

## v0.4.4 — 2026-05-19 — fix

**Multi-email invite: row-based UI 2026 (mỗi email 1 input riêng) + bổ sung text mapping**

- ChatGPT đổi dialog Invite sang layout 3-column (`Email | Role | Seat type`) với mỗi email là **1 ROW riêng** có input riêng. UI cũ là 1 input + textarea expand sau khi click "Add more".
- **Multi-email cũ**: join các email bằng `\n` vào 1 input duy nhất → 1 input không nhận newline → ChatGPT reject toàn bộ.
- **Multi-email mới**: type `email[0]` vào input đầu → loop "Add more" → đợi row mới render (input count tăng) → type `email[i]` vào input rỗng cuối → repeat. Fallback dồn email vào 1 input nếu Add more fail.
- Helpers mới: `countDialogEmailInputs(dialog)` đếm input email-like, `findLastEmptyEmailInput(dialog)` lấy input rỗng cuối.
- Text mapping `inviteSubmitButton`: thêm "Send invites" (plural), "Send invitations", "发送邀请", "Gửi các lời mời" — ưu tiên match plural trước.
- Text mapping `inviteAddMoreButton`: thêm "Add another member", "Add a member", "Add row", "Add many", "Thêm thành viên", "Thêm dòng", "添加成员", "添加一行".
- Text mapping `changeRoleMenuItem`: thêm "Change seat type", "Edit seat type", "Đổi loại ghế", "更改席位类型" — UI mới row menu chỉ còn `Change seat type` + `Remove member` (đổi role thực hiện qua dropdown trên row).
- Progress mới: "Đang nhập email i/N: {email}" — dashboard thấy tiến trình từng email.

---

## v0.4.3 — 2026-05-19 — fix

**Invite flow robust: multi-strategy label, sidebar-link nav, seat-limit error hints**

- `findExternalInvitesToggle`: thay row-only scope bằng **multi-strategy label extraction** — `aria-labelledby` → `aria-label` → `label[for]` → closest `<label>` → previous siblings → single-switch row. Switch nào không có ancestor 1-switch (DOM siblings flat) vẫn được label hoá đúng.
- `console.table` diagnostic mỗi lần scan switch — user mở DevTools thấy ngay label đọc được của từng toggle + pattern nào match/exclude.
- `navigateTo`: ưu tiên click `<a href>` trong sidebar (Next.js router catches) thay vì `pushState`. Selector mới quét tất cả `<a[href]>` match cả tuyệt đối lẫn tương đối. **Quan trọng khi extension bị invoke từ tab `/admin/billing`** — `pushState` từ billing đến identity thường không trigger re-render.
- `INVITE_ERROR_HINTS` thêm: seat limit (`insufficient seats`, `không đủ ghế`, `席位不足`, …) + external domain (`outside your organization`, `miền bên ngoài`, `外部域`). Dialog ChatGPT báo lỗi loại này sẽ được surface rõ ràng thay vì `Dialog text: …`.
- Nav timeout log warning rõ ràng (đang ở X, target Y) thay vì im lặng.

---

## v0.4.2 — 2026-05-19 — fix

**Invite flow: chọn đúng toggle "Allow External Domain Invites" (không nhầm "Automatic Account Creation")**

- `findExternalInvitesToggle()` refactor: scope text match về "row" (ancestor lớn nhất vẫn chỉ chứa 1 switch) thay vì walk-up 5 cấp — chặn false-match khi 2 toggle share ancestor.
- Thêm `EXTERNAL_INVITE_EXCLUDE_PATTERNS` — loại các row chứa "Automatic Account Creation" / "tự động tạo tài khoản" / "自动创建账户" khỏi candidate list.
- Patterns mới: "Allow External Domain Invites" (English đầy đủ), "cho phép lời mời từ miền bên ngoài" (VI), "允许外部域邀请" (ZH) — sắp xếp theo độ dài để chọn pattern đặc trưng nhất khi nhiều match.
- Best-match scoring: pattern dài nhất thắng → chọn switch có row label đặc trưng nhất.
- Áp dụng cùng heuristic cho `harvest-labels.ts` `/admin/identity` scraper — tránh ghi nhầm label "Automatic Account Creation" vào DB.

---

## v0.4.1 — 2026-05-18 — fix

**Invite flow: luôn navigate về /admin/members sau khi tắt toggle**

- `withExternalInvitesEnabled()` trong `finally`: sau khi restore toggle external invites về OFF (nếu trước đó OFF), navigate về `/admin/members` thay vì kẹt ở `/admin/identity`.
- Áp dụng cho cả invite success và invite fail — UX nhất quán + task sau (SYNC_DATA, REMOVE_MEMBER…) khởi động ở đúng trang.

---

## v0.4.0 — 2026-05-18 — feature

**HARVEST_LABELS: probe-invite mode (auto 100% locale coverage)**

- Khi tab "Pending Invites" trống, harvest tự tạo invite probe (`autogpt-probe-{ts}@example.com`) → harvest menu Revoke + confirm Revoke → tự thu hồi probe để workspace sạch.
- Bỏ `member_row_menu_button` khỏi expected list (icon-only, không có text — CSS selector handle).
- Coverage giờ 14 control_key/page Members (thay vì 15) → 18 tổng → đạt 100% nếu probe-invite chạy được.

---

## v0.3.2 — 2026-05-18 — fix

**HARVEST_LABELS: progress lifecycle (background) + initial signal**

- Background runner báo progress sớm: `queued` → `opening_tab` → `rate_limit` **trước** cả khi gửi tới content script. Trước đây dashboard im lặng 5–30s khi extension tự mở tab `chatgpt.com/admin` + inject content script.
- Content script báo signal `starting` ngay tại `0/18` trước locale check — dashboard có gì hiện ngay khi inject.
- Dashboard hiển thị status badge (`PENDING`/`IN_PROGRESS`), elapsed timer cục bộ ticking 1s, watchdog cảnh báo sau 20s nếu không thấy signal nào.
- Áp dụng cùng pattern progress lifecycle cho `SYNC_DATA`.

---

## v0.3.1 — 2026-05-18 — fix

**HARVEST_LABELS: progress real-time + nav verify + 3 phút timeout**

- Per-step progress (`current/total/scanned/elapsed_sec`) — dashboard hiện progress bar + step counter.
- `navigateSpaVerified`: kiểm tra `location.pathname` đổi thật sự sau pushState; skip page nếu nav fail thay vì hang.
- Global 3 phút timeout — harvest tự thoát nếu kẹt.
- Trả error "không lấy được label nào" nếu `total=0` sau crawl (thường do user chưa F5 hoặc selector lệch).
- JSON.parse hardening — backend 5xx không crash extension cache refresh nữa.

---

## v0.3.0 — 2026-05-18 — feature

**HARVEST_LABELS — auto-crawl ChatGPT UI label**

- Action `HARVEST_LABELS`: extension tự navigate 4 page (`/admin/members`, `/admin/billing`, `/admin/billing?tab=invoices`, `/admin/identity`), mở invite dialog + click `...` menu + đọc confirm dialog rồi ESC để hủy → đọc 18 control_key cho 1 locale.
- Dashboard Settings → UI Labels: nút "Harvest VI/EN/ZH" thay thế Console snippet thủ công.
- Endpoint mới `POST /api/v1/ui-labels/harvest` (X-API-KEY) cho extension bulk-upsert đa page.
- `POST /api/v1/workspaces/{id}/harvest-labels` (super-admin) tạo task qua SSE.

---

## v0.2.0 — 2026-05-18 — feature

**UI Label calibration + self-heal stale labels**

- Fetch `/api/v1/ui-labels/bundle` định kỳ (15 phút) — cache label calibrate vào chrome.storage.
- Actions ưu tiên label đã harvest cho (locale × page) hiện tại; fallback hardcoded text patterns nếu DB rỗng.
- Tự động POST `/report-mismatch` khi tìm element fail dù DB có label → dashboard banner stale.
- Wire DB lookup: invite open/submit/add-more, tabs (active/pending/requests/billing-plan/billing-invoices), role options, menu remove/change-role, confirm remove/revoke, toggle external invites.

---

## v0.1.0 — 2026-05-18 — feature

**Initial release**

- Cầu nối Dashboard nội bộ ↔ ChatGPT Business admin.
- Action: INVITE_MEMBER, REMOVE_MEMBER, CHANGE_ROLE, SYNC_DATA, SYNC_BILLING, REVOKE_INVITES.
- Auto-execute task qua SSE (real-time, không poll ChatGPT).
- Multi-language scraper (VI/EN/ZH).
- Port riêng: backend 18000, dashboard 17173, ext dev 17174.
