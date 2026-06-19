"""Chức năng: SYNC RECONCILE (đồng bộ member từ extension + dọn phantom invite).

⚠️ ĐỌC `reconcile.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.

Đây là API cho EXTENSION gọi (auth bằng X-API-KEY qua require_extension_workspace),
KHÔNG phải cho dashboard.

Endpoints:
  - POST /bulk-upsert            → bulk_upsert_members   (sau khi scrape member list)
  - POST /reconcile-after-invite → reconcile_after_invite (Phase 2 verify pending)
"""

from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_session, require_extension_workspace
from app.models import Invite, Member, Workspace
from app.schemas import InviteVerifyReconcileIn, MemberBulkUpsert

from ._shared import router, _compute_subscription_end


@router.post("/bulk-upsert", response_model=dict)
def bulk_upsert_members(
    workspace_id: UUID,
    body: MemberBulkUpsert,
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> dict:
    """Extension gọi sau khi scrape workspace member list.

    Upsert theo (workspace_id, email). KHÔNG đụng `invited_by_user_id` của row đã có.
    Row mới (chưa từng invite qua dashboard) sẽ có `invited_by_user_id = NULL`.
    """
    if workspace.id != workspace_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="API key không khớp với workspace trong URL",
        )

    now = datetime.now(timezone.utc)
    created = 0
    updated = 0
    # Default subscription cho member scrape-only (chưa từng invite qua dashboard):
    # 1 tháng = 30 ngày từ thời điểm tạo row. Theo yêu cầu user 2026-05-19.
    # KHÔNG đụng tới row đã có subscription_months (admin đã chỉnh) — chỉ backfill
    # khi NULL.
    default_sub_months = 1
    default_sub_end = _compute_subscription_end(now, default_sub_months)

    for m in body.members:
        email = m.email.lower()
        existing = db.execute(
            select(Member).where(
                Member.workspace_id == workspace_id, Member.email == email
            )
        ).scalar_one_or_none()
        if existing:
            existing.name = m.name if m.name is not None else existing.name
            existing.chatgpt_role = (
                m.chatgpt_role if m.chatgpt_role is not None else existing.chatgpt_role
            )
            existing.license_type = (
                m.license_type if m.license_type is not None else existing.license_type
            )
            existing.status = m.status
            if m.joined_at:
                existing.joined_at = m.joined_at
            existing.last_synced_at = now
            # Backfill subscription nếu chưa có (legacy rows trước v0.4.4 hoặc
            # row mới được scrape mà chưa từng invite). Dùng created_at làm base.
            if existing.subscription_months is None:
                existing.subscription_months = default_sub_months
                existing.subscription_end_at = _compute_subscription_end(
                    existing.created_at or now, default_sub_months
                )
            updated += 1
        else:
            db.add(
                Member(
                    workspace_id=workspace_id,
                    email=email,
                    name=m.name,
                    chatgpt_role=m.chatgpt_role,
                    license_type=m.license_type,
                    status=m.status,
                    joined_at=m.joined_at,
                    last_synced_at=now,
                    subscription_months=default_sub_months,
                    subscription_end_at=default_sub_end,
                )
            )
            created += 1

    workspace.last_synced_at = now

    removed_count = 0
    # Xác định scope reconcile:
    #   - Nếu body.scraped_statuses set → dùng list đó (chính xác per-sync)
    #   - Else fallback body.is_full_sync: True → ['active','pending']; False → []
    if body.scraped_statuses is not None:
        scopes = tuple(body.scraped_statuses)
    elif body.is_full_sync:
        scopes = ("active", "pending")
    else:
        scopes = ()

    # Tập email "đã scrape" để reconcile. Khi sync lớn chia chunk, extension gửi
    # `reconcile_emails` = TẤT CẢ email đã scrape ở 1 request cuối (members rỗng)
    # → reconcile 1 lần trên toàn bộ, KHÔNG theo từng chunk (tránh mark removed oan
    # member của chunk khác). Fallback: suy ra từ body.members (1 chunk / verify).
    if body.reconcile_emails is not None:
        incoming_emails = {e.lower() for e in body.reconcile_emails}
    else:
        incoming_emails = {m.email.lower() for m in body.members}

    if scopes and incoming_emails:
        # Safety: KHÔNG reconcile member vừa invite qua dashboard trong 10 phút
        # gần đây (ChatGPT thường mất 1-30s để index pending invite vào tab "Lời
        # mời"; nếu extension verify trong khoảng đó, scrape chưa thấy thì backend
        # phải GIỮ chứ không mark removed). Threshold 10 phút đủ rộng cho mọi
        # case index chậm + tránh false-positive khi user invite nhiều email gần
        # nhau (vd a12 lúc 08:34, g12 lúc 08:37 + verify g12 08:38). Sự kiện
        # đáng chú ý — log audit_logs nếu skip nhiều.
        reconcile_cutoff = now - timedelta(minutes=10)
        # Dùng COALESCE(last_invited_at, created_at): member RE-INVITE có
        # created_at cũ (lần đầu) nhưng last_invited_at = lúc re-invite → vẫn
        # được vùng-bảo-vệ 10 phút che, không bị mark removed oan khi ChatGPT
        # index pending invite chậm (fix 2026-06-17, migration 0015).
        stale = (
            db.execute(
                select(Member).where(
                    Member.workspace_id == workspace_id,
                    Member.status.in_(scopes),
                    Member.email.notin_(incoming_emails),
                    ~(
                        (Member.invited_by_user_id.isnot(None))
                        & (
                            func.coalesce(
                                Member.last_invited_at, Member.created_at
                            )
                            > reconcile_cutoff
                        )
                    ),
                )
            )
            .scalars()
            .all()
        )
        for m in stale:
            m.status = "removed"
            m.last_synced_at = now
            removed_count += 1

    # Rogue pending detection: nếu scrape "Lời mời" (pending) thấy email mà
    # KHÔNG có Member record (hoặc record status='removed') → invite này không
    # qua dashboard → trả về để extension auto-revoke trên ChatGPT.
    rogue_pending_emails: list[str] = []
    if scopes and "pending" in scopes:
        # Tất cả pending emails từ scrape. Ưu tiên reconcile_pending_emails (gửi
        # ở request reconcile cuối khi sync lớn); else suy từ body.members.
        if body.reconcile_pending_emails is not None:
            scraped_pending = [e.lower() for e in body.reconcile_pending_emails]
        else:
            scraped_pending = [
                m.email.lower() for m in body.members if m.status == "pending"
            ]
        if scraped_pending:
            existing_by_email = {
                row.email.lower(): row
                for row in db.execute(
                    select(Member).where(
                        Member.workspace_id == workspace_id,
                        Member.email.in_(scraped_pending),
                    )
                ).scalars()
            }
            for email in scraped_pending:
                row = existing_by_email.get(email)
                if row is None or row.status == "removed":
                    rogue_pending_emails.append(email)

    db.add(workspace)
    log_event(
        db,
        actor_type="EXTENSION",
        actor_label=f"workspace:{workspace.name}",
        action="MEMBER_BULK_UPSERT",
        result="SUCCESS",
        target_type="WORKSPACE",
        target_id=str(workspace_id),
        data={
            "created": created,
            "updated": updated,
            "removed_missing": removed_count,
            "total": len(body.members),
            "is_full_sync": body.is_full_sync,
        },
        commit=False,
    )
    db.commit()
    return {
        "created": created,
        "updated": updated,
        "removed_missing": removed_count,
        "total": len(body.members),
        "rogue_pending_emails": rogue_pending_emails,
    }


@router.post("/reconcile-after-invite", response_model=dict)
def reconcile_after_invite(
    workspace_id: UUID,
    body: InviteVerifyReconcileIn,
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> dict:
    """Extension gọi sau khi verify pending tab (Phase 2 của INVITE_MEMBER).

    Dọn phantom: email vừa mời nhưng KHÔNG xuất hiện trong tab 'Lời mời đang chờ
    xử lý' (scrape OK) → Member status=pending tương ứng đánh dấu 'removed' để
    dashboard không hiển thị email chưa thực sự được ChatGPT nhận. CHỈ đụng row
    đang `pending` — KHÔNG đụng `active` (member re-invite vẫn còn trong team).

    Nếu `verify_scrape_failed=True` → giữ nguyên (không scrape được pending list,
    tránh xoá oan; SYNC_DATA sau này sẽ reconcile chuẩn).
    """
    if workspace.id != workspace_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="API key không khớp với workspace trong URL",
        )
    if body.verify_scrape_failed:
        return {"removed": 0, "skipped": True}

    emails = {e.strip().lower() for e in body.unverified_emails if "@" in e}
    if not emails:
        return {"removed": 0, "skipped": False}

    now = datetime.now(timezone.utc)
    rows = (
        db.execute(
            select(Member).where(
                Member.workspace_id == workspace_id,
                Member.email.in_(emails),
                Member.status == "pending",
            )
        )
        .scalars()
        .all()
    )
    removed_emails: list[str] = []
    for m in rows:
        m.status = "removed"
        m.last_synced_at = now
        removed_emails.append(m.email)

    # Đánh dấu Invite row tương ứng 'failed' để audit/lịch sử khớp.
    if removed_emails:
        invites = (
            db.execute(
                select(Invite).where(
                    Invite.workspace_id == workspace_id,
                    Invite.email.in_(removed_emails),
                    Invite.status == "pending",
                )
            )
            .scalars()
            .all()
        )
        for inv in invites:
            inv.status = "failed"

        log_event(
            db,
            actor_type="EXTENSION",
            actor_label=f"workspace:{workspace.name}",
            action="MEMBER_INVITE_VERIFY_RECONCILE",
            result="SUCCESS",
            target_type="WORKSPACE",
            target_id=str(workspace_id),
            data={
                "removed": len(removed_emails),
                "removed_emails": removed_emails,
                "verified_count": len(body.verified_emails),
            },
            commit=False,
        )
        db.commit()

    return {"removed": len(removed_emails), "skipped": False}
