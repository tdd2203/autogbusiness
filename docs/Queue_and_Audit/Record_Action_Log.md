# Use Case: Record Action Log

**Description:** Ghi lại lịch sử mọi hành động của hệ thống và Extension để đối soát.

**Precondition:** Hệ thống đã nhận được yêu cầu hành động.

**Postcondition:** Hành động được ghi lại vĩnh viễn trong hệ thống.

## Actors
- **Admin**
- **Extension**
- **Backend API**

## Data Entities
- **Workspace Billing**
- **Audit Log**

## Flows
### EXCEPTION: Database Error
1. Nếu Backend không thể lưu log do lỗi DB, hệ thống phải ghi lỗi vào log file cục bộ (server side) để tránh mất dấu vết hành động.

### MAIN: MAIN
1. Extension hoặc Admin thực hiện một hành động (Sync, Invite, Change Role, etc.).
2. Backend API tiếp nhận yêu cầu.
3. Backend API tạo một bản ghi Audit Log trong DB với đầy đủ thông tin: thời gian, người thực hiện, hành động, kết quả (SUCCESS/FAILED/PENDING).
4. Hệ thống phản hồi cho người thực hiện (Extension hoặc Admin).

## Business Rules
- Audit Log không được phép sửa đổi hoặc xóa sau khi đã lưu.
- Audit Log phải bao gồm: Timestamp, Actor, Action, Result, và Request Data.
- Mọi hành động của Extension phải tạo một bản ghi Audit Log tại Backend.

