"""Chức năng: SYNC RECONCILE (đồng bộ member từ extension + dọn phantom invite).

⚠️ ĐỌC `reconcile.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
⚠️ Anchor/hạn tuân theo `EXPIRY_RULES.md` §3, §9 — KHÔNG tự chế công thức.

Đây là API cho EXTENSION gọi (auth bằng X-API-KEY qua require_extension_workspace),
KHÔNG phải cho dashboard.

Endpoints:
  - POST /bulk-upsert            → bulk_upsert_members   (sau khi scrape member list)
  - POST /reconcile-after-invite → reconcile_after_invite (Phase 2 verify pending)
"""

import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_session, require_extension_workspace
from app.models import (
    REMOVED_REASON_INVITE_FAILED,
    REMOVED_REASON_SYNC_MISSING,
    AuditLog,
    Invite,
    Member,
    QueueItem,
    Workspace,
)
from app.schemas import InviteVerifyReconcileIn, MemberBulkUpsert
from app.sse import publish_task_event

from ._shared import router, _end_from_purchase

logger = logging.getLogger(__name__)


# Dò XOÁ-GIẢ: chỉ soi các lần mark removed trong cửa sổ này. Đủ rộng để bắt ca
# "xoá-giả rồi nhiều ngày sau mới có người bấm đồng bộ" (sự cố 03→12/8/2026: lần
# full sync trước đó cách 11 ngày), nhưng không lôi lại lịch sử cổ: member bị gỡ
# lâu rồi mà nay quay lại thường là ĐƯỢC MỜI LẠI, không phải xoá hỏng.
FAKE_REMOVE_LOOKBACK = timedelta(days=30)

# VÙNG BẢO VỆ LỜI MỜI TƯƠI: ChatGPT index lời mời vừa gửi vào tab "Lời mời đang
# chờ xử lý" TRỄ 1-30s (mẻ nhiều email còn lâu hơn — server gửi tuần tự). Mọi
# khối "không thấy email ⇒ kết luận xấu" trong file này phải chừa khoảng này ra,
# nếu không sẽ xoá oan lời mời ĐÃ ĐI THẬT. Xem `reconcile.md` §4.
FRESH_INVITE_GUARD = timedelta(minutes=10)


def _flag_fake_removals(
    db: Session,
    workspace: Workspace,
    resurrected: list[tuple[UUID, str, datetime | None]],
    now: datetime,
) -> list[str]:
    """Bóc các ca XOÁ-GIẢ lộ ra nhờ lần sync này, ghi `MEMBER_REMOVE_FAKE_DETECTED`.

    Bối cảnh (sự cố 03→12/8/2026): extension được phép kết luận "member đã rời
    workspace" chỉ bằng ô lọc, KHÔNG click xoá (`removal_evidence='absent_confirmed'`
    — xem `queue/completion.py`). Khi kết luận đó SAI, backend mark removed cho
    member VẪN CÒN trên ChatGPT: email vẫn ăn ghế, còn dashboard giấu luôn khỏi
    danh sách gia hạn (chỉ hiện active/pending) → im lặng tuyệt đối tới lần full
    sync kế tiếp, có khi hàng tuần.

    Bản thân việc "sống lại" đã được xử lý sẵn (upsert đưa về active + tick 60s
    gỡ lại) — cái THIẾU là DẤU VẾT. Không có sự kiện nào cho biết lần xoá trước
    là giả, nên bug chỉ lộ khi có người tình cờ soi bảng gia hạn. Hàm này biến nó
    thành 1 dòng nhật ký ERROR đích danh.

    Chỉ đếm ca `absent_confirmed`: member sống lại sau lần removed
    `clicked_and_verified` (đã click + xác minh row biến mất) hay sau khi bị gỡ
    tay là chuyện khác — mời lại, hoặc ChatGPT hồi row — không phải xoá-giả.

    Idempotent tự nhiên: sau lần này member ở trạng thái active/pending nên các
    sync sau không còn thấy `prev_status == 'removed'` → không log trùng.
    """
    if not resurrected:
        return []
    target_ids = [str(mid) for mid, _, _ in resurrected]
    rows = db.execute(
        select(AuditLog.target_id, AuditLog.data, AuditLog.timestamp)
        .where(
            AuditLog.action == "MEMBER_REMOVED_SYNCED",
            AuditLog.target_id.in_(target_ids),
            AuditLog.timestamp >= now - FAKE_REMOVE_LOOKBACK,
        )
        .order_by(AuditLog.timestamp.desc())
    ).all()
    # Đã sort giảm dần → lần gặp ĐẦU TIÊN của mỗi target là lần removed MỚI NHẤT.
    latest: dict[str, tuple[dict, datetime]] = {}
    for target_id, data, ts in rows:
        if target_id not in latest:
            latest[target_id] = (data or {}, ts)

    flagged: list[str] = []
    for member_id, email, removed_at in resurrected:
        entry = latest.get(str(member_id))
        if entry is None:
            continue
        data, ts = entry
        if data.get("removal_evidence") != "absent_confirmed":
            continue
        blind_hours = round((now - ts).total_seconds() / 3600, 1)
        log_event(
            db,
            actor_type="SYSTEM",
            action="MEMBER_REMOVE_FAKE_DETECTED",
            result="ERROR",
            target_type="MEMBER",
            target_id=str(member_id),
            data={
                "email": email,
                "workspace_id": str(workspace.id),
                "removal_evidence": "absent_confirmed",
                "removed_at": (removed_at or ts).isoformat(),
                "blind_hours": blind_hours,
                "queue_item_id": data.get("queue_item_id"),
                "note": (
                    "Lần xoá tự động gần nhất kết luận 'không thấy trong tab Người "
                    "dùng' và mark removed mà KHÔNG click xoá, nhưng đồng bộ này cho "
                    "thấy email VẪN CÒN trên ChatGPT → lần xoá đó là GIẢ, email đã ăn "
                    f"ghế suốt {blind_hours} giờ. Đã đưa lại về active; nếu quá hạn, "
                    "tick 60s sẽ gỡ lại (lần này có click + xác minh)."
                ),
            },
            commit=False,
        )
        flagged.append(email)
    if flagged:
        logger.warning(
            "[fake-remove] workspace=%s phát hiện %d email bị XOÁ-GIẢ (absent_confirmed) "
            "nay sống lại qua sync: %s",
            workspace.id,
            len(flagged),
            ", ".join(flagged[:10]),
        )
    return flagged


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
    # Đích danh email biến động để dashboard pop-up sau sync (user 2026-08-01):
    # created = có trên ChatGPT nhưng CHƯA có trong hệ thống (auto-create);
    # removed = hệ thống có nhưng ChatGPT KHÔNG còn (mark removed).
    created_emails: list[str] = []
    # Member đang 'removed' mà ChatGPT vẫn trả về → (id, email, removed_at cũ).
    # Đối chiếu audit sau vòng lặp để bóc ca XOÁ-GIẢ — xem `_flag_fake_removals`.
    resurrected: list[tuple[UUID, str, datetime | None]] = []
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
            # Chụp TRƯỚC khi upsert đè: cặp (status cũ, removed_at cũ) là căn cứ
            # duy nhất để biết member này vừa "sống lại" từ 'removed' → nguyên
            # liệu cho `_flag_fake_removals` (dò xoá-giả). Sau vài dòng nữa cả
            # hai đều bị ghi đè.
            prev_status = existing.status
            prev_removed_at = existing.removed_at
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
                existing.removed_reason = None
            # ⚠️ "Sống lại" KHÔNG vô hại: nếu lần removed gần nhất là do XOÁ TỰ
            # ĐỘNG kết luận vắng-mặt-không-click (`absent_confirmed`) thì việc
            # ChatGPT vẫn trả email này chính là BẰNG CHỨNG lần xoá đó là GIẢ.
            # Gom lại, đối chiếu audit sau vòng lặp (1 query cho cả batch).
            if prev_status == "removed" and existing.status in ("active", "pending"):
                resurrected.append((existing.id, existing.email, prev_removed_at))
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
            created_emails.append(email)

    workspace.last_synced_at = now

    removed_count = 0
    removed_emails: list[str] = []
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
        reconcile_cutoff = now - FRESH_INVITE_GUARD
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
            m.removed_reason = REMOVED_REASON_SYNC_MISSING
            m.last_synced_at = now
            removed_count += 1
            removed_emails.append(m.email)

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
        fresh_invite_cutoff = now - FRESH_INVITE_GUARD
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

    # ---- Đối soát LỆCH SỐ LƯỢNG cấp email (user 2026-07-30) ----
    # Sync xong VẪN có thể lệch (vd ChatGPT header 172 mà AutoGPT 171). Sai lệch
    # nhỏ (<10%) lọt qua guard "sync thiếu" nên trước đây KHÔNG ai được báo. Nay
    # so 3 con số trên tab "Người dùng" (active — nơi expected_total là nguồn
    # chuẩn) và CHỈ ĐÍCH DANH email lệch để admin tự truy nguyên nhân — KHÔNG tự
    # xoá/sửa gì (chốt user 2026-07-30):
    #   - expected_total : ChatGPT header báo (vd 172)
    #   - scraped_active : số row active extension bắt được lần này
    #   - db_active      : active trong AutoGPT sau sync (vd 171)
    #   - extra_in_autogpt   : AutoGPT đang active mà ChatGPT scrape KHÔNG thấy
    #                          (đã loại member trong vùng bảo vệ 10' — vừa mời lại).
    #   - missing_in_autogpt : ChatGPT scrape thấy active mà AutoGPT KHÔNG active.
    #   - unresolved_count   : header đếm NHIỀU hơn số row bắt được → còn dòng
    #                          ChatGPT chưa lấy được danh tính (owner / row ảo
    #                          virtualized chưa render) → admin mở tab kiểm tra tay.
    # CHỈ chạy khi scope có 'active' và KHÔNG reconcile_skipped (partial scrape →
    # số liệu vô nghĩa, đã có MEMBER_RECONCILE_SKIPPED lo).
    mismatch: dict | None = None
    if scopes and "active" in scopes and incoming_emails and not reconcile_skipped:
        if body.reconcile_emails is not None:
            _pending_lower = {
                e.lower() for e in (body.reconcile_pending_emails or [])
            }
        else:
            _pending_lower = {
                m.email.lower() for m in body.members if m.status == "pending"
            }
        scraped_active_emails = incoming_emails - _pending_lower
        db_active_emails = {
            e.lower()
            for (e,) in db.execute(
                select(Member.email).where(
                    Member.workspace_id == workspace_id,
                    Member.status == "active",
                )
            ).all()
        }
        db_active = len(db_active_emails)
        scraped_active = len(scraped_active_emails)
        missing_in_autogpt = sorted(scraped_active_emails - db_active_emails)
        raw_extra = db_active_emails - scraped_active_emails
        extra_in_autogpt: list[str] = []
        if raw_extra:
            # Loại member vừa mời lại trong 10' (ChatGPT chưa kịp hiện ở tab active
            # lúc scrape) — cùng vùng bảo vệ như khối mark-removed, tránh báo nhầm.
            protect_cutoff = now - FRESH_INVITE_GUARD
            protected = {
                e.lower()
                for (e,) in db.execute(
                    select(Member.email).where(
                        Member.workspace_id == workspace_id,
                        func.lower(Member.email).in_(raw_extra),
                        Member.invited_by_user_id.isnot(None),
                        func.coalesce(Member.last_invited_at, Member.created_at)
                        > protect_cutoff,
                    )
                ).all()
            }
            extra_in_autogpt = sorted(raw_extra - protected)
        unresolved = 0
        if body.expected_total is not None and body.expected_total > scraped_active:
            unresolved = body.expected_total - scraped_active
        header_mismatch = (
            body.expected_total is not None and body.expected_total != db_active
        )
        if extra_in_autogpt or missing_in_autogpt or unresolved or header_mismatch:
            mismatch = {
                "expected_total": body.expected_total,
                "scraped_active": scraped_active,
                "db_active": db_active,
                "extra_in_autogpt": extra_in_autogpt,
                "missing_in_autogpt": missing_in_autogpt,
                "unresolved_count": unresolved,
            }

    # Dò XOÁ-GIẢ TRƯỚC khi commit: mọi audit của lần sync này vào cùng 1 transaction.
    fake_removed_emails = _flag_fake_removals(db, workspace, resurrected, now)

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
            "fake_removed": len(fake_removed_emails),
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
    # Sync xong vẫn LỆCH số lượng → log riêng (đích danh email) để admin tra
    # nguyên nhân. Nằm ở tab "Chính" của Nhật ký (AuditLogs: nhóm 'sync').
    if mismatch is not None:
        log_event(
            db,
            actor_type="EXTENSION",
            actor_label=f"workspace:{workspace.name}",
            action="MEMBER_SYNC_MISMATCH",
            result="MISMATCH",
            target_type="WORKSPACE",
            target_id=str(workspace_id),
            data=mismatch,
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
        # Đích danh email biến động (cap 50/list để payload gọn — count ở trên
        # vẫn là số ĐẦY ĐỦ). Extension mang xuống QueueItem.result → banner
        # dashboard liệt kê thay đổi sau sync.
        "created_emails": created_emails[:50],
        "removed_emails": removed_emails[:50],
        # Email lộ ra là bị XOÁ-GIẢ nhờ lần sync này (hệ thống tưởng đã gỡ nhưng
        # ChatGPT vẫn còn) → extension mang xuống QueueItem.result để dashboard
        # cảnh báo, thay vì chỉ nằm im trong nhật ký.
        "fake_removed_emails": fake_removed_emails[:50],
        "total": len(body.members),
        "rogue_pending_emails": rogue_pending_emails,
        "reconcile_skipped": reconcile_skipped,
        "reconcile_skip_reason": skip_reason,
        # Số email lệch giữa tab Lời mời và dashboard → đã enqueue tra tab Người dùng.
        "joined_check_count": len(joined_check_emails),
        "joined_check_task_id": joined_check_task_id,
        # Lệch số lượng sau sync (đích danh email) — None nếu khớp. Extension mang
        # xuống QueueItem.result để dashboard cảnh báo admin.
        "mismatch": mismatch,
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

    ⚠️ VÙNG BẢO VỆ 10 PHÚT (fix 2026-08-26 — ca thật `mhlober`, task `8a2b9e4b`):
    endpoint này chạy NGAY sau cú bấm mời, đúng lúc ChatGPT còn đang index. Mẻ 9
    email hôm đó verify thấy 8, thiếu 1 → email thứ 9 bị chốt `removed` +
    `invite_failed` chỉ 75 GIÂY sau khi mời, trong khi lời mời đã đi thật và
    người được mời sau đó vào team. Guard 10 phút của `queue/completion.py` (ghi
    `MEMBER_INVITE_CLEANUP_DEFERRED` + `MEMBER_INVITE_PENDING_VERIFY`) viết ra
    đúng để chặn ca này, nhưng nó chạy 0,1 giây SAU nên không cứu kịp — đường này
    xoá trước và thắng. Nay hai đường dùng CHUNG một luật: email còn trong
    `FRESH_INVITE_GUARD` thì HOÃN phán xử, giữ `pending`, nhường kết luận cho
    - `completion.py` (ghi `MEMBER_INVITE_PENDING_VERIFY` khi task báo COMPLETED),
    - SYNC_DATA/`SYNC_MEMBERS_BATCH` (promote `pending → active` khi thấy email), và
    - resolver nền `main.py::_resolve_stale_pending_invites_once` (quá 20′ vẫn
      không có xác minh nào ⇒ chốt FAILED + hoàn phí + xoá phantom).

    Nghĩa là hoãn KHÔNG phải bỏ qua: lời mời hỏng THẬT vẫn bị chốt và hoàn tiền,
    chỉ chậm hơn vài chục phút. Đổi lại, lời mời trót lọt không còn bị xoá oan —
    thiệt hại lệch hẳn một bậc (xem `reconcile.md` §4).

    ⚠️ Email hoãn KHÔNG được chạm `last_synced_at`: resolver nền coi
    `last_synced_at` mới hơn mốc hoãn là BẰNG CHỨNG DƯƠNG "đồng bộ đã nhìn thấy
    email" → đóng dấu ở đây = tự tay dựng bằng chứng giả, lời mời hỏng thật sẽ
    được tha bổng và không ai hoàn phí.

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
    fresh_cutoff = now - FRESH_INVITE_GUARD
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
    deferred_emails: list[str] = []
    for m in rows:
        # Mốc neo = lần mời GẦN NHẤT (member re-invite giữ created_at cũ — cùng
        # lý do đã buộc khối reconcile ở trên dùng COALESCE, fix 2026-06-17).
        anchor = m.last_invited_at or m.created_at
        if anchor is not None and anchor > fresh_cutoff:
            deferred_emails.append(m.email)
            continue
        m.status = "removed"
        m.removed_at = now
        m.removed_reason = REMOVED_REASON_INVITE_FAILED
        m.last_synced_at = now
        removed_emails.append(m.email)

    if deferred_emails:
        # Cùng action + reason với guard bên `queue/completion.py` → nhật ký của
        # hai đường đọc như một, admin không phải học thêm sự kiện mới.
        log_event(
            db,
            actor_type="SYSTEM",
            actor_label="system:phantom-cleanup-guard",
            action="MEMBER_INVITE_CLEANUP_DEFERRED",
            result="OK",
            target_type="WORKSPACE",
            target_id=str(workspace_id),
            data={
                "workspace_id": str(workspace_id),
                "deferred_emails": deferred_emails,
                "reason": "fresh_invite_within_10min_defer_to_sync",
                "source": "reconcile_after_invite",
            },
            commit=False,
        )

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
                "deferred_emails": deferred_emails,
            },
            commit=False,
        )

    # MỘT commit cho cả lượt: member removed + Invite failed + audit của cả hai
    # nhánh nằm chung transaction (nửa vời = trạng thái lệch, như ca 26/8/2026
    # khi member bị chốt removed xong mới có ai đó ghi log hoãn).
    if removed_emails or deferred_emails:
        db.commit()

    return {
        "removed": len(removed_emails),
        "skipped": False,
        # Email được HOÃN phán xử vì còn trong vùng bảo vệ 10 phút (đã giữ
        # 'pending'). Extension chỉ log; có mặt ở đây để trace ca xoá oan.
        "deferred": len(deferred_emails),
        "deferred_emails": deferred_emails,
    }
