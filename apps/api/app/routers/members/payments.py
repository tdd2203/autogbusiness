"""Chức năng: DÒNG TIỀN CỦA 1 EMAIL (panel chi tiết thành viên).

⚠️ ĐỌC `payments.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.

Trả về mọi khoản tiền đã đi qua email này để admin đối soát bằng mắt, không phải
join tay giữa ví và audit log nữa (yêu cầu user 2026-08-04, sau ca stockbox.m:
mời hỏng 2 lần → hoàn cả 2 → kỳ hạn vẫn còn ⇒ dùng 1 tháng miễn phí mà nhìn màn
hình không thấy được):

  - Sổ cái ví (`wallet_transactions`): `invite_fee` (−), `invite_refund` (+),
    `renew_fee` (−). Đây là tiền THẬT rời/về ví.
  - Hoá đơn QR (`payment_orders`): chỉ khi ví KHÔNG đủ. `pending` = chờ chuyển
    khoản, `paid` = đã nhận, `expired` = hết hạn QR. KHÔNG cộng vào tổng ví (tiền
    QR vào ví rồi mới trừ phí — cộng nữa là đếm hai lần), chỉ hiện để truy vết.

TỔNG `net` = tổng sổ cái ví: âm = đã thu được từng đó; 0 = email này CHƯA thu được
đồng nào (thu rồi hoàn hết) — chính là dấu hiệu của ca stockbox.m.

Ghép khoản với member bằng CẢ HAI đường (email + member_id) vì mỗi loại phí ghi
một kiểu: `invite_fee/invite_refund` neo theo `ref_id = queue_item_id` nên chỉ có
email trong `meta`, còn `renew_fee` neo thẳng `ref_id = member_id`.

⚠️ Cùng 1 email có thể tồn tại ở NHIỀU workspace (unique là (workspace, email)).
Khớp theo email nên panel gom tiền của email đó ở MỌI workspace — đúng ý "dòng
tiền của email này", nhưng đừng đọc nhầm thành "tiền của riêng workspace này".

Endpoint:
  - GET /{member_id}/payments → list_member_payments
"""

from uuid import UUID

from fastapi import Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.deps import get_session, require_permission
from app.models import PaymentOrder, User, WalletTransaction
from app.permissions import Permission
from app.schemas import (
    MemberPaymentEntryOut,
    MemberPaymentOrderOut,
    MemberPaymentsOut,
)

from ._shared import router, _get_workspace_or_404, _member_or_404_visible


@router.get("/{member_id}/payments", response_model=MemberPaymentsOut)
def list_member_payments(
    workspace_id: UUID,
    member_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_VIEW)),
    limit: int = Query(default=100, le=300),
) -> MemberPaymentsOut:
    """Dòng tiền của email (sổ cái ví + hoá đơn QR), mới nhất lên đầu.

    Visibility: `_member_or_404_visible` đã khoá member theo `invited_by_user_id`.
    Thêm một lớp nữa cho TIỀN: sub-admin chỉ thấy giao dịch trong ví CỦA MÌNH —
    email có thể từng do đại lý khác trả phí, số dư ví người khác không phải thứ
    được phép lộ. Super-admin thấy tất cả (vai trò đối soát).
    """
    _get_workspace_or_404(db, workspace_id)
    member = _member_or_404_visible(db, workspace_id, member_id, user)
    email = member.email.lower()

    txn_stmt = select(WalletTransaction).where(
        or_(
            func.lower(WalletTransaction.meta["email"].astext) == email,
            WalletTransaction.ref_id == str(member.id),
        )
    )
    order_stmt = select(PaymentOrder).where(
        or_(
            PaymentOrder.payload["entries"].contains([{"email": member.email}]),
            PaymentOrder.payload["member_id"].astext == str(member.id),
        )
    )
    if not user.is_super_admin:
        txn_stmt = txn_stmt.where(WalletTransaction.user_id == user.id)
        order_stmt = order_stmt.where(PaymentOrder.user_id == user.id)

    txns = (
        db.execute(txn_stmt.order_by(WalletTransaction.seq.desc()).limit(limit))
        .scalars()
        .all()
    )
    orders = (
        db.execute(order_stmt.order_by(PaymentOrder.created_at.desc()).limit(limit))
        .scalars()
        .all()
    )

    # Tổng chỉ tính SỔ CÁI VÍ (xem docstring đầu file: không cộng hoá đơn QR).
    charged = sum(-t.amount for t in txns if t.amount < 0)
    refunded = sum(t.amount for t in txns if t.amount > 0)
    return MemberPaymentsOut(
        email=member.email,
        entries=[MemberPaymentEntryOut.model_validate(t) for t in txns],
        orders=[MemberPaymentOrderOut.model_validate(o) for o in orders],
        charged_total=int(charged),
        refunded_total=int(refunded),
        net_total=int(charged - refunded),
    )
