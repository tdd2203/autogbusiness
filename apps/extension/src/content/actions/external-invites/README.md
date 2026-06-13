# Logic chi tiết: `external-invites` wrapper

> **Folder:** [`apps/extension/src/content/actions/external-invites/`](./)
> **KHÔNG phải dispatcher action** — không nhận `ExecuteActionRequest` trực tiếp. Đây là **wrapper helper** dùng bởi `executeInvite` để toggle setting workspace bảo mật trước/sau khi mời.
> **Mục đích:** đảm bảo trước khi invite email **ngoài domain verified**, workspace setting "Cho phép lời mời từ miền bên ngoài" được BẬT tạm thời; sau invite tắt OFF luôn (force) để giảm rủi ro bảo mật.

## 1. Public API

```ts
// external-invites/index.ts (barrel)
export { withExternalInvitesEnabled } from "./with-external-invites";

// with-external-invites.ts
export async function withExternalInvitesEnabled<T>(
  taskFn: () => Promise<T>,
): Promise<T>
```

- Generic `<T>` cho phép wrap bất kỳ async function nào.
- Hiện chỉ dùng bởi `executeInvite` ([invite.ts:222](../invite.ts#L222)):
  ```ts
  const inviteResult = await withExternalInvitesEnabled(() =>
    executeInviteInner(taskId, emails, role),
  );
  ```

## 2. Spec bảo mật (user 2026-05-20, v0.6.6)

> "Cho phép lời mời từ miền bên ngoài" (`Allow External Domain Invites`) là rủi ro nghiêm trọng: khi BẬT, mọi member trong workspace có thể mời người ở bất kỳ domain nào. Nếu để ON lâu dài, attacker compromise 1 member → spam invite domain ngoài → leak workspace.

Quy trình do user yêu cầu chốt v0.6.6:

1. **Kiểm tra toggle hiện tại** (read prev state).
2. **Nếu OFF → bật ON.** Nếu đã ON → skip click (giữ nguyên cho invite).
3. **Chạy taskFn** (invite).
4. **SAU INVITE (finally): LUÔN tắt OFF**, KỂ CẢ user đã bật ON từ trước.
   - Lý do: vi phạm spec bảo mật của user ("sau mời xong phải tắt mời ngoài"). v0.6.6 force OFF.
5. **Sau khi tắt toggle**, navigate về `/admin/members` để task sau chạy ở đúng trang.

> **GUARANTEE:** `finally` luôn chạy kể cả `taskFn` throw → toggle luôn về OFF.

## 3. Cấu trúc folder

```
external-invites/
├── index.ts                          # Barrel: export withExternalInvitesEnabled
├── with-external-invites.ts          # Wrapper try/finally — LOGIC CHÍNH
├── set-toggle.ts                     # setExternalInvites(target) + private getToggleState
├── navigate.ts                       # navigateTo(pathname, predicate) + private findNavLinkByPath
└── finders/
    ├── find-toggle.ts                # findExternalInvitesToggle — multi-strategy match
    ├── extract-switch-label.ts       # extractSwitchLabel — aria + label + sibling
    └── single-switch-row.ts          # findSingleSwitchRow + SWITCH_SEL const
```

## 4. Luồng xử lý — `withExternalInvitesEnabled<T>(taskFn)`

```
┌─────────────────────────────────────────────────────────────────┐
│ withExternalInvitesEnabled(taskFn)                              │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ setExternalInvites(true)    │  ← Bật ON
              │ → { prev: bool|null,        │
              │     changed: bool }         │
              └─────────────────────────────┘
                            │
                            ▼
                  prev === null?
                            │
              ┌── YES ──────┴───── NO ───┐
              ▼                            ▼
   Không control được toggle  Log state trước invite:
   (DOM đổi, không tìm thấy)  "OFF → đã bật ON" hoặc "đã ON sẵn"
                                          │
                                          ▼
              ┌─────────────────────────────┐
              │ navigateTo(MEMBERS_PATH,    │  ← Đợi /admin/members render đủ
              │   predicate: pathname +     │    (main + > 2 buttons)
              │   main + > 2 buttons)       │    timeout 10s
              │   timeout 10s               │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ try {                       │
              │   return await taskFn()     │  ← Chạy invite
              │ } finally {                 │
              │   ... cleanup               │
              │ }                           │
              └─────────────────────────────┘
                            │
                            ▼
                  FINALLY (LUÔN chạy):
                            │
              ┌─────────────────────────────┐
              │ setExternalInvites(false)   │  ← FORCE OFF (v0.6.6)
              │ — kể cả prev=ON             │    KHÔNG restore prev
              │ — try/catch silent fail     │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ navigateTo(MEMBERS_PATH,    │  ← Đảm bảo end state ở /admin/members
              │   predicate: pathname +     │    UX nhất quán cho user + task sau
              │   main + > 2 buttons)       │
              │   timeout 10s               │
              └─────────────────────────────┘
```

## 5. Luồng `setExternalInvites(target: boolean)`

```
1. navigateTo("/admin/identity", () => !!findExternalInvitesToggle(), 10s)
   - Click sidebar link nếu có, else pushState
   - Đợi DOM render toggle
   - Nếu sau 10s vẫn không thấy toggle → return { prev: null, changed: false }

2. toggle = findExternalInvitesToggle()

3. prev = getToggleState(toggle):
   - <input>: el.checked
   - <button role="switch">: aria-checked="true"/"false"
   - Fallback Radix: data-state="checked"/"unchecked"
   - Cuối cùng: warn + false

4. if (prev === target) → skip click, return { prev, changed: false }

5. humanClick(toggle) + sleep(800ms để ChatGPT PATCH /api/...)

6. Re-query toggle + getToggleState → verify newState === target
   (Chỉ log warning nếu mismatch, KHÔNG throw — best-effort)

7. return { prev, changed: true }
```

## 6. Luồng `findExternalInvitesToggle()` — multi-strategy match

Trang `/admin/identity` thường có nhiều toggle (vd "Automatic Account Creation", "SSO Enforce", etc) — phải pick đúng cái "Allow External Domain Invites".

```
1. Lấy DB labels: dbLabelsFor("toggle_external_invites", "/admin/identity")
   → Array các text từ DB (calibrated bởi HARVEST_LABELS task)

2. Patterns = [...dbLabels, ...EXTERNAL_INVITE_LABEL_PATTERNS]
   EXTERNAL_INVITE_LABEL_PATTERNS (i18n-ui.ts) include:
     "cho phép lời mời từ miền bên ngoài"
     "allow external domain invites"
     "external invite"
     "允许外部域名邀请"
     ...

3. EXCLUDE_PATTERNS (loại bỏ toggle KHÁC khớp nhầm):
     "automatic account creation"
     "tự động tạo tài khoản"
     ...

4. Loop qua tất cả switches:
   for (el of document.querySelectorAll('button[role="switch"], input[type="checkbox"]')) {
     label = extractSwitchLabel(el)  ← aria-labelledby > aria-label > <label for> > prev sibling > single-switch row

     if EXCLUDE_PATTERNS.find((p) => label.includes(p)) → skip

     score = max length của pattern khớp trong label
     if score > bestScore → update bestEl
   }

5. console.table(diagnostic) → log từng switch với label + matched + excluded
   (để dev debug khi DOM ChatGPT đổi)

6. Trả bestEl hoặc null
   - Null: reportLabelMismatch để dashboard biết DB labels cũ + alert admin re-harvest
```

## 7. Luồng `extractSwitchLabel(el)` — gom text từ aria + label + sibling

ChatGPT toggle có thể có label gắn theo nhiều cách:

```
Strategy (theo độ đặc trưng giảm dần):
1. aria-labelledby → text của element được tham chiếu
2. aria-label trực tiếp trên switch
3. <label for="{switch.id}">
4. closest <label> ancestor
5. Previous siblings (limit 3 — structure <h3>label</h3><p>desc</p><switch/>)
6. Text của single-switch row (fallback rộng nhất, có thể nuốt label switch khác)

Tất cả parts concat → lowercase → trim whitespace
→ dùng cho includes() check pattern + exclude
```

## 8. Luồng `navigateTo(pathname, predicate, timeoutMs)`

```
1. Nếu pathname hiện tại đã đúng → skip navigate, jump tới step 2

2. Cố tìm sidebar link <a href={pathname}>:
   - if found → link.click() (Next.js router catches reliably)
   - else → history.pushState() + dispatchEvent(PopStateEvent("popstate"))

3. Poll predicate() mỗi 500ms, max timeoutMs:
   - predicate() returns true → return true
   - timeout → log warn + return predicate() lần cuối
```

> **Tại sao không chỉ pushState?** Next.js router đôi khi không bắt `popstate` event đầu tiên — click `<a>` reliable hơn vì bind Next link handler.

## 9. Lịch sử sửa lỗi & quyết định thiết kế

### Timeline đầy đủ (từ CHANGELOG)

#### v0.1.0 (2026-05-18) — release đầu
- Wrapper `withExternalInvitesEnabled` chưa có. Invite chỉ làm trực tiếp — fail nếu email ngoài domain verified.

#### v0.4.1 (2026-05-18) — luôn navigate về /admin/members trong finally
- **Bug:** sau khi restore toggle, extension kẹt ở `/admin/identity` → task sau (SYNC, REMOVE) phải tự navigate lại.
- **Fix:** trong `finally` của `withExternalInvitesEnabled`, navigate về `/admin/members` SAU khi restore toggle, kể cả invite success hay fail. UX nhất quán.

#### v0.4.2 (2026-05-19) — chọn đúng toggle (exclude "Automatic Account Creation")
- **Bug:** trang `/admin/identity` có nhiều toggle (vd "Cho phép lời mời từ miền bên ngoài" + "Tự động tạo tài khoản"). Multi-strategy label match cũ scope text quá rộng (walk-up 5 cấp) → match nhầm "Automatic Account Creation" → bật/tắt sai toggle → invite vẫn fail.
- **Fix:** scope text match về **row** (ancestor lớn nhất vẫn chỉ chứa 1 switch) thay vì walk-up cố định.
- Thêm `EXTERNAL_INVITE_EXCLUDE_PATTERNS` — loại các row chứa "Automatic Account Creation" / "tự động tạo tài khoản" / "自动创建账户" khỏi candidate list.
- Patterns mới đa ngôn ngữ + best-match scoring: pattern dài nhất thắng → chọn switch có row label đặc trưng nhất.

#### v0.4.3 (2026-05-19) — multi-strategy label extraction + diagnostic
- **Bug:** một số toggle có DOM siblings flat (không có ancestor 1-switch) → row-only scope của v0.4.2 không lấy được label → toggle không tìm thấy.
- **Fix:** `extractSwitchLabel` mở rộng strategy:
  1. `aria-labelledby` (chính xác nhất)
  2. `aria-label`
  3. `<label for>`
  4. closest `<label>` ancestor
  5. Previous siblings (limit 3)
  6. Single-switch row (fallback rộng nhất)
- `console.table` diagnostic mỗi lần scan switch — user mở DevTools thấy ngay label của từng toggle + pattern nào match/exclude.
- `navigateTo` ưu tiên click `<a href>` trong sidebar (Next.js router catches) thay vì `pushState` — fix case extension invoke từ tab `/admin/billing` mà pushState không trigger re-render.

#### v0.4.9 (2026-05-19) — predicate sau navigate mạnh hơn (race condition)
- **Bug:** sau khi bật toggle tại `/admin/identity` → navigate về `/admin/members` → gọi `findInviteOpenButton()` ngay → SPA render content cần vài trăm ms tới vài giây → button chưa tồn tại → invite fail `UI_ELEMENT_NOT_FOUND`.
- **Symptom user thấy:** extension xoay/hang ở `/admin/members` nhưng KHÔNG mở dialog Invite.
- **Fix:** `navigateTo` predicate mạnh hơn — không chỉ chờ pathname mà còn chờ DOM có `<main>` + **≥2 button elements** (= page content đã render xong). Timeout 5s → **10s**.
- Kèm theo fix invite.ts: `findInviteOpenButton` giờ chạy trong `waitFor()` poll loop tới 8s thay vì gọi 1 lần.

#### v0.6.1 (2026-05-20) — fix humanClick double-fire
- **Bug nghiêm trọng:** [`humanClick`](../../human.ts) trước v0.6.1 dispatch synthetic `MouseEvent('click')` RỒI gọi LUÔN `el.click()` native → mỗi lần "click" thực ra fire **2 lần**.
- **Symptom user-reported (cho external-invites):** Toggle "Cho phép lời mời từ miền bên ngoài" click 1 lần → ChatGPT nhận 2 toggle event → **2 toast "Đã cập nhật"** → toggle quay về state cũ → invite vẫn fail.
- **Fix:** chỉ gọi `el.click()` native (Radix/React `onClick` đều catch được). Synthetic `MouseEvent('click')` chỉ là **fallback** khi `el.click` không phải function hoặc throw.
- File [`human.ts`](../../human.ts) `humanClick`.

#### v0.6.5 (2026-05-20) — trình tự "tắt toggle TRƯỚC, chuyển tab Lời mời SAU"
- **Bug:** trước v0.6.5 trình tự: chuyển tab Lời mời TRƯỚC → restore toggle SAU.
  - Restore toggle navigate qua `/admin/identity` → khi quay về `/admin/members` thì **mất URL `?tab=invites`** → F5 load tab "Người dùng" mặc định → Phase 2 verify pending invite **không tìm thấy email**.
- **Fix:** đảo trình tự — tắt toggle TRƯỚC (xong navigate cuối về `/admin/members`), chuyển tab Lời mời SAU ở scope của `executeInvite` ([invite.ts:228-257](../invite.ts#L228-L257)). URL `?tab=invites` được giữ cho F5 verify.

#### **v0.6.6 (2026-05-20) — 🔴 SPEC FIX: LUÔN tắt OFF, KHÔNG restore prev**
- **Bug v0.6.5:** chỉ restore toggle khi `changed=true` → nếu prev=ON (user bật vĩnh viễn) thì finally bỏ qua → toggle giữ ON → vi phạm spec bảo mật user.
- **Spec user 2026-05-20:** "sau mời xong phải tắt mời ngoài" — kể cả prev=ON.
- **Fix:** trong finally, LUÔN gọi `setExternalInvites(false)` — không check `changed`, không restore prev. User có thể bật lại thủ công nếu cần invite tiếp.
- **Lý do:** "Cho phép lời mời từ miền bên ngoài" là rủi ro nghiêm trọng — sau mỗi invite extension phải về trạng thái an toàn nhất (OFF).
- Kèm theo: `waitForPendingListStable` + retry chain `[0, 3000, 6000]` cho Phase 2 verify (xem [`../invite/README.md`](../invite/README.md) section bug fix).

### Bảng tóm tắt

| Version | Loại | Tóm tắt |
|---------|------|---------|
| v0.4.1 | fix | Navigate về `/admin/members` trong finally (UX nhất quán) |
| v0.4.2 | fix | Exclude "Automatic Account Creation" + row-scope text match |
| v0.4.3 | fix | Multi-strategy label extraction + console.table diagnostic |
| v0.4.9 | fix | Predicate mạnh hơn (main + > 2 buttons), timeout 10s |
| v0.6.1 | fix | `humanClick` double-fire (toggle 2 lần → 2 toast) |
| v0.6.5 | fix | Trình tự "tắt toggle TRƯỚC, chuyển tab Lời mời SAU" |
| **v0.6.6** | **🔴 spec fix** | **LUÔN tắt OFF sau invite, KHÔNG restore prev (bảo mật)** |

> **🔥 Symptom debug nhanh:**
> - Toggle bật/tắt sai (nhầm "Automatic Account Creation") → DOM ChatGPT đổi → check `EXTERNAL_INVITE_LABEL_PATTERNS` + `EXTERNAL_INVITE_EXCLUDE_PATTERNS`. Mở DevTools xem `console.table` diagnostic.
> - Toggle click 1 lần → 2 toast → `humanClick` regression — verify [`human.ts`](../../human.ts) vẫn chỉ gọi `el.click()` native, KHÔNG fire synthetic event dư.
> - Toggle giữ ON sau invite → v0.6.6 spec bị regression — verify finally block force OFF, KHÔNG có branch nào skip dựa trên `changed`/`prev`.
> - Invite fail `UI_ELEMENT_NOT_FOUND` sau khi bật toggle → race condition navigation — verify predicate trong `navigateTo("/admin/members", ...)` còn check `main + buttons.length > 2`.

## 10. Fail mode

| Tình huống | Hành vi extension | Recovery |
|------------|-------------------|----------|
| `findExternalInvitesToggle()` trả null (DOM ChatGPT đổi) | `setResult.prev === null` → log warn + chạy invite KHÔNG bật toggle. Nếu email ngoài domain, invite có thể fail (ChatGPT từ chối) | Admin re-harvest labels qua `HARVEST_LABELS` task, hoặc update `EXTERNAL_INVITE_LABEL_PATTERNS` trong [`i18n-ui.ts`](../../i18n-ui.ts) |
| Bật toggle ON nhưng `verify newState !== target` | Log warn, KHÔNG throw, continue chạy taskFn (invite có thể work nếu ChatGPT vẫn accept) | Manual: kiểm tra trang `/admin/identity` thấy toggle bật chưa |
| Force OFF cuối finally throw | Log warn "force OFF FAILED — ChatGPT có thể vẫn ở trạng thái external invites = ON" | Admin tắt thủ công tại `/admin/identity` |
| Navigate về `/admin/members` cuối finally throw | Log warn — task sau (REMOVE, SYNC) tự navigate qua `findControlByKey` | Không cần fix gì |

## 11. Test thủ công

```
1. Mở /admin/identity → verify toggle "Cho phép lời mời từ miền bên ngoài" đang OFF
2. Dashboard: invite 1 email DOMAIN NGOÀI (vd "test@gmail.com" nếu workspace verify zoominfo.com)
3. Verify trong DevTools Console tab ChatGPT:
   - "[autogpt-external-invites] state trước invite: OFF → đã bật ON cho invite"
   - "[autogpt-external-invites] SAU INVITE: LUÔN tắt toggle về OFF (force OFF...)"
4. Verify `/admin/identity` sau task xong: toggle ĐÃ TẮT (OFF)
5. Test edge case: pre-bật toggle ON thủ công → invite domain ngoài
   - Verify console: "state trước invite: ON (đã ON sẵn, không click)"
   - Verify SAU task: toggle TẮT (force OFF, không restore prev)
```
