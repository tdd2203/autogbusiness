"""Chức năng: MEMBER ACTIVITY LOG (lịch sử thay đổi/hoạt động của 1 member).

⚠️ ĐỌC `activity.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.

Khi admin click vào 1 email ở bảng thành viên → mở panel chi tiết kèm timeline
mọi sự kiện audit liên quan member đó (mời / xoá / đổi hạn / đổi email / đổi
giấy phép / thanh toán / chuyển chủ ...). Query-only, đọc từ bảng `audit_logs`.

Cơ chế gom log: phần lớn event ghi `target_type="MEMBER"`. Event đơn lẻ ghi
`target_id = str(member.id)`. Các event HÀNG LOẠT (revoke/transfer chủ sở hữu,
duyệt thanh toán nhiều email) đặt `target_id=None` nhưng nhét danh sách id vào
`data["member_ids"]`. Vì vậy query bắt CẢ HAI: `target_id == id` OR
`data @> {"member_ids": [id]}` (JSONB containment) — để không sót lịch sử.

NGOẠI LỆ mời hàng loạt: `MEMBER_BULK_INVITE_QUEUED` ghi `target_type="QUEUE_ITEM"`
(chưa có member.id lúc log) — KHÔNG lọt 2 nhánh trên. Email member nằm trong
`data["entries"][].email`, nên bắt thêm nhánh thứ 3 khớp theo (workspace_id,
email): `data @> {"workspace_id": ws, "entries": [{"email": <email>}]}`. Nhờ đó
lịch sử "đã mời ngày nào" của email hiện đúng ở panel chi tiết (kể cả email được
mời hàng loạt trước khi có tính năng này — không cần sửa/backfill audit_logs).

Endpoint:
  - GET /{member_id}/logs → list_member_logs
"""

from uuid import UUID

from fastapi import Depends, Query
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.deps import assert_workspace_access, get_session, require_permission
from app.models import AuditLog, User
from app.permissions import Permission
from app.schemas import AuditLogOut

from ._shared import router, _get_workspace_or_404, _member_or_404_visible


@router.get("/{member_id}/logs", response_model=list[AuditLogOut])
def list_member_logs(
    workspace_id: UUID,
    member_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_VIEW)),
    limit: int = Query(default=100, le=500),
) -> list[AuditLog]:
    """Lịch sử audit của 1 member (panel chi tiết khi click email).

    - Workspace tồn tại + user có quyền truy cập workspace.
    - Visibility: sub-admin chỉ xem được log member mình mời (qua
      `_member_or_404_visible`); super-admin xem tất cả. Member `removed` vẫn
      tra được log (không lọc theo status).
    - Trả về theo thời gian giảm dần (mới nhất lên đầu), tối đa `limit`.
    """
    _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)
    member = _member_or_404_visible(db, workspace_id, member_id, user)

    mid = str(member.id)
    stmt = (
        select(AuditLog)
        .where(
            or_(
                and_(
                    AuditLog.target_type == "MEMBER",
                    or_(
                        AuditLog.target_id == mid,
                        # Event hàng loạt: id member nằm trong data["member_ids"].
                        AuditLog.data.contains({"member_ids": [mid]}),
                    ),
                ),
                # Mời hàng loạt (target_type=QUEUE_ITEM, chưa có member.id): khớp
                # theo (workspace_id, email) trong data["entries"] — xem docstring.
                and_(
                    AuditLog.action == "MEMBER_BULK_INVITE_QUEUED",
                    AuditLog.data.contains(
                        {
                            "workspace_id": str(workspace_id),
                            "entries": [{"email": member.email}],
                        }
                    ),
                ),
            ),
        )
        .order_by(AuditLog.timestamp.desc())
        .limit(limit)
    )
    return list(db.execute(stmt).scalars())
