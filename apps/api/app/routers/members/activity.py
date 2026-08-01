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

from app.deps import get_session, require_permission
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

    - Workspace tồn tại.
    - Visibility: sub-admin chỉ xem được log member mình mời (qua
      `_member_or_404_visible`); super-admin xem tất cả. Member `removed` vẫn
      tra được log (không lọc theo status).
    - CỐ Ý KHÔNG gọi `assert_workspace_access`: sub-admin bị gỡ khỏi workspace
      vẫn phải xem được LỊCH SỬ HOẠT ĐỘNG của email do CHÍNH MÌNH add (mở từ
      trang "Email đã add" gom xuyên workspace). `_member_or_404_visible` đã khoá
      theo invited_by_user_id nên chỉ lấy được log member mình mời — không rò rỉ.
    - Trả về theo thời gian giảm dần (mới nhất lên đầu), tối đa `limit`.
    """
    _get_workspace_or_404(db, workspace_id)
    member = _member_or_404_visible(db, workspace_id, member_id, user)

    mid = str(member.id)
    ws_s = str(workspace_id)

    # Ngữ cảnh đổi email: email/member cũ + queue mời mới (để gắn lịch sử trước khi đổi tên).
    change_data = db.execute(
        select(AuditLog.data)
        .where(
            AuditLog.action == "MEMBER_EMAIL_CHANGED",
            AuditLog.target_id == mid,
        )
        .order_by(AuditLog.timestamp.desc())
        .limit(1)
    ).scalar_one_or_none()
    old_email_from_change: str | None = None
    old_mid_from_change: str | None = None
    invite_qid_from_change: str | None = None
    if isinstance(change_data, dict):
        oe = change_data.get("old_email")
        if isinstance(oe, str) and oe.strip():
            old_email_from_change = oe.strip().lower()
        om = change_data.get("old_member_id")
        if isinstance(om, str) and om.strip():
            old_mid_from_change = om.strip()
        iq = change_data.get("invite_queue_item_id")
        if isinstance(iq, str) and iq.strip():
            invite_qid_from_change = iq.strip()

    member_match = and_(
        AuditLog.target_type == "MEMBER",
        or_(
            AuditLog.target_id == mid,
            AuditLog.data.contains({"member_ids": [mid]}),
        ),
    )
    bulk_invite_match = and_(
        AuditLog.action == "MEMBER_BULK_INVITE_QUEUED",
        AuditLog.data.contains(
            {
                "workspace_id": ws_s,
                "entries": [{"email": member.email}],
            }
        ),
    )
    # Bắt cả MEMBER_INVITE_QUEUED theo (workspace_id, email): khi lời mời cũ FAILED
    # → member row bị xoá → sync auto-create ROW MỚI (id khác), log cũ trỏ id cũ nên
    # 2 nhánh trên không thấy. Khớp theo email giữ được lịch sử mời/thất bại của
    # email đó cho row mới (bug user 2026-08-01: modal đếm 1 nhưng timeline trống).
    invite_terminal_match = and_(
        AuditLog.action.in_(
            (
                "MEMBER_INVITE_QUEUED",
                "MEMBER_INVITE_VERIFIED",
                "MEMBER_INVITE_FAILED",
            )
        ),
        AuditLog.data.contains(
            {
                "workspace_id": ws_s,
                "email": member.email,
            }
        ),
    )
    ors: list = [member_match, bulk_invite_match, invite_terminal_match]

    if old_email_from_change and old_email_from_change != member.email.lower():
        ors.append(
            and_(
                AuditLog.action == "MEMBER_BULK_INVITE_QUEUED",
                AuditLog.data.contains(
                    {
                        "workspace_id": ws_s,
                        "entries": [{"email": old_email_from_change}],
                    }
                ),
            )
        )
        ors.append(
            and_(
                AuditLog.action.in_(
                    (
                        "MEMBER_INVITE_QUEUED",
                        "MEMBER_INVITE_VERIFIED",
                        "MEMBER_INVITE_FAILED",
                    )
                ),
                AuditLog.data.contains(
                    {
                        "workspace_id": ws_s,
                        "email": old_email_from_change,
                    }
                ),
            )
        )
    if old_mid_from_change and old_mid_from_change != mid:
        ors.append(
            and_(
                AuditLog.target_type == "MEMBER",
                or_(
                    AuditLog.target_id == old_mid_from_change,
                    AuditLog.data.contains({"member_ids": [old_mid_from_change]}),
                ),
            )
        )
    if invite_qid_from_change:
        ors.append(AuditLog.data.contains({"queue_item_id": invite_qid_from_change}))

    stmt = (
        select(AuditLog)
        .where(or_(*ors))
        .order_by(AuditLog.timestamp.desc())
        .limit(limit)
    )
    return list(db.execute(stmt).scalars())
