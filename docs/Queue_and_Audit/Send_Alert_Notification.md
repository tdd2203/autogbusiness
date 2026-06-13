# Use Case: Send Alert Notification

**Description:** Gửi cảnh báo cho Admin khi hệ thống gặp lỗi hoặc cần hành động thanh toán.

**Precondition:** Phát hiện trạng thái UNPAID hoặc FAILED_UI_CHANGED từ dữ liệu Sync.

**Postcondition:** Admin nhận được cảnh báo và hệ thống hiển thị cảnh báo đỏ trên Dashboard.

## Actors
- **Admin**
- **Backend API**

## Data Entities
- **Workspace Billing**
- **Notification Log**

## Flows
### EXCEPTION: Notification Failed
1. Nếu không gửi được thông báo qua kênh (ví dụ: mất kết nối Telegram), Backend retry 3 lần. Nếu vẫn thất bại, ghi log lỗi nghiêm trọng.

### MAIN: MAIN
1. Backend API phát hiện trạng thái UNPAID hoặc FAILED_UI_CHANGED trong dữ liệu.
2. Backend API kích hoạt quy trình gửi thông báo.
3. Hệ thống gửi thông báo qua kênh kết nối (Telegram/Email/Slack) tới Admin.
4. Backend cập nhật trạng thái Notification Log thành SENT.
5. Dashboard cập nhật trạng thái hiển thị (hiện cảnh báo đỏ) cho tài khoản Admin.

## Business Rules
- Hệ thống phải duy trì trạng thái cảnh báo (đỏ) trên Dashboard cho đến khi Admin xác nhận đã xử lý.
- Nội dung cảnh báo phải chứa thông tin chi tiết về sự cố để Admin nắm bắt nhanh.
- Cảnh báo phải được gửi ngay lập tức khi phát hiện trạng thái UNPAID hoặc FAILED_UI_CHANGED.

## Changelog

### 2026-05-17 — UI redesign: notice + toast component styles
- **Loại**: UI / design system
- **Mô tả**: Tất cả banner cảnh báo / thành công / lỗi trên dashboard chuyển sang component class `.notice` (4 variant: `info` mặc định / `.warn` / `.danger` / `.success`) định nghĩa trong [index.css](../../apps/web/src/index.css). Cấu trúc: `.notice-icon` (32×32 tròn, chứa spinner cho in-progress) + `.notice-title` + `.notice-body`. `TaskCompletionBanner` dùng variant `success`/`danger` thay panel emerald/rose cũ; sync-in-progress dùng variant mặc định + spinner; rogue invite hint dùng `warn`.
- **Toast (singleton)**: giữ nguyên ToastProvider + `confirm()` từ [Toast.tsx](../../apps/web/src/components/Toast.tsx) — `requireType` cho destructive action, ESC/Enter shortcuts, kind icon (i/✓/!/×). Style background dark slate giữ nguyên cho contrast.
- **UNPAID badge**: hiển thị `.badge-danger` "Chưa thanh toán" cạnh tên plan trong cột Plan của bảng Workspaces (xem [[Sync_Workspace_Billing]]).
- **Logic không đổi**: `confirm`/`toast.success`/`toast.error` API và default duration giữ nguyên; banner cảnh báo passive (chưa có Telegram/Email/Slack integration — theo plan hiện tại).
- **File đã đổi**: [index.css](../../apps/web/src/index.css), [TaskCompletionBanner.tsx](../../apps/web/src/components/TaskCompletionBanner.tsx), [Members.tsx](../../apps/web/src/pages/Members.tsx), [Workspaces.tsx](../../apps/web/src/pages/Workspaces.tsx).

