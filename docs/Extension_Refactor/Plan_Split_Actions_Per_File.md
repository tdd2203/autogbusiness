# Kế hoạch tách extension actions — mỗi hàm 1 file riêng

> **Mục tiêu:** chia nhỏ các file `apps/extension/src/content/actions/*.ts` đang
> "fat" (300–900 dòng, gom nhiều helper) thành cấu trúc 1 chức năng = 1 folder,
> mỗi helper logic độc lập = 1 file. Dễ test, dễ rebase, dễ tìm khi DOM ChatGPT
> đổi.
>
> **Phạm vi:** chỉ refactor extension content scripts. KHÔNG đụng background,
> KHÔNG đụng dashboard, KHÔNG đổi behavior. Pure file-split + import path
> update + minor barrel re-exports.
>
> **Created:** 2026-05-20
> **Branch dự kiến:** `refactor/extension-actions-split`

---

## 1. Cấu trúc hiện tại (vấn đề)

```
apps/extension/src/content/
├── actions/
│   ├── change-role.ts            (107 dòng — OK)
│   ├── external-invites.ts       (399 dòng — 8 hàm trộn DOM + nav)
│   ├── harvest-labels.ts         (738 dòng — 15+ hàm cho 4 page)
│   ├── invite.ts                 (802 dòng — 11 hàm, Phase1+Phase2 + helpers)
│   ├── member-row.ts             (helper chung — OK giữ nguyên)
│   ├── purchase-seat.ts          (894 dòng — 11 hàm finder + 2 entry)
│   ├── remove.ts                 (212 dòng — 3 hàm + entry)
│   ├── revoke-invite.ts          (148 dòng — 2 hàm)
│   ├── revoke-invites-batch.ts   (57 dòng — OK)
│   ├── sync-billing.ts           (222 dòng — 3 hàm + entry)
│   └── sync.ts                   (648 dòng — 10+ hàm scrape + regex)
├── human.ts                      (shared input helpers — OK)
├── i18n-ui.ts                    (shared label resolution — OK)
├── selectors.ts                  (shared selectors — OK)
├── progress.ts                   (shared progress reporter — OK)
├── scrapers/{user,billing}.ts    (shared scrapers — OK)
├── stripe-invoice.ts             (riêng cho invoice.stripe.com)
├── link-checkout.ts              (riêng cho checkout.link.com)
├── dashboard-bridge.ts           (postMessage bridge — OK)
└── index.ts                      (dispatcher — OK)
```

**Pain point:**
- `invite.ts` 802 dòng nhét cả Phase 1 (submit) + Phase 2 (verify) + 6 helper
  finder DOM. Mỗi lần ChatGPT đổi UI dialog phải scroll qua mấy trăm dòng.
- `sync.ts` 648 dòng có 4 regex + 5 hàm walker text node + 3 hàm scrape +
  entry point — lẫn giữa "thu thập member" và "thu thập invoice".
- `purchase-seat.ts` 894 dòng có 7 hàm finder modal + 2 entry mode
  (full / skip_to_payment) + extract regex — finder modal #1 và modal #2 trộn.
- `harvest-labels.ts` 738 dòng có hàm cho từng page (`harvestMembers`,
  `harvestBillingPlan`, `harvestBillingInvoices`, `harvestIdentity`) + 6 helper
  wait/nav + 2 helper probe invite.
- `external-invites.ts` 399 dòng có 3 cụm: tìm toggle, set state, wrapper.

---

## 2. Cấu trúc mục tiêu

```
apps/extension/src/content/
├── actions/
│   ├── invite/
│   │   ├── index.ts                       # export executeInvite + executeVerifyPendingInvite (barrel)
│   │   ├── execute-invite.ts              # executeInvite (entry Phase 1, wrap external-invites)
│   │   ├── execute-invite-inner.ts        # executeInviteInner (logic dialog: open → type → submit)
│   │   ├── execute-verify-pending.ts      # executeVerifyPendingInvite (entry Phase 2, sau F5)
│   │   ├── wait-for-pending-list-stable.ts# waitForPendingListStable
│   │   ├── click-add-more.ts              # clickAddMoreIfNeeded
│   │   ├── set-role.ts                    # setRole (native select / Radix combobox)
│   │   └── finders/
│   │       ├── find-invite-open-button.ts # findInviteOpenButton + isToggleOrSwitchOrTab
│   │       ├── find-email-input.ts        # findInviteEmailInput + countDialogEmailInputs + findLastEmptyEmailInput
│   │       └── find-submit-button.ts      # findInviteSubmitButton
│   │
│   ├── remove/
│   │   ├── index.ts                       # export executeRemove
│   │   ├── execute-remove.ts              # executeRemove (entry)
│   │   └── member-filter.ts               # findMemberFilterInput + filterAndFindRow + clearMemberFilter
│   │
│   ├── change-role/
│   │   ├── index.ts                       # export executeChangeRole
│   │   └── execute-change-role.ts         # giữ nguyên (đã sạch)
│   │
│   ├── sync/
│   │   ├── index.ts                       # export executeSync + scrapePendingInvitesAfterInvite + clickTabAndWait
│   │   ├── execute-sync.ts                # executeSync (entry, multi-tab orchestration)
│   │   ├── scrape-pending-after-invite.ts # scrapePendingInvitesAfterInvite (export)
│   │   ├── click-tab-and-wait.ts          # clickTabAndWait (export, dùng bởi nhiều action)
│   │   ├── scrape-current-tab.ts          # scrapeCurrentTab + scrollUntilAllLoaded
│   │   ├── scrape-all-rows.ts             # scrapeAllRows + countEmailsInSubtree
│   │   └── row-extractors/
│   │       ├── email.ts                   # findEmailTextNode + extractSingleEmail + EMAIL_FULL_RE + EMAIL_EXTRACT_RE_G
│   │       ├── name.ts                    # findNameInRow
│   │       └── joined-at.ts               # findJoinedAtInRow + parseDateMulti + buildIso + DATE_RE + EN_MONTHS_SYNC
│   │
│   ├── sync-billing/
│   │   ├── index.ts                       # export executeSyncBilling
│   │   ├── execute-sync-billing.ts        # entry
│   │   ├── click-billing-tab.ts           # clickBillingTab
│   │   └── log-diagnostic.ts              # logBillingDiagnostic
│   │
│   ├── revoke/
│   │   ├── index.ts                       # export executeRevokeInvites + revokeInvite + revokeInvites + RevokeResult
│   │   ├── execute-revoke-batch.ts        # executeRevokeInvites (entry, gộp revoke-invites-batch.ts)
│   │   ├── revoke-invite.ts               # revokeInvite (1 email)
│   │   └── revoke-invites-loop.ts         # revokeInvites (multi-email loop)
│   │
│   ├── harvest-labels/
│   │   ├── index.ts                       # export executeHarvestLabels
│   │   ├── execute-harvest-labels.ts      # executeHarvestLabels (entry + orchestrator 4 page)
│   │   ├── ctx.ts                         # Ctx + step + recordIfText + elapsedSec (shared state)
│   │   ├── nav.ts                         # navigateSpaVerified
│   │   ├── wait.ts                        # waitForDialog + waitForDialogClose + waitForMenu + pressEscape
│   │   ├── pages/
│   │   │   ├── members.ts                 # harvestMembers
│   │   │   ├── billing-plan.ts            # harvestBillingPlan
│   │   │   ├── billing-invoices.ts        # harvestBillingInvoices
│   │   │   └── identity.ts                # harvestIdentity
│   │   └── revoke-probe/
│   │       ├── harvest-revoke-flow.ts     # harvestRevokeFlow
│   │       ├── create-probe.ts            # createProbeInvite
│   │       ├── cleanup-probe.ts           # cleanupProbeInvite
│   │       └── find-pending-rows.ts       # findPendingRows
│   │
│   ├── purchase-seat/
│   │   ├── index.ts                       # export executePurchaseSeat
│   │   ├── execute-purchase-seat.ts       # executePurchaseSeat (entry, full mode)
│   │   ├── execute-payment-chain-only.ts  # executePaymentChainOnly (skip mode)
│   │   ├── constants.ts                   # MAX_QUANTITY + các timeout
│   │   ├── modal1/
│   │   │   ├── find-user-count-input.ts   # findUserCountInput
│   │   │   ├── find-increment-button.ts   # findIncrementButton
│   │   │   └── find-continue-button.ts    # findContinueButton
│   │   ├── modal2/
│   │   │   ├── find-charge-modal.ts       # findChargeModal
│   │   │   ├── find-add-user-button.ts    # findAddUserButton
│   │   │   ├── extract-seat-count.ts      # extractAdditionalSeatCountFromModal
│   │   │   ├── extract-charge-amount.ts   # extractChargeAmountFromModal
│   │   │   └── wait-dismiss.ts            # waitForChargeModalDismiss
│   │   └── invoice/
│   │       └── find-first-unpaid.ts       # findFirstUnpaidInvoice + findFirstUnpaidInvoiceStripeUrl
│   │
│   ├── external-invites/
│   │   ├── index.ts                       # export withExternalInvitesEnabled
│   │   ├── with-external-invites.ts       # withExternalInvitesEnabled (wrapper)
│   │   ├── set-toggle.ts                  # setExternalInvites + getToggleState
│   │   ├── navigate.ts                    # navigateTo + findNavLinkByPath
│   │   └── finders/
│   │       ├── find-toggle.ts             # findExternalInvitesToggle
│   │       ├── single-switch-row.ts       # findSingleSwitchRow
│   │       └── extract-switch-label.ts    # extractSwitchLabel
│   │
│   └── member-row.ts                      # GIỮ NGUYÊN — đã là shared helper sạch
│
├── human.ts                                # GIỮ NGUYÊN
├── i18n-ui.ts                              # GIỮ NGUYÊN
├── selectors.ts                            # GIỮ NGUYÊN
├── progress.ts                             # GIỮ NGUYÊN
├── scrapers/                               # GIỮ NGUYÊN
├── stripe-invoice.ts                       # GIỮ NGUYÊN (entry riêng cho domain stripe)
├── link-checkout.ts                        # GIỮ NGUYÊN (entry riêng cho domain link)
├── dashboard-bridge.ts                     # GIỮ NGUYÊN
└── index.ts                                # dispatcher — chỉ đổi import path
```

**Lưu ý xoá file cũ:** sau khi tách:
- xoá `actions/invite.ts`, `actions/remove.ts`, `actions/sync.ts`,
  `actions/sync-billing.ts`, `actions/revoke-invite.ts`,
  `actions/revoke-invites-batch.ts`, `actions/harvest-labels.ts`,
  `actions/purchase-seat.ts`, `actions/external-invites.ts`,
  `actions/change-role.ts`.
- `index.ts` của mỗi folder làm barrel → public API không đổi (tương đương
  import từ file `.ts` flat trước đây).

---

## 3. Quy tắc tách

| Quy tắc | Áp dụng |
|---------|---------|
| **1 file = 1 hàm public** (entry hoặc helper được nhiều file dùng) | Bắt buộc |
| **Helper private chỉ 1 caller** thì gộp vào file của caller | Giảm phân mảnh |
| **Regex/constant gắn liền hàm** thì để cùng file với hàm dùng | Đỡ phải nhảy file |
| **Barrel `index.ts`** mỗi folder action — chỉ re-export public API | Giữ import path ngắn từ `content/index.ts` |
| **KHÔNG** đụng logic, KHÔNG đổi behavior | Pure refactor |
| **Đặt tên file `kebab-case.ts`** khớp với tên hàm export | Dễ grep |
| **JSDoc** chuyển nguyên si từ file cũ sang file mới, KHÔNG rút gọn | Giữ context lịch sử (v0.6.4 fix abc...) |

---

## 4. Public API contract — KHÔNG đổi

Các symbol public sau phải vẫn export được từ vị trí cũ qua barrel:

| Symbol | Import path cũ | Import path mới (sau refactor) |
|--------|----------------|-------------------------------|
| `executeInvite`, `executeVerifyPendingInvite` | `./actions/invite` | `./actions/invite` (barrel) |
| `executeRemove` | `./actions/remove` | `./actions/remove` |
| `executeChangeRole` | `./actions/change-role` | `./actions/change-role` |
| `executeSync`, `scrapePendingInvitesAfterInvite`, `clickTabAndWait` | `./actions/sync` | `./actions/sync` |
| `executeSyncBilling` | `./actions/sync-billing` | `./actions/sync-billing` |
| `executeRevokeInvites`, `revokeInvite`, `revokeInvites`, `RevokeResult` | `./actions/revoke-invites-batch`, `./actions/revoke-invite` | gộp về `./actions/revoke` |
| `executeHarvestLabels` | `./actions/harvest-labels` | `./actions/harvest-labels` |
| `executePurchaseSeat` | `./actions/purchase-seat` | `./actions/purchase-seat` |
| `withExternalInvitesEnabled` | `./actions/external-invites` | `./actions/external-invites` |

> ⚠️ Trường hợp `revoke` — gộp 2 file cũ vào 1 folder. Phải sửa thêm 1 import
> ở `content/index.ts:11` từ `./actions/revoke-invites-batch` → `./actions/revoke`.

---

## 5. Thứ tự thực thi (giảm rủi ro)

Mỗi pha là 1 commit độc lập. Sau mỗi pha chạy `npm run build` trong
`apps/extension/` để verify TS compile + tạo bundle. KHÔNG cần test runtime
ngay từng pha — chỉ kiểm tra end-to-end sau pha cuối qua extension reload +
1 task INVITE_MEMBER + 1 task SYNC_DATA trên ChatGPT thật.

### Pha 0 — chuẩn bị (1 commit)
- [ ] Tạo branch `refactor/extension-actions-split`
- [ ] Bump `apps/extension/src/version.ts` patch (vd `0.6.7` → `0.6.8`) và
  thêm entry CHANGELOG: `refactor: tách action thành 1-hàm-1-file (không đổi behavior)`
- [ ] Commit "chore(ext): chuẩn bị refactor split actions"

### Pha 1 — action đơn giản nhất trước (1 commit)
- [ ] Tách `change-role.ts` → `change-role/{index,execute-change-role}.ts`
- [ ] Tách `revoke-invite.ts` + `revoke-invites-batch.ts` → folder `revoke/`
- [ ] Update `content/index.ts` import `./actions/revoke-invites-batch` → `./actions/revoke`
- [ ] Xoá 3 file cũ
- [ ] `npm run build` PASS
- [ ] Commit "refactor(ext): split change-role + revoke vào folder riêng"

### Pha 2 — external-invites (1 commit)
- [ ] Tách `external-invites.ts` (399 dòng) → folder `external-invites/`
- [ ] `invite.ts` (chưa tách) chỉ phải đổi import `./external-invites` → giữ nguyên path (barrel)
- [ ] `npm run build` PASS
- [ ] Commit "refactor(ext): split external-invites finders/setters"

### Pha 3 — remove + sync-billing (1 commit)
- [ ] Tách `remove.ts` → folder `remove/` (entry + member-filter helpers)
- [ ] Tách `sync-billing.ts` → folder `sync-billing/`
- [ ] `npm run build` PASS
- [ ] Commit "refactor(ext): split remove + sync-billing"

### Pha 4 — sync.ts (1 commit)
> **Rủi ro cao** — file 648 dòng, scrapeAllRows được scrapePendingInvitesAfterInvite gọi gián tiếp.
- [ ] Tách `sync.ts` → folder `sync/` theo cấu trúc đề xuất
- [ ] Đặc biệt: extractor regex (EMAIL_FULL_RE, DATE_RE, ...) move vào `row-extractors/`
- [ ] Verify `executeSync` + `scrapePendingInvitesAfterInvite` + `clickTabAndWait` vẫn export đúng từ barrel
- [ ] `invite.ts` (chưa tách) chỉ đổi import `./sync` (giữ nguyên path)
- [ ] `npm run build` PASS
- [ ] Commit "refactor(ext): split sync.ts (10+ helpers → row-extractors/)"

### Pha 5 — invite.ts (1 commit)
> **Rủi ro cao nhất** — 802 dòng, có Phase 1 + Phase 2 + 6 finder DOM.
- [ ] Tách `invite.ts` → folder `invite/`
- [ ] Hai entry `executeInvite` + `executeVerifyPendingInvite` ở 2 file riêng
- [ ] Inner `executeInviteInner` 1 file riêng (không export ra ngoài folder)
- [ ] `setRole` 1 file riêng (có cả native SELECT branch + Radix combobox branch)
- [ ] Finders gom vào subfolder `finders/`
- [ ] `npm run build` PASS
- [ ] Commit "refactor(ext): split invite.ts thành Phase1 + Phase2 + finders/"

### Pha 6 — purchase-seat (1 commit)
- [ ] Tách `purchase-seat.ts` (894 dòng) → folder `purchase-seat/`
- [ ] Modal #1 finders vào `modal1/`, modal #2 vào `modal2/`
- [ ] Invoice scrape vào `invoice/`
- [ ] `executePaymentChainOnly` (skip mode) 1 file riêng
- [ ] `npm run build` PASS
- [ ] Commit "refactor(ext): split purchase-seat (modal1/modal2/invoice)"

### Pha 7 — harvest-labels (1 commit)
- [ ] Tách `harvest-labels.ts` (738 dòng) → folder `harvest-labels/`
- [ ] Mỗi page (members/billing-plan/billing-invoices/identity) 1 file trong `pages/`
- [ ] Cluster probe invite (`createProbeInvite`, `cleanupProbeInvite`, `harvestRevokeFlow`, `findPendingRows`) vào `revoke-probe/`
- [ ] Shared `Ctx` + `step` + `recordIfText` vào `ctx.ts`
- [ ] `npm run build` PASS
- [ ] Commit "refactor(ext): split harvest-labels theo page/"

### Pha 8 — verification + smoke test (1 commit nếu cần fix)
- [ ] `npm run build` PASS lần cuối
- [ ] Load unpacked extension từ `apps/extension/dist/`
- [ ] Test 5 luồng smoke trên dashboard local:
  - [ ] `INVITE_MEMBER` 1 email → verify pending tab có row
  - [ ] `SYNC_DATA` workspace có > 5 member → verify dashboard có đủ
  - [ ] `REMOVE_MEMBER` 1 email vừa invite → verify xoá thành công
  - [ ] `SYNC_BILLING` → verify seat ratio đúng
  - [ ] `HARVEST_LABELS` locale=vi → verify 18 control_key có label
- [ ] Nếu smoke fail → fix import bị miss → commit "fix(ext): import path còn miss sau split"
- [ ] PR `refactor/extension-actions-split` → master

### Pha 9 — cleanup (optional, sau merge)
- [ ] Verify `apps/extension/CHANGELOG.md` mention refactor
- [ ] Verify Memory `feedback_extension_version_bump.md` không bị vi phạm
  (version đã bump ở Pha 0)
- [ ] Update `docs/Extension_Refactor/` thêm `Done_<date>.md` nếu cần lưu lại

---

## 6. Checklist verify mỗi pha

Trước khi commit pha:

```powershell
# 1. TypeScript compile
cd apps/extension
npm run build

# 2. Verify file mới có đúng JSDoc đã copy
git diff --stat HEAD~1

# 3. Verify barrel index.ts export đúng
grep -E "^export" apps/extension/src/content/actions/<folder>/index.ts

# 4. Verify content/index.ts dispatch không break
grep -E "from\s+\"\\./actions/" apps/extension/src/content/index.ts
```

---

## 7. Anti-pattern cần tránh khi refactor

| Anti-pattern | Lý do tránh |
|--------------|-------------|
| Đổi tên hàm sang camelCase mới khi tách file | Vi phạm "no behavior change" |
| Gộp 2 hàm thành 1 vì "trông giống nhau" | Có thể giống cú pháp nhưng diff về phạm vi (vd `findMemberRow` ở `member-row.ts` shared, ở từng action không cùng input shape) |
| Extract regex thành module const generic | Regex có context (DATE_RE ở sync ≠ DATE_RE harvest), tách lung tung → import circular |
| Bỏ JSDoc cũ vì "đã rõ" | Comment có lý do lịch sử (v0.6.4 vì sao bỏ scrapedStatuses), mất context = bug tương lai |
| Thêm test runner ngay trong refactor PR | Phạm vi quá rộng → khó review. Test thuộc PR riêng. |
| Sửa luôn bug khi nhìn thấy | Out of scope, log issue riêng |
| Đổi `apps/extension/CHANGELOG.md` thành nhiều entry | 1 entry "refactor split actions" là đủ |

---

## 8. Rủi ro & mitigation

| Rủi ro | Khả năng | Mitigation |
|--------|----------|-----------|
| Import circular sau tách | Trung bình — `sync` được `invite` import lại | Verify build sau mỗi pha; nếu cycle → đẩy helper lên `actions/_shared/` |
| Vite bundler không tree-shake đúng | Thấp | Build prod + so sánh size `dist/assets/index.ts-*.js` trước/sau |
| Mất JSDoc lịch sử quan trọng | Cao nếu copy ẩu | Dùng git diff để verify mỗi block comment được copy nguyên si |
| Quên update `content/index.ts` import | Trung bình | Build sẽ fail TS → bắt được trước commit |
| Quên xoá file cũ sau tách | Thấp | Mỗi pha có step "xoá file cũ" tường minh; `git status` sau build |
| Bug regression do nhầm logic khi tách hàm dùng `this` / closure | Thấp (extension không dùng class, chủ yếu pure function) | Smoke test ở Pha 8 |

---

## 9. Sau khi merge

- [ ] Bump version extension (đã làm ở Pha 0) — popup hiển thị `v0.6.8`
- [ ] Lưu lại file kế hoạch này dưới `docs/Extension_Refactor/` để tham chiếu
- [ ] Cập nhật Memory `feature_changelog_practice.md` nếu cần (mỗi action giờ
  có thể có spec riêng — sau refactor sẽ tách spec dễ hơn)
- [ ] Cân nhắc PR follow-up:
  - Thêm unit test cho row-extractors (regex EMAIL/DATE/role)
  - Thêm unit test cho extract amount/seat count từ modal text
  - Tách `human.ts` đã 200+ dòng nhưng vẫn cohesive — chưa cần

---

## 10. Ước lượng effort

| Pha | Số file mới | Số dòng di chuyển | Ước lượng |
|-----|-------------|-------------------|-----------|
| 0 | 0 | 0 | 15' |
| 1 | 6 | ~260 | 30' |
| 2 | 7 | ~400 | 30' |
| 3 | 6 | ~440 | 30' |
| 4 | 9 | ~650 | 60' |
| 5 | 8 | ~800 | 90' |
| 6 | 10 | ~900 | 60' |
| 7 | 12 | ~740 | 60' |
| 8 | 0 (smoke) | 0 | 30' |
| **Tổng** | **58** | **~4200** | **~6h** |

> Có thể chia làm 2 ngày: ngày 1 = pha 0–4 (low/med risk), ngày 2 = pha 5–8
> (invite/purchase-seat/harvest-labels là 3 cụm rủi ro nhất).
