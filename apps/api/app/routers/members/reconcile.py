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

from ._shared import router, _end_from_purchase


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
    # 1 tháng = 30 ngày. Theo yêu cầu user 2026-05-19.
    # Mốc neo "Ngày gia hạn" = ngày thêm hiển thị trên dashboard = last_invited_at ??
    # created_at (KHÁC joined_at scrape ChatGPT). Lưu vào subscription_purchased_at để
    # cột "Ngày gia hạn" khớp; hạn = neo + tháng×30 CHÍNH XÁC (hết hạn = gia hạn + 30).
    # Chỉ THIẾT LẬP khi CHƯA có hạn (subscription_end_at IS NULL) — KHÔNG bao giờ đè
    # hạn đã set (gia hạn/bulk-set-expiry đã set end_at dù months có thể = None).
    default_sub_months = 1

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
            # NGÀY THAM GIA = thời điểm MỜI (có giờ) nếu có. Scrape ChatGPT chỉ trả
            # NGÀY (00:00) → KHÔNG ghi đè joined_at đã có bằng giá trị kém chính xác
            # hơn. Chỉ đặt lần đầu (joined_at IS NULL), ưu tiên last_invited_at.
            # Yêu cầu user 2026-07-06 ("ngày tham gia lấy từ thời gian mời, cả giờ").
            if existing.joined_at is None:
                existing.joined_at = existing.last_invited_at or m.joined_at
            existing.last_synced_at = now
            # Owner (chủ sở hữu workspace) mặc định VÔ HẠN — KHÔNG cấp gói (user
            # 2026-07-06). Member thường: backfill subscription CHỈ khi chưa từng có
            # hạn (end_at IS NULL) — legacy / row mới scrape. KHÔNG đụng hạn đã set.
            if existing.chatgpt_role != "owner" and existing.subscription_end_at is None:
                anchor = existing.last_invited_at or existing.created_at or now
                existing.subscription_months = default_sub_months
                existing.subscription_purchased_at = anchor
                existing.subscription_end_at = _end_from_purchase(
                    anchor, default_sub_months
                )
            updated += 1
        else:
            # Owner mới scrape lần đầu → vô hạn (không gói). Member thường → gói mặc định.
            # Mốc neo = now (giờ ghi nhận trên dashboard ≈ created_at); hạn = neo + 30.
            is_owner = m.chatgpt_role == "owner"
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
                    subscription_months=None if is_owner else default_sub_months,
                    subscription_purchased_at=None if is_owner else now,
                    subscription_end_at=None
                    if is_owner
                    else _end_from_purchase(now, default_sub_months),
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

    # ⚠️ GUARD "SYNC THIẾU" — đối chiếu TRƯỚC khi mark-removed để không phá dữ
    # liệu lịch sử khi scrape lỗi (vd bug list chưa render hết → chỉ ra 2/49 member).
    # Nếu bỏ qua: reconcile sẽ mark 47 member còn lại 'removed' oan.
    #
    # Nguồn sự thật = expected_total (header count ChatGPT tự báo). Nếu ChatGPT nói
    # có N active mà lần scrape này chỉ thấy ≪ N → chắc chắn scrape THIẾU → BỎ QUA
    # reconcile. Phân biệt với "admin xoá thật còn ít": khi đó header cũng = số ít
    # → expected_total ≈ scrape → KHÔNG skip (reconcile chạy bình thường).
    #
    # Chỉ áp cho scope 'active' (nơi có nguy cơ xoá hàng loạt). Member đã upsert ở
    # bước trên VẪN được lưu — chỉ bước xoá bị hoãn tới lần sync đủ.
    reconcile_skipped = False
    skip_reason: str | None = None
    if scopes and incoming_emails and "active" in scopes:
        # Số email active trong lần scrape này.
        if body.reconcile_emails is not None:
            pending_lower = {
                e.lower() for e in (body.reconcile_pending_emails or [])
            }
            incoming_active_count = len(incoming_emails - pending_lower)
        else:
            incoming_active_count = sum(
                1 for m in body.members if m.status == "active"
            )
        existing_active_count = db.execute(
            select(func.count())
            .select_from(Member)
            .where(
                Member.workspace_id == workspace_id,
                Member.status == "active",
            )
        ).scalar_one()

        if body.expected_total is not None and body.expected_total > 0:
            # Cho phép sai lệch nhỏ (member đang xử lý giữa lúc đọc header và
            # scrape). Thiếu > 10% so với header = scrape chưa đủ → skip.
            if incoming_active_count < body.expected_total * 0.9:
                reconcile_skipped = True
                skip_reason = (
                    f"partial_scrape: active scrape được {incoming_active_count} "
                    f"< header ChatGPT báo {body.expected_total}"
                )
        elif existing_active_count >= 10 and incoming_active_count <= 2:
            # Fallback khi extension cũ KHÔNG gửi expected_total: chỉ chặn đúng
            # chữ ký của bug (roster ≥10 mà sync sập còn ≤2) để không cản trở
            # việc xoá hợp lệ ở workspace nhỏ.
            reconcile_skipped = True
            skip_reason = (
                f"partial_scrape_no_header: active scrape được "
                f"{incoming_active_count} nhưng DB đang có {existing_active_count}"
            )

    if scopes and incoming_emails and not reconcile_skipped:
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
            "reconcile_skipped": reconcile_skipped,
            "expected_total": body.expected_total,
        },
        commit=False,
    )
    # Sự kiện đáng chú ý: reconcile bị chặn vì nghi sync thiếu → log riêng để
    # admin/monitoring thấy (member cũ được GIỮ, không mark removed).
    if reconcile_skipped:
        log_event(
            db,
            actor_type="EXTENSION",
            actor_label=f"workspace:{workspace.name}",
            action="MEMBER_RECONCILE_SKIPPED",
            result="SKIPPED",
            target_type="WORKSPACE",
            target_id=str(workspace_id),
            data={"reason": skip_reason, "expected_total": body.expected_total},
            commit=False,
        )
    db.commit()
    return {
        "created": created,
        "updated": updated,
        "removed_missing": removed_count,
        "total": len(body.members),
        "rogue_pending_emails": rogue_pending_emails,
        "reconcile_skipped": reconcile_skipped,
        "reconcile_skip_reason": skip_reason,
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
