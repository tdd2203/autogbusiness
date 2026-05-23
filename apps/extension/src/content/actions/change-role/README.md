# Logic chi tiết: `CHANGE_ROLE` action

> **Folder:** [`apps/extension/src/content/actions/change-role/`](./)
> **Trigger:** background runner gửi `ExecuteActionRequest` `{ kind: "CHANGE_ROLE", taskId, email, new_role, old_role }`
> **Mục đích:** đổi vai trò của 1 thành viên trên trang `chatgpt.com/admin/members` từ role hiện tại sang role mới (owner/admin/member/analytics_viewer)

## 1. Public API

```ts
// change-role/index.ts (barrel)
export { executeChangeRole } from "./execute-change-role";

// execute-change-role.ts
export async function executeChangeRole(
  taskId: string,
  email: string,
  newRole: ChatGPTRole,
  oldRole: ChatGPTRole | null = null,
): Promise<ExecuteActionResponse>
```

- `taskId`: ID task để report progress về backend qua [`reportProgress`](../../progress.ts).
- `email`: email member cần đổi role.
- `newRole`: role đích — `"owner" | "admin" | "member" | "analytics_viewer"`.
- `oldRole`: role hiện tại (optional). Dùng để chính xác hơn khi tìm dropdown vì label dropdown đang hiển thị role cũ. `null` nghĩa là không biết → fallback match tất cả role label.

**Trả về:**
- `{ ok: true, data: { email, new_role, old_role } }` khi thành công
- `{ ok: false, error_code, error_message }` khi fail (mã: `PAGE_NOT_ADMIN`, `UI_ELEMENT_NOT_FOUND`)

## 2. Luồng xử lý (step-by-step)

```
┌─────────────────────────────────────────────────────────────────┐
│ executeChangeRole(taskId, email, newRole, oldRole)              │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ Report "locating"           │  ← reportProgress({phase:"locating"})
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ Check pathname /admin       │  ← nếu không phải /admin → return PAGE_NOT_ADMIN
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ findMemberRow(email)        │  ← helper từ ../member-row
              │   tìm DOM row chứa email    │
              └─────────────────────────────┘
                            │
                            ▼
                   row === null ?
                            │
              ┌─── YES ─────┴────── NO ───┐
              ▼                             ▼
   return UI_ELEMENT_NOT_FOUND   ┌─────────────────────────────┐
                                  │ Report "opening-dropdown"   │
                                  └─────────────────────────────┘
                                              │
                                              ▼
                                  ┌─────────────────────────────┐
                                  │ findRowRoleDropdown(row,    │
                                  │   oldRole)                  │
                                  │   tìm <button> dropdown vai │
                                  │   trò trong row             │
                                  └─────────────────────────────┘
                                              │
                                              ▼
                                       dropdown null?
                                              │
                                  ┌── YES ────┴───── NO ────┐
                                  ▼                          ▼
                       return UI_ELEMENT_NOT_FOUND  ┌─────────────────────┐
                                                     │ randomDelay()       │
                                                     │ humanClick(dropdown)│  ← click mở menu
                                                     │ sleep(400ms)        │
                                                     └─────────────────────┘
                                                              │
                                                              ▼
                                                     Report "selecting"
                                                              │
                                                              ▼
                                                     findRoleOption(newRole)
                                                              │  ← i18n-ui.ts trả option theo
                                                              │    label ROLE_LABELS[newRole]
                                                              │    (đa ngôn ngữ vi/en/zh)
                                                              ▼
                                                       option null?
                                                              │
                                                  ┌── YES ────┴──── NO ───┐
                                                  ▼                        ▼
                                       return UI_ELEMENT_NOT_FOUND  humanClick(option)
                                                                          │
                                                                          ▼
                                                                  randomDelay(800-1500)
                                                                          │
                                                                          ▼
                                                                  VERIFY (best-effort):
                                                                  - findMemberRow(email)
                                                                  - findRowRoleDropdown(row,
                                                                    newRole)
                                                                  - log success/warning,
                                                                    KHÔNG fail nếu verify fail
                                                                          │
                                                                          ▼
                                                                  return { ok: true,
                                                                    data: { email, new_role,
                                                                    old_role } }
```

## 3. Quy ước UI ChatGPT (2026)

| Element | DOM pattern | Selector / heuristic |
|---------|-------------|----------------------|
| Row member | `<div>` chứa email + cột Vai trò + cột Ngày | `findMemberRow(email)` — walk text nodes tìm email-format text node, trace lên ancestor lớn nhất chứa đúng 1 email |
| Dropdown role | `<button>` text = "Thành viên" / "Member" / "成员" / ... | `findRowRoleDropdown(row, role)` — tìm button trong row có text khớp `ROLE_LABELS[role]` từ [`i18n-ui.ts`](../../i18n-ui.ts) |
| Role option (sau click dropdown) | `<div role="menuitem">` hoặc `<li>` text khớp ROLE_LABELS | `findRoleOption(newRole)` — tương tự nhưng search trong menu vừa mở |

**ROLE_LABELS** đa ngôn ngữ:
```
owner            → "Chủ sở hữu" / "Owner" / "所有者"
admin            → "Quản trị viên" / "Admin" / "管理员"
member           → "Thành viên" / "Member" / "成员"
analytics_viewer → "Trình xem dữ liệu phân tích" / "Analytics Viewer" / "分析查看者"
```

## 4. Lịch sử sửa lỗi & quyết định thiết kế

### Timeline đầy đủ (từ CHANGELOG)

#### v0.1.0 (2026-05-18) — release đầu
- Action `CHANGE_ROLE` ra mắt cùng các action khác (INVITE_MEMBER, REMOVE_MEMBER, SYNC_DATA, SYNC_BILLING, REVOKE_INVITES).
- Flow CŨ: click "..." menu trong row → "Change role" item → dropdown trong dialog → chọn role.

#### v0.2.0 (2026-05-18) — wire DB label lookup
- Thêm DB lookup cho `menu_change_role` qua [`dbLabelsFor`](../../../shared/ui-labels.ts).
- Trước v0.2.0: chỉ dùng hardcoded `TEXT_FALLBACKS.changeRoleMenuItem` (vi/en/zh fixed).
- Sau v0.2.0: nếu DB có label calibrate (qua HARVEST_LABELS), ưu tiên DB trước fallback.

#### v0.4.4 (2026-05-19) — text mapping mới "Change seat type"
- **Root cause:** ChatGPT đổi dialog Invite sang layout 3-column → row menu chỉ còn `"Change seat type"` + `"Remove member"` (ĐỔI ROLE đã chuyển sang dropdown inline).
- **Fix:** thêm `"Change seat type"`, `"Edit seat type"`, `"Đổi loại ghế"`, `"更改席位类型"` vào `TEXT_FALLBACKS.changeRoleMenuItem` để extension vẫn tìm được item kể cả khi user dùng flow cũ.
- **Lưu ý:** đây là patch tạm thời — flow cũ click "..." đã KHÔNG còn dùng cho CHANGE_ROLE từ v0.4.15.

#### **v0.4.15 (2026-05-19) — 🔴 BREAKING FIX: chuyển sang inline dropdown**
- **Root cause:** UI ChatGPT 2026 đổi role qua **dropdown INLINE** trên row ("Thành viên ▼" trực tiếp trong cột Vai trò) — **KHÔNG còn ẩn trong "..." menu**. Code v0.4.14 vẫn dùng flow cũ → click "..." → tìm "Change role" item → KHÔNG có → `waitFor` timeout → treo **IN_PROGRESS vĩnh viễn**.
- **Fix:** tìm inline dropdown theo text role hiện tại + label match → click → menu mở → click target role option.
- **Helper mới:** `findRowRoleDropdown(row, currentRole?)` trong [`member-row.ts`](../member-row.ts) — multi-strategy:
  1. Match text role label (Thành viên / Member / 成员).
  2. Fallback `aria-haspopup="menu"` hoặc `aria-haspopup="listbox"` (loại trừ seat type dropdown "ChatGPT"/"Codex").
- **Dispatcher** [`content/index.ts`](../../index.ts) pass `old_role` từ task payload → helper lọc dropdown theo role hiện tại chính xác hơn.
- **Dashboard fix kèm theo:** [`Members.tsx`](../../../../../web/src/pages/Members.tsx) `useEffect` watch `recentTasks` — khi task `CHANGE_ROLE` (cùng INVITE/REMOVE/REVOKE/SYNC_DATA) chuyển sang COMPLETED → `invalidateQueries(['members'])` → list refresh tự động trong **<2s**, không cần F5.

#### v0.4.16 (2026-05-19) — thêm role `analytics_viewer`
- Dashboard role dropdown CHỈ hiển thị "Thành viên" + "Xem dữ liệu" (analytics_viewer). Member đã là admin/owner KHÔNG cho đổi qua dashboard — chỉ icon 🔒 + tooltip.
- Schema [`messages.ts`](../../../shared/messages.ts) `ChatGPTRole` type thêm `"analytics_viewer"`.
- [`i18n-ui.ts`](../../i18n-ui.ts) `ROLE_LABELS` + `ROLE_KEYWORDS` thêm:
  - VI: `"Trình xem dữ liệu phân tích"`
  - EN: `"Analytics viewer"`
  - ZH: `"分析查看器"`
- Backend [`schemas.py`](../../../../../api/app/schemas.py) thêm `"analytics_viewer"` vào `Literal` type.

#### v0.4.20 (2026-05-19) — DB sync sau CHANGE_ROLE COMPLETED
- **Bug:** trước v0.4.20, extension đổi role trên ChatGPT thành công nhưng **DB không update** → dashboard hiển thị role cũ tới khi `SYNC_DATA` chạy.
- **Fix backend** [`update_task`](../../../../../api/app/routers/queue.py): thêm handler khi `CHANGE_ROLE` chuyển sang `COMPLETED` → `Member.chatgpt_role = new_role` ngay.

### Bảng tóm tắt

| Version | Loại | Tóm tắt |
|---------|------|---------|
| v0.1.0 | feature | Release action `CHANGE_ROLE` |
| v0.2.0 | feature | Wire DB lookup `menu_change_role` |
| v0.4.4 | fix | Text mapping "Change seat type" (UI mới) |
| **v0.4.15** | **🔴 BREAKING fix** | **Switch to inline dropdown (fix treo IN_PROGRESS)** |
| v0.4.16 | feature | Thêm role `analytics_viewer` |
| v0.4.20 | fix | DB sync `Member.chatgpt_role` sau COMPLETED |

> **🔥 Symptom debug nhanh:**
> - `CHANGE_ROLE` treo `IN_PROGRESS` vĩnh viễn → ChatGPT có thể đã đổi UI dropdown lần nữa. Kiểm tra `findRowRoleDropdown` còn match được không. Có thể cần thêm `aria-haspopup` mới hoặc text variant mới vào `ROLE_LABELS`.
> - `CHANGE_ROLE` COMPLETED nhưng dashboard hiển thị role cũ → backend handler `update_task` không update `Member.chatgpt_role` — kiểm tra [`queue.py`](../../../../../api/app/routers/queue.py).
> - Menu dropdown mở nhưng option `newRole` không tìm thấy → role label chưa được calibrate cho locale ChatGPT đang dùng → chạy `HARVEST_LABELS` task cho locale đó.

## 5. Fail mode & error code

| Mã | Khi nào xảy ra | Cách fix |
|----|----------------|----------|
| `PAGE_NOT_ADMIN` | URL hiện tại không chứa `/admin` (extension chạy nhầm tab) | Mở `chatgpt.com/admin/members` thủ công |
| `UI_ELEMENT_NOT_FOUND` (no row) | Email không có trong DOM hiện tại — có thể chưa scroll tới, hoặc đã bị xoá | Sync trước → verify member còn trong workspace |
| `UI_ELEMENT_NOT_FOUND` (no dropdown) | DOM row có nhưng không tìm thấy button dropdown vai trò | ChatGPT đổi UI → cần update `findRowRoleDropdown` hoặc DB ui_labels |
| `UI_ELEMENT_NOT_FOUND` (no option) | Dropdown mở nhưng menu không có option khớp `newRole` | Thêm role label vào `ROLE_LABELS` hoặc DB `ui_labels.invite_role_<role>` |

## 6. Code structure (sau Pha 1 refactor)

```
change-role/
├── index.ts                    # Barrel: chỉ re-export executeChangeRole
└── execute-change-role.ts      # Toàn bộ logic — 106 dòng, 1 hàm export
```

Tách rất nhẹ vì file gốc đã sạch (107 dòng, 1 entry function, không có helper riêng). Tạo folder chủ yếu để consistency với các action khác — và để sau này nếu cần thêm helper (vd retry logic, fallback flow cũ) thì có chỗ rõ ràng.

**Imports chính:**
- `humanClick`, `randomDelay`, `sleep` từ [`../../human.ts`](../../human.ts) — anti-detection input
- `findRoleOption` từ [`../../i18n-ui.ts`](../../i18n-ui.ts) — đa ngôn ngữ role label
- `reportProgress` từ [`../../progress.ts`](../../progress.ts) — UI progress
- `findMemberRow`, `findRowRoleDropdown` từ [`../member-row.ts`](../member-row.ts) — DOM finder dùng chung

## 7. Test thủ công

```
1. Mở dashboard → Workspace có ≥ 2 member
2. Tạo task CHANGE_ROLE cho 1 member: { email: "a@b.com", new_role: "admin", old_role: "member" }
3. Verify trong DevTools Console của tab ChatGPT:
   - "[autogpt-change-role] verified: dropdown giờ có role label 'admin'"
4. Verify trong UI ChatGPT /admin/members: cột Vai trò của member đó hiển thị "Quản trị viên"
5. Verify dashboard: member's chatgpt_role = 'admin' sau next SYNC_DATA
```
