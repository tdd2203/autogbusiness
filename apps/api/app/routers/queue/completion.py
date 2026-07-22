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
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    get_session,
    require_extension_workspace,
)
from app.models import AuditLog, Invite, Member, QueueItem, Workspace
from app.schemas import QueueOut, QueueUpdate
from app.services import wallet_service

from ._shared import router


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
         no-op nếu task không có giao dịch — user non-beta).

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
    wallet_service.refund_invite(db, item.id, emails=None)

    # 4. Hoàn phí ⇒ void kỳ đã trả cho MỌI member còn sống của task (phantom nào
    #    joined_at != NULL không bị xoá ở bước 2 vẫn phải mất "hạn ma" → không cho
    #    mời lại miễn phí oan). Xem void_refunded_invite_periods / bug thuylinhtctbg.
    from app.routers.members._shared import void_refunded_invite_periods

    void_refunded_invite_periods(
        db, workspace_id=workspace_id, emails=sorted(task_emails), now=now_terminal
    )


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

    reconcile_note: str | None = None
    effective_status = body.status
    # REMOVE_MEMBER chỉ được mark removed khi CÓ BẰNG CHỨNG DƯƠNG member đã thực sự
    # rời ChatGPT: `result.data.verified === true`. Extension (>= v0.9.23) phát tín
    # hiệu này qua ĐÚNG HAI đường, cả hai đều là bằng chứng dương:
    #   1. Tìm thấy row → click xoá → POLL thấy row BIẾN MẤT.
    #   2. `data.absent === true` — lọc tab "Người dùng" không ra email VÀ đã chứng
    #      minh ô lọc còn sống (clear lọc thấy member khác → gõ lại vẫn trống). Đúng
    #      nghiệp vụ: không có trong business thì coi như đã gỡ xong (user
    #      2026-07-22) — xem `confirmAbsenceViaFilter` bên extension.
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
            for member in stale_members:
                member.status = "removed"
                member.removed_at = revoked_at
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
                if expired_init:
                    remove_data["removal_reason"] = "expired"
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
    #                        workspace"); KHÔNG mark removed (tránh xoá oan khi
    #                        scan sót row trên list lớn — cùng bài học mục đầu file).
    if item.type == "SYNC_MEMBER" and effective_status == "COMPLETED":
        target_email = ((item.payload or {}).get("email") or "").lower()
        found_in = ((body.result or {}).get("data") or {}).get("found_in")
        if target_email and found_in in ("active", "pending"):
            member = db.execute(
                select(Member).where(
                    Member.workspace_id == workspace.id,
                    Member.email == target_email,
                )
            ).scalar_one_or_none()
            if member:
                now = datetime.now(timezone.utc)
                member.last_synced_at = now
                if found_in == "active" and member.status != "active":
                    member.status = "active"
                    if member.joined_at is None:
                        member.joined_at = now
                    # Hồi sinh từ 'removed' → xoá stale removed_at (kẻo dính job
                    # hard-delete 90 ngày dù member đang active) — khớp reconcile.py.
                    if member.removed_at is not None:
                        member.removed_at = None
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
    # chạm last_synced_at; 'none' → CHỈ báo, KHÔNG mark removed (an toàn khi scan
    # sót row — cùng bài học đầu file).
    if item.type == "SYNC_MEMBERS_BATCH" and effective_status == "COMPLETED":
        results = ((body.result or {}).get("data") or {}).get("results") or []
        now = datetime.now(timezone.utc)
        for entry in results:
            if not isinstance(entry, dict):
                continue
            email = (entry.get("email") or "").lower()
            found_in = entry.get("found_in")
            if not email or found_in not in ("active", "pending"):
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
            if found_in == "active" and member.status != "active":
                member.status = "active"
                if member.joined_at is None:
                    member.joined_at = now
                # Hồi sinh từ 'removed' → xoá stale removed_at (kẻo dính job
                # hard-delete 90 ngày dù member đang active) — khớp reconcile.py.
                if member.removed_at is not None:
                    member.removed_at = None
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
        # Cả lệnh hỏng → hoàn phí + xoá phantom + ghi timeline FAILED. Logic gom
        # vào reconcile_failed_invite() để đường timeout (execution.py) tái dùng
        # y hệt (trước đây timeout bỏ qua → "thất bại nửa vời").
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
            wallet_service.refund_invite(db, item.id, emails=emails_to_delete)
            # Hoàn phí ⇒ void kỳ đã trả (phantom joined_at != NULL sống sót bộ lọc
            # xoá bên trên vẫn phải mất "hạn ma"). Xem void_refunded_invite_periods.
            from app.routers.members._shared import void_refunded_invite_periods

            void_refunded_invite_periods(
                db,
                workspace_id=workspace.id,
                emails=emails_to_delete,
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
    return item
