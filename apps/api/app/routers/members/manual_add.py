"""Chức năng: THÊM THỦ CÔNG email (bản ghi quản lý — KHÔNG mời qua extension).

⚠️ ĐỌC `manual_add.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
⚠️ Tính hạn (anchor/end) tuân theo `EXPIRY_RULES.md` — KHÔNG tự chế công thức.

Bối cảnh (user 2026-07-30): workspace bật "Tự động tạo tài khoản" (auto-create) cho
miền đã xác minh → email thuộc miền đó TỰ vào workspace ChatGPT khi họ đăng nhập,
KHÔNG cần extension đi mời. Vì thế cần 1 action CHỈ GHI NHẬN email vào dashboard để
quản lý (chu kỳ + tiền) mà KHÔNG:
  - tạo QueueItem/INVITE_MEMBER (không nhờ extension mời trên ChatGPT),
  - trừ ví (miễn phí),
  - đánh dấu ĐÃ THANH TOÁN (chu kỳ để `unpaid` — chỉ để đối soát "đã dùng bao nhiêu
    chu kỳ / bao nhiêu tiền", super-admin tự xác nhận thanh toán sau nếu muốn qua
    tab "Email đã add").

Khác biệt so với `invite.py`:
  - status = `active` NGAY (email ĐÃ tham gia trên ChatGPT nhờ auto-create) — không
    qua `pending`/không cần Đồng bộ để lên active.
  - Cycle `payment_status='unpaid'` thay vì `paid`; member `payment_status='unpaid'`.
  - CHẶN CỨNG email không thuộc `workspace.verified_domain` (auto-create chỉ chạy cho
    miền đã xác minh → email ngoài miền sẽ KHÔNG tự vào).
  - CHỈ super-admin.

Endpoint:
  - POST /manual-add  → manual_add_members  (nhiều email, KHÔNG task extension)
"""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_current_user, get_session
from app.models import Member, MemberSubscriptionCycle, User
from app.schemas import MemberBulkInviteIn

from ._shared import (
    router,
    _end_from_purchase,
    _extend_subscription_end,
    _get_workspace_or_404,
)


def _append_unpaid_cycle(
    member: Member,
    *,
    start_at: datetime | None,
    end_at: datetime | None,
    months: int | None,
) -> None:
    """Nối MỘT chu kỳ CHƯA THANH TOÁN phủ [start_at → end_at].

    Bản sao của `_shared._append_paid_cycle` nhưng để `payment_status='unpaid'`
    (không set paid_at/paid_marked_by): thêm thủ công KHÔNG trừ ví, KHÔNG đánh dấu đã
    thanh toán — chỉ ghi nhận để đối soát chu kỳ + tiền. `cycle_number` nối tiếp max
    hiện có. No-op nếu khoảng rỗng. Xem [[subscription-cycle-model]]."""
    if start_at is None or end_at is None or end_at <= start_at:
        return
    next_number = (
        max((c.cycle_number for c in member.subscription_cycles), default=0) + 1
    )
    member.subscription_cycles.append(
        MemberSubscriptionCycle(
            cycle_number=next_number,
            months=months,
            start_at=start_at,
            end_at=end_at,
            payment_status="unpaid",
        )
    )


def _mark_member_unpaid(member: Member) -> None:
    """Đặt trạng thái thanh toán TỔNG HỢP cấp member = 'unpaid' + dọn dấu vết đã trả.

    Thêm thủ công luôn sinh chu kỳ `unpaid` → member 'unpaid'. Dọn paid_*/requested_*
    để không lẫn dấu vết cũ (ca reactivate member `removed` từng có kỳ đã trả)."""
    member.payment_status = "unpaid"
    member.paid_at = None
    member.paid_marked_by_id = None
    member.payment_requested_at = None
    member.payment_requested_by_id = None


@router.post("/manual-add", status_code=status.HTTP_201_CREATED, response_model=dict)
def manual_add_members(
    workspace_id: UUID,
    body: MemberBulkInviteIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Thêm THỦ CÔNG nhiều email vào workspace như bản ghi QUẢN LÝ (KHÔNG mời).

    Chỉ super-admin. Với mỗi email:
      - CHẶN CỨNG nếu không thuộc `workspace.verified_domain`.
      - Chưa có member (hoặc `removed`) → tạo/kích hoạt lại `active`, cửa sổ hạn
        [now → now + months×30], 1 chu kỳ `unpaid`.
      - Đã `active`/`pending` trong CHÍNH workspace này → cộng dồn thêm 1 chu kỳ
        `unpaid` (giống gia hạn nhưng không tính phí): dời hạn từ hạn hiện tại (nếu
        còn hiệu lực) hoặc từ now, +months×30.

    KHÔNG tạo QueueItem/Invite (không nhờ extension), KHÔNG trừ ví. Trả
    {count, added_count, renewed_count, member_ids}.
    """
    if not user.is_super_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Chỉ super-admin được thêm thủ công email quản lý.",
        )
    ws = _get_workspace_or_404(db, workspace_id)
    domain = (ws.verified_domain or "").strip().lower()
    if not domain:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Không gian này chưa cấu hình miền đã xác minh. Thêm thủ công chỉ dùng "
                "cho email thuộc miền đã xác minh (auto-create tự tạo tài khoản)."
            ),
        )

    resolved = body.resolved_entries()
    entries: list[tuple[str, int | None]] = [
        (str(e.email).lower(), e.subscription_months) for e in resolved
    ]
    if not entries:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Danh sách email rỗng sau dedupe.",
        )

    # CHẶN CỨNG email ngoài miền đã xác minh — auto-create chỉ chạy cho miền này.
    suffix = "@" + domain
    out_of_domain = [e for e, _ in entries if not e.endswith(suffix)]
    if out_of_domain:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "EMAIL_OUT_OF_DOMAIN",
                "message": (
                    f"{len(out_of_domain)} email không thuộc miền @{domain} — "
                    f"chỉ email thuộc miền đã xác minh mới thêm thủ công được."
                ),
                "emails": out_of_domain[:20],
            },
        )

    role = body.role
    now = datetime.now(timezone.utc)
    emails_lower = [e for e, _ in entries]
    existing_map = {
        m.email: m
        for m in db.execute(
            select(Member).where(
                Member.workspace_id == workspace_id,
                Member.email.in_(emails_lower),
            )
        ).scalars().all()
    }

    added: list[Member] = []
    renewed: list[Member] = []
    audit_entries: list[dict] = []
    for email, months in entries:
        existing = existing_map.get(email)
        if existing is not None and existing.status in ("active", "pending"):
            # Đã trong workspace → CỘNG DỒN 1 chu kỳ mới (giống gia hạn, không phí).
            base_end = (
                existing.subscription_end_at
                if (
                    existing.subscription_end_at is not None
                    and existing.subscription_end_at > now
                )
                else now
            )
            new_end = _extend_subscription_end(base_end, months) or base_end
            _append_unpaid_cycle(
                existing, start_at=base_end, end_at=new_end, months=months
            )
            existing.subscription_months = months
            existing.subscription_purchased_at = now
            existing.subscription_end_at = new_end
            _mark_member_unpaid(existing)
            member = existing
            renewed.append(member)
            action = "renewed"
        else:
            # Mới hoàn toàn hoặc kích hoạt lại `removed` → chu kỳ tham gia mới từ now.
            end = _end_from_purchase(now, months)
            if existing is not None:
                # Reactivate record `removed`: dựng lại từ đầu (bỏ chu kỳ cũ).
                existing.subscription_cycles = []
                db.flush()
                existing.status = "active"
                existing.chatgpt_role = role
                existing.invited_by_user_id = user.id
                existing.joined_at = now
                existing.removed_at = None
                existing.last_synced_at = None
                existing.subscription_months = months
                existing.subscription_purchased_at = now
                existing.subscription_end_at = end
                member = existing
            else:
                member = Member(
                    workspace_id=workspace_id,
                    email=email,
                    chatgpt_role=role,
                    status="active",
                    invited_by_user_id=user.id,
                    joined_at=now,
                    subscription_months=months,
                    subscription_purchased_at=now,
                    subscription_end_at=end,
                )
                db.add(member)
            db.flush()
            _append_unpaid_cycle(member, start_at=now, end_at=end, months=months)
            _mark_member_unpaid(member)
            added.append(member)
            action = "added"
        db.flush()
        audit_entries.append(
            {
                "email": email,
                "action": action,
                "subscription_months": member.subscription_months,
                "subscription_end_at": (
                    member.subscription_end_at.isoformat()
                    if member.subscription_end_at
                    else None
                ),
            }
        )

    all_members = added + renewed
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="MEMBER_MANUAL_ADDED",
        result="OK",
        target_type="WORKSPACE",
        target_id=str(workspace_id),
        data={
            "workspace_id": str(workspace_id),
            "count": len(entries),
            "added_count": len(added),
            "renewed_count": len(renewed),
            "entries": audit_entries,
        },
        commit=False,
    )
    db.commit()
    return {
        "count": len(entries),
        "added_count": len(added),
        "renewed_count": len(renewed),
        "member_ids": [str(m.id) for m in all_members],
    }
