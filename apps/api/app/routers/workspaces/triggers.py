"""Chức năng: TASK TRIGGERS (dashboard enqueue task cho Extension thực thi).

⚠️ ĐỌC `triggers.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
Docs ghi lịch sử lỗi, business rule và ý tưởng cải tiến — code chỉ là "how".

Endpoints (đăng ký lên router dùng chung từ `_shared`):
  - POST /{workspace_id}/sync             → trigger_sync            (SYNC_DATA)
  - POST /{workspace_id}/sync-member      → trigger_sync_member     (SYNC_MEMBER)
  - POST /{workspace_id}/sync-members-batch → trigger_sync_members_batch (SYNC_MEMBERS_BATCH)
  - GET  /{workspace_id}/sync-quota     → get_sync_quota        (web ẩn nút)
  - POST /{workspace_id}/revoke-invites → trigger_revoke_invites (REVOKE_INVITES)
  - POST /{workspace_id}/harvest-labels → trigger_harvest_labels (HARVEST_LABELS)
  - POST /{workspace_id}/sync-billing   → trigger_sync_billing  (SYNC_BILLING)
  - POST /{workspace_id}/purchase-seat  → trigger_purchase_seat (PURCHASE_SEAT)

Rate-limit (⚠️ xem `triggers.md` mục business rules):
  - Full-sync (SYNC_DATA): admin phụ (is_super_admin=False) phải cách nhau ≥ 5
    tiếng giữa 2 lần / workspace (cooldown); admin chính không giới hạn.
  - Chống spam lệnh per-email (SYNC_MEMBER, REMOVE_MEMBER, CHANGE_ROLE,
    CHANGE_LICENSE_TYPE): lặp CÙNG (loại lệnh, email) liên tiếp >3 lần (task FAILED
    không tính) → cấm tài khoản 10 phút (đá session + chặn login). Dùng chung
    `enforce_command_spam` ở app.deps (User.command_ban_until).
"""

from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    assert_workspace_access,
    enforce_command_spam,
    get_session,
    require_permission,
    require_super_admin,
)
from app.models import Member, QueueItem, User, Workspace
from app.permissions import Permission
from app.routers.members._shared import _visibility_filter
from app.schemas import PurchaseSeatIn, SyncMemberIn, SyncMembersBatchIn
from app.sse import publish_task_event

from ._shared import router, _get_workspace_or_404

# --- Rate-limit constants (⚠️ xem triggers.md trước khi đổi) ---
# Full-sync: admin phụ phải cách nhau tối thiểu N tiếng giữa 2 lần (cooldown).
# Admin chính (is_super_admin) bỏ qua hoàn toàn — thích sync lúc nào cũng được.
FULL_SYNC_MIN_INTERVAL_HOURS = 5
# Chống-spam sync lẻ (và các lệnh per-email khác) dùng chung helper
# `enforce_command_spam` ở app.deps: cùng (loại lệnh, email) lặp >3 lần → cấm 10 phút.


def _last_full_sync_at(db: Session, user_id: UUID, workspace_id: UUID) -> datetime | None:
    """Thời điểm SYNC_DATA gần nhất do `user_id` tạo cho workspace (None nếu chưa có).

    Tính MỌI status (kể cả FAILED) — một lần bấm là tính, giữ đúng tinh thần
    chống-spam "cách nhau N tiếng". Nếu sau này muốn nới (loại trừ FAILED để cho
    retry ngay), thêm filter status ở đây + ghi docs.
    """
    return db.execute(
        select(func.max(QueueItem.created_at)).where(
            QueueItem.type == "SYNC_DATA",
            QueueItem.created_by_id == user_id,
            QueueItem.workspace_id == workspace_id,
        )
    ).scalar_one()


@router.post("/{workspace_id}/sync", status_code=status.HTTP_202_ACCEPTED)
def trigger_sync(
    workspace_id: UUID,
    include_pending: bool = True,
    scope: str | None = None,
    expected_locale: str | None = None,
    db: Session = Depends(get_session),
    # Full-sync toàn workspace (nút "Đồng bộ từ ChatGPT") gate bằng quyền RIÊNG
    # WORKSPACE_FULL_SYNC — mặc định TẮT cho sub-admin (không nằm trong perms mặc
    # định), super-admin cấp thủ công mới có; super-admin luôn pass. Tách khỏi
    # WORKSPACE_SYNC_TRIGGER để KHOÁ ĐỘC LẬP: sync 1 member / batch pending ở tab
    # "Chờ tham gia" vẫn mở mặc định (xem trigger_sync_member / _batch).
    user: User = Depends(require_permission(Permission.WORKSPACE_FULL_SYNC)),
) -> dict:
    """Tạo task SYNC_DATA để Extension scrape danh sách member từ ChatGPT về DB.

    Args:
        include_pending: nếu True (default) → scrape cả 3 tab (Người dùng + Lời
        mời + Yêu cầu); nếu False → chỉ scrape Người dùng (nhanh hơn ~3 lần
        nhưng không cập nhật trạng thái pending invites).
        expected_locale: tùy chọn ('vi' | 'en' | 'zh') — chỉ dùng khi client
        chủ động truyền (debug). Dashboard web KHÔNG gửi field này; ngôn ngữ
        sidebar dashboard độc lập với ChatGPT. Null = không check (mặc định).
    """
    _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)

    # Rate-limit full-sync: admin phụ phải cách nhau ≥ FULL_SYNC_MIN_INTERVAL_HOURS
    # tiếng giữa 2 lần/workspace. Admin chính (is_super_admin) bỏ qua hoàn toàn.
    # Khoá hàng workspace FOR UPDATE TRƯỚC khi đọc last-sync để serialize double-click
    # (mẫu purchase-seat) — nếu không, 2 request đồng thời cùng thấy "đủ điều kiện"
    # rồi cùng tạo task → lọt cooldown.
    if not user.is_super_admin:
        now = datetime.now(timezone.utc)
        db.execute(
            select(Workspace.id).where(Workspace.id == workspace_id).with_for_update()
        )
        last_at = _last_full_sync_at(db, user.id, workspace_id)
        if last_at is not None:
            if last_at.tzinfo is None:
                last_at = last_at.replace(tzinfo=timezone.utc)
            next_allowed = last_at + timedelta(hours=FULL_SYNC_MIN_INTERVAL_HOURS)
            if now < next_allowed:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail={
                        "code": "FULL_SYNC_COOLDOWN",
                        "message": (
                            f"Đồng bộ toàn bộ phải cách nhau ít nhất "
                            f"{FULL_SYNC_MIN_INTERVAL_HOURS} tiếng, không được spam."
                        ),
                        "reset_at": next_allowed.isoformat(),
                    },
                )

    normalized_locale: str | None = None
    if expected_locale in ("vi", "en", "zh"):
        normalized_locale = expected_locale
    elif expected_locale and expected_locale.lower().startswith("zh"):
        normalized_locale = "zh"
    # scope: 'members' | 'invites' | 'both'. Tương thích cũ: nếu client chỉ gửi
    # include_pending thì map (True→both, False→members).
    sync_scope = (
        scope
        if scope in ("members", "invites", "both")
        else ("both" if include_pending else "members")
    )
    payload: dict = {
        "sync_scope": sync_scope,
        # include_pending giữ lại cho reader cũ: members-only → False, còn lại True.
        "include_pending": sync_scope != "members",
    }
    if normalized_locale:
        payload["expected_locale"] = normalized_locale
    queue_item = QueueItem(
        type="SYNC_DATA",
        status="PENDING",
        workspace_id=workspace_id,
        payload=payload,
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="WORKSPACE_SYNC_QUEUED",
        result="PENDING",
        target_type="WORKSPACE",
        target_id=str(workspace_id),
        data={
            "queue_item_id": str(queue_item.id),
            "include_pending": include_pending,
            "expected_locale": normalized_locale,
        },
        commit=False,
    )
    db.commit()
    publish_task_event(
        workspace_id,
        {"type": "task-available", "task_id": str(queue_item.id), "task_type": "SYNC_DATA"},
    )
    return {"queue_item_id": str(queue_item.id), "status": "queued"}


@router.get("/{workspace_id}/sync-quota")
def get_sync_quota(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.WORKSPACE_SYNC_TRIGGER)),
) -> dict:
    """Web hỏi: user hiện tại có được full-sync ngay bây giờ không (để ẩn/hiện nút).

    Admin chính: luôn cho phép (`reset_at=None`). Admin phụ: cho phép nếu lần
    full-sync gần nhất đã cách ≥ FULL_SYNC_MIN_INTERVAL_HOURS tiếng; nếu chưa,
    `reset_at` = mốc được phép lần kế. Logic khớp y hệt `trigger_sync` để UI và
    backend không lệch.
    """
    _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)
    if user.is_super_admin:
        return {"full_sync_allowed": True, "reset_at": None}
    now = datetime.now(timezone.utc)
    last_at = _last_full_sync_at(db, user.id, workspace_id)
    if last_at is None:
        return {"full_sync_allowed": True, "reset_at": None}
    if last_at.tzinfo is None:
        last_at = last_at.replace(tzinfo=timezone.utc)
    next_allowed = last_at + timedelta(hours=FULL_SYNC_MIN_INTERVAL_HOURS)
    return {
        "full_sync_allowed": now >= next_allowed,
        "reset_at": next_allowed.isoformat(),
    }


@router.post("/{workspace_id}/sync-member", status_code=status.HTTP_202_ACCEPTED)
def trigger_sync_member(
    workspace_id: UUID,
    body: SyncMemberIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.WORKSPACE_SYNC_TRIGGER)),
) -> dict:
    """Tạo task SYNC_MEMBER — "đồng bộ 1 tài khoản lẻ" cho đúng 1 email.

    Extension tìm email ở tab "Lời mời đang chờ xử lý" trước; không thấy → fallback
    sang tab "Người dùng". Kết quả (`found_in`) được completion reconcile:
    active → member.status='active' (đã tham gia); pending → giữ pending; none →
    chỉ báo "email không tồn tại trong workspace" (KHÔNG mark removed).

    Chống-spam: nếu lặp lại CÙNG (SYNC_MEMBER, email) liên tiếp >3 lần (task FAILED
    không tính) → cấm tài khoản 10 phút (đá session + chặn login) qua
    `enforce_command_spam`. Áp cho MỌI user.
    """
    _get_workspace_or_404(db, workspace_id)
    # KHÔNG gate assert_workspace_access: gán workspace CHỈ giới hạn việc ADD (mời).
    # Đồng bộ 1 tài khoản mình ĐÃ add (nút ⋯ trang "Email đã thêm") vẫn cho phép kể
    # cả khi sub-admin bị gỡ khỏi workspace — khớp remove/renew/change-email. Chống
    # spam (enforce_command_spam) vẫn giữ. Xem members/remove.py, subscription.py.
    email = body.email.strip().lower()

    # Chống spam: cùng email lặp >3 lần liên tiếp → cấm 10 phút (raise 403).
    enforce_command_spam(db, user, "SYNC_MEMBER", email)

    # Dedupe: đã có SYNC_MEMBER PENDING/IN_PROGRESS cùng email → trả task cũ.
    existing = (
        db.execute(
            select(QueueItem).where(
                QueueItem.workspace_id == workspace_id,
                QueueItem.type == "SYNC_MEMBER",
                QueueItem.status.in_(("PENDING", "IN_PROGRESS")),
                QueueItem.payload["email"].astext == email,
            )
        )
        .scalars()
        .first()
    )
    if existing:
        return {
            "queue_item_id": str(existing.id),
            "status": existing.status,
            "deduplicated": True,
        }

    queue_item = QueueItem(
        type="SYNC_MEMBER",
        status="PENDING",
        workspace_id=workspace_id,
        payload={"email": email},
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="SYNC_MEMBER_QUEUED",
        result="PENDING",
        target_type="WORKSPACE",
        target_id=str(workspace_id),
        data={"queue_item_id": str(queue_item.id), "email": email},
        commit=False,
    )
    db.commit()
    publish_task_event(
        workspace_id,
        {"type": "task-available", "task_id": str(queue_item.id), "task_type": "SYNC_MEMBER"},
    )
    return {"queue_item_id": str(queue_item.id), "status": "queued", "deduplicated": False}


@router.post("/{workspace_id}/sync-members-batch", status_code=status.HTTP_202_ACCEPTED)
def trigger_sync_members_batch(
    workspace_id: UUID,
    body: SyncMembersBatchIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.WORKSPACE_SYNC_TRIGGER)),
) -> dict:
    """Tạo task SYNC_MEMBERS_BATCH — "đồng bộ hàng loạt" cho 1 danh sách email.

    Gom N email pending vào ĐÚNG MỘT task: extension vào tab "Người dùng" 1 lần →
    tìm từng email → thấy = active (đã tham gia), không = pending. Thay cho việc
    web fan-out N task SYNC_MEMBER (mỗi task lại quét lại toàn bộ pending — thừa,
    user report 2026-07-06).

    Hai nguồn email:
      - `body.emails`: danh sách cụ thể (thanh bulk ở tab "Chờ tham gia").
      - `body.all_pending=true`: backend TỰ GOM toàn bộ member status='pending'
        của workspace (nút "Đồng bộ lời mời" ở header — user 2026-07-15). Bỏ qua
        `body.emails`.

    Completion reconcile theo `result.data.results` (mảng {email, found_in}):
    active → member.status='active' + joined_at; pending → giữ (KHÔNG mark removed
    — an toàn khi scan sót).

    KHÔNG áp `enforce_command_spam` per-email (1 task/mẻ đã tự bounded); thay bằng
    dedup: đã có SYNC_MEMBERS_BATCH PENDING/IN_PROGRESS của workspace → trả task cũ.
    """
    _get_workspace_or_404(db, workspace_id)
    if body.all_pending:
        # Nút "Đồng bộ lời mời" ở header workspace quét TOÀN BỘ pending của không
        # gian → vẫn cần quyền truy cập workspace.
        assert_workspace_access(db, user, workspace_id)
        # Gom TOÀN BỘ email đang pending của workspace từ DB (không phụ thuộc web
        # truyền lên) — đúng ý "đồng bộ toàn bộ email chờ tham gia" của nút header.
        rows = db.execute(
            select(Member.email).where(
                Member.workspace_id == workspace_id,
                Member.status == "pending",
            )
        ).scalars()
        emails = sorted({e.strip().lower() for e in rows if e and e.strip()})
    else:
        # KHÔNG gate assert_workspace_access cho danh sách email chỉ định: gán
        # workspace CHỈ giới hạn việc ADD (mời). Thanh "Cập nhật N đã chọn → Đồng bộ"
        # ở trang "Email đã thêm" quét xuyên workspace, nên sub-admin không (còn)
        # được gán vẫn phải kiểm tra được email MÌNH ĐÃ ADD đã tham gia hay chưa —
        # khớp sync-member lẻ + remove/renew/change-email. Khoá rò rỉ bằng
        # `_visibility_filter` dưới đây thay vì bằng assignment.
        wanted = {e.strip().lower() for e in body.emails if e.strip()}
        if wanted:
            stmt = select(Member.email).where(
                Member.workspace_id == workspace_id,
                func.lower(Member.email).in_(wanted),
            )
            stmt = _visibility_filter(stmt, user)
            rows = db.execute(stmt).scalars()
            emails = sorted({e.strip().lower() for e in rows if e and e.strip()})
        else:
            emails = []
    if not emails:
        if body.all_pending:
            # Không có member nào đang chờ tham gia — không cần tạo task.
            return {
                "queue_item_id": None,
                "status": "no_pending",
                "count": 0,
                "deduplicated": False,
            }
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Danh sách email rỗng."
                if not any(e.strip() for e in body.emails)
                # Có gửi email nhưng không email nào là member bạn quản lý trong
                # workspace này → nói rõ, đừng báo "rỗng" gây khó hiểu.
                else "Không có email nào thuộc quyền quản lý của bạn trong workspace này."
            ),
        )

    # Dedupe: đã có SYNC_MEMBERS_BATCH PENDING/IN_PROGRESS cho workspace → trả task cũ
    # (tránh chồng nhiều mẻ batch cùng lúc khi user bấm nhiều lần).
    existing = (
        db.execute(
            select(QueueItem).where(
                QueueItem.workspace_id == workspace_id,
                QueueItem.type == "SYNC_MEMBERS_BATCH",
                QueueItem.status.in_(("PENDING", "IN_PROGRESS")),
            )
        )
        .scalars()
        .first()
    )
    if existing:
        return {
            "queue_item_id": str(existing.id),
            "status": existing.status,
            "count": len(emails),
            "deduplicated": True,
        }

    queue_item = QueueItem(
        type="SYNC_MEMBERS_BATCH",
        status="PENDING",
        workspace_id=workspace_id,
        payload={"emails": emails},
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="SYNC_MEMBERS_BATCH_QUEUED",
        result="PENDING",
        target_type="WORKSPACE",
        target_id=str(workspace_id),
        data={"queue_item_id": str(queue_item.id), "count": len(emails)},
        commit=False,
    )
    db.commit()
    publish_task_event(
        workspace_id,
        {
            "type": "task-available",
            "task_id": str(queue_item.id),
            "task_type": "SYNC_MEMBERS_BATCH",
        },
    )
    return {
        "queue_item_id": str(queue_item.id),
        "status": "queued",
        "count": len(emails),
        "deduplicated": False,
    }


@router.post(
    "/{workspace_id}/revoke-invites", status_code=status.HTTP_202_ACCEPTED
)
def trigger_revoke_invites(
    workspace_id: UUID,
    body: dict,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_REMOVE)),
) -> dict:
    """Tạo task REVOKE_INVITES để Extension thu hồi danh sách pending invites.

    Body: {"emails": ["a@x.com", "b@y.com", ...]}

    Dùng cho flow "rogue invite detection": sau khi sync, dashboard phát hiện
    pending invites trên ChatGPT KHÔNG có trong DB → admin xác nhận thu hồi.
    """
    _get_workspace_or_404(db, workspace_id)
    raw_emails = body.get("emails") or []
    emails = [
        str(e).strip().lower()
        for e in raw_emails
        if isinstance(e, str) and "@" in e
    ]
    if not emails:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Danh sách emails rỗng hoặc không hợp lệ",
        )

    queue_item = QueueItem(
        type="REVOKE_INVITES",
        status="PENDING",
        workspace_id=workspace_id,
        payload={"emails": emails},
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="REVOKE_INVITES_QUEUED",
        result="PENDING",
        target_type="WORKSPACE",
        target_id=str(workspace_id),
        data={
            "workspace_id": str(workspace_id),
            "queue_item_id": str(queue_item.id),
            "count": len(emails),
            "emails": emails,
            **({"email": emails[0]} if len(emails) == 1 else {}),
        },
        commit=False,
    )
    db.commit()
    publish_task_event(
        workspace_id,
        {
            "type": "task-available",
            "task_id": str(queue_item.id),
            "task_type": "REVOKE_INVITES",
        },
    )
    return {
        "queue_item_id": str(queue_item.id),
        "status": "queued",
        "count": len(emails),
    }


@router.post("/{workspace_id}/harvest-labels", status_code=status.HTTP_202_ACCEPTED)
def trigger_harvest_labels(
    workspace_id: UUID,
    body: dict,
    db: Session = Depends(get_session),
    user: User = Depends(require_super_admin),
) -> dict:
    """Dashboard yêu cầu extension auto-quét label ChatGPT cho 1 locale.

    Body: {"locale": "vi" | "en" | "zh"}
    Extension navigate /admin/members → /admin/billing → /admin/identity, đọc
    text 18 control_key rồi POST /ui-labels/harvest. Admin chỉ cần đặt ChatGPT
    sang locale này trước khi bấm — không phải nhập tay.
    """
    locale = str(body.get("locale", "")).lower()
    if locale not in ("vi", "en", "zh"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="locale phải là 'vi', 'en' hoặc 'zh'",
        )
    _get_workspace_or_404(db, workspace_id)
    queue_item = QueueItem(
        type="HARVEST_LABELS",
        status="PENDING",
        workspace_id=workspace_id,
        payload={"locale": locale},
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="UI_LABELS_HARVEST_QUEUED",
        result="PENDING",
        target_type="UI_LABEL",
        data={"queue_item_id": str(queue_item.id), "locale": locale},
        commit=False,
    )
    db.commit()
    publish_task_event(
        workspace_id,
        {
            "type": "task-available",
            "task_id": str(queue_item.id),
            "task_type": "HARVEST_LABELS",
        },
    )
    return {"queue_item_id": str(queue_item.id), "status": "queued", "locale": locale}


@router.post("/{workspace_id}/sync-billing", status_code=status.HTTP_202_ACCEPTED)
def trigger_sync_billing(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.WORKSPACE_SYNC_TRIGGER)),
) -> dict:
    """Tạo task SYNC_BILLING để Extension scrape seat_total/seat_used từ trang billing."""
    _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)
    queue_item = QueueItem(
        type="SYNC_BILLING",
        status="PENDING",
        workspace_id=workspace_id,
        payload={},
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="WORKSPACE_BILLING_SYNC_QUEUED",
        result="PENDING",
        target_type="WORKSPACE",
        target_id=str(workspace_id),
        data={"queue_item_id": str(queue_item.id)},
        commit=False,
    )
    db.commit()
    publish_task_event(
        workspace_id,
        {"type": "task-available", "task_id": str(queue_item.id), "task_type": "SYNC_BILLING"},
    )
    return {"queue_item_id": str(queue_item.id), "status": "queued"}


@router.post("/{workspace_id}/purchase-seat", status_code=status.HTTP_202_ACCEPTED)
def trigger_purchase_seat(
    workspace_id: UUID,
    body: PurchaseSeatIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.BILLING_PAY)),
) -> dict:
    """Tạo task PURCHASE_SEAT để Extension mua thêm `quantity` seat trên ChatGPT.

    Flow extension (xem `docs/Workspace_Management/Purchase_Seat.md`):
      1. Navigate /admin/billing?tab=plan
      2. Click "Quản lý giấy phép"
      3. Tăng input "Người dùng" lên +quantity (vd 13 → 14)
      4. Click "Tiếp tục"
      → DỪNG. Admin tự bấm nút payment cuối trên ChatGPT.

    Dedup: nếu workspace đã có PURCHASE_SEAT PENDING/IN_PROGRESS → trả về task
    cũ (tránh double-charge khi user double-click). Audit log để admin trace
    được mọi lần thực hiện.
    """
    _get_workspace_or_404(db, workspace_id)
    # Khoá hàng workspace (FOR UPDATE) trước khi check-then-insert để serialize
    # các request purchase-seat ĐỒNG THỜI (double-click / retry mạng). Nếu không
    # khoá, 2 request có thể cùng thấy `existing = None` rồi cùng tạo task
    # PURCHASE_SEAT → double-charge. Lock giữ tới commit; request thứ 2 chờ rồi
    # thấy task PENDING mà request 1 vừa tạo → đi nhánh dedup (fix 2026-06-17).
    db.execute(
        select(Workspace.id)
        .where(Workspace.id == workspace_id)
        .with_for_update()
    )
    existing = (
        db.execute(
            select(QueueItem).where(
                QueueItem.workspace_id == workspace_id,
                QueueItem.type == "PURCHASE_SEAT",
                QueueItem.status.in_(("PENDING", "IN_PROGRESS")),
            )
        )
        .scalars()
        .first()
    )
    if existing:
        return {
            "queue_item_id": str(existing.id),
            "status": existing.status,
            "deduplicated": True,
        }

    queue_item = QueueItem(
        type="PURCHASE_SEAT",
        status="PENDING",
        workspace_id=workspace_id,
        payload={"quantity": body.quantity},
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="PURCHASE_SEAT_QUEUED",
        result="PENDING",
        target_type="WORKSPACE",
        target_id=str(workspace_id),
        data={"queue_item_id": str(queue_item.id), "quantity": body.quantity},
        commit=False,
    )
    db.commit()
    publish_task_event(
        workspace_id,
        {
            "type": "task-available",
            "task_id": str(queue_item.id),
            "task_type": "PURCHASE_SEAT",
        },
    )
    return {
        "queue_item_id": str(queue_item.id),
        "status": "queued",
        "quantity": body.quantity,
        "deduplicated": False,
    }
