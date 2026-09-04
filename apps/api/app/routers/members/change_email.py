"""Chức năng: CHANGE EMAIL (đổi email member — giữ nguyên hạn dùng cũ).

⚠️ ĐỌC `change-email.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.

Endpoint:
  - POST /{member_id}/change-email → change_member_email

Nghiệp vụ: khách đổi email. KHÔNG được cấp hạn mới — email mới phải kế thừa
y nguyên `subscription_end_at` (và subscription_months) của email cũ. Đổi email
= 2 action vật lý trên ChatGPT: (1) GỠ email cũ, (2) MỜI email mới → enqueue
task-gỡ rồi INVITE_MEMBER (queue FIFO: gỡ trước, mời sau → trả seat trước khi
mời). Vì là thay thế 1-đổi-1 (net seat = 0) nên KHÔNG chạy seat guard.

Task GỠ LUÔN là REMOVE_MEMBER (kể cả khi DB ghi `pending`): extension tìm ở tab
"Người dùng", không thấy thì tự sang tab "Lời mời đang chờ xử lý" thu hồi. Xem
chú thích ở chỗ enqueue để biết vì sao bỏ nhánh REVOKE_INVITES.

⚠️ 4/9/2026: giao diện KHÔNG còn nút "Đổi email" — mọi thao tác đi qua "Chuyển hạn
sử dụng đến" (`transfer_subscription.py`), vốn làm đúng việc này và còn nhận được
cả email đang là thành viên (cộng dồn hạn). Endpoint này giữ lại cho client cũ và
cho dữ liệu lịch sử; sửa nghiệp vụ thì sửa CẢ HAI, hoặc tốt hơn là sửa ở transfer.
"""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_session, require_permission
from app.models import (
    REMOVED_REASON_EMAIL_CHANGED,
    Invite,
    Member,
    MemberSubscriptionCycle,
    QueueItem,
    User,
)
from app.permissions import Permission
from app.schemas import MemberChangeEmailIn, MemberOut
from app.services import transfer_link
from app.sse import publish_task_event

from ._shared import router, _get_workspace_or_404, _member_or_404_visible


@router.post(
    "/{member_id}/change-email",
    response_model=MemberOut,
    status_code=status.HTTP_201_CREATED,
)
def change_member_email(
    workspace_id: UUID,
    member_id: UUID,
    body: MemberChangeEmailIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> Member:
    """Đổi email cho 1 member: xoá email cũ + mời email mới, GIỮ NGUYÊN hạn dùng.

    Cần CẢ quyền mời (MEMBER_INVITE) lẫn xoá (MEMBER_REMOVE) vì sinh ra 2 action.
    Trả về Member MỚI (email mới, status=pending) để dashboard cập nhật bảng.
    """
    ws = _get_workspace_or_404(db, workspace_id)
    # KHÔNG gate assert_workspace_access: gán workspace CHỈ giới hạn việc ADD (mời
    # MỚI). Đổi email là thay-thế 1-đổi-1 (net seat = 0) của thành viên mình ĐÃ add,
    # nên vẫn cho phép kể cả khi sub-admin bị gỡ khỏi workspace; `_member_or_404_visible`
    # (invited_by_user_id) khoá theo chủ sở hữu email cũ. Xem renew.py.
    # Đổi email cũng là 1 thao tác xoá → yêu cầu thêm quyền remove (require_permission
    # ở trên đã ép MEMBER_INVITE; kiểm tra remove ở đây để không cấp lén quyền xoá).
    if not user.is_super_admin and Permission.MEMBER_REMOVE.value not in (
        user.permissions or []
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Đổi email cần cả quyền mời và quyền xoá thành viên",
        )

    old = _member_or_404_visible(db, workspace_id, member_id, user)
    new_email = body.new_email.lower()

    if old.status == "removed":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Không thể đổi email cho thành viên đã bị xoá",
        )
    if new_email == old.email.lower():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email mới trùng với email hiện tại",
        )

    # Email mới KHÔNG được trùng member đang hoạt động/chờ khác trong workspace.
    existing_new = db.execute(
        select(Member).where(
            Member.workspace_id == workspace_id, Member.email == new_email
        )
    ).scalar_one_or_none()
    if existing_new and existing_new.status != "removed":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email mới đã là thành viên trong workspace",
        )

    # Hạn dùng kế thừa Y NGUYÊN từ email cũ — KHÔNG tính lại. Kế thừa CẢ mốc neo
    # "Ngày gia hạn" (subscription_purchased_at) để cột hiển thị KHỚP với hạn (hết hạn
    # = gia hạn + 30); nếu bỏ, cột gia hạn fallback last_invited_at=now sẽ lệch hạn cũ.
    carried_months = old.subscription_months
    carried_end = old.subscription_end_at
    carried_purchased = old.subscription_purchased_at
    # Kế thừa CẢ "thời gian mời/thêm" (last_invited_at = ngày tham gia hiển thị) từ
    # email gốc — đây là thay thế, KHÔNG phải lời mời mới, nên email mới giữ nguyên
    # mốc thời gian của email gốc (yêu cầu user: "thời gian đổi lấy từ email gốc").
    # Fallback created_at cho row legacy chưa có last_invited_at.
    carried_last_invited = old.last_invited_at or old.created_at
    role = old.chatgpt_role or "member"
    old_email = old.email
    old_status = old.status

    # (1) GỠ email cũ khỏi ChatGPT — enqueue TRƯỚC (queue FIFO: trả seat trước khi mời).
    # LUÔN là REMOVE_MEMBER, kể cả khi DB ghi `pending` (giống transfer_subscription):
    # extension tìm ở tab "Người dùng" trước, KHÔNG thấy thì tự sang tab "Lời mời đang
    # chờ xử lý" thu hồi.
    #
    # Vì sao bỏ nhánh REVOKE_INVITES cho `pending` (4/9/2026): trạng thái trong DB là
    # thứ CÓ THỂ CŨ — người ta bấm nhận lời mời xong mà chưa tới lượt đồng bộ thì DB
    # vẫn ghi `pending`. Lúc đó lệnh thu hồi mở đúng menu của một thành viên đã tham
    # gia, menu không có mục "Thu hồi lời mời", và đường lui sang tab "Người dùng"
    # KHÔNG chạy (nó chỉ chạy khi không thấy dòng nào) → task hỏng, email cũ ở lại
    # ChatGPT ăn thêm một ghế cho tới lần đồng bộ sau. Trên production 6/29 lệnh thu
    # hồi hỏng đúng kiểu này, còn REMOVE_MEMBER hỏng 1/22 — đường gỡ bắt đầu từ tab
    # "Người dùng" không cần đoán trạng thái nên đúng cho cả hai ca.
    remove_qi = QueueItem(
        type="REMOVE_MEMBER",
        status="PENDING",
        workspace_id=workspace_id,
        payload={"member_id": str(old.id), "email": old_email},
        created_by_id=user.id,
    )
    remove_task_type = "REMOVE_MEMBER"
    db.add(remove_qi)
    # (2) MỜI email mới.
    invite_qi = QueueItem(
        type="INVITE_MEMBER",
        status="PENDING",
        workspace_id=workspace_id,
        payload={
            "email": new_email,
            "role": role,
            "verified_domain": ws.verified_domain,
        },
        created_by_id=user.id,
    )
    db.add(invite_qi)
    db.flush()

    # Email cũ → removed ngay trong DB (extension sẽ thực thi xoá trên ChatGPT).
    now = datetime.now(timezone.utc)
    old.status = "removed"
    old.removed_at = now
    old.removed_reason = REMOVED_REASON_EMAIL_CHANGED
    # HẠN ĐÃ THEO EMAIL MỚI ĐI ⇒ đóng hạn dòng cũ NGAY (đặt = now), giống hệt
    # transfer_subscription làm với email cho. Trước 24/8/2026 dòng cũ giữ nguyên
    # `subscription_end_at` tương lai (bản sao của hạn vừa chuyển) và sinh ra hai
    # cái sai cùng lúc:
    #   - hiển thị: email đã xoá vẫn khoe "còn hạn 27 ngày" (user hỏi 24/8);
    #   - TIỀN: `_is_paid_period_active` chỉ đọc mốc này ⇒ mời lại CHÍNH email cũ
    #     được coi là "còn hạn → MIỄN PHÍ", trong khi email mới vẫn đang tiêu đúng
    #     kỳ đã trả đó. Một suất đã trả thành hai người dùng, mà ghế trên ChatGPT
    #     thì vẫn tính tiền cả hai. `find_movable_paid_members` cũng sẽ chuyển
    #     miễn phí "hạn ma" này sang workspace khác.
    # TUYỆT ĐỐI không đặt None: None = "vô thời hạn", không phải "hết hạn"
    # (EXPIRY_RULES §5 — đã có ca mất tiền vì đúng chỗ này).
    old.subscription_end_at = now

    # Tạo/cập nhật member email mới với hạn dùng cũ. Giữ chủ sở hữu (invited_by)
    # của member cũ — đây là thay thế, không phải lời mời mới của admin thao tác.
    if existing_new:
        member = existing_new
        member.status = "pending"
        member.removed_at = None  # tái kích hoạt → hết trạng thái removed
        member.removed_reason = None
        member.chatgpt_role = role
        member.invited_by_user_id = old.invited_by_user_id
        member.subscription_months = carried_months
        member.subscription_purchased_at = carried_purchased
        member.subscription_end_at = carried_end
        member.last_invited_at = carried_last_invited
    else:
        member = Member(
            workspace_id=workspace_id,
            email=new_email,
            chatgpt_role=role,
            status="pending",
            invited_by_user_id=old.invited_by_user_id,
            subscription_months=carried_months,
            subscription_purchased_at=carried_purchased,
            subscription_end_at=carried_end,
            last_invited_at=carried_last_invited,
        )
        db.add(member)

    db.add(
        Invite(
            workspace_id=workspace_id,
            email=new_email,
            role=role,
            status="pending",
            queue_item_id=invite_qi.id,
            invited_by_user_id=old.invited_by_user_id,
        )
    )
    db.flush()

    # Đổi email = ĐỔI TÊN, KHÔNG phải giao dịch mới. Email mới phải kế thừa nguyên
    # trạng thái thanh toán của email gốc (họ đã trả rồi thì vẫn là đã trả), gồm
    # cả phí mời RIÊNG và toàn bộ lịch sử chu kỳ. Nếu bỏ, member mới về mặc định
    # "unpaid" + mất lịch sử kỳ → báo tài chính/stats lệch.
    member.payment_status = old.payment_status
    member.payment_requested_at = old.payment_requested_at
    member.payment_requested_by_id = old.payment_requested_by_id
    member.paid_at = old.paid_at
    member.paid_marked_by_id = old.paid_marked_by_id
    member.fee_vnd = old.fee_vnd
    # Gói danh tính người dùng vào CỘT: email gốc + chuyển từ/đến. Cùng một nguồn với
    # "Chuyển hạn sử dụng đến" nên chuỗi A→B→C và ô gộp tiền không phụ thuộc vào việc
    # thao tác đi qua endpoint nào (xem `services/transfer_link.py`).
    transfer_link.record_transfer(old, member, takeover=True, now=now)
    # Số kỳ chuyển (đọc trước khi reassign để ghi audit).
    carried_cycles = (
        db.execute(
            select(MemberSubscriptionCycle.id).where(
                MemberSubscriptionCycle.member_id == old.id
            )
        )
        .scalars()
        .all()
    )
    # Nếu email mới là row "removed" tái dùng: xoá các chu kỳ CŨ của chính nó trước
    # (tránh đụng unique (member_id, cycle_number) khi gắn chu kỳ email gốc vào).
    if existing_new:
        db.execute(
            delete(MemberSubscriptionCycle).where(
                MemberSubscriptionCycle.member_id == member.id
            )
        )
    # MOVE (không copy) chu kỳ email gốc → email mới: member cũ sẽ bị hard-delete
    # sau 30 ngày (removed_at), cascade sẽ xoá luôn chu kỳ nếu còn gắn member cũ.
    # Dùng UPDATE trực tiếp (không đụng relationship) để tránh delete-orphan cascade.
    if carried_cycles:
        db.execute(
            update(MemberSubscriptionCycle)
            .where(MemberSubscriptionCycle.member_id == old.id)
            .values(member_id=member.id)
        )

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="MEMBER_EMAIL_CHANGED",
        result="PENDING",
        target_type="MEMBER",
        target_id=str(member.id),
        data={
            "workspace_id": str(workspace_id),
            "old_email": old_email,
            "new_email": new_email,
            "old_member_id": str(old.id),
            "old_status": old_status,
            "role": role,
            "subscription_months": carried_months,
            "subscription_end_at": carried_end.isoformat() if carried_end else None,
            # Trạng thái thanh toán kế thừa từ email gốc (đổi tên, không tính lại).
            "payment_status": old.payment_status,
            "carried_cycles": len(carried_cycles),
            # Task gỡ email cũ: REMOVE_MEMBER (active) hoặc REVOKE_INVITES (pending).
            "old_removal_task_type": remove_task_type,
            "origin_email": member.origin_email,
            "remove_queue_item_id": str(remove_qi.id),
            "invite_queue_item_id": str(invite_qi.id),
        },
        commit=False,
    )
    db.commit()
    db.refresh(member)

    # Đánh thức extension cho cả 2 task.
    publish_task_event(
        workspace_id,
        {
            "type": "task-available",
            "task_id": str(remove_qi.id),
            "task_type": remove_task_type,
        },
    )
    publish_task_event(
        workspace_id,
        {
            "type": "task-available",
            "task_id": str(invite_qi.id),
            "task_type": "INVITE_MEMBER",
        },
    )
    return member
