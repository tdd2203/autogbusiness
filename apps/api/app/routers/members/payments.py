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

ĐỔI EMAIL: email nhận là một member row MỚI (email khác, id khác) nên không khớp
được đồng nào — panel của nó hiện 0 ₫ trong khi email cũ ôm cả 330k, dù ghế đang
dùng là ghế đã trả tiền đó (user 31/8/2026). Vì vậy panel lần NGƯỢC chuỗi đổi
email và gom luôn tiền của các email cũ, mỗi khoản gắn `from_email` để web đóng
khung riêng — gom nhưng không để đọc lẫn thành tiền của email mới.

Endpoint:
  - GET /{member_id}/payments → list_member_payments
"""

from collections.abc import Sequence
from uuid import UUID

from fastapi import Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.deps import get_session, require_permission
from app.models import Member, PaymentOrder, User, WalletTransaction
from app.permissions import Permission
from app.schemas import (
    MemberPaymentAllocationOut,
    MemberPaymentEntryOut,
    MemberPaymentOrderOut,
    MemberPaymentsOut,
)

from ._shared import router, _get_workspace_or_404, _member_or_404_visible

# Trần số chặng khi lần ngược chuỗi đổi email (A → B → C…). Chuỗi thật dài 1–2
# chặng; trần này chỉ để dữ liệu vòng (email cũ được mời lại rồi lại đổi) không
# treo vòng lặp. Khớp `_EMAIL_CHAIN_MAX_HOPS` bên added_members.py.
_EMAIL_CHAIN_MAX_HOPS = 10


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

    # Email CŨ đã đổi thành email này (gần nhất trước). Tiền của chúng gom về đây,
    # gắn `from_email` để web đóng khung riêng — xem docstring đầu file.
    old_chain = _predecessor_emails(db, member)
    emails = [email, *(em.lower() for _, em in old_chain)]
    ref_ids = [str(member.id), *(mid for mid, _ in old_chain)]
    email_of_ref = {mid: em.lower() for mid, em in old_chain}

    txn_stmt = select(WalletTransaction).where(
        or_(
            func.lower(WalletTransaction.meta["email"].astext).in_(emails),
            WalletTransaction.ref_id.in_(ref_ids),
        )
    )
    order_stmt = select(PaymentOrder).where(
        or_(
            *[
                PaymentOrder.payload["entries"].contains([{"email": em}])
                for em in _order_payload_emails(member, old_chain)
            ],
            PaymentOrder.payload["member_id"].astext.in_(ref_ids),
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

    txn_owner = {t.id: _owner_email(t.meta, t.ref_id, email, email_of_ref) for t in txns}
    order_owner = {
        o.id: _owner_email(
            None,
            (o.payload or {}).get("member_id"),
            email,
            email_of_ref,
            payload_emails=_payload_emails(o),
        )
        for o in orders
    }

    voided_orders = _orders_with_all_fees_refunded(db, orders)
    allocations = _order_allocations(db, orders, user, order_owner, email)

    # Tổng chỉ tính SỔ CÁI VÍ (xem docstring đầu file: không cộng hoá đơn QR).
    charged = sum(-t.amount for t in txns if t.amount < 0)
    refunded = sum(t.amount for t in txns if t.amount > 0)
    return MemberPaymentsOut(
        email=member.email,
        entries=[
            MemberPaymentEntryOut.model_validate(t).model_copy(
                update={"from_email": txn_owner.get(t.id)}
            )
            for t in txns
        ],
        orders=[
            MemberPaymentOrderOut.model_validate(o).model_copy(
                update={
                    "fee_refunded": o.id in voided_orders,
                    **_member_share(
                        allocations.get(o.id, []), order_owner.get(o.id) or email
                    ),
                    "allocations": allocations.get(o.id, []),
                    "from_email": order_owner.get(o.id),
                }
            )
            for o in orders
        ],
        charged_total=int(charged),
        refunded_total=int(refunded),
        net_total=int(charged - refunded),
        inherited_emails=[em for _, em in old_chain],
    )


def _predecessor_emails(db: Session, member: Member) -> list[tuple[str, str]]:
    """(id member cũ, email cũ NGUYÊN DẠNG) của các lần ĐỔI EMAIL dẫn tới email này.

    Giữ nguyên chữ hoa/thường vì `payload.entries[].email` của hoá đơn so khớp CHÍNH
    XÁC chuỗi (JSONB containment); chỗ nào cần so theo email thì tự `.lower()`.

    Nguồn: CỘT `members.transferred_from_*` (migration 0066) — bản ghi nào tiếp quản
    danh tính của một email cũ đều mang sẵn con trỏ ngược. Trước 4/9/2026 chỗ này dò
    nhật ký `MEMBER_EMAIL_CHANGED`, nên mọi lần "chuyển hạn sử dụng đến" (nay là
    đường DUY NHẤT của giao diện) đều không gom được tiền của email trước. Lần ngược
    từng chặng nên chuỗi A → B → C xem ở C vẫn gom được tiền của cả B lẫn A.

    Trả theo thứ tự GẦN → XA (B rồi mới tới A). Gặp id đã đi qua thì dừng: email cũ
    có thể được mời lại rồi chuyển lần nữa, thành vòng.
    """
    out: list[tuple[str, str]] = []
    seen = {str(member.id)}
    cursor: Member | None = member
    for _ in range(_EMAIL_CHAIN_MAX_HOPS):
        if cursor is None:
            break
        old_id = cursor.transferred_from_member_id
        old_email = (cursor.transferred_from_email or "").strip()
        if old_id is None or not old_email or str(old_id) in seen:
            break
        seen.add(str(old_id))
        out.append((str(old_id), old_email))
        cursor = db.get(Member, old_id)
    return out


def _order_payload_emails(
    member: Member, old_chain: Sequence[tuple[str, str]]
) -> list[str]:
    """Email dùng để dò `payload.entries[].email` của hoá đơn (giữ nguyên chữ hoa).

    JSONB containment so khớp CHÍNH XÁC chuỗi nên không được hạ chữ: email hiện tại
    lấy đúng dạng lưu ở bảng members, email cũ lấy nguyên dạng nhật ký ghi lại (nhật
    ký chép thẳng `old.email`, cùng nguồn với payload hoá đơn).
    """
    out = [member.email]
    for _, em in old_chain:
        if em not in out:
            out.append(em)
    return out


def _owner_email(
    meta: dict | None,
    ref_id: object,
    current_email: str,
    email_of_ref: dict[str, str],
    payload_emails: Sequence[str] | None = None,
) -> str | None:
    """Khoản tiền này thuộc email CŨ nào? (None = của chính email đang xem).

    Ưu tiên email đang xem: hoá đơn gộp cả email cũ lẫn email mới thì nó là hoá đơn
    của email mới, không phải hàng kế thừa. Chỉ khi không dính email hiện tại mới
    tra sang chuỗi cũ — theo `meta.email` / `payload.entries`, rồi tới `ref_id`
    (renew_fee/cycle_fee neo thẳng member_id).
    """
    candidates = list(payload_emails or [])
    em = str((meta or {}).get("email") or "").strip().lower()
    if em and em not in candidates:
        candidates.insert(0, em)
    if current_email in candidates:
        return None
    ref = str(ref_id or "").strip()
    if ref and ref in email_of_ref:
        return email_of_ref[ref]
    for c in candidates:
        if c in email_of_ref.values():
            return c
    return None


def _member_share(
    allocs: Sequence[MemberPaymentAllocationOut], email: str
) -> dict[str, object]:
    """Phần của RIÊNG email đang xem trong một hoá đơn (đã hoàn phí chưa, lúc nào).

    Hoá đơn gộp nhiều email: 1 email hỏng không làm cả hoá đơn thành rỗng
    (`fee_refunded` vẫn false), nhưng trên panel CỦA EMAIL ĐÓ nó là "hoá đơn thất
    bại" — tiền đã hoàn, dịch vụ không giao. Xem payments.md §2.2.
    """
    for a in allocs:
        if a.email.lower() == email and a.status == "failed":
            return {
                "member_fee_refunded": True,
                "member_refunded_at": a.refunded_at,
            }
    return {}


def _order_allocations(
    db: Session,
    orders: Sequence[PaymentOrder],
    user: User,
    order_owner: dict[UUID, str | None],
    member_email: str,
) -> dict[UUID, list[MemberPaymentAllocationOut]]:
    """Tiền của mỗi hoá đơn đã đi tới email nào, thành hay hỏng.

    Một hoá đơn QR trả cho cả LƯỢT mời (có lượt 17 email, 5.610.000₫): con số tổng
    không nói được email nào ăn phần nào, càng không nói email nào mời hỏng đã hoàn
    tiền (user 2026-08-29). Nối `PaymentOrder.queue_item_id` ↔ `invite_fee.ref_id`
    (MỘT dòng cho MỖI email của lượt) rồi đọc cờ `reversed` để ra ✓/✕ từng email.

    Email có trong `payload.entries` mà KHÔNG có dòng phí ⇒ `pending`: mời lại email
    còn hạn là miễn phí, và lượt bị dời sang lần đồng bộ sau cũng chưa trừ gì.

    Hoá đơn `renew` chỉ ứng với đúng một member (không có đường hoàn phí) ⇒ một dòng
    `ok` cho chính email đang xem.
    """
    invite_orders = [o for o in orders if o.queue_item_id]
    queue_ids = {str(o.queue_item_id) for o in invite_orders}
    fees: dict[str, list[WalletTransaction]] = {}
    refunds: dict[tuple[str, str], WalletTransaction] = {}
    if queue_ids:
        txn_stmt = select(WalletTransaction).where(
            WalletTransaction.ref_id.in_(queue_ids),
            WalletTransaction.kind.in_(("invite_fee", "invite_refund")),
        )
        if not user.is_super_admin:
            txn_stmt = txn_stmt.where(WalletTransaction.user_id == user.id)
        for t in db.execute(txn_stmt.order_by(WalletTransaction.seq)).scalars().all():
            em = str((t.meta or {}).get("email") or "").lower()
            if t.kind == "invite_fee":
                fees.setdefault(str(t.ref_id), []).append(t)
            elif em:
                refunds[(str(t.ref_id), em)] = t

    out: dict[UUID, list[MemberPaymentAllocationOut]] = {}
    for o in orders:
        rows: list[MemberPaymentAllocationOut] = []
        seen: set[str] = set()
        qid = str(o.queue_item_id) if o.queue_item_id else None
        for t in fees.get(qid, []) if qid else []:
            em = str((t.meta or {}).get("email") or "").lower()
            if not em or em in seen:
                continue
            seen.add(em)
            refund = refunds.get((qid, em)) if qid else None
            rows.append(
                MemberPaymentAllocationOut(
                    email=em,
                    amount=abs(int(t.amount)),
                    status="failed" if t.reversed else "ok",
                    refunded_at=refund.created_at if refund else None,
                )
            )
        for em in _payload_emails(o):
            if em in seen:
                continue
            seen.add(em)
            rows.append(
                MemberPaymentAllocationOut(email=em, amount=0, status="pending")
            )
        if not rows and o.kind == "renew":
            # Hoá đơn gia hạn ứng với đúng 1 member — ghi tên email SỞ HỮU nó, có
            # thể là email cũ khi hoá đơn được gom sang từ một lần đổi email.
            rows.append(
                MemberPaymentAllocationOut(
                    email=order_owner.get(o.id) or member_email.lower(),
                    amount=int(o.amount_vnd),
                    status="ok",
                )
            )
        out[o.id] = rows
    return out


def _payload_emails(order: PaymentOrder) -> list[str]:
    """Email mà hoá đơn `invite` được tạo ra để trả cho (intent lúc tạo lệnh)."""
    entries = (order.payload or {}).get("entries")
    if not isinstance(entries, list):
        return []
    out: list[str] = []
    for e in entries:
        em = e.get("email") if isinstance(e, dict) else None
        if isinstance(em, str) and "@" in em:
            low = em.strip().lower()
            if low and low not in out:
                out.append(low)
    return out


def _orders_with_all_fees_refunded(
    db: Session, orders: Sequence[PaymentOrder]
) -> set[UUID]:
    """Id các hoá đơn QR mà TOÀN BỘ phí mời nó trả cho đã được hoàn.

    Nạp tiền qua QR rồi lượt mời hỏng → phí quay về ví ⇒ nhãn "đã thanh toán" trên
    hoá đơn thành ra nói dối: mã nạp đó rốt cuộc không đổi lấy gì (user 2026-08-27,
    ca imas_wangying@163.com: 2 hoá đơn 330k đều "Đã thanh toán" trong khi 2 lượt
    mời tương ứng đều hỏng và đã hoàn phí). Web gạch ngang các hoá đơn này.

    Nối qua `PaymentOrder.queue_item_id` (kết quả thực thi của hoá đơn) ↔
    `invite_fee.ref_id` (= queue_item_id, MỘT dòng cho MỖI email của lượt mời).

    ⚠️ Chỉ đánh dấu khi MỌI `invite_fee` của lượt đó đã `reversed`. Hoá đơn gộp
    nhiều email mà chỉ 1 email hỏng thì tiền vẫn đổi được thứ gì đó — gạch cả hoá
    đơn là nói quá. Hoá đơn `renew` không có đường hoàn phí ⇒ không bao giờ dính.

    Tiền nạp KHÔNG biến mất: nó nằm lại ở ví (hoàn phí trả về ví, không trả về ngân
    hàng). Đây chỉ là chuyện hoá đơn đó không còn tương ứng với dịch vụ nào.
    """
    queue_ids = {str(o.queue_item_id) for o in orders if o.queue_item_id}
    if not queue_ids:
        return set()
    rows = db.execute(
        select(WalletTransaction.ref_id)
        .where(
            WalletTransaction.kind == "invite_fee",
            WalletTransaction.ref_id.in_(queue_ids),
        )
        .group_by(WalletTransaction.ref_id)
        .having(func.bool_and(WalletTransaction.reversed))
    ).scalars()
    fully_refunded = set(rows)
    return {
        o.id
        for o in orders
        if o.queue_item_id and str(o.queue_item_id) in fully_refunded
    }
