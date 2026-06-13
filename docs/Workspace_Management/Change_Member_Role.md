# Use Case: Change Member Role

**Description:** Extension thực hiện thay đổi vai trò của thành viên trong Workspace trên ChatGPT Business theo yêu cầu từ Backend.

**Precondition:** Admin đã đăng nhập sẵn vào ChatGPT Business trên trình duyệt, thành viên cần thay đổi vai trò tồn tại trong danh sách.

**Postcondition:** Vai trò của thành viên đã được cập nhật thành công trên ChatGPT Business, trạng thái task đã cập nhật trên Backend.

## Actors
- **Backend API**
- **Chrome Extension**

## Data Entities
- **QueueTask**
- **WorkspaceMember**

## Flows
### EXCEPTION: Element Missing / UI Changed
1. Extension không tìm thấy thành phần UI 'Role Selector' hoặc không thể ch�?n vai trò mới. 2. Extension ghi nhận lỗi 'UI_CHANGED_OR_NOT_FOUND' và gửi v�? Backend. 3. Backend cập nhật trạng thái task thành 'FAILED' và thông báo cảnh báo cho Admin trên Dashboard.

### MAIN
1. Extension polled Backend API để lấy task 'CHANGE_ROLE' với tham số 'member_email' và 'new_role'. 2. Extension đi�?u hướng đến trang quản lý thành viên. 3. Extension tìm kiếm thành viên theo email. 4. Extension thực hiện mô ph�?ng click vào selector 'Role'. 5. Extension ch�?n vai trò mới từ danh sách thả xuống. 6. Extension ch�? hệ thống lưu và gửi kết quả 'SUCCESS' v�? Backend API.

## Business Rules
- M�?i hành động phải tạo một bản ghi Audit Log tại Backend
- Rate limit: Tối đa 5 thao tác mỗi đợt, nghỉ 30-60 giây giữa các đợt
- Cơ chế Fail-Fast: Nếu không tìm thấy thành phần UI, dừng ngay lập tức và báo lỗi v�? Backend
- Phải kiểm tra sự tồn tại của thành viên trước khi thực hiện hành động
- Phải mô ph�?ng chuỗi sự kiện chuột (mousedown -> mouseup -> click) không dùng .click() trực tiếp

## Changelog

### 2026-05-17 — UI redesign: dropdown role inline trong bảng thành viên
- **Loại**: UI / design system
- **Mô tả**: Selector đổi role chuyển sang inline `select.form-input` (padding nhỏ 4×8, font 12px) nằm trong cột Actions, chỉ hiển thị cho super-admin và member status `active`. Không còn nút "Đổi vai trò" riêng — đổi role trực tiếp bằng select onChange.
- **Logic không đổi**: `PATCH /api/v1/workspaces/{ws}/members/{id}/role`, permission `MEMBER_CHANGE_ROLE` (super-admin only), payload `{ new_role }` giữ nguyên; mutation invalidate `members` + `triggerExtensionRun()`.
- **File đã đổi**: [Members.tsx](../../apps/web/src/pages/Members.tsx).

### 2026-05-16 — Implement: extension DOM action `change_role` (Tuần 5) ⚠�? selectors cần verify
- **Loại**: extension
- **Mô tả**: [actions/change-role.ts](../../apps/extension/src/content/actions/change-role.ts) tìm row → click menu → click "Change role" → đợi submenu → click role option theo text (`owner`/`admin`/`member`). Verify dựa trên text match — best-effort do submenu UI chưa biết chắc.

### 2026-05-15 — Implement: backend change-role endpoint (Tuần 2.3) ✅
- **Loại**: endpoint
- **Mô tả**: `PATCH /api/v1/workspaces/{ws_id}/members/{member_id}/role` tạo `QueueItem` type `CHANGE_ROLE`. Chỉ super-admin thực hiện được (permission `MEMBER_CHANGE_ROLE` là super-admin only). Payload chứa `old_role` + `new_role` để Extension biết trạng thái before/after.
- **Tại sao**: Bảo toàn rule "MEMBER_CHANGE_ROLE chỉ super-admin" từ [[project-auth-model]].
- **File đã đổi**: [members.py](../../apps/api/app/routers/members.py) (`change_member_role`).
- **Tests**: [test_workspace_member.py](../../apps/api/tests/test_workspace_member.py) `test_sub_admin_cannot_change_role` — pass.

