# Use Case: Login to Dashboard

**Description:** Admin (super-admin hoặc sub-admin) đăng nhập vào Dashboard để điều khiển Chrome Extension thao tác trên ChatGPT Business.

**Precondition:** Tài khoản đã tồn tại trong hệ thống — super-admin được seed sẵn từ biến môi trường khi triển khai; sub-admin được super-admin tạo qua chức năng Manage Sub-Accounts. Hệ thống đã chạy.

**Postcondition:** Người dùng được xác thực, nhận JWT/session và được điều hướng vào Dashboard với phạm vi quyền tương ứng (super-admin có toàn quyền, sub-admin chỉ có các permission đã được cấp).

## Actors
- **Admin (super-admin / sub-admin)**
- **Backend API**

## Data Entities
- **User** (id, email, username, password_hash, is_super_admin, permissions, is_active)
- **UserSession** (jwt token / session record)
- **AuditLog**

## Flows
### EXCEPTION: Invalid Credentials
1. Admin nhập sai email/username hoặc password.
2. Backend kiểm tra: tài khoản không tồn tại hoặc password không khớp.
3. Backend trả về HTTP 401 với thông báo "Email/Username hoặc mật khẩu không đúng".
4. Admin giữ nguyên tại trang đăng nhập.
5. Backend tạo Audit Log với action `LOGIN_FAILED`, lưu identifier đã nhập (KHÔNG lưu password).

### EXCEPTION: Account Disabled
1. Admin nhập đúng email/username và password.
2. Backend phát hiện `is_active = false` (sub-admin đã bị super-admin disable).
3. Backend trả về HTTP 403 với thông báo "Tài khoản đã bị vô hiệu hóa. Vui lòng liên hệ super-admin".
4. Backend tạo Audit Log `LOGIN_BLOCKED_DISABLED`.

### MAIN: Main Flow - Login Success
1. Admin truy cập trang `/login` của Dashboard.
2. Admin nhập **email hoặc username** vào field "Tài khoản" và nhập password, nhấn "Đăng nhập".
3. Frontend gửi `POST /api/v1/auth/login` với `{ identifier, password }`.
4. Backend tự detect identifier là email (chứa `@`) hay username, tìm User tương ứng.
5. Backend so sánh password với `password_hash` bằng bcrypt.
6. Backend kiểm tra `is_active = true`.
7. Backend phát hành JWT chứa `user_id`, `is_super_admin`, `permissions`, set vào HttpOnly cookie (hoặc trả về body để FE lưu).
8. Backend tạo Audit Log `LOGIN_SUCCESS` (actor = user, result = SUCCESS).
9. Frontend gọi `GET /api/v1/auth/me` để lấy profile + permissions, lưu vào state.
10. Frontend điều hướng vào Dashboard, sidebar chỉ hiển thị các mục có permission tương ứng.

### ALT: Change Password
1. Sau khi đăng nhập, Admin vào trang Settings.
2. Admin nhập password cũ + password mới (≥ 8 ký tự).
3. Frontend gửi `POST /api/v1/auth/change-password`.
4. Backend xác thực password cũ, cập nhật `password_hash` mới.
5. Backend tạo Audit Log `PASSWORD_CHANGED`.

## Business Rules
- Hệ thống có **đúng 1 super-admin**, được seed từ env (`SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_USERNAME`, `SUPER_ADMIN_PASSWORD`) khi khởi động lần đầu. Nếu đã tồn tại thì bỏ qua bước seed.
- Super-admin **không thể bị xóa hoặc disable**; chỉ được phép đổi password.
- Sub-admins được super-admin tạo và có thể bị disable/reset password bất cứ lúc nào (xem [[Manage_Sub_Accounts]]).
- Mỗi user có cả `email` và `username` — cả hai unique, đăng nhập được bằng bất kỳ field nào.
- Password lưu dưới dạng bcrypt hash; tối thiểu 8 ký tự khi tạo/đổi.
- JWT/session có thời hạn (mặc định 12 giờ), tự động hết hạn yêu cầu đăng nhập lại.
- Super-admin có TẤT CẢ permissions mặc định; check permission bypass với `is_super_admin = true`.
- Sub-admin chỉ có các permission được tick trong list `permissions` (JSONB). 5 permission cứng (`USER_MANAGE`, `EXTENSION_CONFIG`, `BILLING_VIEW`, `BILLING_PAY`, `MEMBER_CHANGE_ROLE`) KHÔNG được phép cấp cho sub-admin.
- Mọi sự kiện đăng nhập (thành công/thất bại/bị chặn) phải tạo Audit Log.

## Changelog

### 2026-05-15 — First-run setup + bcrypt fix
- **Loại**: bugfix
- **Mô tả**: passlib 1.7.4 không tương thích bcrypt 5.x (lỗi `ValueError: password cannot be longer than 72 bytes` từ `detect_wrap_bug`). Tạm fix bằng cài `bcrypt<4.0` vào venv. Cần pin trong [pyproject.toml](../../apps/api/pyproject.toml) chính thức (Tuần 1.0).
- **Tại sao**: lần đầu chạy `uvicorn` báo lỗi seed super-admin do bcrypt 5.0.0 tự cài qua passlib's extra.
- **File đã đổi**: chỉ venv (chưa persist) — sẽ persist trong commit Tuần 1.0.

### 2026-05-15 — Implement: JWT revocation qua token_version (Tuần 1.1) ✅
- **Loại**: security
- **Mô tả**: Thêm cột `token_version INTEGER NOT NULL DEFAULT 0` vào `users`. JWT phát hành mang claim `tv` (=`user.token_version` lúc phát hành). `get_current_user` reject 401 "Token đã bị thu hồi" nếu `tv` ≠ `user.token_version`. `tv` được bump khi: (1) sub-admin bị disable, (2) super-admin reset password, (3) user tự change password. Endpoint `/auth/change-password` đổi response từ 204 sang `TokenOut` mới (frontend swap token, không bị kick).
- **Tại sao**: Red flag #1 — JWT 12h không revoke được. Spec `Manage_Sub_Accounts.md` yêu cầu disable phải invalidate session ngay.
- **File đã đổi**: [security.py](../../apps/api/app/security.py), [deps.py](../../apps/api/app/deps.py), [models.py](../../apps/api/app/models.py), [routers/auth.py](../../apps/api/app/routers/auth.py), [routers/users.py](../../apps/api/app/routers/users.py), migration mới [0002_token_version.py](../../apps/api/alembic/versions/0002_token_version.py), [Settings.tsx](../../apps/web/src/pages/Settings.tsx) (swap token sau change-password).
- **Tests**: [test_token_version.py](../../apps/api/tests/test_token_version.py) — 7/7 pass.
