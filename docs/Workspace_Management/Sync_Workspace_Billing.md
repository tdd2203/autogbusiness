# Use Case: Sync Workspace Billing

**Description:** Tự động đồng bộ thông tin gói cước và hạn mức sử dụng (seat) từ giao diện quản trị ChatGPT Business.

**Precondition:** Admin đã đăng nhập vào Dashboard và ChatGPT Business. Extension đã được cài đặt và cấu hình API Key.

**Postcondition:** Dữ liệu Billing được đồng bộ, nếu unpaid thì Admin đã nhận được thông báo cảnh báo.

## Actors
- **Admin**
- **Dashboard UI**
- **Backend API**
- **Extension**

## Data Entities
- **ActionLogs**
- **AuditLog**
- **WorkspaceBilling**

## Flows
### ALT: Unpaid Status Detected
1. Hệ thống phát hiện billing_status là UNPAID.
2. Backend ghi nhận trạng thái PAYMENT_REQUIRED.
3. Backend kích hoạt quy trình gửi thông báo cho Admin (Email/Dashboard Alert).
4. Hệ thống yêu cầu xác nhận thủ công từ Admin để chuyển sang trang thanh toán.

### EXCEPTION: UI Changed Exception
1. Extension không tìm thấy các thành phần UI (do OpenAI thay đổi giao diện).
2. Extension dừng ngay lập tức.
3. Extension báo lỗi FAILED_UI_CHANGED về Backend.
4. Backend cập nhật trạng thái FAILED và Dashboard hiển thị cảnh báo bảo trì cho Admin.

### ALT: Rate Limit Check
1. Nếu thời gian kể từ lần sync gần nhất < 5 phút, Extension bỏ qua lượt sync này để tuân thủ quy tắc Rate limit.

### EXCEPTION: Fail-Fast on UI Change
1. Extension không tìm thấy các thành phần UI (do cấu trúc trang web thay đổi).
2. Extension dừng ngay lập tức, gửi thông báo lỗi FAILED_UI_CHANGED về Backend.
3. Backend ghi lại lỗi vào log và Dashboard hiển thị thông báo cần bảo trì Extension cho Admin.

### MAIN: MAIN
1. Extension thực hiện Polling đến Backend API (mỗi 5 phút).
2. Backend kiểm tra Rate limit (1 request/5 phút) và trả về task Sync Billing.
3. Extension điều hướng đến trang quản trị của Workspace trên ChatGPT.
4. Extension tìm kiếm và trích xuất thông tin: subscription_plan, renewal_date, seat_total, seat_used, billing_status.
5. Nếu tìm thấy thông tin: Extension gửi dữ liệu về Backend API.
6. Backend lưu vào WorkspaceBilling và tạo bản ghi AuditLog.
7. Nếu billing_status == UNPAID: Backend kích hoạt cờ PAYMENT_REQUIRED và gửi thông báo cho Admin qua Dashboard.
8. Admin nhận thông báo, nhấn nút "Thanh toán ngay" trên Dashboard.
9. Dashboard chuyển hướng (redirect) Admin đến trang thanh toán chính thức của OpenAI.

## Business Rules
- Nếu không tìm thấy element thanh toán, Extension phải dừng và báo FAILED_UI_CHANGED.
- Extension phải có độ trễ ngẫu nhiên từ 1.5s - 4s khi đọc dữ liệu billing.
- Mọi hành động thanh toán phải được Admin xác nhận thủ công trên giao diện của OpenAI.
- Nếu billing_status là UNPAID, Dashboard phải hiển thị cảnh báo đỏ và gửi thông báo cho Admin.
- Không tự động hóa các thao tác thanh toán tài chính qua Extension.
- Dữ liệu thành viên phải được kiểm tra tính hợp lệ trước khi cập nhật vào DB.
- Cơ chế Fail-Fast: Nếu không tìm thấy thành phần UI (do OpenAI thay đổi giao diện), dừng ngay lập tức và đánh dấu trạng thái FAILED_UI_CHANGED tại Backend.
- Mọi hành động đồng bộ phải tạo một bản ghi Audit Log tại Backend.
- Rate limit: 1 request mỗi 5 phút để tránh bị phát hiện spam.

