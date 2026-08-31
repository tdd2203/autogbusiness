"""Chức năng: EXTENSION COMPLETION — báo COMPLETED/FAILED + reconcile DB.

⚠️ ĐỌC `completion.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
Docs ghi lịch sử lỗi, business rule và ý tưởng cải tiến — code chỉ là "how".

Đây là hàm phức tạp nhất của package: extension báo kết quả cuối cùng của task,
backend set trạng thái terminal RỒI reconcile DB theo loại task (sync role /
license_type, mark removed, phantom cleanup invite, …). Mọi side-effect dễ gây
bug nằm ở đây — chỉnh sửa phải đọc `completion.md` mục 4 trước.

Endpoints (đăng ký lên router dùng chung từ `_shared`):
  - PATCH /{item_id} → update_task
"""

from datetime import datetime, timedelta, timezone
from typing import NamedTuple
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import delete, func, or_, select, text, update
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    get_session,
    require_extension_workspace,
)
from app.models import (
    PLATFORM_CANVA,
    REMOVED_REASON_BY_ADMIN,
    REMOVED_REASON_EMAIL_CHANGED,
    REMOVED_REASON_EXPIRED,
    REMOVED_REASON_INVITE_FAILED,
    REMOVED_REASON_SEAT_CREDIT,
    REMOVED_REASON_INVITE_REVOKED,
    AuditLog,
    Invite,
    Member,
    QueueItem,
    Workspace,
)
from app.schemas import QueueOut, QueueUpdate
from app.services import wallet_service
from app.services.task_errors import friendly_error_message
from app.sse import publish_task_event

from ._shared import router
from .timing import stamp_task_timing


def _refund_stranded_deferred_fees(
    db: Session,
    *,
    workspace_id: UUID,
    emails: set[str],
    exclude_item_id: UUID,
) -> wallet_service.InviteRefund:
    """Hoàn nốt phí của lời mời TRƯỚC ĐÓ cùng email đang KẸT ở "chờ xác minh".

    Ca thật 22/8/2026 (mất 330k, user phải cộng tay bù):
      18:20  mời `k…@gmail.com` → trừ 330k → task FAILED `VERIFY_FAILED` nhưng đã
             bấm Gửi ⇒ `defer_unverified_invite` HOÃN phán xử (đúng): phí giữ lại,
             member còn 'pending', chờ resolver 20′ chốt bằng bằng chứng.
      18:28  admin "Mời lại" cùng email → task MIỄN PHÍ đó cũng FAILED
             (`NOT_ENOUGH_SEATS`, lỗi trước lúc bấm Gửi) ⇒ `reconcile_failed_invite`:
             xoá member pending, ghi `MEMBER_INVITE_FAILED`, và hoàn phí **của chính
             nó** = 0đ. 330k của lần 18:20 KHÔNG ai đụng tới.
      ⇒ resolver 20′ sau đó bỏ qua vĩnh viễn: member đã bị xoá (`member is None`) VÀ
        đã có audit `MEMBER_INVITE_FAILED` sau mốc defer (`resolved_after`). Tiền
        nằm lại trong doanh thu, ghế thì không có.

    Bất biến bị hở: phí đi theo TASK, còn kết luận "lời mời hỏng" lại đi theo EMAIL.
    Task sau chốt hỏng cho email nào thì phải đóng luôn đường tiền còn treo của email
    đó — bằng không mỗi cú mời-lại-hỏng lại nuốt một khoản phí của lần mời trả tiền.

    Chỉ đụng phí THỰC SỰ mồ côi, ba lớp chặn:
      1. Task cũ phải `FAILED` + `invite_fee` chưa `reversed` (FAILED mà còn giữ phí
         thì chỉ có thể là đường hoãn — không có đường nào khác).
      2. Email chưa từng có `MEMBER_INVITE_VERIFIED` sau khi task cũ kết thúc — đồng
         bộ đã thấy người ta trong team thì lời mời ĐI ĐƯỢC, phí thu đúng.
      3. Không còn member `active` sống với email đó — cùng lý lẽ với (2), đây là
         bằng chứng mạnh nhất và cũng là luật `defer_unverified_invite` đang dùng.

    KHÔNG commit — caller commit. Trả `InviteRefund` để caller gộp vào `refunded`
    rồi void/đánh dấu nợ theo đúng bất biến "hoàn phí ⇒ void kỳ".
    """
    if not emails:
        return wallet_service.InviteRefund(0, [])

    rows = db.execute(
        text(
            """
            SELECT DISTINCT wt.ref_id AS item_id,
                   lower(wt.meta->>'email') AS email,
                   COALESCE(q.completed_at, q.created_at) AS ended_at
            FROM wallet_transactions wt
            JOIN queue_items q ON q.id::text = wt.ref_id
            WHERE wt.kind = 'invite_fee'
              AND wt.reversed = false
              AND lower(wt.meta->>'email') = ANY(:emails)
              AND wt.ref_id <> :exclude
              AND q.type = 'INVITE_MEMBER'
              AND q.status = 'FAILED'
              AND q.workspace_id = :ws
            """
        ),
        {
            "emails": sorted(emails),
            "exclude": str(exclude_item_id),
            "ws": str(workspace_id),
        },
    ).mappings().all()
    if not rows:
        return wallet_service.InviteRefund(0, [])

    total = 0
    refunded_emails: list[str] = []
    for row in rows:
        email = row["email"]
        if not email:
            continue
        verified_after = db.execute(
            select(AuditLog.id)
            .where(
                AuditLog.action == "MEMBER_INVITE_VERIFIED",
                AuditLog.data["email"].astext == email,
                AuditLog.data["workspace_id"].astext == str(workspace_id),
                AuditLog.timestamp > row["ended_at"],
            )
            .limit(1)
        ).first()
        if verified_after is not None:
            continue
        still_active = db.execute(
            select(Member.id)
            .where(
                Member.workspace_id == workspace_id,
                Member.email == email,
                Member.status == "active",
            )
            .limit(1)
        ).first()
        if still_active is not None:
            continue
        one = wallet_service.refund_invite(
            db, UUID(row["item_id"]), emails=[email]
        )
        total += one.total_vnd
        refunded_emails.extend(one.emails)
    return wallet_service.InviteRefund(total, sorted(set(refunded_emails)))


class InviteFailureSummary(NamedTuple):
    """Kết cục TIỀN của một lệnh mời hỏng, chia theo từng email — để banner kết quả
    nói đúng chuyện gì đã xảy ra với khoản đã trừ, thay vì nói chung "đã hoàn phí".

    `refunded` = tiền đã quay về ví. `seat_credit` = KHÔNG hoàn, giữ tiền gắn với
    email để lần mời lại miễn phí (luật NOT_ENOUGH_SEATS chốt 28/8/2026).
    """

    failed: list[str]
    refunded: list[str]
    seat_credit: list[str]


def reconcile_failed_invite(
    db: Session,
    item: QueueItem,
    *,
    workspace_id: UUID,
    workspace_name: str,
    error_code: str | None = None,
) -> InviteFailureSummary:
    """Reconcile 1 task INVITE_MEMBER THẤT BẠI HOÀN TOÀN — dùng chung cho CẢ 2 đường:
      - extension báo FAILED (completion.update_task), VÀ
      - timeout lazy-cleanup (execution.pick_next).

    ⚠️ Trước đây khối này chỉ nằm inline trong completion.py nên lời mời chết qua
    đường TIMEOUT bị "thất bại nửa vời": tiền kẹt (không hoàn) + member kẹt
    'pending' (hiện "Chờ tham gia") + timeline vẫn "Đã mời". Gom vào đây để cả 2
    đường xử lý y hệt.

    Ba việc, THỨ TỰ quan trọng:
      1. Ghi MEMBER_INVITE_FAILED gắn từng member (timeline lật "Thất bại") — PHẢI
         chạy TRƯỚC khi xoá, không thì lookup member không thấy → mất mốc terminal
         → stepper suy nhầm "thành công" từ lần mời lại sau (completion.md §5).
      2. Xoá Member(pending, joined_at IS NULL) + Invite phantom của task (không
         đụng record đã active/đã join).
      3. Hoàn TOÀN BỘ phí invite_fee của task về ví (idempotent qua cột `reversed`;
         no-op nếu task không có giao dịch — user non-beta), VÀ phí còn treo của lời
         mời trước đó cùng email đang kẹt "chờ xác minh"
         (`_refund_stranded_deferred_fees` — ca thật 22/8/2026).

    NGOẠI LỆ `NOT_ENOUGH_SEATS` (chốt user 28/8/2026): KHÔNG hoàn tiền, thay vào đó
    giữ bản ghi lại làm phiếu đã-trả-tiền của email → mời lại email đó miễn phí. Xem
    khối `seat_credit_emails` bên dưới và `_keep_seat_credit_members`.

    KHÔNG commit — caller commit (completion: cuối update_task; execution: sau vòng
    lặp stuck_tasks).
    """
    inv_payload = item.payload or {}
    if isinstance(inv_payload.get("emails"), list):
        task_emails = {
            str(e).lower()
            for e in inv_payload["emails"]
            if isinstance(e, str) and "@" in e
        }
    elif isinstance(inv_payload.get("email"), str):
        task_emails = {inv_payload["email"].lower()}
    else:
        task_emails = set()

    now_terminal = datetime.now(timezone.utc)

    # ── PHẢI MUA SUẤT MÀ MUA KHÔNG ĐƯỢC ⇒ GIỮ TIỀN, MỜI LẠI MIỄN PHÍ ─────────
    #
    # Luật tiền do user chốt 28/8/2026: *"mời mà còn seat thì hoàn tiền, mời mà
    # phải mua seat thì add lại miễn phí đối với email đó"*.
    #
    # Vì sao không hoàn tiền cho ca này cho xong: hoàn về VÍ thì khoản đó lập tức
    # bị lượt mời sau tiêu mất, nên người dùng vẫn phải nạp lại đúng số tiền để
    # mời lại chính email vừa hỏng. Chiều 28/8 workspace GPT1 đi đúng vòng đó 5
    # lần liền (`tranbanien123`, `ngocvu14.3.2001`, `lphg2509`): trừ → hoàn → trừ
    # → hoàn, mà không ai được thêm vào đội.
    #
    # Giữ tiền GẮN VỚI EMAIL thì khoản đã trả không đi đâu được: bản ghi ở lại với
    # nguyên `subscription_end_at`, và luật "mời lại còn hạn thì miễn phí" (có sẵn
    # từ 14/7, xem `perform_invite_core`) tự lo phần còn lại — không phát sinh khái
    # niệm mới, không có đường tính phí nào phải sửa.
    #
    # CHỈ áp cho `NOT_ENOUGH_SEATS` — lời mời hỏng vì lý do khác (UI đổi, timeout,
    # ChatGPT từ chối) vẫn hoàn tiền như cũ.
    #
    # BẤT BIẾN: giữ tiền ⇔ giữ được PHIẾU gắn với email. Phiếu chính là
    # `subscription_end_at` còn ở tương lai trên bản ghi — không có nó thì lần mời
    # sau vẫn bị tính phí, tiền giữ lại thành tiền nuốt không. Nên email nào không
    # có hạn còn sống (mời "vô thời hạn": `months=None` ⇒ `subscription_end_at`
    # NULL mà phí vẫn thu tối thiểu 1 tháng) thì HOÀN TIỀN như cũ.
    seat_credit_emails: set[str] = set()
    if error_code == "NOT_ENOUGH_SEATS" and task_emails:
        seat_credit_emails = {
            row.lower()
            for row in db.execute(
                select(Member.email).where(
                    Member.workspace_id == workspace_id,
                    Member.email.in_(sorted(task_emails)),
                    Member.status == "pending",
                    Member.joined_at.is_(None),
                    Member.subscription_end_at.isnot(None),
                    Member.subscription_end_at > now_terminal,
                )
            )
            .scalars()
            .all()
        }
    refund_emails = sorted(task_emails - seat_credit_emails)

    # 1. Timeline: chấm thất bại cho MỌI member còn sống của task (TRƯỚC khi xoá).
    for email in sorted(task_emails):
        member = db.execute(
            select(Member).where(
                Member.workspace_id == workspace_id,
                Member.email == email,
                Member.status.in_(("pending", "active")),
            )
        ).scalar_one_or_none()
        if member is None:
            continue
        log_event(
            db,
            actor_type="EXTENSION",
            actor_label=f"workspace:{workspace_name}",
            action="MEMBER_INVITE_FAILED",
            result="FAILED",
            target_type="MEMBER",
            target_id=str(member.id),
            data={
                "email": email,
                "workspace_id": str(workspace_id),
                "queue_item_id": str(item.id),
                "verified_at": now_terminal.isoformat(),
                "error_code": error_code,
            },
            commit=False,
        )

    # 2. Email "ma" của task. XOÁ Ở BƯỚC 5 — SAU khi hoàn phí + void kỳ, không phải
    #    ở đây (đảo thứ tự 2026-08-27): xoá trước thì kỳ ĐÃ TRẢ cascade đi mất trước
    #    khi có ai kịp hỏi kỳ đó đã được hoàn tiền chưa. Xem `_delete_phantom_members`.
    invites = (
        db.execute(select(Invite).where(Invite.queue_item_id == item.id))
        .scalars()
        .all()
    )
    emails_to_delete = [inv.email.lower() for inv in invites]

    # 3. Hoàn phí invite_fee của task — TRỪ những email được giữ tiền theo phiếu.
    #    `emails=[]` ⇒ không hoàn đồng nào, `InviteRefund` khi đó falsy nên bước void
    #    kỳ và bước dò nợ hoàn-phí bên dưới tự đứng im — giữ đúng bất biến của file
    #    này: KHÔNG hoàn tiền ⇒ KHÔNG void kỳ.
    refunded = (
        wallet_service.refund_invite(db, item.id, emails=None)
        if not seat_credit_emails
        else wallet_service.refund_invite(db, item.id, emails=refund_emails)
    )

    # 3b. …VÀ phí còn treo của lời mời TRƯỚC ĐÓ cùng email (đường "chờ xác minh").
    #     Phí đi theo TASK nhưng kết luận "hỏng" đi theo EMAIL — task này vừa chốt
    #     hỏng cho các email đó thì khoản treo kia cũng hết cửa thành công. Không
    #     làm ở đây thì resolver 20′ sẽ bỏ qua vĩnh viễn (member vừa bị xoá ở bước 2
    #     + audit FAILED vừa ghi ở bước 1 khớp đúng 2 điều kiện SKIP của nó) — ca
    #     thật 22/8/2026, xem docstring `_refund_stranded_deferred_fees`.
    #     Ca giữ tiền theo email cũng KHÔNG đụng khoản treo đó: hoàn nó về ví sẽ
    #     kéo theo void kỳ của chính email đang được giữ tiền (`void_refunded_invite_periods`
    #     void theo `refunded.emails`) — mất luôn cái "còn hạn" làm nên lần mời lại
    #     miễn phí. Khoản treo ở lại cùng email, đúng tinh thần của luật này.
    stranded = (
        None
        if not refund_emails
        else _refund_stranded_deferred_fees(
            db,
            workspace_id=workspace_id,
            emails=set(refund_emails),
            exclude_item_id=item.id,
        )
    )
    if stranded:
        refunded = wallet_service.InviteRefund(
            refunded.total_vnd + stranded.total_vnd,
            sorted(set(refunded.emails) | set(stranded.emails)),
        )

    # 4. Hoàn phí ⇒ void kỳ đã trả — CHỈ cho email THỰC SỰ có tiền quay về ví lượt
    #    này (`refunded.emails`), KHÔNG phải mọi email trong payload task. Phantom nào
    #    joined_at != NULL không bị xoá ở bước 5 vẫn phải mất "hạn ma" → không cho
    #    mời lại miễn phí oan. Xem void_refunded_invite_periods / bug thuylinhtctbg.
    #
    #    ⚠️ Ca thật 23/8/2026: void theo `task_emails` cắt oan kỳ hạn
    #    đã trả bằng MỘT TASK KHÁC. Mời lại member còn hạn là MIỄN PHÍ (không có
    #    invite_fee cho task này) → refund = 0 đồng, nhưng void vẫn chạy ⇒ end_at = now
    #    ⇒ 50 giây sau job auto-expire gỡ khách khỏi workspace. Khách mất cả ghế lẫn
    #    tháng đã trả, không một đồng hoàn lại. Bất biến: KHÔNG hoàn tiền ⇒ KHÔNG void.
    from app.routers.members._shared import (
        flag_refunded_invite_debt,
        void_refunded_invite_periods,
    )

    void_refunded_invite_periods(
        db, workspace_id=workspace_id, emails=refunded.emails, now=now_terminal
    )
    # 5. GIỜ mới xoá Member + Invite phantom. Kỳ nào sống sót bước 4 = tiền KHÔNG
    #    được hoàn lượt này (vd kỳ kế thừa từ lần ĐỔI EMAIL) ⇒ bản ghi đó chỉ chuyển
    #    `removed`, không xoá — kẻo mất trắng lịch sử tiền.
    if emails_to_delete:
        # GIỮ bản ghi của email được giữ tiền: nó đang ôm `subscription_end_at` của
        # kỳ vừa trả, mà chính mốc đó làm nên lần mời lại miễn phí. Xoá đi là tiền
        # đã trừ biến mất không còn dấu vết nào.
        keep = [e for e in emails_to_delete if e in seat_credit_emails]
        drop = [e for e in emails_to_delete if e not in seat_credit_emails]
        if keep:
            _keep_seat_credit_members(
                db,
                workspace_id=workspace_id,
                workspace_name=workspace_name,
                emails=keep,
                now=now_terminal,
                item_id=item.id,
            )
        if drop:
            _delete_phantom_members(
                db,
                workspace_id=workspace_id,
                emails=drop,
                now=now_terminal,
                queue_item_id=item.id,
            )
        # Lời mời KHÔNG tồn tại trên ChatGPT (chưa bấm gửi được vì thiếu suất) →
        # dòng Invite phải đi trong cả hai ca, kẻo nó treo mãi "đang chờ".
        db.execute(
            delete(Invite).where(
                Invite.queue_item_id == item.id,
                Invite.email.in_(emails_to_delete),
            )
        )
    # 6. Member đã `active` thì bước 4 KHÔNG đụng tới (void = xoá hạn = tặng vô thời
    #    hạn, xem docstring flag_refunded_invite_debt) → đánh dấu CHƯA THANH TOÁN +
    #    báo động, kẻo email vẫn ở trong team mà màn hình hiện "đã thanh toán".
    if refunded:
        _flag_refund_debt(
            db,
            flag_refunded_invite_debt,
            workspace_id=workspace_id,
            workspace_name=workspace_name,
            emails=refunded.emails,
            item_id=item.id,
            now=now_terminal,
        )

    return InviteFailureSummary(
        failed=sorted(task_emails),
        refunded=sorted({e.lower() for e in refunded.emails}),
        seat_credit=sorted(seat_credit_emails),
    )


def _invite_task_emails(item: QueueItem) -> set[str]:
    """Email của một task INVITE_MEMBER (batch `emails` hoặc đơn `email`), lowercase."""
    payload = item.payload or {}
    if isinstance(payload.get("emails"), list):
        return {
            str(e).lower()
            for e in payload["emails"]
            if isinstance(e, str) and "@" in e
        }
    if isinstance(payload.get("email"), str):
        return {payload["email"].lower()}
    return set()


def _stamp_invite_outcome(
    item: QueueItem,
    *,
    invited: list[str] | None = None,
    failed: list[str] | None = None,
    pending_verify: list[str] | None = None,
    refunded: list[str] | None = None,
    seat_credit: list[str] | None = None,
    reason_code: str | None = None,
) -> None:
    """Ghi kết cục TỪNG EMAIL của lệnh mời vào `item.result["invite_outcome"]`.

    Vì sao (user 29/8/2026): banner kết quả chỉ nói "verify 7/8" rồi cắt còn 3 email
    → người dùng biết lệnh chạy xong nhưng KHÔNG biết email nào đã mời được. Backend
    ngay tại đây đã chia đủ ba nhóm (verified / hoãn đối chiếu / hỏng đã hoàn phí),
    chỉ là chưa ai ghi lại. Ghi ra để dashboard liệt kê thẳng từng email.

    Ba nhóm LOẠI TRỪ nhau: `invited` = có mặt thật trên ChatGPT; `pending_verify` =
    chưa xác minh được, đang đối chiếu (chưa được coi là hỏng); `failed` = đã chốt
    hỏng, bản ghi bị xoá. `refunded`/`seat_credit` là tập con của `failed` cho biết
    tiền đi đâu (xem InviteFailureSummary).

    Gán LẠI cả dict `item.result` — JSONB sửa tại chỗ không được SQLAlchemy theo dõi.
    """
    item.result = {
        **(item.result or {}),
        "invite_outcome": {
            "invited": invited or [],
            "failed": failed or [],
            "pending_verify": pending_verify or [],
            "refunded": refunded or [],
            "seat_credit": seat_credit or [],
            "reason_code": reason_code,
            # Câu giải thích lấy THẲNG từ `task_errors` — bảng chữ cho đại lý đã
            # chốt 28/8/2026. Dashboard tuyệt đối không được dựng bảng dịch mã lỗi
            # thứ hai: hai bảng thì sớm muộn cũng nói hai chuyện khác nhau, và ca
            # đắt nhất (`SEAT_PURCHASE_FAILED` — mua suất không thành) là ca dễ bị
            # bỏ sót nhất ở bảng đi sau.
            "reason_text": friendly_error_message(reason_code, None),
        },
    }


def close_invite_defer_with_sync_evidence(
    db: Session,
    member: Member,
    *,
    workspace_name: str,
    found_in: str,
) -> bool:
    """Đồng bộ ĐÃ THẤY email trong ChatGPT ⇒ đóng trạng thái "chờ xác minh" của lời
    mời bằng `MEMBER_INVITE_VERIFIED`. Trả True nếu vừa ghi. KHÔNG commit.

    `defer_unverified_invite` hoãn phán xử một lời mời đã bấm Gửi mà extension không
    xác minh kịp, rồi giao việc đối chiếu cho `SYNC_MEMBERS_BATCH`. Nhưng cái CHỐT
    của lời hứa đó — `_resolve_stale_pending_invites_once` (main.py) — chỉ chấp nhận
    hai dấu hiệu: member sang 'active', hoặc có `MEMBER_INVITE_VERIFIED` nối tiếp.

    ⚠️ CA THẬT 26/8/2026 (task 76d68e55, mẻ 5 email): mời đi thật, mẻ sync ngay sau
    đó trả `found_in='pending'` cho cả 5 — đúng bằng chứng cần tìm — nhưng nhánh
    reconcile chỉ chạm `last_synced_at`, không để lại dấu hiệu nào trong hai dấu hiệu
    trên. Hết 20′ resolver hoàn 5×330.000đ + void kỳ + xoá bản ghi của những lời mời
    đang nằm chờ THẬT trong ChatGPT. `found_in='pending'` là bằng chứng DƯƠNG rằng
    lời mời đã đi: người được mời chưa bấm nhận không phải là dịch vụ giao hỏng.

    `found_in='none'` KHÔNG gọi vào đây: không thấy đâu cả thì phải để resolver chốt.
    """
    if found_in not in ("active", "pending"):
        return False
    defer_ev = (
        db.execute(
            select(AuditLog)
            .where(
                AuditLog.action == "MEMBER_INVITE_PENDING_VERIFY",
                AuditLog.target_type == "MEMBER",
                AuditLog.target_id == str(member.id),
            )
            .order_by(AuditLog.timestamp.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
    if defer_ev is None:
        return False  # không có lời mời nào đang treo → không có gì để đóng
    # Đã có kết luận nối tiếp (VERIFIED/FAILED) → khỏi ghi chồng.
    resolved_after = db.execute(
        select(AuditLog.id)
        .where(
            AuditLog.target_type == "MEMBER",
            AuditLog.target_id == str(member.id),
            AuditLog.action.in_(("MEMBER_INVITE_VERIFIED", "MEMBER_INVITE_FAILED")),
            AuditLog.timestamp > defer_ev.timestamp,
        )
        .limit(1)
    ).first()
    if resolved_after is not None:
        return False
    log_event(
        db,
        actor_type="EXTENSION",
        actor_label=f"workspace:{workspace_name}",
        action="MEMBER_INVITE_VERIFIED",
        result="COMPLETED",
        target_type="MEMBER",
        target_id=str(member.id),
        data={
            "email": member.email.lower(),
            "workspace_id": str(member.workspace_id),
            "queue_item_id": (defer_ev.data or {}).get("queue_item_id"),
            "verified_at": datetime.now(timezone.utc).isoformat(),
            "error_code": None,
            "reason": f"sync_found_in_{found_in}",
        },
        commit=False,
    )
    return True


# Lời mời phải ĐỦ CŨ thì lời chứng "không thấy ở đâu cả" của đồng bộ mới đáng tin.
# Tab "Lời mời đang chờ" của ChatGPT không cập nhật tức thì; chốt hỏng ngay sau cú
# bấm Gửi là rơi vào đúng cái bẫy mà cả đường hoãn-phán-xử sinh ra để tránh (hoàn
# phí + xoá bản ghi của một lời mời đang nằm chờ THẬT). Ca timeout 8′ luôn vượt mốc
# này nên vẫn được chốt ngay; ca `VERIFY_FAILED` hỏng sớm (~2′) thì nhường cho
# `_resolve_stale_pending_invites_once` ở mốc 20′ như cũ.
INVITE_MISSING_MIN_AGE = timedelta(minutes=5)


def _email_change_target_emails(db: Session, queue_item_id: str | UUID) -> set[str]:
    """Email MỚI của lần đổi email / chuyển hạn mà lượt mời của nó CHÍNH LÀ task này.

    `change_email` (và `transfer_subscription`) ghi `invite_queue_item_id` = id task
    mời vào nhật ký, nên từ task hỏng lần ngược ra được: bản ghi email mới này không
    phải "ma" của một lời mời mới — nó đang ôm chu kỳ CHUYỂN sang từ email cũ.
    """
    rows = (
        db.execute(
            select(AuditLog.data).where(
                AuditLog.action.in_(
                    ("MEMBER_EMAIL_CHANGED", "MEMBER_SUBSCRIPTION_TRANSFERRED")
                ),
                AuditLog.data["invite_queue_item_id"].astext == str(queue_item_id),
            )
        )
        .scalars()
        .all()
    )
    out: set[str] = set()
    for data in rows:
        for key in ("new_email", "target_email"):
            value = (data or {}).get(key)
            if isinstance(value, str) and value.strip():
                out.add(value.strip().lower())
    return out


def _keep_seat_credit_members(
    db: Session,
    *,
    workspace_id: UUID,
    workspace_name: str,
    emails: list[str],
    now: datetime,
    item_id: UUID,
) -> list[str]:
    """Mời hỏng vì THIẾU SUẤT: giữ bản ghi lại làm "phiếu đã trả tiền" của email đó.

    Bản ghi chuyển `removed` + `removed_reason='invite_seat_credit'` nhưng GIỮ
    NGUYÊN `subscription_end_at` và các chu kỳ đã thanh toán. Hai hệ quả, cả hai
    đều là hành vi có sẵn chứ không phải luật mới:
      · `perform_invite_core` thấy `removed` + còn hạn ⇒ mời lại KHÔNG tính phí,
        cửa sổ hạn giữ nguyên (luật "mời lại còn hạn thì miễn phí", 14/7/2026);
      · `removed` nên nó không nằm trong danh sách sống, không chiếm suất, không
        kéo `_auto_buy_seats_for_pending` đi mua bù cho một lời mời không tồn tại.

    Chỉ đụng bản ghi "ma" (`pending` + chưa từng tham gia) của chính task này —
    y hệt phạm vi của `_delete_phantom_members`, chỉ khác là giữ thay vì xoá.

    Trả về các email đã giữ. KHÔNG commit.
    """
    if not emails:
        return []
    rows = (
        db.execute(
            select(Member).where(
                Member.workspace_id == workspace_id,
                Member.email.in_([e.lower() for e in emails]),
                Member.status == "pending",
                Member.joined_at.is_(None),
            )
        )
        .scalars()
        .all()
    )
    kept: list[str] = []
    for m in rows:
        m.status = "removed"
        m.removed_at = now
        m.removed_reason = REMOVED_REASON_SEAT_CREDIT
        db.add(m)
        kept.append(m.email)
        log_event(
            db,
            actor_type="SYSTEM",
            actor_label=f"workspace:{workspace_name}",
            action="MEMBER_INVITE_SEAT_CREDIT",
            result="SUCCESS",
            target_type="MEMBER",
            target_id=str(m.id),
            data={
                "email": m.email,
                "queue_item_id": str(item_id),
                "workspace_id": str(workspace_id),
                "subscription_end_at": (
                    m.subscription_end_at.isoformat()
                    if m.subscription_end_at
                    else None
                ),
                "note": (
                    "Mời hỏng vì workspace hết suất và mua bù không được. KHÔNG hoàn "
                    "tiền — khoản đã trả ở lại với email này, mời lại email này sẽ "
                    "miễn phí trong thời hạn đã trả."
                ),
            },
            commit=False,
        )
    return kept


def _delete_phantom_members(
    db: Session,
    *,
    workspace_id: UUID,
    emails: list[str],
    now: datetime,
    queue_item_id: str | UUID | None = None,
) -> list[str]:
    """Xoá bản ghi "ma" của lời mời hỏng — TRỪ bản ghi KẾ THỪA chu kỳ đã trả.

    "Ma" = `pending` + `joined_at IS NULL`: email chưa từng vào team, lời mời hỏng thì
    xoá hẳn cho sạch. Nhưng khuôn đó KHÔNG chỉ có ma: bản ghi email MỚI của một lần
    ĐỔI EMAIL cũng y hệt, mà nó đang ôm toàn bộ `member_subscription_cycles` CHUYỂN
    sang từ email cũ. Xoá thẳng ⇒ chu kỳ cascade theo ⇒ lịch sử tiền biến mất: báo cáo
    hụt lần mua đầu, và mời lại email đó bị tính phí như email MỚI — khách trả lần hai
    cho cùng một ghế (ca thật 22/8/2026: chuỗi lampesdafret22 → minalqureshi221 →
    saghan876 chỉ còn đúng MỘT chu kỳ, chu kỳ mua gốc không còn ở bản ghi nào).

    Nhận diện KHÔNG đoán mò: `queue_item_id` của task hỏng lần ngược ra nhật ký
    `MEMBER_EMAIL_CHANGED` (`_email_change_target_emails`). Lời mời thường vẫn bị xoá
    y như cũ — chỉ đúng bản ghi kế thừa mà CÒN chu kỳ mới được giữ lại, chuyển
    `removed`/`invite_failed` (đúng cách `reconcile.py` làm với lời mời hỏng): biến
    mất khỏi danh sách sống, nhưng lịch sử tiền còn nguyên.

    Gọi SAU khi đã hoàn phí + void kỳ của chính lượt hỏng này: kỳ nào CÒN LẠI lúc đó
    mới thật sự là tiền chưa được hoàn.

    Trả về các email được GIỮ LẠI thay vì xoá.
    """
    if not emails:
        return []
    protected = (
        _email_change_target_emails(db, queue_item_id) if queue_item_id else set()
    )
    rows = (
        db.execute(
            select(Member).where(
                Member.workspace_id == workspace_id,
                Member.email.in_([e.lower() for e in emails]),
                Member.status == "pending",
                Member.joined_at.is_(None),
            )
        )
        .scalars()
        .all()
    )
    kept: list[str] = []
    for m in rows:
        if m.email.lower() in protected and m.subscription_cycles:
            m.status = "removed"
            m.removed_at = now
            m.removed_reason = REMOVED_REASON_INVITE_FAILED
            db.add(m)
            kept.append(m.email)
        else:
            db.delete(m)
    return kept


def fail_deferred_invite(
    db: Session,
    member: Member,
    *,
    queue_item_id: str | None,
    actor_type: str,
    actor_label: str,
    error_code: str,
    now: datetime,
    extra: dict | None = None,
) -> None:
    """CHỐT HỎNG một lời mời đang treo "chờ xác minh", theo ĐÚNG một email.

    Ba việc, đúng thứ tự (thứ tự có ý nghĩa — xem chú thích từng bước): ghi
    `MEMBER_INVITE_FAILED` (timeline lật "Thất bại"), hoàn phí + void kỳ đã trả,
    rồi xoá phantom member/invite. KHÔNG commit — caller commit.

    Dùng chung cho hai người gọi để đường tiền chỉ có MỘT bản: resolver 20′
    (`main.py::_resolve_stale_pending_invites_once`) và nhánh đồng bộ báo
    `found_in='none'` (`close_invite_defer_with_missing_evidence`).
    """
    from app.routers.members._shared import void_refunded_invite_periods

    email = member.email.lower()
    ws_id = member.workspace_id
    # 1. Timeline FAILED — TRƯỚC khi xoá member để lookup còn thấy đối tượng.
    log_event(
        db,
        actor_type=actor_type,
        actor_label=actor_label,
        action="MEMBER_INVITE_FAILED",
        result="FAILED",
        target_type="MEMBER",
        target_id=str(member.id),
        data={
            "email": email,
            "workspace_id": str(ws_id),
            "queue_item_id": queue_item_id,
            "verified_at": now.isoformat(),
            "error_code": error_code,
            **(extra or {}),
        },
        commit=False,
    )
    # 2. Hoàn phí (idempotent) + void kỳ đã trả — CHỈ void khi lượt hoàn này thực
    #    sự trả tiền lại cho chính email đó (bất biến "hoàn phí ⇒ void kỳ"; void mà
    #    không hoàn = cắt kỳ khách đã trả bằng task khác — ca thật 23/8/2026).
    refunded = (
        wallet_service.refund_invite(db, UUID(queue_item_id), emails=[email])
        if queue_item_id
        else None
    )
    if refunded and refunded.emails:
        void_refunded_invite_periods(
            db, workspace_id=ws_id, emails=refunded.emails, now=now
        )
    # 3. Xoá phantom member + invite (email này CHƯA từng tham gia). Bước 2 đã hoàn
    #    phí + void kỳ, nên kỳ nào CÒN LẠI là tiền chưa được hoàn ⇒ giữ bản ghi lại
    #    thay vì xoá (ca đổi email — xem `_delete_phantom_members`).
    db.execute(
        delete(Invite).where(
            Invite.workspace_id == ws_id,
            func.lower(Invite.email) == email,
        )
    )
    #    (Ở ĐÂY xoá KHÔNG lọc `pending`/`joined_at IS NULL` như hai đường kia — giữ
    #    nguyên hành vi cũ, chỉ thêm đúng một ngoại lệ: còn chu kỳ thì không xoá.)
    if (
        queue_item_id
        and member.subscription_cycles
        and email in _email_change_target_emails(db, queue_item_id)
    ):
        member.status = "removed"
        member.removed_at = now
        member.removed_reason = REMOVED_REASON_INVITE_FAILED
        db.add(member)
    else:
        db.delete(member)


def close_invite_defer_with_missing_evidence(
    db: Session,
    member: Member,
    *,
    workspace_name: str,
    found_in: str,
    now: datetime,
) -> bool:
    """Đồng bộ KHÔNG THẤY email ở tab nào ⇒ chốt lời mời đang treo là HỎNG + hoàn
    phí NGAY. Trả True nếu vừa chốt (member đã bị xoá — caller đừng đụng nữa).

    Đối xứng với `close_invite_defer_with_sync_evidence` (chiều dương). Trước đây
    chiều âm chỉ đóng dấu `member.sync_missing_at` rồi vẫn bắt chờ đủ 20′ cho
    `_resolve_stale_pending_invites_once` — trong khi mẻ đồng bộ VỪA trả lời đúng
    câu hỏi mà resolver sẽ đi hỏi lại. Tiền của đại lý bị giam thêm ~19 phút cho
    một lời mời đã biết chắc là hỏng (user 26/8/2026).

    Chỉ chốt khi ĐỦ CẢ NĂM điều — mỗi điều bịt một kiểu chốt oan:
      1. `found_in='none'` (quét cả tab Lời mời lẫn Người dùng đều không thấy);
      2. member còn `pending` (chưa ai bấm nhận);
      3. có `MEMBER_INVITE_PENDING_VERIFY` đang treo, chưa có VERIFIED/FAILED nối tiếp;
      4. lời mời đã đủ cũ (`INVITE_MISSING_MIN_AGE`) — tab lời mời không tươi tức thì;
      5. không còn task INVITE_MEMBER nào đang mở cho email đó (đang chạy ≠ hỏng).
    """
    if found_in != "none" or member.status != "pending":
        return False
    email = member.email.lower()
    anchor = member.last_invited_at or member.created_at
    if anchor is None or now - anchor < INVITE_MISSING_MIN_AGE:
        return False
    defer_ev = (
        db.execute(
            select(AuditLog)
            .where(
                AuditLog.action == "MEMBER_INVITE_PENDING_VERIFY",
                AuditLog.target_type == "MEMBER",
                AuditLog.target_id == str(member.id),
            )
            .order_by(AuditLog.timestamp.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
    if defer_ev is None:
        return False
    resolved_after = db.execute(
        select(AuditLog.id)
        .where(
            AuditLog.target_type == "MEMBER",
            AuditLog.target_id == str(member.id),
            AuditLog.action.in_(("MEMBER_INVITE_VERIFIED", "MEMBER_INVITE_FAILED")),
            AuditLog.timestamp > defer_ev.timestamp,
        )
        .limit(1)
    ).first()
    if resolved_after is not None:
        return False
    open_invite = db.execute(
        select(QueueItem.id)
        .where(
            QueueItem.workspace_id == member.workspace_id,
            QueueItem.type == "INVITE_MEMBER",
            QueueItem.status.in_(("PENDING", "IN_PROGRESS")),
            or_(
                QueueItem.payload["email"].astext == email,
                QueueItem.payload.contains({"emails": [email]}),
            ),
        )
        .limit(1)
    ).first()
    if open_invite is not None:
        return False

    fail_deferred_invite(
        db,
        member,
        queue_item_id=(defer_ev.data or {}).get("queue_item_id"),
        actor_type="EXTENSION",
        actor_label=f"workspace:{workspace_name}",
        error_code="INVITE_NOT_FOUND_BY_SYNC",
        now=now,
        extra={"reason": "sync_found_in_none", "deferred_at": defer_ev.timestamp.isoformat()},
    )
    return True


def enqueue_sync_probe(
    db: Session, *, workspace_id: UUID, emails: list[str]
) -> bool:
    """Xếp một mẻ `SYNC_MEMBERS_BATCH` ĐI XEM TẬN NƠI các email đang treo chờ xác minh.

    "Hoãn phán xử để đối chiếu" chỉ có nghĩa nếu THẬT SỰ có ai đi đối chiếu. Trước
    đây chỉ nhánh FAILED-defer xếp mẻ này, còn nhánh COMPLETED-defer (guard 10′) thì
    không — hoãn xong không ai đi xem, 20′ sau resolver chốt hỏng trong mù và hoàn
    phí (ca thật 28-29/8/2026: 12 email vào team thật vẫn bị hoàn 3.960.000đ, xem
    [[hoan-phi-mu-khi-mời-khong-kiem-chung]]). Giờ cả hai nhánh dùng chung hàm này.

    Dedup: đã có mẻ đang chờ/đang chạy thì thôi — nó tự gom email pending. Trả True
    nếu vừa xếp mẻ mới. `created_by_id=None`: task của HỆ THỐNG, không ăn suất
    cooldown sync của admin phụ (cùng lối `_enqueue_periodic_sync_once`). KHÔNG
    commit — caller commit."""
    if not emails:
        return False
    existing = db.execute(
        select(QueueItem.id)
        .where(
            QueueItem.workspace_id == workspace_id,
            QueueItem.type == "SYNC_MEMBERS_BATCH",
            QueueItem.status.in_(("PENDING", "IN_PROGRESS")),
        )
        .limit(1)
    ).first()
    if existing is not None:
        return False
    db.add(
        QueueItem(
            type="SYNC_MEMBERS_BATCH",
            status="PENDING",
            workspace_id=workspace_id,
            payload={"emails": sorted({e.lower() for e in emails})},
            created_by_id=None,
        )
    )
    return True


def defer_unverified_invite(
    db: Session,
    item: QueueItem,
    *,
    workspace_id: UUID,
    workspace_name: str,
    error_code: str | None = None,
) -> bool:
    """Task INVITE_MEMBER FAILED nhưng cú "Gửi lời mời" ĐÃ XẢY RA THẬT (extension gửi
    `result.submit_clicked`) → KHÔNG hoàn phí, KHÔNG xoá bản ghi, KHÔNG void kỳ. Đánh
    dấu chờ xác minh + đi TÌM bằng chứng, để đường tiền luôn có căn cứ.

    ⚠️ BÀI HỌC (production 12/8/2026, 2 ca mời báo hỏng OAN): "extension không xác
    minh được" bị đối xử như "lời mời hỏng" ⇒ hoàn phí + `void_refunded_invite_periods`
    trong vòng 30-100 giây, trong khi lời mời đã tới hộp thư người nhận thật. Đường
    COMPLETED-chưa-xác-minh vốn đã cẩn thận (hoãn 10′ rồi resolver 20′ mới chốt bằng
    bằng chứng) — chỉ đường FAILED là chốt vội. Hàm này làm HAI đường đối xứng nhau.

    Ranh giới: CHỈ hoãn khi có BẰNG CHỨNG DƯƠNG là lệnh đã submit. Lỗi trước lúc bấm
    Gửi (không tìm thấy nút, toggle 'mời ngoài miền' không bật được, sai trang…) vẫn
    đi `reconcile_failed_invite` — hoàn phí NGAY là đúng, tiền không được giam oan.
    ChatGPT tự báo lỗi trong dialog (`chatgpt_error_hint`) cũng vậy: đó là bằng chứng
    dương rằng lời mời KHÔNG đi (caller lọc trước khi gọi hàm này).

    Hai việc:
      1. Ghi `MEMBER_INVITE_PENDING_VERIFY` gắn từng member — timeline hiện "Chờ xác
         minh" (đúng sự thật) thay vì "Thất bại", VÀ đây chính là mốc mà
         `_resolve_stale_pending_invites_once` (main.py) canh: quá 20′ vẫn không ai
         thấy email trong team thì lúc đó mới chốt hỏng + hoàn phí — quyết định CÓ
         bằng chứng (thời gian + đồng bộ).
      2. Enqueue `SYNC_MEMBERS_BATCH` cho đúng các email đó — chủ động ĐI XEM tab
         "Người dùng" ngay trong vài phút, không ngồi chờ hết 20′. Đồng bộ thấy email
         → promote 'active' + ghi VERIFIED ⇒ resolver bỏ qua, phí giữ nguyên (đúng).

    Trả True nếu đã hoãn (caller BỎ QUA reconcile_failed_invite). Trả False khi không
    còn member nào sống để theo dõi — hoãn lúc đó chỉ là giam tiền không ai đối chiếu,
    nên caller phải hoàn phí như cũ. KHÔNG commit — caller commit."""
    inv_payload = item.payload or {}
    if isinstance(inv_payload.get("emails"), list):
        task_emails = {
            str(e).lower()
            for e in inv_payload["emails"]
            if isinstance(e, str) and "@" in e
        }
    elif isinstance(inv_payload.get("email"), str):
        task_emails = {inv_payload["email"].lower()}
    else:
        task_emails = set()
    if not task_emails:
        return False

    members = (
        db.execute(
            select(Member).where(
                Member.workspace_id == workspace_id,
                Member.email.in_(sorted(task_emails)),
                Member.status.in_(("pending", "active")),
            )
        )
        .scalars()
        .all()
    )
    if not members:
        return False
    # Member ĐÃ `active` = đồng bộ đã thấy email trong team ⇒ bằng chứng MẠNH NHẤT rằng
    # lời mời đi được. Không hoãn, không theo dõi, và tuyệt đối không hoàn phí: trước
    # đây nhánh này rơi vào `reconcile_failed_invite` → hoàn phí rồi
    # `flag_refunded_invite_debt` lật member sang "chưa thanh toán" (ca stockbox.m) —
    # tức tự tạo ra một khoản nợ cho dịch vụ ĐÃ giao đúng và ĐÃ thu đúng tiền.
    pending_members = [m for m in members if m.status == "pending"]
    if not pending_members:
        return True

    now = datetime.now(timezone.utc)
    for member in pending_members:
        log_event(
            db,
            actor_type="EXTENSION",
            actor_label=f"workspace:{workspace_name}",
            action="MEMBER_INVITE_PENDING_VERIFY",
            result="PENDING",
            target_type="MEMBER",
            target_id=str(member.id),
            data={
                "email": member.email,
                "workspace_id": str(workspace_id),
                "queue_item_id": str(item.id),
                "error_code": error_code,
                "reason": "submitted_but_unverified_defer_to_sync",
            },
            commit=False,
        )

    enqueue_sync_probe(
        db, workspace_id=workspace_id, emails=[m.email for m in pending_members]
    )
    return True


def _flag_refund_debt(
    db: Session,
    flagger,
    *,
    workspace_id: UUID,
    workspace_name: str,
    emails: list[str],
    item_id: UUID,
    now: datetime,
) -> None:
    """Đánh dấu nợ + ghi audit cho email ĐÃ HOÀN PHÍ nhưng vẫn ở trong team.

    `MEMBER_REFUND_WHILE_IN_TEAM` (result ERROR) nổi lên trang Nhật ký để admin truy
    thu — hạn dùng GIỮ NGUYÊN (khách đang dùng thật, không cắt giữa chừng) và ví
    KHÔNG bị trừ lại tự động (rút tiền đại lý khi họ không bấm gì là việc không được
    làm ngầm). Xem kiểm chứng 2026-08-04 trong `members/payments.md`."""
    for member in flagger(db, workspace_id=workspace_id, emails=emails, now=now):
        log_event(
            db,
            actor_type="EXTENSION",
            actor_label=f"workspace:{workspace_name}",
            action="MEMBER_REFUND_WHILE_IN_TEAM",
            result="ERROR",
            target_type="MEMBER",
            target_id=str(member.id),
            data={
                "email": member.email,
                "workspace_id": str(workspace_id),
                "queue_item_id": str(item_id),
                "note": (
                    "Đã hoàn phí mời nhưng email VẪN ở trong team ChatGPT → đánh dấu "
                    "CHƯA THANH TOÁN để truy thu. Hạn dùng giữ nguyên, ví không bị trừ lại."
                ),
            },
            commit=False,
        )


def _absorb_seat_reading(workspace: Workspace, result: object) -> bool:
    """Ghi lại số suất mà extension vừa ĐỌC TẬN NƠI trên ChatGPT vào workspace.

    Task mời mở hộp "Quản lý suất" để đếm suất trước khi mời, và kèm số đọc được
    vào `result` (`seat_total`/`seat_assigned`, hoặc `*_after` khi có mua bù).
    Trước đây con số đó chỉ nằm trong result rồi thôi — `workspace.seat_total` chỉ
    đổi khi chạy SYNC_BILLING, nên dashboard toàn ôm số cũ (24/8/2026: DB ghi 148
    suất trong khi ChatGPT đã 150–151).

    Ghi lại để LẦN MỜI SAU được BỎ QUA việc mở hộp: `_seat_hint` (members/invite.py)
    gửi cặp số này xuống, extension thấy còn thừa chỗ thì mời thẳng. Đọc được lần
    nào thì hint tươi lần đó — không đọc được cũng không sao, chỉ là mở hộp như cũ.

    CHỈ nhận số ĐỌC TẬN NƠI. Khi extension đi đường tắt (`seat_check` =
    "skipped_headroom") thì `seat_total` trong result CHÍNH LÀ hint ta vừa gửi
    xuống — ghi lại là vòng tròn: số cũ tự xác nhận chính nó và mãi mãi không bao
    giờ tươi lại. Bỏ qua scope đó.

    Trả True nếu có cập nhật (caller commit chung).
    """
    if not isinstance(result, dict):
        return False
    # Task FAILED gắn seatData ở gốc `result`; task COMPLETED gộp vào `result.data`.
    for scope in (result, result.get("data")):
        if not isinstance(scope, dict):
            continue
        if scope.get("seat_check") == "skipped_headroom":
            continue
        # Số SAU khi mua bù mới là số cuối cùng — ưu tiên nó.
        total = scope.get("seat_total_after")
        assigned = scope.get("seat_assigned_after")
        if not isinstance(total, int):
            total = scope.get("seat_total")
            assigned = scope.get("seat_assigned")
        if not isinstance(total, int) or total <= 0:
            continue
        changed = False
        if workspace.seat_total != total:
            workspace.seat_total = total
            changed = True
        if isinstance(assigned, int) and 0 <= assigned <= total:
            if workspace.seat_used != assigned:
                workspace.seat_used = assigned
                changed = True
        return changed
    return False


# ── TỰ MUA BÙ SUẤT CHO LỜI MỜI ĐANG TREO (chốt user 2026-08-24) ─────────────
# Lời mời đang chờ KHÔNG chiếm suất trên ChatGPT (hộp "Quản lý suất" chỉ đếm người
# ĐÃ tham gia), nhưng sẽ chiếm ngay khi người ta bấm nhận. Ca thật CHATGPT PRO
# 24/8/2026: 60/60 đã gán + 1 lời mời treo ⇒ đang NỢ 1 suất mà không chỗ nào báo.
# Người đó bấm nhận thì ChatGPT vẫn phải cấp suất thứ 61 và vẫn tính tiền — mua
# trước là trả sớm khoản đằng nào cũng tới, đổi lại tránh được hộp "Mua suất người
# dùng và gửi lời mời" do ChatGPT tự quyết số tiền.
#
# Đây là đường DUY NHẤT hệ thống tự tiêu tiền thật mà không có người bấm — sau khi
# sync định kỳ đổi sang quét cả hai tab, nó chạy cả lúc không ai ngồi trước máy.
# User biết điều đó và vẫn chọn như vậy. Rào chắn phải dày hơn mọi đường khác:
# xem `_auto_buy_seats_for_pending`.

# Trần mỗi lần tự mua. Thiếu nhiều hơn số này là bất thường (sync hỏng, hoặc admin
# vừa mời cả mẻ lớn) → chỉ ghi nhật ký cảnh báo, để người thật nhìn trước.
AUTO_SEAT_BUY_MAX = 5

# Khoảng cách tối thiểu giữa 2 lần MUA SUẤT của cùng workspace (mọi nguồn, kể cả
# admin bấm tay). Chặn vòng lặp mua: ChatGPT cập nhật số suất chậm một nhịp thì mẻ
# sync kế tiếp vẫn thấy thiếu và mua lần nữa.
AUTO_SEAT_BUY_COOLDOWN = timedelta(hours=6)

# Lời mời treo LÂU HƠN mốc này KHÔNG được kéo hệ thống đi mua suất.
#
# "Còn trong tab Lời mời" chỉ chứng minh lời mời CÒN ĐÓ, không chứng minh nó SẼ
# ĐƯỢC NHẬN — GPT1 có `lucrativoa2` treo 11 ngày, hạn thuê bao còn 3
# ngày, vẫn nằm nguyên trong tab. Mua suất cho lời mời đã nguội là trả phí THÁNG
# LẶP LẠI cho một chỗ ngồi nhiều khả năng bỏ trống.
#
# ⚠️ CHỈ áp cho đường TỰ MUA. Đường mời (`_seat_hint.pending`) vẫn đếm ĐỦ MỌI lời
# mời chờ: ở đó đếm thừa cùng lắm là mở hộp đếm tận nơi, còn đếm thiếu là mời mù
# vào chỗ không có → ChatGPT bật hộp "Mua suất người dùng và gửi lời mời" với số
# tiền do nó tự quyết. Hai đường chịu rủi ro ngược nhau nên rào khác nhau.
AUTO_SEAT_PENDING_MAX_AGE = timedelta(days=7)


def _pending_worth_a_seat(
    db: Session, workspace: Workspace
) -> tuple[list[str], list[str]]:
    """Chia lời mời đang chờ thành (ĐÁNG mua suất, KHÔNG đáng) — xem
    `AUTO_SEAT_PENDING_MAX_AGE`.

    Không đáng khi:
      - mời đã quá `AUTO_SEAT_PENDING_MAX_AGE` mà vẫn chưa ai nhận. Mốc tính theo
        lần mời GẦN NHẤT: `max(created_at, last_invited_at)` — admin bấm "Mời lại"
        là lời mời tươi lại, dù member được tạo từ lâu.
      - hạn thuê bao đã qua: có nhận cũng không còn gì để dùng.
    """
    rows = db.execute(
        select(
            Member.email,
            Member.created_at,
            Member.last_invited_at,
            Member.subscription_end_at,
        ).where(Member.workspace_id == workspace.id, Member.status == "pending")
    ).all()
    now = datetime.now(timezone.utc)
    worth: list[str] = []
    stale: list[str] = []
    for email, created_at, last_invited_at, subscription_end_at in rows:
        invited_at = max(
            [d for d in (created_at, last_invited_at) if d is not None],
            default=None,
        )
        too_old = invited_at is None or (now - invited_at) > AUTO_SEAT_PENDING_MAX_AGE
        expired = subscription_end_at is not None and subscription_end_at <= now
        (stale if (too_old or expired) else worth).append(email)
    return worth, stale


def _auto_buy_seats_for_pending(
    db: Session, workspace: Workspace, item: QueueItem, result: object
) -> UUID | None:
    """Thiếu suất cho lời mời đang treo → tự tạo task PURCHASE_SEAT mua bù.

    Công thức: `thiếu = đã_gán + lời_mời_đang_chờ − tổng_suất`.
      - `đã_gán`, `tổng_suất`: extension vừa đọc TẬN NƠI ở hộp "Quản lý suất".
      - `lời_mời_đang_chờ`: đếm trong DB, nhưng CHỈ tin khi mẻ sync này vừa quét
        tab "Lời mời đang chờ" (`invites_scanned`) VÀ reconcile đã thật sự chạy
        (`reconcile_skipped` không bật) — chỉ khi đó lời mời chết mới vừa được
        dọn xong, số đếm được mới là số CÒN SỐNG THẬT.

    Sáu rào chắn (bỏ bất kỳ cái nào là mở đường tiêu tiền sai):
      1. CHỈ chạy sau SYNC_DATA có quét tab Lời mời VÀ reconcile không bị từ chối.
      2. Số suất phải CHẮC CHẮN — `seat_uncertain` (bộ đếm ≠ dòng tỉ lệ) thì dừng.
      3. Lời mời treo quá lâu / hết hạn thuê bao KHÔNG được tính (xem
         `_pending_worth_a_seat`).
      4. Trần `AUTO_SEAT_BUY_MAX` suất/lần.
      5. Đang có PURCHASE_SEAT chờ/chạy → không tạo thêm (khoá hàng workspace
         FOR UPDATE trước khi check-then-insert, y như `trigger_purchase_seat`).
      6. Cách lần mua suất gần nhất < `AUTO_SEAT_BUY_COOLDOWN` → không mua.

    Trả về id task vừa tạo (caller publish SSE SAU commit), hoặc None.
    """
    if item.type != "SYNC_DATA" or not isinstance(result, dict):
        return None
    # NHÁNH CANVA KHÔNG BAO GIỜ MUA SUẤT: gói đã có sẵn 50 suất và không có đường nào
    # mua thêm. Thực tế mẻ sync Canva cũng không mang `invites_scanned`/`seat_total`
    # nên đã rơi ở rào dưới, nhưng chặn thẳng ở đây cho rõ ý — đây là chỗ tiêu tiền
    # thật, không để nó phụ thuộc vào hình dạng payload của nhánh khác.
    if workspace.platform == PLATFORM_CANVA:
        return None
    if result.get("invites_scanned") is not True:
        return None
    # Backend vừa TỪ CHỐI reconcile (nghi mẻ sync thiếu dữ liệu, xem reconcile.py)
    # ⇒ lời mời chờ trong DB CHƯA được dọn theo mẻ này. Quét được tab chỉ chứng
    # minh "đã nhìn", không chứng minh "đã đối chiếu xong" — mà đúng ca bị từ chối
    # lại là ca DB còn ôm lời mời đã chết. Tiêu tiền theo số đó là mua thừa.
    if result.get("reconcile_skipped") is True:
        return None
    total = result.get("seat_total")
    assigned = result.get("seat_assigned")
    if not isinstance(total, int) or not isinstance(assigned, int) or total <= 0:
        return None

    pending_emails, stale_emails = _pending_worth_a_seat(db, workspace)
    pending = len(pending_emails)
    shortfall = assigned + pending - total
    if shortfall <= 0:
        return None

    def _skip(reason: str, extra: dict | None = None) -> None:
        """Ghi nhật ký ca THIẾU SUẤT mà không mua — để admin biết mà xử tay."""
        log_event(
            db,
            actor_type="SYSTEM",
            actor_label="auto-seat",
            action="AUTO_PURCHASE_SEAT_SKIPPED",
            result="FAILED",
            target_type="WORKSPACE",
            target_id=str(workspace.id),
            data={
                "reason": reason,
                "shortfall": shortfall,
                "seat_total": total,
                "seat_assigned": assigned,
                "pending": pending,
                "pending_emails": pending_emails,
                "pending_stale_ignored": stale_emails,
                **(extra or {}),
            },
            commit=False,
        )

    # (2) Số mơ hồ thì tuyệt đối không mua — tiền đã trừ không đòi lại được.
    if result.get("seat_uncertain") is True:
        _skip("seat_uncertain")
        return None

    # (4) Thiếu quá nhiều: dừng cho người thật nhìn.
    if shortfall > AUTO_SEAT_BUY_MAX:
        _skip("over_auto_cap", {"cap": AUTO_SEAT_BUY_MAX})
        return None

    # (5) Khoá hàng workspace rồi mới check-then-insert.
    db.execute(select(Workspace.id).where(Workspace.id == workspace.id).with_for_update())
    running = (
        db.execute(
            select(QueueItem.id).where(
                QueueItem.workspace_id == workspace.id,
                QueueItem.type == "PURCHASE_SEAT",
                QueueItem.status.in_(("PENDING", "IN_PROGRESS")),
            )
        )
        .scalars()
        .first()
    )
    if running:
        _skip("purchase_in_flight", {"queue_item_id": str(running)})
        return None

    # (6) Cách lần mua trước quá gần → chờ. Tính theo MỌI task mua suất (kể cả
    # admin bấm tay): ChatGPT cộng suất chậm một nhịp thì mẻ sync kế tiếp vẫn đọc
    # ra số cũ và sẽ mua chồng lần nữa.
    since = datetime.now(timezone.utc) - AUTO_SEAT_BUY_COOLDOWN
    recent = (
        db.execute(
            select(QueueItem.id).where(
                QueueItem.workspace_id == workspace.id,
                QueueItem.type == "PURCHASE_SEAT",
                QueueItem.created_at >= since,
            )
        )
        .scalars()
        .first()
    )
    if recent:
        _skip(
            "cooldown",
            {
                "queue_item_id": str(recent),
                "hours": AUTO_SEAT_BUY_COOLDOWN.total_seconds() / 3600,
            },
        )
        return None

    purchase = QueueItem(
        type="PURCHASE_SEAT",
        status="PENDING",
        workspace_id=workspace.id,
        payload={"quantity": shortfall, "reason": "auto_pending_seat"},
        # Không có người bấm — task này do hệ thống sinh ra.
        created_by_id=None,
    )
    db.add(purchase)
    db.flush()
    log_event(
        db,
        actor_type="SYSTEM",
        actor_label="auto-seat",
        action="AUTO_PURCHASE_SEAT_QUEUED",
        result="PENDING",
        target_type="WORKSPACE",
        target_id=str(workspace.id),
        data={
            "queue_item_id": str(purchase.id),
            "quantity": shortfall,
            "seat_total": total,
            "seat_assigned": assigned,
            "pending": pending,
            # Đích danh email kéo việc mua này — để admin đối chiếu khi thấy giao
            # dịch lạ, và thấy luôn lời mời nào đã bị loại vì quá cũ / hết hạn.
            "pending_emails": pending_emails,
            "pending_stale_ignored": stale_emails,
            "sync_item_id": str(item.id),
            "note": (
                f"{assigned} người đang dùng + {pending} lời mời đang chờ = "
                f"{assigned + pending} suất sẽ bị chiếm, workspace mới có {total} "
                f"→ tự mua bù {shortfall} suất."
            ),
        },
        commit=False,
    )
    return purchase.id


@router.patch("/{item_id}", response_model=QueueOut)
def update_task(
    item_id: UUID,
    body: QueueUpdate,
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> QueueItem:
    item = db.get(QueueItem, item_id)
    if not item:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Queue item không tồn tại"
        )
    if item.workspace_id != workspace.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Queue item không thuộc workspace của API key này",
        )
    # ---- IDEMPOTENCY / TERMINAL GUARD (fix 2026-06-17) ----
    # Task đã ở trạng thái terminal (COMPLETED/FAILED) KHÔNG được xử lý lại:
    #  - Extension PATCH trùng (retry mạng / double-fire) → chạy lại reconcile
    #    (re-mark removed, double DELETE invite, sync role/license lần 2) — không
    #    idempotent an toàn.
    #  - Task đã bị execution.py set FAILED+TIMEOUT, extension báo COMPLETED muộn
    #    → trước đây LẬT terminal FAILED→COMPLETED rồi chạy side-effect cho task
    #    đã chết.
    # → Khoá: đã terminal thì trả nguyên trạng (idempotent), bỏ qua mọi
    #   side-effect. Nguồn chân lý cuối vẫn là SYNC_DATA.
    if item.status in ("COMPLETED", "FAILED"):
        return item

    # ---- DRY-RUN: extension đã BỎ QUA thao tác thật (workspace.dry_run_mode) ----
    # Extension báo COMPLETED kèm result.dry_run=true cho task phá huỷ. Vì KHÔNG có
    # gì đổi thật trên ChatGPT, TUYỆT ĐỐI không áp side-effect DB (mark removed,
    # sync role/license/usage, phantom cleanup invite, revoke…). Chỉ set terminal +
    # audit riêng để truy vết. Đặt TRƯỚC mọi nhánh side-effect bên dưới.
    if (
        body.status == "COMPLETED"
        and isinstance(body.result, dict)
        and body.result.get("dry_run") is True
    ):
        item.status = "COMPLETED"
        item.result = body.result
        item.error_code = None
        item.error_message = None
        item.completed_at = datetime.now(timezone.utc)
        stamp_task_timing(item)
        db.add(item)
        log_event(
            db,
            actor_type="EXTENSION",
            actor_label=f"workspace:{workspace.name}",
            action=f"QUEUE_DRY_RUN:{item.type}",
            result="COMPLETED",
            target_type="QUEUE_ITEM",
            target_id=str(item.id),
            data={"dry_run": True},
            commit=False,
        )
        db.commit()
        db.refresh(item)
        return item

    # Số suất extension vừa đọc tận nơi → ghi vào workspace để lần mời sau khỏi
    # phải mở lại hộp "Quản lý suất". Chạy cho CẢ COMPLETED lẫn FAILED: task chết
    # ở bước sau vẫn có thể đã đếm suất xong. Xem `_absorb_seat_reading`.
    if _absorb_seat_reading(workspace, body.result):
        db.add(workspace)

    # Thiếu suất cho lời mời đang treo → tự mua bù (xem `_auto_buy_seats_for_pending`).
    # Chỉ xét khi task ĐI TỚI ĐÍCH: task hỏng giữa chừng thì số nó mang về không
    # đủ tin để tiêu tiền. SSE bắn SAU commit — task chưa nằm trong DB mà đã báo
    # "có việc" thì extension quay lại hỏi sẽ không thấy gì.
    auto_purchase_id: UUID | None = None
    if body.status == "COMPLETED":
        auto_purchase_id = _auto_buy_seats_for_pending(db, workspace, item, body.result)

    reconcile_note: str | None = None
    effective_status = body.status
    # REMOVE_MEMBER chỉ được mark removed khi CÓ BẰNG CHỨNG DƯƠNG member đã thực sự
    # rời ChatGPT: `result.data.verified === true`. Extension (>= v0.9.23) phát tín
    # hiệu này qua ĐÚNG HAI đường, cả hai đều là bằng chứng dương:
    #   1. Tìm thấy row → click xoá → POLL thấy row BIẾN MẤT.
    #   2. `data.absent === true` — lọc tab "Người dùng" không ra email VÀ đã chứng
    #      minh ô lọc còn sống (clear lọc thấy member khác → gõ lại vẫn trống). Đúng
    #      nghiệp vụ: không có trong business thì coi như đã gỡ xong (user
    #      2026-07-22) — xem `filterOnceAndResolve` bên extension.
    #
    # ⚠️ Đường (2) là đường DUY NHẤT mark removed mà KHÔNG có cú click nào, nên nó
    # đứt gánh là xoá-giả: email vẫn ăn ghế trên ChatGPT còn dashboard giấu luôn
    # khỏi danh sách gia hạn. Đúng chuyện đã xảy ra 03→12/8/2026 (4 email): extension
    # v≤0.11.1 coi "số row đổi khác lúc chưa lọc" là bằng chứng ô lọc đã chạy, nhưng
    # tab /admin/members mới mở còn đang đổ row nên số row tự đổi. v0.11.2 mới thực
    # thi ĐÚNG hợp đồng ghi ở trên (list đứng yên + positive control + 2 vòng).
    # Lưới an toàn phía backend: `_flag_fake_removals` (members/reconcile.py) — sync
    # sau thấy lại email vừa removed bằng `absent_confirmed` ⇒ MEMBER_REMOVE_FAKE_DETECTED.
    #
    # ⚠️ KHÔNG suy "không tìm thấy = đã xoá" một cách TRẦN TRỤI (bug user 2026-07-21,
    # TÁI diễn 06:29 cùng ngày): `MEMBER_NOT_IN_WORKSPACE` trơ trọi từng được
    # auto-convert → removed, nhưng "không tìm thấy" KHÔNG đáng tin khi ô lọc vắng
    # mặt (rơi scroll-scan trên list virtualized) hoặc tab nền bị Chrome throttle →
    # mark removed GIẢ cho member VẪN CÒN → đồng bộ hồi sinh → VÒNG LẶP xoá-giả. Nên
    # ranh giới nằm ở BẰNG CHỨNG chứ không ở "thấy/không thấy": ext gửi kèm `absent`
    # chỉ khi đã tự chứng minh; `MEMBER_NOT_IN_WORKSPACE` (FAILED, ext cũ hoặc không
    # chứng minh được) vẫn KHÔNG mark removed — để ĐỒNG BỘ đầy đủ (SYNC_DATA/
    # bulk-upsert, `expected_total` — xem reconcile.py) chốt.
    removal_verified = False

    # ---- REVOKE_INVITES COMPLETED → CHỈ mark removed email THỰC SỰ thu hồi ----
    # ⚠️ Trước đây mark removed MÙ theo payload chỉ cần status=COMPLETED → bug: extension
    # có thể fail 1 phần (vd menu ChatGPT không có mục "Thu hồi lời mời") mà vẫn báo
    # COMPLETED → member bị removed dù lời mời VẪN CÒN trên ChatGPT (user 2026-07-13).
    # Giờ đọc `result.data.results[].ok`: chỉ email ok=true (revoke/remove thành công)
    # mới mark removed + `Invite`→revoked + audit; email fail → GIỮ pending + log cảnh báo.
    if body.status == "COMPLETED" and item.type == "REVOKE_INVITES":
        raw_emails = (item.payload or {}).get("emails") or []
        payload_emails = {
            str(e).strip().lower()
            for e in raw_emails
            if isinstance(e, str) and "@" in e
        }
        per_results = ((body.result or {}).get("data") or {}).get("results")
        if isinstance(per_results, list):
            revoked_ok = {
                str(r.get("email", "")).strip().lower()
                for r in per_results
                if isinstance(r, dict) and r.get("ok") is True
            }
        else:
            # Extension cũ không trả `results` → thiếu căn cứ → KHÔNG mark removed
            # (an toàn: thà để pending còn hơn xoá nhầm khi chưa chắc đã thu hồi).
            revoked_ok = set()
        to_remove = payload_emails & revoked_ok
        failed_emails = payload_emails - revoked_ok
        if to_remove:
            stale_members = (
                db.execute(
                    select(Member).where(
                        Member.workspace_id == workspace.id,
                        Member.email.in_(to_remove),
                        Member.status.in_(("pending", "active")),
                    )
                )
                .scalars()
                .all()
            )
            revoked_at = datetime.now(timezone.utc)
            # Lời mời đang chờ của email HẾT HẠN cũng bị gỡ bằng REVOKE_INVITES (job
            # nền `_enqueue_expired_removals_once` chọn REVOKE cho pending, REMOVE cho
            # active). Không phân biệt ở đây thì tab "Đã xoá" ghi nhầm "thu hồi lời
            # mời" cho email thực chất chết vì hết hạn. Căn cứ = task này có được job
            # hết hạn tạo ra không (cùng cách nhận diện với nhánh REMOVE_MEMBER).
            expired_revoke = db.execute(
                select(AuditLog.id)
                .where(
                    AuditLog.action == "MEMBER_EXPIRED_REMOVE_QUEUED",
                    AuditLog.data["queue_item_id"].astext == str(item.id),
                )
                .limit(1)
            ).first()
            revoke_reason = (
                REMOVED_REASON_EXPIRED if expired_revoke else REMOVED_REASON_INVITE_REVOKED
            )
            for member in stale_members:
                member.status = "removed"
                member.removed_at = revoked_at
                # Cùng lý lẽ với nhánh REMOVE_MEMBER: lời mời của email đang mắc kẹt
                # vì ĐỔI EMAIL nay thu hồi được thật → lý do là 'đổi email', không
                # phải 'thu hồi lời mời'.
                if member.email_change_stuck_at is not None:
                    member.removed_reason = REMOVED_REASON_EMAIL_CHANGED
                    member.email_change_stuck_at = None
                    member.email_change_stuck_to = None
                else:
                    member.removed_reason = revoke_reason
                db.add(member)
                log_event(
                    db,
                    actor_type="EXTENSION",
                    actor_label=f"workspace:{workspace.name}",
                    action="MEMBER_INVITE_REVOKED",
                    result="OK",
                    target_type="MEMBER",
                    target_id=str(member.id),
                    data={
                        "email": member.email,
                        "workspace_id": str(workspace.id),
                        # Gắn queue_item_id để timeline gộp vào ĐÚNG dòng
                        # *_REMOVE_QUEUED (khớp như MEMBER_INVITE_VERIFIED),
                        # lật "Đang chờ" → "Thành công".
                        "queue_item_id": str(item.id),
                    },
                    commit=False,
                )
            db.execute(
                update(Invite)
                .where(
                    Invite.workspace_id == workspace.id,
                    Invite.email.in_(to_remove),
                    Invite.status == "pending",
                )
                .values(status="revoked")
            )
        if failed_emails:
            # Extension báo COMPLETED nhưng các email này KHÔNG thực sự thu hồi được
            # → để lại pending + log để admin biết mà xử lý (không âm thầm nuốt).
            log_event(
                db,
                actor_type="EXTENSION",
                actor_label=f"workspace:{workspace.name}",
                action="MEMBER_INVITE_REVOKE_FAILED",
                result="ERROR",
                target_type="WORKSPACE",
                target_id=str(workspace.id),
                data={
                    "emails": sorted(failed_emails),
                    "queue_item_id": str(item.id),
                    "note": "Extension báo COMPLETED nhưng không thu hồi được các email này (giữ pending)",
                },
                commit=False,
            )

    item.status = effective_status
    if body.result is not None:
        item.result = body.result
    elif reconcile_note:
        item.result = {"reconciled": True, "note": reconcile_note}
    item.error_code = None if effective_status == "COMPLETED" else body.error_code
    item.error_message = (
        reconcile_note
        if effective_status == "COMPLETED" and reconcile_note
        else (None if effective_status == "COMPLETED" else body.error_message)
    )
    if effective_status in ("COMPLETED", "FAILED"):
        item.completed_at = datetime.now(timezone.utc)
        # Chốt sổ thời gian ngay lúc lệnh về đích — xem `timing.py`.
        stamp_task_timing(item)
    db.add(item)

    # CHANGE_ROLE COMPLETED → sync Member.chatgpt_role trong DB.
    # Trước đây extension click đổi role trên ChatGPT thành công nhưng DB
    # không update → dashboard vẫn hiển thị role cũ cho tới khi SYNC_DATA chạy.
    # Lookup member theo email từ payload + đổi chatgpt_role = new_role.
    if (
        item.type == "CHANGE_ROLE"
        and effective_status == "COMPLETED"
    ):
        payload = item.payload or {}
        target_email = (payload.get("email") or "").lower()
        new_role = payload.get("new_role")
        if target_email and new_role:
            member = db.execute(
                select(Member).where(
                    Member.workspace_id == workspace.id,
                    Member.email == target_email,
                )
            ).scalar_one_or_none()
            if member:
                member.chatgpt_role = new_role
                db.add(member)
                log_event(
                    db,
                    actor_type="EXTENSION",
                    actor_label=f"workspace:{workspace.name}",
                    action="MEMBER_ROLE_SYNCED",
                    result="COMPLETED",
                    target_type="MEMBER",
                    target_id=str(member.id),
                    data={"email": target_email, "new_role": new_role},
                    commit=False,
                )

    # CHANGE_LICENSE_TYPE COMPLETED → sync Member.license_type trong DB.
    # Tương tự CHANGE_ROLE: extension đổi trên ChatGPT xong, DB phải update ngay
    # chứ không đợi SYNC_DATA.
    if (
        item.type == "CHANGE_LICENSE_TYPE"
        and effective_status == "COMPLETED"
    ):
        payload = item.payload or {}
        target_email = (payload.get("email") or "").lower()
        new_license_type = payload.get("new_license_type")
        if target_email and new_license_type:
            member = db.execute(
                select(Member).where(
                    Member.workspace_id == workspace.id,
                    Member.email == target_email,
                )
            ).scalar_one_or_none()
            if member:
                member.license_type = new_license_type
                db.add(member)
                log_event(
                    db,
                    actor_type="EXTENSION",
                    actor_label=f"workspace:{workspace.name}",
                    action="MEMBER_LICENSE_TYPE_SYNCED",
                    result="COMPLETED",
                    target_type="MEMBER",
                    target_id=str(member.id),
                    data={"email": target_email, "new_license_type": new_license_type},
                    commit=False,
                )

    # SET_USAGE_LIMIT COMPLETED → sync Member.usage_limit_credits trong DB.
    # Giống CHANGE_LICENSE_TYPE: extension đặt trên ChatGPT xong, DB update ngay
    # chứ không đợi SYNC_DATA.
    if item.type == "SET_USAGE_LIMIT" and effective_status == "COMPLETED":
        payload = item.payload or {}
        target_email = (payload.get("email") or "").lower()
        limit_credits = payload.get("limit_credits")
        if target_email and limit_credits is not None:
            member = db.execute(
                select(Member).where(
                    Member.workspace_id == workspace.id,
                    Member.email == target_email,
                )
            ).scalar_one_or_none()
            if member:
                member.usage_limit_credits = limit_credits
                db.add(member)
                log_event(
                    db,
                    actor_type="EXTENSION",
                    actor_label=f"workspace:{workspace.name}",
                    action="MEMBER_USAGE_LIMIT_SYNCED",
                    result="COMPLETED",
                    target_type="MEMBER",
                    target_id=str(member.id),
                    data={"email": target_email, "limit_credits": limit_credits},
                    commit=False,
                )

    # REMOVE_MEMBER COMPLETED → sync Member.status='removed' trong DB — NHƯNG CHỈ
    # khi có bằng chứng xác minh (removal_verified). Extension mới trả
    # result.data.verified=true sau khi POLL thấy row biến mất; nhánh
    # MEMBER_NOT_IN_WORKSPACE cũng set removal_verified.
    if (
        item.type == "REMOVE_MEMBER"
        and effective_status == "COMPLETED"
    ):
        if not removal_verified:
            ext_data = (body.result or {}).get("data") or {}
            if isinstance(ext_data, dict) and ext_data.get("verified") is True:
                removal_verified = True
        payload = item.payload or {}
        target_email = (payload.get("email") or "").lower()
        if target_email:
            member = db.execute(
                select(Member).where(
                    Member.workspace_id == workspace.id,
                    Member.email == target_email,
                )
            ).scalar_one_or_none()
            if member and member.status != "removed" and not removal_verified:
                # Extension báo COMPLETED nhưng KHÔNG kèm bằng chứng đã rời (bản cũ,
                # hoặc dialog đóng mà chưa verify) → TUYỆT ĐỐI không mark removed
                # (chống xoá-giả). Giữ active, ghi cảnh báo; tick auto-remove sau
                # sẽ enqueue lại + extension mới verify lại đến khi thật sự rời.
                log_event(
                    db,
                    actor_type="EXTENSION",
                    actor_label=f"workspace:{workspace.name}",
                    action="MEMBER_REMOVE_UNVERIFIED",
                    result="ERROR",
                    target_type="MEMBER",
                    target_id=str(member.id),
                    data={
                        "email": target_email,
                        "queue_item_id": str(item.id),
                        "note": "Task báo COMPLETED nhưng thiếu bằng chứng member đã rời ChatGPT → GIỮ active, chờ retry verify.",
                    },
                    commit=False,
                )
            elif member and member.status != "removed":
                member.status = "removed"
                member.removed_at = datetime.now(timezone.utc)
                db.add(member)
                remove_data: dict = {
                    "email": target_email,
                    # Timeline chi tiết thành viên hiện chip "Workspace" cho dòng
                    # gỡ/xoá — log này có lúc đứng MỘT MÌNH (dòng *_REMOVE_QUEUED
                    # không nằm trong kết quả) nên phải tự mang nơi gỡ.
                    "workspace_id": str(workspace.id),
                    "queue_item_id": str(item.id),
                }
                # Gỡ theo đường nào: "clicked" = tìm thấy row → click xoá → poll thấy
                # biến mất; "absent" = không có trong tab Người dùng (ô lọc đã chứng
                # minh còn sống). Cần cho hậu kiểm nếu lại nghi ngờ xoá-giả.
                ext_result_data = (body.result or {}).get("data") or {}
                if isinstance(ext_result_data, dict) and ext_result_data.get("absent") is True:
                    remove_data["removal_evidence"] = "absent_confirmed"
                    remove_data["absence_reason"] = ext_result_data.get("absence_reason")
                else:
                    remove_data["removal_evidence"] = "clicked_and_verified"
                expired_init = db.execute(
                    select(AuditLog.id)
                    .where(
                        AuditLog.action == "MEMBER_EXPIRED_REMOVE_QUEUED",
                        AuditLog.data["queue_item_id"].astext == str(item.id),
                    )
                    .limit(1)
                ).first()
                # Lý do lưu THẲNG lên member (cột removed_reason) để tab "Đã xoá"
                # đọc trực tiếp, khỏi truy ngược audit log — nhiều đường xoá khác
                # ghi log ở cấp WORKSPACE nên không tra ngược theo email được.
                if member.email_change_stuck_at is not None:
                    # Ca ĐỔI EMAIL MẮC KẸT (lần gỡ trước hỏng → sync thấy email vẫn
                    # ở ChatGPT nên hồi sinh nó) nay đã gỡ được THẬT. Đây là kết cục
                    # muộn của lần đổi email, không phải "admin xoá tay": ghi
                    # by_admin ở đây là làm đứt chuỗi cũ→mới ở tab "Đã xoá", đúng
                    # cái sai đã xảy ra ngày 22/8/2026. Cờ mắc kẹt gỡ luôn.
                    remove_data["removal_reason"] = "email_changed"
                    member.removed_reason = REMOVED_REASON_EMAIL_CHANGED
                    member.email_change_stuck_at = None
                    member.email_change_stuck_to = None
                elif expired_init:
                    remove_data["removal_reason"] = "expired"
                    member.removed_reason = REMOVED_REASON_EXPIRED
                else:
                    member.removed_reason = REMOVED_REASON_BY_ADMIN
                log_event(
                    db,
                    actor_type="EXTENSION",
                    actor_label=f"workspace:{workspace.name}",
                    action="MEMBER_REMOVED_SYNCED",
                    result="COMPLETED",
                    target_type="MEMBER",
                    target_id=str(member.id),
                    # queue_item_id để timeline gộp vào dòng *_REMOVE_QUEUED
                    # tương ứng (lật "Đang chờ" → "Thành công").
                    data=remove_data,
                    commit=False,
                )

    # Đếm số member được nâng pending→active trong lần đồng bộ này (SYNC_MEMBER /
    # SYNC_MEMBERS_BATCH) — đính vào audit QUEUE_UPDATED cuối để tab "Chính" tóm tắt
    # "Đồng bộ · N đã tham gia" mà không phải gom lại các sự kiện promote rời rạc
    # (mỗi promote vẫn nằm trong vòng đời lời mời của member — xem join-transition).
    promoted_active_emails: list[str] = []

    # SYNC_MEMBER COMPLETED → "đồng bộ 1 tài khoản lẻ" reconcile theo `found_in`.
    # Extension trả {ok, data:{email, found_in}}; runner gói thành result={data:{...}}.
    #   found_in='active'  → member đã CHẤP NHẬN lời mời → set status='active'
    #                        (+ joined_at nếu chưa có). Đây là mục tiêu chính.
    #   found_in='pending' → vẫn đang chờ → giữ pending, chỉ chạm last_synced_at.
    #   found_in='none'    → KHÔNG thấy ở cả 2 tab → CHỈ báo (giữ result để
    #                        dashboard hiển thị "email không tồn tại trong
    #                        workspace") + ĐÁNH DẤU `sync_missing_at` để mở khoá
    #                        "Mời lại" (member ghi active nhưng thực tế đã rời
    #                        workspace — xem reinvite_member); KHÔNG mark removed
    #                        (tránh xoá oan khi scan sót row trên list lớn — cùng
    #                        bài học mục đầu file).
    if item.type == "SYNC_MEMBER" and effective_status == "COMPLETED":
        target_email = ((item.payload or {}).get("email") or "").lower()
        found_in = ((body.result or {}).get("data") or {}).get("found_in")
        if target_email and found_in in ("active", "pending", "none"):
            member = db.execute(
                select(Member).where(
                    Member.workspace_id == workspace.id,
                    Member.email == target_email,
                )
            ).scalar_one_or_none()
            if member:
                now = datetime.now(timezone.utc)
                member.last_synced_at = now
                # Thấy lại → xoá cờ "sync không thấy"; không thấy → đóng dấu now.
                member.sync_missing_at = now if found_in == "none" else None
                if found_in == "active" and member.status != "active":
                    member.status = "active"
                    if member.joined_at is None:
                        member.joined_at = now
                    # Hồi sinh từ 'removed' → xoá stale removed_at (kẻo dính job
                    # hard-delete 90 ngày dù member đang active) — khớp reconcile.py.
                    if member.removed_at is not None:
                        member.removed_at = None
                        member.removed_reason = None
                    log_event(
                        db,
                        actor_type="EXTENSION",
                        actor_label=f"workspace:{workspace.name}",
                        action="MEMBER_SYNC_PROMOTED_ACTIVE",
                        result="COMPLETED",
                        target_type="MEMBER",
                        target_id=str(member.id),
                        # `queue_item_id`: để nhật ký gom MỌI email của CÙNG một
                        # lệnh đồng bộ về MỘT dòng. Thiếu trường này thì mỗi email
                        # thành một dòng riêng — mẻ 12 email đẻ 12 dòng (ảnh user
                        # 28/8/2026, mốc 15:38).
                        data={
                            "email": target_email,
                            "found_in": found_in,
                            "queue_item_id": str(item.id),
                        },
                        commit=False,
                    )
                    promoted_active_emails.append(target_email)
                # KHÔNG thấy email ở đâu ⇒ chốt lời mời đang treo là HỎNG + hoàn
                # phí NGAY (member bị xoá → không đụng gì nữa). Xem
                # close_invite_defer_with_missing_evidence.
                closed_missing = close_invite_defer_with_missing_evidence(
                    db,
                    member,
                    workspace_name=workspace.name,
                    found_in=found_in,
                    now=now,
                )
                if not closed_missing:
                    # Thấy email trong ChatGPT ⇒ đóng "chờ xác minh" của lời mời
                    # đang treo (nếu có) — xem close_invite_defer_with_sync_evidence.
                    close_invite_defer_with_sync_evidence(
                        db,
                        member,
                        workspace_name=workspace.name,
                        found_in=found_in,
                    )
                    db.add(member)

    # SYNC_MEMBERS_BATCH COMPLETED → "đồng bộ hàng loạt" reconcile theo MẢNG
    # `result.data.results` = [{email, found_in}]. Cùng ngữ nghĩa với SYNC_MEMBER
    # nhưng áp cho nhiều email trong 1 task (extension quét tab Lời mời 1 lần rồi
    # đối chiếu). found_in='active' → set active + joined_at; 'pending' → giữ,
    # chạm last_synced_at; 'none' → CHỈ báo + đóng dấu `sync_missing_at` (mở khoá
    # "Mời lại"), KHÔNG mark removed (an toàn khi scan sót row — bài học đầu file).
    if item.type == "SYNC_MEMBERS_BATCH" and effective_status == "COMPLETED":
        results = ((body.result or {}).get("data") or {}).get("results") or []
        now = datetime.now(timezone.utc)
        for entry in results:
            if not isinstance(entry, dict):
                continue
            email = (entry.get("email") or "").lower()
            found_in = entry.get("found_in")
            if not email or found_in not in ("active", "pending", "none"):
                continue
            member = db.execute(
                select(Member).where(
                    Member.workspace_id == workspace.id,
                    Member.email == email,
                )
            ).scalar_one_or_none()
            if not member:
                continue
            member.last_synced_at = now
            # Thấy lại → xoá cờ "sync không thấy"; không thấy → đóng dấu now.
            member.sync_missing_at = now if found_in == "none" else None
            if found_in == "active" and member.status != "active":
                member.status = "active"
                if member.joined_at is None:
                    member.joined_at = now
                # Hồi sinh từ 'removed' → xoá stale removed_at (kẻo dính job
                # hard-delete 90 ngày dù member đang active) — khớp reconcile.py.
                if member.removed_at is not None:
                    member.removed_at = None
                    member.removed_reason = None
                log_event(
                    db,
                    actor_type="EXTENSION",
                    actor_label=f"workspace:{workspace.name}",
                    action="MEMBER_SYNC_PROMOTED_ACTIVE",
                    result="COMPLETED",
                    target_type="MEMBER",
                    target_id=str(member.id),
                    # Xem ghi chú `queue_item_id` ở nhánh trên.
                    data={
                        "email": email,
                        "found_in": found_in,
                        "batch": True,
                        "queue_item_id": str(item.id),
                    },
                    commit=False,
                )
                promoted_active_emails.append(email)
            # Thấy email trong ChatGPT ⇒ đóng "chờ xác minh" của lời mời đang treo.
            # ĐÂY là mắt xích đã đứt ngày 26/8/2026 — mẻ sync này chính là mẻ mà
            # `defer_unverified_invite` enqueue để đi tìm bằng chứng, mà tìm được
            # rồi lại không ghi nhận. Xem close_invite_defer_with_sync_evidence.
            # Chiều âm: không thấy đâu cả ⇒ chốt hỏng + hoàn phí NGAY (member bị
            # xoá → bỏ qua phần còn lại của email này).
            if close_invite_defer_with_missing_evidence(
                db,
                member,
                workspace_name=workspace.name,
                found_in=found_in,
                now=now,
            ):
                continue
            close_invite_defer_with_sync_evidence(
                db,
                member,
                workspace_name=workspace.name,
                found_in=found_in,
            )
            db.add(member)

    # PHANTOM CLEANUP cho INVITE_MEMBER: xoá Member + Invite records mà ChatGPT
    # KHÔNG thực sự nhận → dashboard chỉ hiển thị email đã được mời thật.
    #
    # Case 1 — FAILED (extension không chạy được, content script lỗi, dialog
    # không mở, etc.): xoá toàn bộ Member + Invite records của queue task này.
    #
    # Case 2 — COMPLETED với verify info: chỉ xoá emails trong unverified_emails
    # (ChatGPT từ chối thầm / email đã active sẵn). Verified emails giữ lại.
    #
    # Case 3 — COMPLETED nhưng verify_scrape_failed=true (extension không
    # scrape được tab pending): GIỮ LẠI tất cả records (không có thông tin để
    # quyết định → safe default), admin tự kiểm tra manual.
    #
    # Chỉ xoá Member records `status='pending'` + `joined_at IS NULL` —
    # đảm bảo không xoá nhầm record đã được sync sang active.
    if item.type == "INVITE_MEMBER" and effective_status == "FAILED":
        # ĐÃ BẤM GỬI mà không xác minh được ⇒ chưa biết hỏng: hoãn phán xử, đi đối
        # chiếu (defer_unverified_invite). ChatGPT tự báo lỗi trong dialog thì đó là
        # bằng chứng dương rằng lời mời KHÔNG đi → hoàn phí ngay như cũ.
        fail_result = body.result if isinstance(body.result, dict) else {}
        submitted_unverified = (
            fail_result.get("submit_clicked") is True
            and not fail_result.get("chatgpt_error_hint")
        )
        deferred = submitted_unverified and defer_unverified_invite(
            db,
            item,
            workspace_id=workspace.id,
            workspace_name=workspace.name,
            error_code=body.error_code,
        )
        # Cả lệnh hỏng → hoàn phí + xoá phantom + ghi timeline FAILED. Logic gom
        # vào reconcile_failed_invite() để đường timeout (execution.py) tái dùng
        # y hệt (trước đây timeout bỏ qua → "thất bại nửa vời").
        if not deferred:
            failure = reconcile_failed_invite(
                db,
                item,
                workspace_id=workspace.id,
                workspace_name=workspace.name,
                error_code=body.error_code,
            )
            _stamp_invite_outcome(
                item,
                failed=failure.failed,
                refunded=failure.refunded,
                seat_credit=failure.seat_credit,
                reason_code=body.error_code,
            )
        else:
            # Hoãn phán xử = CHƯA hỏng: banner phải nói "chưa xác minh", không được
            # nhuộm đỏ một lời mời có thể đã tới hộp thư người nhận.
            _stamp_invite_outcome(
                item,
                pending_verify=sorted(_invite_task_emails(item)),
                reason_code=body.error_code,
            )
    elif item.type == "INVITE_MEMBER" and effective_status == "COMPLETED":
        result_dict = body.result or {}
        verify_failed = bool(result_dict.get("verify_scrape_failed"))
        # EMAIL CHƯA HỀ VÀO ĐƯỢC Ô MỜI (extension khai, xem execute-invite-inner):
        # hộp thoại đóng giữa chừng hoặc không thêm được dòng nhập → những email này
        # KHÔNG nằm trong cú "Gửi lời mời" nào cả.
        #
        # Đây là bằng chứng DƯƠNG rằng lời mời chưa đi — khác hẳn "đã bấm gửi mà
        # chưa soi lại được". Nên chúng KHÔNG đi đường hoãn-phán-xử: chốt hỏng +
        # hoàn phí NGAY, kể cả khi verify không scrape được. Hoãn ở đây là giam
        # tiền 20 phút cho một việc đã biết chắc kết quả (bug user 30/8/2026: màn
        # hình báo "đã gửi, đang xác nhận" cho email chưa hề được gửi).
        skipped_set = {
            str(e).lower()
            for e in (result_dict.get("skipped_emails") or [])
            if isinstance(e, str) and "@" in e
        }
        emails_to_delete: list[str] = []
        # Email defer (mời tươi < 10′ nhưng CHƯA verify): tách khỏi emails_to_delete để
        # KHÔNG xoá, NHƯNG cũng KHÔNG được coi là verified (bug thuylinhtctbg 2026-07-16:
        # trước đây defer rơi ngược vào verified_now → set joined_at + ghi VERIFIED →
        # "báo thành công oan"). Giữ set riêng để loại khỏi verified_now bên dưới.
        deferred_set: set[str] = set()
        if not verify_failed:
            unverified = result_dict.get("unverified_emails") or []
            if isinstance(unverified, list):
                emails_to_delete = [
                    str(e).lower()
                    for e in unverified
                    if isinstance(e, str) and "@" in e
                ]
        # Gộp email chưa nhập được vào diện chốt hỏng — kể cả nhánh
        # `verify_scrape_failed` (không scrape được KHÔNG xoá được bằng chứng này).
        if skipped_set:
            emails_to_delete = sorted(set(emails_to_delete) | skipped_set)
            log_event(
                db,
                actor_type="EXTENSION",
                actor_label=f"workspace:{workspace.name}",
                action="MEMBER_INVITE_NOT_TYPED",
                result="FAILED",
                target_type="QUEUE_ITEM",
                target_id=str(item.id),
                data={
                    "workspace_id": str(workspace.id),
                    "skipped_emails": sorted(skipped_set),
                    "reason": "khong_nhap_duoc_vao_o_moi",
                },
                commit=False,
            )

        # GUARD 10 PHÚT (fix 2026-07-13 — xem EXPIRY_RULES.md §9 + sync-reconcile-safety):
        # COMPLETED + email lọt "unverified" CÓ THỂ do ChatGPT CHƯA index xong lời mời
        # vừa gửi (trễ vài giây–chục giây), KHÔNG phải mời hỏng. KHÔNG hard-delete
        # member/invite còn TƯƠI (mời < 10 phút) — kẻo xoá oan lời mời THÀNH CÔNG rồi
        # sync tạo lại neo sai ngày import (bug ngocsangung). Để member 'pending',
        # nhường SYNC làm nguồn sự thật.
        if emails_to_delete:
            cutoff = datetime.now(timezone.utc) - timedelta(minutes=10)
            fresh = (
                db.execute(
                    select(Member.email).where(
                        Member.workspace_id == workspace.id,
                        Member.email.in_(emails_to_delete),
                        func.coalesce(Member.last_invited_at, Member.created_at)
                        > cutoff,
                    )
                )
                .scalars()
                .all()
            )
            # Email chưa nhập được thì "mời tươi < 10 phút" không có nghĩa gì —
            # không có lời mời nào để ChatGPT index cả. Loại khỏi diện được hoãn.
            fresh_set = {e.lower() for e in fresh} - skipped_set
            if fresh_set:
                deferred = [e for e in emails_to_delete if e in fresh_set]
                deferred_set = fresh_set
                emails_to_delete = [e for e in emails_to_delete if e not in fresh_set]
                log_event(
                    db,
                    actor_type="SYSTEM",
                    actor_label="system:phantom-cleanup-guard",
                    action="MEMBER_INVITE_CLEANUP_DEFERRED",
                    result="OK",
                    target_type="QUEUE_ITEM",
                    target_id=str(item.id),
                    data={
                        "workspace_id": str(workspace.id),
                        "deferred_emails": deferred,
                        "reason": "fresh_invite_within_10min_defer_to_sync",
                    },
                    commit=False,
                )
                # Báo cáo TRUNG THỰC theo từng member (fix 2026-07-16, bug
                # thuylinhtctbg): trước đây email defer im lặng → timeline dừng ở
                # "Đã mời" → UI thể hiện như đã mời THÀNH CÔNG dù CHƯA xác minh. Ghi
                # sự kiện PENDING gắn member để modal hiện "Chờ xác minh" — nếu lời
                # mời hỏng thật, resolver nền (main.py) sẽ lật FAILED + hoàn phí sau.
                deferred_members = (
                    db.execute(
                        select(Member).where(
                            Member.workspace_id == workspace.id,
                            Member.email.in_([e.lower() for e in deferred]),
                            Member.status == "pending",
                        )
                    )
                    .scalars()
                    .all()
                )
                for dm in deferred_members:
                    log_event(
                        db,
                        actor_type="EXTENSION",
                        actor_label=f"workspace:{workspace.name}",
                        action="MEMBER_INVITE_PENDING_VERIFY",
                        result="PENDING",
                        target_type="MEMBER",
                        target_id=str(dm.id),
                        data={
                            "email": dm.email,
                            "workspace_id": str(workspace.id),
                            "queue_item_id": str(item.id),
                            "reason": "fresh_invite_within_10min_defer_to_sync",
                        },
                        commit=False,
                    )
                # …và ĐI XEM THẬT. Hoãn mà không cử ai đi đối chiếu thì 20′ sau
                # resolver nền chốt hỏng trong mù: nó chỉ tha khi thấy dấu vết một
                # lượt sync SAU mốc hoãn, mà auto-sync chỉ chạy 1 lần/ngày. Đây là
                # đúng lỗ hổng đã hoàn oan 3.960.000đ ngày 28-29/8/2026.
                enqueue_sync_probe(
                    db,
                    workspace_id=workspace.id,
                    emails=[dm.email for dm in deferred_members],
                )

        # ---- TRẠNG THÁI THÀNH CÔNG theo TỪNG member (gắn timeline) ----
        # Ghi MEMBER_INVITE_VERIFIED gắn member.id + set joined_at = LẦN VERIFIED
        # ĐẦU TIÊN.
        #   - "Thành công" = email VERIFIED (có trong tab Lời mời HOẶC Người dùng —
        #     email unverified sẽ bị phantom cleanup xoá BÊN DƯỚI).
        #   - verify_scrape_failed → CHƯA xác minh được → KHÔNG chấm thành công (giữ
        #     record pending, timeline vẫn PENDING cho tới khi SYNC xác nhận).
        # ⚠️ Phải chạy TRƯỚC phantom cleanup (delete bên dưới) để member còn tồn tại.
        # Nguồn email dùng `payload` (sống sót qua cleanup, khác Invite đã bị xoá).
        inv_payload = item.payload or {}
        if isinstance(inv_payload.get("emails"), list):
            task_emails = {
                str(e).lower()
                for e in inv_payload["emails"]
                if isinstance(e, str) and "@" in e
            }
        elif isinstance(inv_payload.get("email"), str):
            task_emails = {inv_payload["email"].lower()}
        else:
            task_emails = set()

        verified_now: set[str] = set()
        if not verify_failed:
            # Verified = có mặt thật; loại CẢ email sẽ xoá LẪN email defer (chưa biết
            # kết quả → không được chấm thành công, tránh set joined_at + VERIFIED oan).
            verified_now = (
                task_emails - {e.lower() for e in emails_to_delete} - deferred_set
            )

        now_terminal = datetime.now(timezone.utc)
        for email in sorted(verified_now):
            member = db.execute(
                select(Member).where(
                    Member.workspace_id == workspace.id,
                    Member.email == email,
                    Member.status.in_(("pending", "active")),
                )
            ).scalar_one_or_none()
            if member is None:
                continue  # member không còn (đã removed/không tồn tại) → bỏ qua
            if member.joined_at is None:
                # joined_at = lần thành công ĐẦU TIÊN; KHÔNG ghi đè nếu đã có
                # (mời lại / sync trước đó đã ghi nhận) → giữ mốc thành công đầu.
                member.joined_at = now_terminal
                db.add(member)
            log_event(
                db,
                actor_type="EXTENSION",
                actor_label=f"workspace:{workspace.name}",
                action="MEMBER_INVITE_VERIFIED",
                result="COMPLETED",
                target_type="MEMBER",
                target_id=str(member.id),
                data={
                    "email": email,
                    "workspace_id": str(workspace.id),
                    "queue_item_id": str(item.id),
                    "verified_at": now_terminal.isoformat(),
                    "error_code": body.error_code,
                },
                commit=False,
            )

        # Xoá bản ghi "ma" nằm SAU hoàn phí + void (đảo thứ tự 2026-08-27) — xem
        # `_delete_phantom_members`: xoá trước thì kỳ ĐÃ TRẢ cascade đi mất.
        # HOÀN PHÍ VÍ (feature 003) cho email COMPLETED nhưng KHÔNG verify được
        # (unverified). verify_scrape_failed → không xoá/không hoàn. Idempotent qua
        # cột `reversed`. No-op nếu task không có giao dịch invite_fee (non-beta).
        refunded_emails: list[str] = []
        if emails_to_delete:
            refunded = wallet_service.refund_invite(
                db, item.id, emails=emails_to_delete
            )
            refunded_emails = sorted({e.lower() for e in refunded.emails})
            # Hoàn phí ⇒ void kỳ đã trả (phantom joined_at != NULL sống sót bộ lọc
            # xoá bên dưới vẫn phải mất "hạn ma"). Void theo `refunded.emails` —
            # email KHÔNG được hoàn đồng nào thì kỳ hạn của họ do task khác trả,
            # cắt là cướp hạn (ca thật 23/8, xem reconcile_failed_invite).
            from app.routers.members._shared import (
                flag_refunded_invite_debt,
                void_refunded_invite_periods,
            )

            void_refunded_invite_periods(
                db,
                workspace_id=workspace.id,
                emails=refunded.emails,
                now=now_terminal,
            )
            # Member `active` không bị void đụng tới → đánh dấu nợ + báo động.
            if refunded:
                _flag_refund_debt(
                    db,
                    flag_refunded_invite_debt,
                    workspace_id=workspace.id,
                    workspace_name=workspace.name,
                    emails=refunded.emails,
                    item_id=item.id,
                    now=now_terminal,
                )
            # GIỜ mới xoá: kỳ sống sót void = tiền chưa được hoàn ⇒ giữ bản ghi.
            _delete_phantom_members(
                db,
                workspace_id=workspace.id,
                emails=emails_to_delete,
                now=now_terminal,
                queue_item_id=item.id,
            )
            db.execute(
                delete(Invite).where(
                    Invite.queue_item_id == item.id,
                    Invite.email.in_(emails_to_delete),
                )
            )

        # Kết cục từng email cho banner kết quả. `verify_scrape_failed` = không đọc
        # được tab Lời mời ⇒ KHÔNG biết gì về email nào cả, cả mẻ vào nhóm "chưa xác
        # minh" (đúng sự thật) thay vì mặc định xanh.
        _stamp_invite_outcome(
            item,
            invited=sorted(verified_now),
            failed=sorted(emails_to_delete),
            pending_verify=sorted(
                (task_emails - skipped_set) if verify_failed else deferred_set
            ),
            refunded=refunded_emails,
            # Lệnh COMPLETED không mang mã lỗi nào; nhóm hỏng ở đây (nếu có) là các
            # email chưa nhập được, nên nói đúng nguyên nhân thay vì câu chung.
            reason_code="INVITE_NOT_TYPED" if skipped_set else None,
        )

    # SYNC_BILLING chỉ chạy khi user chủ động trigger từ dashboard (WorkspaceLayout
    # "Cập nhật giá & ngày renew" / Workspaces list "Sync billing"). Extension
    # popup KHÔNG có button trigger (v0.6.11 — popup tự re-fetch whoami khi
    # SYNC_BILLING từ dashboard hoàn tất). Không auto-chain sau INVITE/REMOVE.
    log_event(
        db,
        actor_type="EXTENSION",
        actor_label=f"workspace:{workspace.name}",
        action=f"QUEUE_UPDATED:{item.type}"
        + (":RECONCILED" if reconcile_note else ""),
        result=effective_status
        if effective_status in ("COMPLETED", "FAILED")
        else "PENDING",
        target_type="QUEUE_ITEM",
        target_id=str(item.id),
        data={
            "status": effective_status,
            "error_code": body.error_code,
            "error_message": body.error_message,
            "reconciled": bool(reconcile_note),
            # Kết quả đồng bộ: số member được nâng pending→active + email (để tab
            # "Chính" tóm tắt "Đồng bộ · N đã tham gia" và liệt kê đối tượng). Chỉ
            # gắn khi có, tránh nhiễu data cho task không phải sync.
            **(
                {
                    "promoted_active": len(promoted_active_emails),
                    "promoted_emails": promoted_active_emails,
                }
                if promoted_active_emails
                else {}
            ),
        },
        commit=False,
    )
    db.commit()
    db.refresh(item)
    if auto_purchase_id is not None:
        publish_task_event(
            workspace.id,
            {
                "type": "task-available",
                "task_id": str(auto_purchase_id),
                "task_type": "PURCHASE_SEAT",
            },
        )
    return item
