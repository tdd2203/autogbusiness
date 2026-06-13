# Use Case: Remove Member

**Description:** Extension thực hiện xóa thành viên kh�?i Workspace trên ChatGPT Business theo yêu cầu từ Backend.

**Precondition:** Admin đã đăng nhập sẵn vào ChatGPT Business trên trình duyệt, thành viên cần xóa tồn tại trong danh sách.

**Postcondition:** Thành viên đã bị xóa kh�?i workspace trên ChatGPT Business, trạng thái task đã cập nhật trên Backend.

## Actors
- **Backend API**
- **Chrome Extension**

## Data Entities
- **QueueTask**
- **WorkspaceMember**

## Flows
### EXCEPTION: Element Missing / UI Changed
1. Extension không tìm thấy thành phần UI 'Remove Button' hoặc 'Confirm Button'. 2. Extension ghi nhận lỗi 'UI_CHANGED_OR_NOT_FOUND' và gửi v�? Backend. 3. Backend cập nhật trạng thái task thành 'FAILED' và thông báo cảnh báo cho Admin trên Dashboard.

### MAIN
1. Extension polled Backend API để lấy task 'REMOVE_MEMBER' với tham số 'member_email'. 2. Extension đi�?u hướng đến trang quản lý thành viên. 3. Extension tìm kiếm thành viên theo email. 4. Extension thực hiện mô ph�?ng click nút 'Remove' của thành viên đó. 5. Extension ch�? hộp thoại xác nhận xuất hiện và thực hiện mô ph�?ng click nút 'Confirm'. 6. Extension gửi kết quả 'SUCCESS' v�? Backend API.

## Business Rules
- M�?i hành động phải tạo một bản ghi Audit Log tại Backend
- Rate limit: Tối đa 5 thao tác mỗi đợt, nghỉ 30-60 giây giữa các đợt
- Cơ chế Fail-Fast: Nếu không tìm thấy thành phần UI, dừng ngay lập tức và báo lỗi v�? Backend
- Phải kiểm tra sự tồn tại của thành viên trước khi thực hiện hành động
- Phải mô ph�?ng chuỗi sự kiện chuột (mousedown -> mouseup -> click) không dùng .click() trực tiếp

## Changelog

### 2026-05-17 — UI redesign: nút Xoá / Thu hồi trong bảng thành viên
- **Loại**: UI / design system
- **Mô tả**: Nút "Xoá" (cho member active) và "Thu hồi" (cho member pending) chuyển sang `.row-action` (text-only, hover đổi background danger/warning). Confirm dialog vẫn dùng `confirm(...)` từ ToastProvider với `requireType: "delete"` cho xoá active (irreversible).
- **Logic không đổi**: `DELETE /api/v1/workspaces/{ws}/members/{id}` cho active, `POST /revoke-invites` cho pending; visibility filter `invited_by_user_id` cho sub-admin giữ nguyên; mutation invalidate `members` query + `triggerExtensionRun()`.
- **File đã đổi**: [Members.tsx](../../apps/web/src/pages/Members.tsx).

### 2026-05-16 — Implement: extension DOM action `remove` (Tuần 5) ⚠�? selectors cần verify
- **Loại**: extension
- **Mô tả**: [actions/remove.ts](../../apps/extension/src/content/actions/remove.ts) tìm row member theo email → click menu "..." → click "Remove" → confirm dialog → verify member biến mất kh�?i danh sách. Dùng helpers anti-detection + waitFor timeout.
- **Selectors**: `memberRow`, `memberRowEmail`, `memberRowMenu`, `removeMenuItem`, `confirmRemoveButton` trong [selectors.ts](../../apps/extension/src/content/selectors.ts) — cần verify trên DOM thật.

### 2026-05-15 — Implement: backend remove endpoint với visibility filter (Tuần 2.3) ✅
- **Loại**: endpoint
- **Mô tả**: `DELETE /api/v1/workspaces/{ws_id}/members/{member_id}` tạo `QueueItem` type `REMOVE_MEMBER`. Permission `MEMBER_REMOVE` (super-admin bypass). Sub-admin chỉ remove được member có `invited_by_user_id = self`; thử remove member khác → 404 (hide existence).
- **Tại sao**: �?ảm bảo sub-admin không thao tác xóa nhầm member của ngư�?i khác. Match ownership rule [[feature-workspace-member-visibility]].
- **File đã đổi**: [members.py](../../apps/api/app/routers/members.py) (`remove_member`, `_member_or_404_visible`).
- **Tests**: [test_workspace_member.py](../../apps/api/tests/test_workspace_member.py) `test_sub_admin_cannot_remove_member_invited_by_super` — pass.

