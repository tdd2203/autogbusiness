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

## Changelog

### 2026-05-17 — UI redesign: trang Audit Log
- **Loại**: UI / design system
- **Mô tả**: Trang AuditLogs redesign — breadcrumb "System / Audit Log", `display-h1` + page-sub ("Lịch sử mọi hành động trên hệ thống. Lưu trữ 90 ngày."), filter chips (`Tất cả / Admin actions / Extension events / Failed only`) phân loại theo `actor_type` + prefix action. Mỗi row hiển thị:
  - Timestamp dùng `.timestamp` (time + date stacked).
  - Actor: avatar tròn — chữ "E" + background info cho `EXTENSION` / `QUEUE_*`, chữ cái đầu email cho admin; bên cạnh là `actor-name` + `actor-sub` mono.
  - Action dùng `.action-name` chip mono (surface-2 background).
  - Result `.badge-success / .badge-danger / .badge-neutral`.
  - Target rút gọn `TYPE:id_first_8…` font-mono.
- **Search**: filter client-side theo action / actor_label / target_id; meta `Hiển thị {shown} / {total}` ở header.
- **Logic không đổi**: query `GET /api/v1/audit-logs?limit=200`, schema response giữ nguyên (không thêm field mới).
- **File đã đổi**: [AuditLogs.tsx](../../apps/web/src/pages/AuditLogs.tsx).

