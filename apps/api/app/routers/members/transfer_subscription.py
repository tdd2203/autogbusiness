"""Chức năng: CHUYỂN HẠN SỬ DỤNG ĐẾN (chuyển hạn còn lại sang 1 email khác).

⚠️ ĐỌC `transfer-subscription.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
⚠️ Mọi phép tính hạn phải theo `EXPIRY_RULES.md` — KHÔNG tự chế công thức.

Endpoints:
  - POST /{member_id}/transfer-subscription/preview → preview_transfer_subscription
  - POST /{member_id}/transfer-subscription         → transfer_subscription

Nghiệp vụ (user 2026-08-21): khách đang có hạn nhưng muốn dùng bằng email khác.
Admin bấm "Chuyển hạn sử dụng đến" → nhập email nhận → modal hiện PHÉP TÍNH đầy
đủ (hạn email cho, phần còn lại, hạn email nhận sau khi cộng) → xác nhận.

KHÁC "đổi email" (`change_email.py`) ở đúng một điểm cốt lõi: đổi email đòi email
mới CHƯA phải thành viên (409 nếu đang dùng), còn chuyển hạn CHẤP NHẬN email nhận
đang dùng và **CỘNG DỒN** hạn còn lại vào hạn sẵn có của họ.

Email CHO hạn bị gỡ khỏi workspace bằng 1 task `REMOVE_MEMBER`: extension tìm ở
tab "Người dùng", KHÔNG thấy thì tự chuyển sang tab "Lời mời đang chờ xử lý" và
thu hồi lời mời (fallback thêm ở extension v0.11.7 — đúng thứ tự user mô tả).
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_session, require_permission
from app.models import (
    Invite,
    Member,
    MemberSubscriptionCycle,
    QueueItem,
    User,
    Workspace,
)
from app.permissions import Permission
from app.schemas import (
    MemberOut,
    MemberTransferPreviewOut,
    MemberTransferSubscriptionIn,
    TransferSourceOut,
    TransferTargetOut,
)
from app.sse import publish_task_event

from ._shared import router, _get_workspace_or_404, _member_or_404_visible


def _as_utc(dt: datetime | None) -> datetime | None:
    """Postgres trả datetime naive tuỳ cột — ép về UTC-aware để trừ được với `now`."""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


@dataclass
class TransferPlan:
    """Kết quả tính 1 lần chuyển hạn. Dùng CHUNG cho preview và lệnh thật —
    con số admin nhìn thấy chính là con số được ghi, không tính lại lần 2."""

    source: Member
    target: Member | None
    target_email: str
    mode: str  # 'fresh' | 'accumulate' | 'unlimited'
    new_end_at: datetime | None
    new_months: int | None
    new_purchased_at: datetime | None
    accumulate_from: datetime | None
    remaining: timedelta
    will_invite: bool
    blocked_reason: str | None


def _plan_transfer(
    db: Session,
    workspace_id: UUID,
    source: Member,
    target_email: str,
    now: datetime,
) -> TransferPlan:
    """Tính TOÀN BỘ phép chuyển hạn (không ghi DB).

    Ba chế độ:
      - `unlimited` — email cho đang VÔ THỜI HẠN (months=NULL, end=NULL, xem
        EXPIRY_RULES §5): chuyển nguyên trạng vô thời hạn sang email nhận.
      - `fresh` — email nhận CHƯA ở trong workspace (hoặc đang `removed`): bê
        NGUYÊN mốc hạn + số tháng + mốc neo của email cho (giống `change_email`),
        rồi mời email nhận vào.
      - `accumulate` — email nhận ĐANG dùng: `hạn mới = mốc cộng + phần còn lại`,
        với `mốc cộng = max(hạn hiện tại của email nhận, now)` — email nhận đang
        quá hạn thì phần chuyển sang tính từ BÂY GIỜ, không cộng vào quá khứ
        (cộng vào quá khứ ⇒ hạn mới vẫn < now ⇒ bị quét gỡ ngay, xem §6).
        Giữ NGUYÊN `subscription_months` + mốc neo của email nhận: đây KHÔNG phải
        lần mua mới, chỉ nối thêm thời gian (EXPIRY_RULES §4 case 1 "client gửi
        thẳng end_at" / "theo ngày cụ thể").
    """
    src_end = _as_utc(source.subscription_end_at)
    src_unlimited = src_end is None and source.subscription_months is None

    target = db.execute(
        select(Member).where(Member.workspace_id == workspace_id, Member.email == target_email)
    ).scalar_one_or_none()
    target_live = target if target is not None and target.status != "removed" else None
    tgt_end = _as_utc(target_live.subscription_end_at) if target_live else None
    tgt_unlimited = (
        target_live is not None and tgt_end is None and target_live.subscription_months is None
    )

    def blocked(reason: str, mode: str) -> TransferPlan:
        return TransferPlan(
            source=source,
            target=target,
            target_email=target_email,
            mode=mode,
            new_end_at=None,
            new_months=None,
            new_purchased_at=None,
            accumulate_from=None,
            remaining=timedelta(0),
            will_invite=False,
            blocked_reason=reason,
        )

    # ---- Email CHO phải còn hạn để mà chuyển -------------------------------
    if src_unlimited:
        if tgt_unlimited:
            return blocked(
                f"{target_email} vốn đã VÔ THỜI HẠN — không cần chuyển thêm.",
                "unlimited",
            )
        return TransferPlan(
            source=source,
            target=target,
            target_email=target_email,
            mode="unlimited",
            new_end_at=None,
            new_months=None,
            new_purchased_at=None,
            accumulate_from=None,
            remaining=timedelta(0),
            will_invite=target_live is None,
            blocked_reason=None,
        )

    if src_end is None:
        return blocked(f"{source.email} chưa có hạn sử dụng nào để chuyển.", "fresh")
    if src_end <= now:
        return blocked(
            f"{source.email} đã hết hạn ngày "
            f"{src_end.strftime('%d/%m/%Y %H:%M')} — không còn hạn để chuyển.",
            "fresh",
        )

    remaining = src_end - now

    # ---- Email NHẬN đang vô thời hạn thì chuyển vào là vô nghĩa -------------
    if tgt_unlimited:
        return blocked(
            f"{target_email} đang VÔ THỜI HẠN — chuyển hạn vào không có tác dụng.",
            "accumulate",
        )

    # ---- fresh: email nhận chưa ở trong workspace ---------------------------
    if target_live is None:
        return TransferPlan(
            source=source,
            target=target,
            target_email=target_email,
            mode="fresh",
            new_end_at=src_end,
            new_months=source.subscription_months,
            new_purchased_at=_as_utc(source.subscription_purchased_at),
            accumulate_from=None,
            remaining=remaining,
            will_invite=True,
            blocked_reason=None,
        )

    # ---- accumulate: email nhận đang dùng ----------------------------------
    base = tgt_end if (tgt_end is not None and tgt_end > now) else now
    return TransferPlan(
        source=source,
        target=target,
        target_email=target_email,
        mode="accumulate",
        new_end_at=base + remaining,
        # Giữ NGUYÊN số tháng + mốc neo của email nhận: nối thêm thời gian chứ
        # không phải kỳ mua mới, nên không suy lại months (EXPIRY_RULES §4).
        new_months=target_live.subscription_months,
        new_purchased_at=_as_utc(target_live.subscription_purchased_at),
        accumulate_from=base,
        remaining=remaining,
        will_invite=False,
        blocked_reason=None,
    )


def _plan_to_preview(plan: TransferPlan, now: datetime) -> MemberTransferPreviewOut:
    src_end = _as_utc(plan.source.subscription_end_at)
    src_unlimited = src_end is None and plan.source.subscription_months is None
    tgt_live = plan.target if plan.target is not None and plan.target.status != "removed" else None
    tgt_end = _as_utc(tgt_live.subscription_end_at) if tgt_live else None
    return MemberTransferPreviewOut(
        source=TransferSourceOut(
            member_id=plan.source.id,
            email=plan.source.email,
            status=plan.source.status,
            subscription_end_at=src_end,
            subscription_months=plan.source.subscription_months,
            unlimited=src_unlimited,
            expired=src_end is not None and src_end <= now,
            remaining_seconds=max(0, int(plan.remaining.total_seconds())),
        ),
        target=TransferTargetOut(
            email=plan.target_email,
            exists=tgt_live is not None,
            status=tgt_live.status if tgt_live else None,
            subscription_end_at=tgt_end,
            unlimited=(
                tgt_live is not None and tgt_end is None and tgt_live.subscription_months is None
            ),
            expired=tgt_end is not None and tgt_end <= now,
        ),
        mode=plan.mode,
        new_end_at=plan.new_end_at,
        new_months=plan.new_months,
        accumulate_from=plan.accumulate_from,
        will_invite=plan.will_invite,
        removal_task_type="REMOVE_MEMBER",
        blocked_reason=plan.blocked_reason,
    )


def _load_for_transfer(
    db: Session,
    workspace_id: UUID,
    member_id: UUID,
    target_email_raw: str,
    user: User,
) -> tuple[Workspace, Member, str]:
    """Guard dùng chung cho preview lẫn lệnh thật: quyền + tồn tại + email hợp lệ."""
    ws = _get_workspace_or_404(db, workspace_id)
    # Chuyển hạn sinh ra CẢ lệnh gỡ lẫn (có thể) lệnh mời → đòi cả 2 quyền, giống
    # change_email (decorator đã ép MEMBER_INVITE; kiểm MEMBER_REMOVE ở đây để
    # không cấp lén quyền xoá cho tài khoản chỉ có quyền mời).
    if not user.is_super_admin and Permission.MEMBER_REMOVE.value not in (user.permissions or []):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Chuyển hạn cần cả quyền mời và quyền xoá thành viên",
        )

    source = _member_or_404_visible(db, workspace_id, member_id, user)
    target_email = target_email_raw.lower()
    if source.status == "removed":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Không thể chuyển hạn từ thành viên đã bị xoá",
        )
    if target_email == source.email.lower():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email nhận trùng với email hiện tại",
        )
    return ws, source, target_email


@router.post(
    "/{member_id}/transfer-subscription/preview",
    response_model=MemberTransferPreviewOut,
)
def preview_transfer_subscription(
    workspace_id: UUID,
    member_id: UUID,
    body: MemberTransferSubscriptionIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> MemberTransferPreviewOut:
    """Tính TRƯỚC phép chuyển hạn cho modal — KHÔNG ghi gì vào DB.

    `blocked_reason != null` ⇒ modal khoá nút xác nhận và hiện đúng lý do đó
    (endpoint thật cũng sẽ từ chối với cùng câu chữ → không lệch giữa 2 nơi).
    """
    now = datetime.now(timezone.utc)
    _ws, source, target_email = _load_for_transfer(
        db, workspace_id, member_id, body.target_email, user
    )
    plan = _plan_transfer(db, workspace_id, source, target_email, now)
    return _plan_to_preview(plan, now)


@router.post(
    "/{member_id}/transfer-subscription",
    response_model=MemberOut,
    status_code=status.HTTP_201_CREATED,
)
def transfer_subscription(
    workspace_id: UUID,
    member_id: UUID,
    body: MemberTransferSubscriptionIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> Member:
    """Chuyển hạn còn lại của 1 email sang email khác + gỡ email cho khỏi workspace.

    Trả về member NHẬN (đã cập nhật hạn) để dashboard vẽ lại bảng.
    """
    now = datetime.now(timezone.utc)
    ws, source, target_email = _load_for_transfer(
        db, workspace_id, member_id, body.target_email, user
    )
    plan = _plan_transfer(db, workspace_id, source, target_email, now)
    if plan.blocked_reason:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=plan.blocked_reason)

    source_email = source.email
    source_status = source.status
    # Chụp hạn CŨ của email cho TRƯỚC khi bước (2) ghi đè `subscription_end_at = now`.
    source_end_before = _as_utc(source.subscription_end_at)
    role = source.chatgpt_role or "member"
    old_target_end = _as_utc(plan.target.subscription_end_at) if plan.target else None

    # ---- (1) GỠ email CHO — enqueue TRƯỚC (queue FIFO: trả seat rồi mới mời) ---
    # LUÔN là REMOVE_MEMBER, kể cả khi member đang `pending`: extension tìm ở tab
    # "Người dùng" trước, KHÔNG thấy thì tự sang tab "Lời mời đang chờ xử lý" thu
    # hồi (fallback v0.11.7). Đây đúng thứ tự user mô tả và tránh phải đoán trạng
    # thái DB — DB có thể lệch (member vừa bấm nhận lời mời xong chưa kịp sync).
    remove_qi = QueueItem(
        type="REMOVE_MEMBER",
        status="PENDING",
        workspace_id=workspace_id,
        payload={"member_id": str(source.id), "email": source_email},
        created_by_id=user.id,
    )
    db.add(remove_qi)

    invite_qi: QueueItem | None = None
    if plan.will_invite:
        invite_qi = QueueItem(
            type="INVITE_MEMBER",
            status="PENDING",
            workspace_id=workspace_id,
            payload={
                "email": target_email,
                "role": role,
                "verified_domain": ws.verified_domain,
            },
            created_by_id=user.id,
        )
        db.add(invite_qi)
    db.flush()

    # ---- (2) Email CHO: mất hạn + rời workspace -----------------------------
    source.status = "removed"
    source.removed_at = now
    # Hạn đã chuyển đi ⇒ đặt HẾT HẠN NGAY (= now). TUYỆT ĐỐI không đặt NULL:
    # NULL nghĩa là "vô thời hạn" chứ không phải "mất hạn" (EXPIRY_RULES §5 — đã
    # có ca mất tiền vì đúng chỗ này).
    source.subscription_end_at = now

    # ---- (3) Email NHẬN: nhận hạn ------------------------------------------
    # `takeover` = bản ghi email nhận được TẠO MỚI hoặc TÁI DÙNG từ row `removed`
    # (đúng khi và chỉ khi có mời vào). Chỉ lúc đó mới được ghi đè danh tính của
    # nó (status/vai trò/chủ sở hữu/mốc thêm/thanh toán/chu kỳ) bằng của email cho.
    #
    # ⚠️ KHÔNG được dùng `mode != "accumulate"` làm điều kiện: mode `unlimited` có
    # thể rơi vào email nhận ĐANG hoạt động — ghi đè khi đó sẽ lật họ về `pending`
    # (mà không có task mời nào) và xoá sạch lịch sử thanh toán/chu kỳ của họ.
    target = plan.target
    takeover = plan.will_invite
    if takeover:
        if target is None:
            target = Member(
                workspace_id=workspace_id,
                email=target_email,
                chatgpt_role=role,
                status="pending",
                invited_by_user_id=source.invited_by_user_id,
            )
            db.add(target)
        else:
            target.status = "pending"
            target.removed_at = None
            target.chatgpt_role = role
            target.invited_by_user_id = source.invited_by_user_id
        # Kế thừa mốc "thời gian mời/thêm" của email gốc — đây là chuyển chỗ, không
        # phải lời mời mới (cùng lý do đã chốt ở change_email).
        target.last_invited_at = source.last_invited_at or source.created_at
        # Đã trả tiền cho kỳ này rồi thì email nhận vẫn là "đã trả".
        target.payment_status = source.payment_status
        target.payment_requested_at = source.payment_requested_at
        target.payment_requested_by_id = source.payment_requested_by_id
        target.paid_at = source.paid_at
        target.paid_marked_by_id = source.paid_marked_by_id
        target.fee_vnd = source.fee_vnd

    assert target is not None
    if plan.mode == "accumulate":
        # Email nhận đang dùng → CHỈ nối thêm thời gian. Giữ nguyên mốc neo, số
        # tháng, chu kỳ, trạng thái thanh toán của họ: đây không phải lần mua mới.
        target.subscription_end_at = plan.new_end_at
    else:
        # fresh / unlimited → nhận NGUYÊN trạng thái hạn của email cho (bê cả mốc
        # neo để cột "Ngày gia hạn" khớp với hạn). `unlimited` ⇒ cả 3 đều None.
        target.subscription_months = plan.new_months
        target.subscription_purchased_at = plan.new_purchased_at
        target.subscription_end_at = plan.new_end_at
    db.flush()

    # ---- (4) Chu kỳ thanh toán ---------------------------------------------
    # takeover (email nhận là bản ghi mới/tái dùng): MOVE chu kỳ của email cho sang
    # email nhận — email cho sẽ bị hard-delete sau 30 ngày, cascade xoá mất lịch sử
    # nếu để nguyên.
    # KHÔNG takeover (email nhận đang dùng): KHÔNG đụng chu kỳ của họ. Chuyển hạn
    # KHÔNG phải lần mua mới nên cũng không sinh kỳ mới (sẽ thổi phồng doanh thu ở
    # báo cáo tài chính). Lịch sử kỳ nằm lại với email cho.
    carried_cycles: list[UUID] = []
    if takeover:
        carried_cycles = list(
            db.execute(
                select(MemberSubscriptionCycle.id).where(
                    MemberSubscriptionCycle.member_id == source.id
                )
            ).scalars()
        )
        # Row `removed` tái dùng: xoá chu kỳ CŨ của chính nó trước để không đụng
        # unique (member_id, cycle_number) khi gắn chu kỳ email cho vào.
        db.execute(
            delete(MemberSubscriptionCycle).where(MemberSubscriptionCycle.member_id == target.id)
        )
        if carried_cycles:
            db.execute(
                update(MemberSubscriptionCycle)
                .where(MemberSubscriptionCycle.member_id == source.id)
                .values(member_id=target.id)
            )
    if plan.mode == "unlimited":
        # "Chuyển sang vô thời hạn ⇒ xoá hết chu kỳ đang có" (EXPIRY_RULES §5).
        db.execute(
            delete(MemberSubscriptionCycle).where(MemberSubscriptionCycle.member_id == target.id)
        )
        carried_cycles = []

    if plan.will_invite and invite_qi is not None:
        db.add(
            Invite(
                workspace_id=workspace_id,
                email=target_email,
                role=role,
                status="pending",
                queue_item_id=invite_qi.id,
                invited_by_user_id=source.invited_by_user_id,
            )
        )

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="MEMBER_SUBSCRIPTION_TRANSFERRED",
        result="PENDING",
        target_type="MEMBER",
        target_id=str(target.id),
        data={
            "workspace_id": str(workspace_id),
            "source_email": source_email,
            "target_email": target_email,
            "source_member_id": str(source.id),
            "source_status": source_status,
            "mode": plan.mode,
            "transferred_seconds": int(plan.remaining.total_seconds()),
            "source_end_at": source_end_before.isoformat() if source_end_before else None,
            "old_target_end_at": old_target_end.isoformat() if old_target_end else None,
            "new_end_at": plan.new_end_at.isoformat() if plan.new_end_at else None,
            "new_months": plan.new_months,
            "will_invite": plan.will_invite,
            "carried_cycles": len(carried_cycles),
            "remove_queue_item_id": str(remove_qi.id),
            "invite_queue_item_id": str(invite_qi.id) if invite_qi else None,
        },
        commit=False,
    )
    db.commit()
    db.refresh(target)

    publish_task_event(
        workspace_id,
        {
            "type": "task-available",
            "task_id": str(remove_qi.id),
            "task_type": "REMOVE_MEMBER",
        },
    )
    if invite_qi is not None:
        publish_task_event(
            workspace_id,
            {
                "type": "task-available",
                "task_id": str(invite_qi.id),
                "task_type": "INVITE_MEMBER",
            },
        )
    return target
