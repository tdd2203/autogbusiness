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

from datetime import datetime, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    get_session,
    require_extension_workspace,
)
from app.models import Invite, Member, QueueItem, Workspace
from app.schemas import QueueOut, QueueUpdate

from ._shared import router


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

    # ---- REMOVE_MEMBER + MEMBER_NOT_IN_WORKSPACE → coi như đã xoá thành công ----
    # Extension v0.8.19+: REMOVE chỉ định vị bằng Ô LỌC server-side của ChatGPT
    # (KHÔNG còn scroll-scan/lật trang dễ sót). Ô lọc không ra email → member
    # CHẮC CHẮN không còn trong tab Người dùng = đã rời business → convert
    # FAILED→COMPLETED + mark removed ngay (yêu cầu user: "tìm không thấy tức là
    # không có trong business rồi, xoá luôn ở webapp").
    #
    # LỊCH SỬ: hành vi này từng bị BỎ vì bản cũ dùng scroll-scan trên list
    # virtualized → TÌM SÓT row dù member vẫn còn → mark removed NHẦM. Nay an
    # toàn vì:
    #  - error_code RIÊNG MEMBER_NOT_IN_WORKSPACE chỉ phát từ đường ô lọc (đáng
    #    tin), KHÁC UI_ELEMENT_NOT_FOUND của "menu/nút confirm lỗi" (member CÓ
    #    nhưng thao tác hỏng → vẫn để FAILED, KHÔNG xoá).
    #  - Ô lọc query toàn list phía ChatGPT, không phụ thuộc row đã render.
    if (
        body.status == "FAILED"
        and item.type == "REMOVE_MEMBER"
        and body.error_code == "MEMBER_NOT_IN_WORKSPACE"
    ):
        effective_status = "COMPLETED"
        reconcile_note = (
            "Ô lọc ChatGPT không thấy email trong tab Người dùng → coi như đã "
            "rời business, đánh dấu removed ở dashboard."
        )

    # ---- REVOKE_INVITES COMPLETED → mark các email trong payload là removed ----
    # Extension đã click "Thu hồi lời mời" trên ChatGPT thành công cho danh sách
    # email; DB phải khớp theo (status='removed') để dashboard không còn hiển
    # thị các pending record này.
    if body.status == "COMPLETED" and item.type == "REVOKE_INVITES":
        raw_emails = (item.payload or {}).get("emails") or []
        revoke_emails = [
            str(e).strip().lower()
            for e in raw_emails
            if isinstance(e, str) and "@" in e
        ]
        if revoke_emails:
            stale_members = (
                db.execute(
                    select(Member).where(
                        Member.workspace_id == workspace.id,
                        Member.email.in_(revoke_emails),
                        Member.status.in_(("pending", "active")),
                    )
                )
                .scalars()
                .all()
            )
            for member in stale_members:
                member.status = "removed"
                db.add(member)

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

    # REMOVE_MEMBER COMPLETED → sync Member.status='removed' trong DB.
    if (
        item.type == "REMOVE_MEMBER"
        and effective_status == "COMPLETED"
    ):
        payload = item.payload or {}
        target_email = (payload.get("email") or "").lower()
        if target_email:
            member = db.execute(
                select(Member).where(
                    Member.workspace_id == workspace.id,
                    Member.email == target_email,
                )
            ).scalar_one_or_none()
            if member and member.status != "removed":
                member.status = "removed"
                db.add(member)
                log_event(
                    db,
                    actor_type="EXTENSION",
                    actor_label=f"workspace:{workspace.name}",
                    action="MEMBER_REMOVED_SYNCED",
                    result="COMPLETED",
                    target_type="MEMBER",
                    target_id=str(member.id),
                    data={"email": target_email},
                    commit=False,
                )

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
    if item.type == "INVITE_MEMBER":
        emails_to_delete: list[str] = []
        if effective_status == "FAILED":
            invites = (
                db.execute(
                    select(Invite).where(Invite.queue_item_id == item.id)
                )
                .scalars()
                .all()
            )
            emails_to_delete = [inv.email.lower() for inv in invites]
        elif effective_status == "COMPLETED":
            result_dict = body.result or {}
            verify_failed = bool(result_dict.get("verify_scrape_failed"))
            if not verify_failed:
                unverified = result_dict.get("unverified_emails") or []
                if isinstance(unverified, list):
                    emails_to_delete = [
                        str(e).lower()
                        for e in unverified
                        if isinstance(e, str) and "@" in e
                    ]

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
        },
        commit=False,
    )
    db.commit()
    db.refresh(item)
    return item
