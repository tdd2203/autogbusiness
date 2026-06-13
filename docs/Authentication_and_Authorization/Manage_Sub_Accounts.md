# Use Case: Manage Sub-Accounts

**Description:** Super-admin tạo, sửa, disable và reset password cho các tài khoản phụ (sub-admins) để cấp quy�?n truy cập Dashboard cho ngư�?i quản lý khác.

**Precondition:** Super-admin đã đăng nhập vào Dashboard. Quy�?n `USER_MANAGE` luôn được gắn cứng với super-admin và KHÔNG cấp được cho sub-admin.

**Postcondition:** Sub-account được tạo/cập nhật trong DB với danh sách permission tương ứng. M�?i thay đổi được ghi Audit Log.

## Actors
- **Super-admin**
- **Backend API**

## Data Entities
- **User** (id, email, username, password_hash, is_super_admin, permissions, is_active, created_by, created_at, updated_at)
- **AuditLog**

## Permission Catalog

### Super-admin only (KHÔNG grant được cho sub-admin)
- `USER_MANAGE` — tạo/sửa/disable sub-accounts, reset password
- `EXTENSION_CONFIG` — đổi API Key Extension, xem trạng thái Extension
- `BILLING_VIEW` — xem trang Billing + cảnh báo UNPAID
- `BILLING_PAY` — nhấn "Thanh toán ngay" → redirect OpenAI
- `MEMBER_CHANGE_ROLE` — đổi vai trò Owner/Admin/Member trong Workspace ChatGPT

### Grant được cho sub-admin
- `MEMBER_VIEW` — xem danh sách thành viên Workspace
- `MEMBER_INVITE` — tạo task INVITE_MEMBER
- `MEMBER_REMOVE` — tạo task REMOVE_MEMBER
- `WORKSPACE_SYNC_TRIGGER` — kích hoạt sync thủ công
- `QUEUE_VIEW` — xem trạng thái queue tasks
- `AUDIT_LOG_VIEW` — xem Audit Log

## Flows
### MAIN: Create Sub-Account
1. Super-admin vào trang Users → nhấn "Tạo tài khoản phụ".
2. Form yêu cầu: `email`, `username`, `password` (tạm th�?i, sub-admin nên đổi sau lần đăng nhập đầu), và checkbox cho từng permission grant được.
3. Frontend gửi `POST /api/v1/users` với payload.
4. Backend validate: email/username unique, password ≥ 8 ký tự, m�?i permission trong list phải thuộc nhóm grant được (reject nếu có permission cứng).
5. Backend tạo User mới với `is_super_admin = false`, `is_active = true`, `created_by = super_admin_id`, password bcrypt hash.
6. Backend tạo Audit Log `USER_CREATED` (actor, target_user, granted_permissions).
7. Trả v�? 201 với thông tin user (không bao gồm password).

### ALT: Update Permissions
1. Super-admin vào chi tiết sub-account → chỉnh checkbox permissions → "Lưu".
2. Frontend gửi `PATCH /api/v1/users/{id}` với `{ permissions: [...] }`.
3. Backend validate permissions nằm trong nhóm grant được, cập nhật.
4. Backend tạo Audit Log `USER_PERMISSIONS_UPDATED` với diff (added/removed).

### ALT: Disable / Re-enable Sub-Account
1. Super-admin nhấn "Vô hiệu hóa" trên sub-account.
2. Frontend gửi `PATCH /api/v1/users/{id}` với `{ is_active: false }`.
3. Backend cập nhật, invalidate session hiện tại của sub-account đó.
4. Audit Log `USER_DISABLED` / `USER_ENABLED`.

### ALT: Reset Password
1. Super-admin nhấn "�?ặt lại mật khẩu" → nhập password mới hoặc nhấn "Sinh ngẫu nhiên".
2. Frontend gửi `POST /api/v1/users/{id}/reset-password` với `{ new_password }`.
3. Backend cập nhật `password_hash`, invalidate session sub-admin đó.
4. Audit Log `USER_PASSWORD_RESET` (actor = super-admin, target = sub-admin).
5. Hiển thị password mới một lần duy nhất cho super-admin để chuyển cho sub-admin.

### EXCEPTION: Email/Username Conflict
1. Super-admin nhập email hoặc username trùng với user đã tồn tại.
2. Backend trả v�? HTTP 409 Conflict với chi tiết field bị trùng.
3. Frontend hiển thị lỗi trên field tương ứng, không tạo user.

### EXCEPTION: Attempt to Grant Restricted Permission
1. Super-admin (qua API trực tiếp) gửi permission thuộc nhóm cứng (vd `BILLING_VIEW`) trong payload tạo/sửa sub-admin.
2. Backend trả v�? HTTP 400 với thông báo "Permission '{key}' chỉ thuộc super-admin, không cấp được cho sub-admin".
3. Audit Log `USER_PERMISSION_GRANT_REJECTED`.

### EXCEPTION: Modify Super-Admin
1. Bất kỳ thao tác disable/xóa/đổi permissions với user `is_super_admin = true` đ�?u bị từ chối với HTTP 403.
2. Cho phép DUY NHẤT: super-admin tự đổi password qua endpoint `change-password` (không qua user management).

## Business Rules
- Chỉ user có `is_super_admin = true` mới g�?i được các endpoint quản lý user. Sub-admin g�?i sẽ nhận 403.
- Không có endpoint "xóa cứng" sub-account (DELETE). Chỉ disable để giữ Audit trail.
- Email và username unique riêng (2 unique constraint), case-insensitive khi so sánh.
- Password mới khi reset ≥ 8 ký tự; backend không lưu plaintext, không gửi qua email tự động.
- M�?i thao tác (create/update/disable/enable/reset) đ�?u tạo Audit Log với actor, target, action, before/after state.
- Sub-account khi bị disable mất hết session hiện tại ngay lập tức.

## Changelog

### 2026-05-17 — UI fix: bỏ "+" thừa khỏi label "Tạo tài khoản"
- **Loại**: UI / bugfix
- **Mô tả**: i18n string `users.create` còn prefix "+ " trong khi nút mới đã có icon `+` JSX → hiển thị "+ + Tạo tài khoản". Bỏ prefix khỏi label cho cả `vi.json` và `zh-CN.json`.
- **File đã đổi**: [vi.json](../../apps/web/src/i18n/locales/vi.json), [zh-CN.json](../../apps/web/src/i18n/locales/zh-CN.json).

### 2026-05-17 — UI redesign: trang "Tài khoản phụ"
- **Loại**: UI / design system
- **Mô tả**: Trang Users redesign — breadcrumb "Organization / Tài khoản phụ", `display-h1` + page-sub, table-card với search input filter theo email/username. Mỗi row hiển thị actor avatar + email + ngày tạo (`Owner · từ {date}`), role bằng `.badge-info` cho super-admin / `.role-tag` cho sub-admin, permissions list dùng `.role-tag` chips, status `.badge-success/.badge-danger`. Khi chỉ có 1 tài khoản, hiển thị dashed hint card khuyến nghị tạo sub-account.
- **Form tạo tài khoản**: dùng `.surface-card` + grid responsive, checkbox permissions vẫn theo `GRANTABLE` (10 quyền grant được, super-admin only vẫn bị reject ở backend).
- **Logic không đổi**: mutation `POST/PATCH /api/v1/users`, `reset-password`, `toggleActive` giữ nguyên; `permissions` payload và validation phía BE không đổi; super-admin row vẫn không có nút disable/reset.
- **File đã đổi**: [Users.tsx](../../apps/web/src/pages/Users.tsx).

### 2026-05-15 — Implement: disable/reset-password invalidate session ngay (Tuần 1.1) ✅
- **Loại**: security
- **Mô tả**: `PATCH /users/{id}` với `is_active=false` và `POST /users/{id}/reset-password` đ�?u bump `token_version` của target. JWT cũ của sub-admin trở thành invalid (401) ở request kế tiếp. Cơ chế: JWT chứa claim `tv`, `get_current_user` so sánh với DB.
- **Tại sao**: Trước đây, business rule "disable mất session ngay" không khả thi vì JWT stateless. Token cũ vẫn dùng được đến 12h.
- **File đã đổi**: [routers/users.py](../../apps/api/app/routers/users.py), [models.py](../../apps/api/app/models.py), [deps.py](../../apps/api/app/deps.py), [security.py](../../apps/api/app/security.py).
- **Tests**: [test_token_version.py](../../apps/api/tests/test_token_version.py) `test_disable_user_invalidates_token`, `test_reset_password_invalidates_token` — pass.
