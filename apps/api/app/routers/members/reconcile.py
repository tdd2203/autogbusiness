"""Chức năng: SYNC RECONCILE (đồng bộ member từ extension + dọn phantom invite).

⚠️ ĐỌC `reconcile.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
⚠️ Anchor/hạn tuân theo `EXPIRY_RULES.md` §3, §9 — KHÔNG tự chế công thức.

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
from app.models import Invite, Member, QueueItem, Workspace
from app.schemas import InviteVerifyReconcileIn, MemberBulkUpsert
from app.sse import publish_task_event

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
    # Fix ③ (EXPIRY_RULES §9): khôi phục GIỜ MỜI cho member dựng/backfill qua sync.
    # Email đã mời qua dashboard có bản ghi Invite; nếu scrape KHÔNG mang ngày tham gia
    # (m.joined_at None) → lấy giờ mời SỚM NHẤT làm mốc, thay vì để anchor rơi về ngày
    # import (bug ngocsangung). Nạp 1 LẦN (batch) tránh N query trong vòng lặp.
    _incoming = [mm.email.lower() for mm in body.members]
    invite_times: dict[str, datetime] = {}
    if _incoming:
        invite_times = {
            e.lower(): t
            for e, t in db.execute(
                select(Invite.email, func.min(Invite.created_at))
                .where(
                    Invite.workspace_id == workspace_id,
                    func.lower(Invite.email).in_(_incoming),
                )
                .group_by(Invite.email)
            ).all()
            if t is not None
        }
    created = 0
    updated = 0
    # Default subscription cho member scrape-only (chưa từng invite qua dashboard):
    # 1 tháng = 30 ngày. Theo yêu cầu user 2026-05-19.
    # Mốc neo "Ngày gia hạn" LẦN ĐẦU = NGÀY THAM GIA thật: last_invited_at ?? joined_at
    # ?? created_at (chốt user 2026-07-13 — xem EXPIRY_RULES.md §3.5, §9). Member đồng bộ
    # thuần từ ChatGPT vào team TRƯỚC lúc import → neo theo joined_at (ngày vào team),
    # KHÔNG theo created_at (ngày import — vô nghĩa nghiệp vụ, gây thừa hạn). Lưu vào
    # subscription_purchased_at; hạn = neo + tháng×30 CHÍNH XÁC (hết hạn = gia hạn + 30).
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
            # ⚠️ CHỐT CHẶN chống HẠ CẤP active → pending. Sync scope 'invites' CHỈ
            # quét tab "Lời mời đang chờ xử lý" → mọi row bị gán cứng pending. Nếu
            # tab active chưa unmount kịp (React), row active lọt vào lần quét này
            # sẽ mang nhãn pending → trước đây ghi thẳng khiến member đang active
            # bị đẩy về "Chờ tham gia" và KẸT (scope invites không quét lại tab
            # active để promote). Một lần scrape TAB PENDING không đủ căn cứ khẳng
            # định member đã rời team — cùng triết lý guard chống mark-removed.
            # Chỉ chặn đúng chiều active→pending; các chuyển khác (pending→active,
            # →removed…) vẫn cho qua. Nguồn sự thật để hạ active là SYNC_DATA scope
            # 'both' (quét tab active, active-wins) hoặc REMOVE/REVOKE.
            if not (existing.status == "active" and m.status == "pending"):
                existing.status = m.status
            # TÁI KÍCH HOẠT: member từng bị 'removed' (kể cả removed OAN do verify
            # lời mời cũ mark nhầm) nay scrape lại thấy active/pending → clear mốc
            # retention 30 ngày (giống invite.py / change_email.py). Tránh member
            # active mà vẫn còn removed_at rác + để job hard-delete không dính.
            if existing.status != "removed" and existing.removed_at is not None:
                existing.removed_at = None
            # NGÀY THAM GIA = thời điểm MỜI (có giờ) nếu có. Scrape ChatGPT chỉ trả
            # NGÀY (00:00) → KHÔNG ghi đè joined_at đã có bằng giá trị kém chính xác
            # hơn. Chỉ đặt lần đầu (joined_at IS NULL), ưu tiên last_invited_at.
            # Yêu cầu user 2026-07-06 ("ngày tham gia lấy từ thời gian mời, cả giờ").
            if existing.joined_at is None:
                existing.joined_at = (
                    existing.last_invited_at
                    or m.joined_at
                    or invite_times.get(email)
                )
            existing.last_synced_at = now
            # Owner (chủ sở hữu workspace) mặc định VÔ HẠN — KHÔNG cấp gói (user
            # 2026-07-06). Member thường: backfill subscription CHỈ khi chưa từng có
            # hạn (end_at IS NULL) — legacy / row mới scrape. KHÔNG đụng hạn đã set.
            if existing.chatgpt_role != "owner" and existing.subscription_end_at is None:
                # Anchor lần đầu = NGÀY THAM GIA (joined_at đã set ngay phía trên nếu
                # trước đó NULL). Xem EXPIRY_RULES.md §3.5.
                anchor = (
                    existing.last_invited_at
                    or existing.joined_at
                    or existing.created_at
                    or now
                )
                existing.subscription_months = default_sub_months
                existing.subscription_purchased_at = anchor
                existing.subscription_end_at = _end_from_purchase(
                    anchor, default_sub_months
                )
            updated += 1
        else:
            # Owner mới scrape lần đầu → vô hạn (không gói). Member thường → gói mặc định.
            # Mốc neo lần đầu = NGÀY THAM GIA (m.joined_at), fallback now nếu scrape
            # thiếu; hạn = neo + 30. Xem EXPIRY_RULES.md §3.5.
            is_owner = m.chatgpt_role == "owner"
            # Ngày tham gia = scrape ?? GIỜ MỜI (Invite) — không rơi về ngày import.
            new_joined = m.joined_at or invite_times.get(email)
            new_anchor = None if is_owner else (new_joined or now)
            db.add(
                Member(
                    workspace_id=workspace_id,
                    email=email,
                    name=m.name,
                    chatgpt_role=m.chatgpt_role,
                    license_type=m.license_type,
                    status=m.status,
                    joined_at=new_joined,
                    last_synced_at=now,
                    subscription_months=None if is_owner else default_sub_months,
                    subscription_purchased_at=new_anchor,
                    subscription_end_at=None
                    if is_owner
                    else _end_from_purchase(new_anchor, default_sub_months),
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

    # ⚠️ CHỈ mark 'removed' cho member 'pending' khi lần sync này ĐÃ quét CẢ tab
    # "Người dùng" (active). Một pending RỜI tab "Lời mời" có 2 nguyên nhân không
    # phân biệt được nếu chỉ nhìn tab Lời mời: (a) NGƯỜI DÙNG CHẤP NHẬN lời mời →
    # sang tab "Người dùng" (active), (b) invite bị thu hồi/hết hạn. Sync scope
    # 'invites' CHỈ quét tab "Lời mời" → không đủ căn cứ → KHÔNG xoá (user report
    # 2026-07-13: đồng bộ lời mời làm MẤT thành viên đã tham gia). Nguồn sự thật
    # để xoá pending = sync scope 'both' (quét tab active: thấy email → promote
    # active; không thấy ở đâu → mới thật sự removed). Cùng triết lý guard
    # active→pending chỉ hạ khi scope 'both'.
    removal_scopes = scopes
    if "pending" in scopes and "active" not in scopes:
        removal_scopes = tuple(s for s in scopes if s != "pending")

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

    if removal_scopes and incoming_emails and not reconcile_skipped:
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
                    Member.status.in_(removal_scopes),
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
            m.removed_at = now
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

    # ---- "Lời mời chờ xử lý": email BIẾN MẤT khỏi tab Lời mời → truy tiếp tab
    # "Người dùng" (user 2026-07-22) ----
    # Quét tab Lời mời xong, đối chiếu với danh sách pending trên dashboard. Email
    # dashboard đang để "chờ tham gia" mà KHÔNG còn ở tab Lời mời của ChatGPT thì
    # về lý có 2 khả năng: (a) người dùng ĐÃ CHẤP NHẬN lời mời → nay nằm ở tab
    # "Người dùng"; (b) lời mời hỏng/bị thu hồi. Không phân biệt được nếu chỉ nhìn
    # tab Lời mời — đó chính là lý do khối reconcile bên trên KHÔNG dám mark removed
    # (sự cố mất member 2026-07-13).
    #
    # Nay: thay vì bỏ lửng chờ "Đồng bộ cả 2", tự enqueue SYNC_MEMBERS_BATCH cho
    # đúng nhóm email lệch đó → extension lọc TỪNG email trong tab "Người dùng" →
    # thấy ⇒ đã tham gia (completion.py promote pending→active); không thấy ⇒ giữ
    # pending. (b) coi như không xảy ra: luồng invite đã verify pending tab ngay lúc
    # mời (Phase 2) nên lời mời "thành công giả" hầu như không còn — user chốt bỏ
    # qua nhánh này, chỉ cần tra tab Người dùng là đủ.
    #
    # CHỈ chạy cho sync CHỈ-tab-Lời-mời (`pending` mà không có `active`): scope
    # 'both' vốn đã quét tab Người dùng nên biết thừa ai đã tham gia.
    joined_check_emails: list[str] = []
    joined_check_task_id: str | None = None
    # Scrape rỗng do LỖI và scrape rỗng THẬT (mọi lời mời đều đã được nhận) nhìn
    # giống hệt nhau nếu chỉ xét `incoming_emails`. `reconcile_emails is not None`
    # = extension gửi danh sách TƯỜNG MINH ⇒ scrape thành công, rỗng là rỗng thật.
    pending_scan_authoritative = (
        body.reconcile_emails is not None or bool(incoming_emails)
    )
    if (
        scopes
        and "pending" in scopes
        and "active" not in scopes
        and pending_scan_authoritative
        and not reconcile_skipped
    ):
        # Vùng bảo vệ 10 phút như khối mark-removed: ChatGPT index lời mời mới vào
        # tab "Lời mời" trễ 1-30s → email vừa mời chưa hiện KHÔNG phải "đã tham gia".
        fresh_invite_cutoff = now - timedelta(minutes=10)
        conds = [
            Member.workspace_id == workspace_id,
            Member.status == "pending",
            ~(
                (Member.invited_by_user_id.isnot(None))
                & (
                    func.coalesce(Member.last_invited_at, Member.created_at)
                    > fresh_invite_cutoff
                )
            ),
        ]
        # Tab Lời mời rỗng THẬT (mọi lời mời đều đã được nhận) → không loại trừ ai;
        # `notin_(<rỗng>)` là mệnh đề vô nghĩa nên chỉ thêm khi có email.
        if incoming_emails:
            conds.append(Member.email.notin_(incoming_emails))
        vanished = db.execute(select(Member.email).where(*conds)).scalars().all()
        joined_check_emails = sorted({e.lower() for e in vanished})

    if joined_check_emails:
        # Dedupe như `trigger_sync_members_batch`: đang có mẻ batch chạy dở thì thôi
        # (lần quét sau vẫn thấy các email này nếu chúng thực sự còn lệch).
        existing_batch = (
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
        if existing_batch is None:
            batch_item = QueueItem(
                type="SYNC_MEMBERS_BATCH",
                status="PENDING",
                workspace_id=workspace_id,
                # `source` để truy vết task này do sync-lời-mời tự sinh, không phải
                # do admin bấm "Cập nhật hàng loạt".
                payload={
                    "emails": joined_check_emails,
                    "source": "invite_sync_diff",
                },
                created_by_id=None,
            )
            db.add(batch_item)
            db.flush()
            joined_check_task_id = str(batch_item.id)
            log_event(
                db,
                actor_type="EXTENSION",
                actor_label=f"workspace:{workspace.name}",
                action="SYNC_MEMBERS_BATCH_QUEUED",
                result="PENDING",
                target_type="WORKSPACE",
                target_id=str(workspace_id),
                data={
                    "queue_item_id": joined_check_task_id,
                    "count": len(joined_check_emails),
                    "source": "invite_sync_diff",
                    "note": "Email lệch giữa tab Lời mời (ChatGPT) và danh sách chờ tham gia (dashboard) → tra tiếp tab Người dùng để xác định ai đã tham gia.",
                },
                commit=False,
            )

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
    if joined_check_task_id:
        # Sau commit — extension pick ngay task tra tab "Người dùng".
        publish_task_event(
            workspace_id,
            {
                "type": "task-available",
                "task_id": joined_check_task_id,
                "task_type": "SYNC_MEMBERS_BATCH",
            },
        )
    return {
        "created": created,
        "updated": updated,
        "removed_missing": removed_count,
        "total": len(body.members),
        "rogue_pending_emails": rogue_pending_emails,
        "reconcile_skipped": reconcile_skipped,
        "reconcile_skip_reason": skip_reason,
        # Số email lệch giữa tab Lời mời và dashboard → đã enqueue tra tab Người dùng.
        "joined_check_count": len(joined_check_emails),
        "joined_check_task_id": joined_check_task_id,
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
        m.removed_at = now
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
