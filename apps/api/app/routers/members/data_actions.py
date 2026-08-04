"""Chức năng: XUẤT DỮ LIỆU / XOÁ DỮ LIỆU của 1 member (menu "..." trên ChatGPT).

⚠️ ĐỌC `data_actions.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.

ChatGPT (2026-08) thêm 2 mục vào menu "..." của member **đã tham gia** ở
/admin/members tab "Người dùng": "Xuất dữ liệu" và "Xoá dữ liệu". 2 endpoint dưới
đây enqueue task tương ứng cho extension thực thi (backend KHÔNG gọi ChatGPT).

Endpoints (đăng ký lên router dùng chung từ `_shared`):
  - POST /{member_id}/export-data  → export_member_data   (quyền MEMBER_EXPORT_DATA)
  - POST /{member_id}/delete-data  → delete_member_data   (quyền MEMBER_DELETE_DATA)

Quyền: 2 quyền MỚI, KHÔNG nằm trong quyền mặc định của tài khoản phụ và KHÔNG
backfill cho tài khoản cũ ⇒ mặc định chỉ super-admin dùng được (super-admin có
mọi quyền). Super-admin có thể cấp thủ công về sau — xem `app/permissions.py`.
"""

from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import enforce_command_spam, get_session, require_permission
from app.models import Member, QueueItem, User
from app.permissions import Permission
from app.sse import publish_task_event

from ._shared import router, _get_workspace_or_404, _member_or_404_visible

# Loại task ↔ quyền ↔ nhãn audit. 1 nguồn để 2 endpoint dùng chung (không lặp code).
_EXPORT = "EXPORT_MEMBER_DATA"
_DELETE = "DELETE_MEMBER_DATA"


def _has_open_data_task(db: Session, member: Member, task_type: str) -> bool:
    """Member đã có task CÙNG LOẠI đang mở (PENDING/IN_PROGRESS)?

    Enqueue idempotent: khác REMOVE, 2 thao tác này KHÔNG đổi cột nào trên `members`
    nên không có trạng thái DB để chặn bấm lại → phải soi hàng đợi. Bấm 2 lần liên
    tiếp (hoặc 2 admin cùng bấm) chỉ tạo 1 task."""
    return (
        db.execute(
            select(QueueItem.id)
            .where(
                QueueItem.workspace_id == member.workspace_id,
                QueueItem.status.in_(("PENDING", "IN_PROGRESS")),
                and_(
                    QueueItem.type == task_type,
                    QueueItem.payload["member_id"].astext == str(member.id),
                ),
            )
            .limit(1)
        ).first()
        is not None
    )


def _enqueue_data_task(
    db: Session,
    *,
    workspace_id: UUID,
    member: Member,
    user: User,
    task_type: str,
) -> dict:
    """Tạo 1 task dữ liệu cho member + audit + publish SSE. Trả body cho endpoint."""
    # CHỈ member ĐÃ THAM GIA: 2 mục menu này chỉ tồn tại ở tab "Người dùng" của
    # ChatGPT. Member `pending` (lời mời chưa nhận) hay `removed` không có menu đó →
    # extension chắc chắn fail, chặn ngay ở backend cho rõ lỗi.
    if member.status != "active":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Chỉ áp dụng cho thành viên ĐÃ THAM GIA (đang hoạt động). "
                f"Thành viên này đang ở trạng thái '{member.status}'."
            ),
        )

    if _has_open_data_task(db, member, task_type):
        return {
            "status": "already_queued",
            "email": member.email,
            "task_type": task_type,
        }

    # Chống spam lệnh per-email như các lệnh member khác (cùng loại + cùng email lặp
    # liên tiếp quá ngưỡng → cấm tạm). Gọi TRƯỚC khi tạo QueueItem.
    enforce_command_spam(db, user, task_type, member.email)

    queue_item = QueueItem(
        type=task_type,
        status="PENDING",
        workspace_id=workspace_id,
        payload={"member_id": str(member.id), "email": member.email},
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action=(
            "MEMBER_EXPORT_DATA_QUEUED"
            if task_type == _EXPORT
            else "MEMBER_DELETE_DATA_QUEUED"
        ),
        result="PENDING",
        target_type="MEMBER",
        target_id=str(member.id),
        data={
            "workspace_id": str(workspace_id),
            "email": member.email,
            "task_type": task_type,
            "queue_item_id": str(queue_item.id),
        },
        commit=False,
    )
    db.commit()
    publish_task_event(
        workspace_id,
        {"type": "task-available", "task_type": task_type, "email": member.email},
    )
    return {
        "queue_item_id": str(queue_item.id),
        "status": "queued",
        "email": member.email,
        "task_type": task_type,
    }


@router.post("/{member_id}/export-data", status_code=status.HTTP_202_ACCEPTED)
def export_member_data(
    workspace_id: UUID,
    member_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_EXPORT_DATA)),
) -> dict:
    """Yêu cầu ChatGPT XUẤT dữ liệu của member (menu "..." → "Xuất dữ liệu").

    Không phá huỷ: ChatGPT gửi bản xuất về email chủ workspace. Vẫn gate quyền riêng
    vì đây là dữ liệu hội thoại của người dùng."""
    _get_workspace_or_404(db, workspace_id)
    member = _member_or_404_visible(db, workspace_id, member_id, user)
    return _enqueue_data_task(
        db, workspace_id=workspace_id, member=member, user=user, task_type=_EXPORT
    )


@router.post("/{member_id}/delete-data", status_code=status.HTTP_202_ACCEPTED)
def delete_member_data(
    workspace_id: UUID,
    member_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_DELETE_DATA)),
) -> dict:
    """XOÁ TOÀN BỘ dữ liệu (hội thoại) của member trên ChatGPT — KHÔNG HOÀN TÁC.

    Thao tác phá huỷ nặng nhất trong hệ thống: khác REMOVE (chỉ gỡ khỏi workspace,
    dữ liệu cá nhân còn nguyên), cái này xoá hẳn nội dung. Quyền riêng, mặc định
    chỉ super-admin."""
    _get_workspace_or_404(db, workspace_id)
    member = _member_or_404_visible(db, workspace_id, member_id, user)
    return _enqueue_data_task(
        db, workspace_id=workspace_id, member=member, user=user, task_type=_DELETE
    )
