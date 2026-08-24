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
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    get_session,
    require_extension_workspace,
)
from app.models import (
    REMOVED_REASON_BY_ADMIN,
    REMOVED_REASON_EXPIRED,
    REMOVED_REASON_INVITE_REVOKED,
    AuditLog,
    Invite,
    Member,
    QueueItem,
    Workspace,
)
from app.schemas import QueueOut, QueueUpdate
from app.services import wallet_service
from app.sse import publish_task_event

from ._shared import router


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


def reconcile_failed_invite(
    db: Session,
    item: QueueItem,
    *,
    workspace_id: UUID,
    workspace_name: str,
    error_code: str | None = None,
) -> None:
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

    # 2. Xoá Member + Invite phantom (chỉ pending chưa join).
    invites = (
        db.execute(select(Invite).where(Invite.queue_item_id == item.id))
        .scalars()
        .all()
    )
    emails_to_delete = [inv.email.lower() for inv in invites]
    if emails_to_delete:
        db.execute(
            delete(Member).where(
                Member.workspace_id == workspace_id,
                Member.email.in_(emails_to_delete),
                Member.status == "pending",
                Member.joined_at.is_(None),
            )
        )
        db.execute(
            delete(Invite).where(
                Invite.queue_item_id == item.id,
                Invite.email.in_(emails_to_delete),
            )
        )

    # 3. Hoàn toàn bộ phí invite_fee của task.
    refunded = wallet_service.refund_invite(db, item.id, emails=None)

    # 3b. …VÀ phí còn treo của lời mời TRƯỚC ĐÓ cùng email (đường "chờ xác minh").
    #     Phí đi theo TASK nhưng kết luận "hỏng" đi theo EMAIL — task này vừa chốt
    #     hỏng cho các email đó thì khoản treo kia cũng hết cửa thành công. Không
    #     làm ở đây thì resolver 20′ sẽ bỏ qua vĩnh viễn (member vừa bị xoá ở bước 2
    #     + audit FAILED vừa ghi ở bước 1 khớp đúng 2 điều kiện SKIP của nó) — ca
    #     thật 22/8/2026, xem docstring `_refund_stranded_deferred_fees`.
    stranded = _refund_stranded_deferred_fees(
        db,
        workspace_id=workspace_id,
        emails=task_emails,
        exclude_item_id=item.id,
    )
    if stranded:
        refunded = wallet_service.InviteRefund(
            refunded.total_vnd + stranded.total_vnd,
            sorted(set(refunded.emails) | set(stranded.emails)),
        )

    # 4. Hoàn phí ⇒ void kỳ đã trả — CHỈ cho email THỰC SỰ có tiền quay về ví lượt
    #    này (`refunded.emails`), KHÔNG phải mọi email trong payload task. Phantom nào
    #    joined_at != NULL không bị xoá ở bước 2 vẫn phải mất "hạn ma" → không cho
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
    # 5. Member đã `active` thì bước 4 KHÔNG đụng tới (void = xoá hạn = tặng vô thời
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

    # Dedup: đã có mẻ SYNC_MEMBERS_BATCH đang chờ/đang chạy → nó sẽ tự gom email
    # pending, không cần chồng thêm task.
    existing = db.execute(
        select(QueueItem.id)
        .where(
            QueueItem.workspace_id == workspace_id,
            QueueItem.type == "SYNC_MEMBERS_BATCH",
            QueueItem.status.in_(("PENDING", "IN_PROGRESS")),
        )
        .limit(1)
    ).first()
    if existing is None:
        # created_by_id=None: task của HỆ THỐNG, không ăn suất cooldown sync của
        # admin phụ (cùng lối `_enqueue_periodic_sync_once`).
        db.add(
            QueueItem(
                type="SYNC_MEMBERS_BATCH",
                status="PENDING",
                workspace_id=workspace_id,
                payload={"emails": sorted(m.email.lower() for m in pending_members)},
                created_by_id=None,
            )
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
# ĐƯỢC NHẬN — GPT1 có `lucrativoa2@gmail.com` treo 11 ngày, hạn thuê bao còn 3
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
                if expired_init:
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
                        data={"email": target_email, "found_in": found_in},
                        commit=False,
                    )
                    promoted_active_emails.append(target_email)
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
                    data={"email": email, "found_in": found_in, "batch": True},
                    commit=False,
                )
                promoted_active_emails.append(email)
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
            reconcile_failed_invite(
                db,
                item,
                workspace_id=workspace.id,
                workspace_name=workspace.name,
                error_code=body.error_code,
            )
    elif item.type == "INVITE_MEMBER" and effective_status == "COMPLETED":
        result_dict = body.result or {}
        verify_failed = bool(result_dict.get("verify_scrape_failed"))
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
            fresh_set = {e.lower() for e in fresh}
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

        if emails_to_delete:
            db.execute(
                delete(Member).where(
                    Member.workspace_id == workspace.id,
                    Member.email.in_(emails_to_delete),
                    Member.status == "pending",
                    Member.joined_at.is_(None),
                )
            )
            db.execute(
                delete(Invite).where(
                    Invite.queue_item_id == item.id,
                    Invite.email.in_(emails_to_delete),
                )
            )

        # HOÀN PHÍ VÍ (feature 003) cho email COMPLETED nhưng KHÔNG verify được
        # (unverified). verify_scrape_failed → không xoá/không hoàn. Idempotent qua
        # cột `reversed`. No-op nếu task không có giao dịch invite_fee (non-beta).
        if emails_to_delete:
            refunded = wallet_service.refund_invite(
                db, item.id, emails=emails_to_delete
            )
            # Hoàn phí ⇒ void kỳ đã trả (phantom joined_at != NULL sống sót bộ lọc
            # xoá bên trên vẫn phải mất "hạn ma"). Void theo `refunded.emails` —
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
