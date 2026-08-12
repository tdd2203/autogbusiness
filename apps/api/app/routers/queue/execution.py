"""Chức năng: EXTENSION EXECUTION — pick task kế tiếp + báo tiến độ.

⚠️ ĐỌC `execution.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
Docs ghi lịch sử lỗi, business rule và ý tưởng cải tiến — code chỉ là "how".

Các endpoint này do EXTENSION gọi (auth bằng X-API-KEY → require_extension_workspace)
để lấy task PENDING kế tiếp (FIFO) và đẩy progress real-time trong lúc chạy.
Việc báo COMPLETED/FAILED + reconcile DB nằm ở `completion.py`.

Endpoints (đăng ký lên router dùng chung từ `_shared`):
  - GET   /next               → pick_next
  - PATCH /{item_id}/progress → update_progress
"""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    get_session,
    require_extension_workspace,
)
from app.models import QueueItem, Workspace, WorkspaceSettings
from app.schemas import QueueOut, QueueProgressUpdate

from ._shared import router
from .completion import defer_unverified_invite, reconcile_failed_invite


@router.get("/next", response_model=QueueOut | None)
def pick_next(
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> QueueItem | None:
    """Extension polling: lấy 1 task PENDING FIFO trong workspace của API key, đánh dấu IN_PROGRESS.

    Trước khi pick task mới, AUTO-FAIL task IN_PROGRESS bị treo quá ngưỡng (theo
    loại task) trong cùng workspace — extension picked nhưng không trả kết quả
    (service worker MV3 chết giữa chừng, content script crash, tab close, DOM
    treo, …). Lazy cleanup tránh popup hiển thị 'ĐANG CHẠY' mãi mãi + cho phép
    task tiếp theo chạy.

    Ngưỡng treo theo LOẠI task (`STUCK_THRESHOLDS`) thay cho 5 phút cứng (tồn
    đọng #4 trong execution.md): UI ops nhanh (invite/remove/role ~30-80s thực
    tế) chỉ cần 3 phút → task chết được dọn nhanh, không chiếm dashboard 5 phút;
    còn task dài (SYNC_DATA lật nhiều trang ~137s, PURCHASE_SEAT chain Stripe/
    Link) giữ ngưỡng cao hơn để KHÔNG bị auto-fail oan khi đang chạy thật.
    """
    from datetime import timedelta

    # Ngưỡng treo theo loại task. Tính từ p50/max thực đo (xem execution.md mục 5):
    # INVITE max 79s, SYNC_DATA max 137s, các UI op khác <45s. Ngưỡng để dư buffer
    # trên max thực nhưng vẫn thấp hơn nhiều so với 5 phút cũ.
    STUCK_THRESHOLDS = {
        "INVITE_MEMBER": timedelta(minutes=3),
        "REMOVE_MEMBER": timedelta(minutes=3),
        "CHANGE_ROLE": timedelta(minutes=3),
        "CHANGE_LICENSE_TYPE": timedelta(minutes=3),
        "SET_USAGE_LIMIT": timedelta(minutes=3),
        "REVOKE_INVITES": timedelta(minutes=3),
        # Xuất/Xoá dữ liệu: cùng lớp UI-op với remove (lọc email → menu → dialog).
        "EXPORT_MEMBER_DATA": timedelta(minutes=3),
        "DELETE_MEMBER_DATA": timedelta(minutes=3),
        # SYNC_MEMBER: tìm 1 email ở tab Lời mời rồi fallback lật trang tab Người
        # dùng (như remove) → cho 4 phút (giữa UI-op 3' và SYNC_DATA full 6').
        "SYNC_MEMBER": timedelta(minutes=4),
        "SYNC_BILLING": timedelta(minutes=4),
        # Batch quét TOÀN BỘ tab Lời mời 1 lần + check N email còn lại ở tab Người
        # dùng → cùng ngân sách với full-sync (extension content timeout 330s).
        "SYNC_MEMBERS_BATCH": timedelta(minutes=6),
        "SYNC_DATA": timedelta(minutes=6),
        "HARVEST_LABELS": timedelta(minutes=6),
        "PURCHASE_SEAT": timedelta(minutes=8),
    }
    DEFAULT_STUCK_THRESHOLD = timedelta(minutes=5)
    now = datetime.now(timezone.utc)
    # Lấy mọi task IN_PROGRESS rồi lọc theo ngưỡng riêng của từng loại (số task
    # IN_PROGRESS đồng thời rất nhỏ nên filter ở Python không tốn kém).
    in_progress = (
        db.execute(
            select(QueueItem).where(
                QueueItem.workspace_id == workspace.id,
                QueueItem.status == "IN_PROGRESS",
                QueueItem.picked_at.is_not(None),
            )
        )
        .scalars()
        .all()
    )
    stuck_tasks = [
        t
        for t in in_progress
        if t.picked_at is not None
        and now - t.picked_at
        > STUCK_THRESHOLDS.get(t.type, DEFAULT_STUCK_THRESHOLD)
    ]
    for stuck in stuck_tasks:
        age_sec = int((now - stuck.picked_at).total_seconds()) if stuck.picked_at else None
        threshold = STUCK_THRESHOLDS.get(stuck.type, DEFAULT_STUCK_THRESHOLD)
        threshold_min = int(threshold.total_seconds() // 60)
        stuck.status = "FAILED"
        stuck.error_code = "TIMEOUT"
        stuck.error_message = (
            f"Task IN_PROGRESS quá {threshold_min} phút ({age_sec}s) — extension "
            f"không trả kết quả. Auto-cleanup lúc pick task tiếp theo."
        )
        stuck.completed_at = now
        db.add(stuck)
        log_event(
            db,
            actor_type="SYSTEM",
            actor_label="lazy-cleanup",
            action=f"QUEUE_TIMEOUT:{stuck.type}",
            result="FAILED",
            target_type="QUEUE_ITEM",
            target_id=str(stuck.id),
            data={"age_sec": age_sec, "workspace_id": str(workspace.id)},
            commit=False,
        )
        # ⚠️ INVITE_MEMBER timeout PHẢI reconcile (trước đây chỉ set status=FAILED →
        # "thất bại nửa vời": tiền kẹt + member kẹt 'pending' + timeline vẫn "Đã mời").
        #
        # NHƯNG reconcile ở đây là HOÃN PHÁN XỬ, không phải chốt hỏng (sửa 12/8/2026):
        # timeout nghĩa là extension CHẾT IM LẶNG — không ai biết nó đã bấm "Gửi lời
        # mời" hay chưa. Đúng cái ca không có report nào để mang cờ `submit_clicked`
        # xuống, tức lỗ hổng còn lại của 2 ca mất tiền 12/8. Chốt hỏng ở đây là ĐOÁN:
        # đoán sai một lần = một ghế dùng miễn phí vĩnh viễn.
        #
        # Vì sao hoãn LUÔN AN TOÀN về tiền (khác với chốt hỏng): hoãn KHÔNG bao giờ
        # làm mất tiền, chỉ làm tiền về ví MUỘN hơn. Cả hai kịch bản đều kết đúng:
        #   - Đã bấm Gửi rồi chết → đồng bộ/tham gia lộ ra trong 20′ ⇒ member 'active',
        #     phí giữ nguyên (trước đây: hoàn phí + xoá bản ghi = mất trắng).
        #   - Chưa bấm Gửi → không ai thấy email ⇒ `_resolve_stale_pending_invites_once`
        #     (main.py) hoàn phí + xoá phantom ở mốc 20′ thay vì 3′.
        # Giá phải trả: tiền của đại lý bị giam thêm ~17 phút cho lời mời hỏng thật.
        # Đây là đánh đổi đã được chủ hệ thống chốt 12/8/2026.
        if stuck.type == "INVITE_MEMBER":
            if not defer_unverified_invite(
                db,
                stuck,
                workspace_id=workspace.id,
                workspace_name=workspace.name,
                error_code="TIMEOUT",
            ):
                # Không còn member nào sống để theo dõi → hoãn chỉ là giam tiền mà
                # không ai đối chiếu → chốt hỏng + hoàn phí ngay như cũ.
                reconcile_failed_invite(
                    db,
                    stuck,
                    workspace_id=workspace.id,
                    workspace_name=workspace.name,
                    error_code="TIMEOUT",
                )
    if stuck_tasks:
        db.commit()

    item = (
        db.execute(
            select(QueueItem)
            .where(
                QueueItem.status == "PENDING",
                QueueItem.workspace_id == workspace.id,
                # Task chờ super-admin duyệt (approval_status='pending') KHÔNG được
                # pick. NULL (không cần duyệt) hoặc 'approved' mới chạy.
                or_(
                    QueueItem.approval_status.is_(None),
                    QueueItem.approval_status == "approved",
                ),
            )
            .order_by(QueueItem.created_at.asc())
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        .scalars()
        .first()
    )
    if not item:
        return None
    item.status = "IN_PROGRESS"
    item.picked_at = datetime.now(timezone.utc)
    db.add(item)
    log_event(
        db,
        actor_type="EXTENSION",
        actor_label=f"workspace:{workspace.name}",
        action=f"QUEUE_PICKED:{item.type}",
        result="PENDING",
        target_type="QUEUE_ITEM",
        target_id=str(item.id),
        commit=False,
    )
    db.commit()
    db.refresh(item)
    # ---- DRY-RUN: báo extension BỎ QUA thao tác thật ----
    # `dry_run_mode` nằm ở bảng WorkspaceSettings (không có row = mặc định False).
    # Đính cờ vào payload của RESPONSE để extension short-circuit task phá huỷ
    # (invite/remove/change-role/...). Dùng expunge để KHÔNG persist thay đổi này
    # vào DB — payload gốc của task giữ nguyên (nguồn sự thật không đổi).
    settings = db.get(WorkspaceSettings, workspace.id)
    if settings is not None and settings.dry_run_mode:
        item.payload = {**(item.payload or {}), "dry_run": True}
        db.expunge(item)
    return item


@router.patch("/{item_id}/progress", response_model=QueueOut)
def update_progress(
    item_id: UUID,
    body: QueueProgressUpdate,
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> QueueItem:
    """Extension báo progress real-time, KHÔNG audit log từng tick (tránh spam)."""
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
    item.progress = _merge_progress_history(item.progress, body.progress)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


# Trần số mốc phase giữ lại trong progress.history (1 task không có lý do vượt
# vài chục transition; cap để JSONB không phình nếu extension báo phase lạ liên tục).
_MAX_PHASE_HISTORY = 100


def _merge_progress_history(prev: dict | None, incoming: dict) -> dict:
    """Gộp snapshot progress mới + lịch sử phase (timeline) để dashboard tính được
    THỜI GIAN từng giai đoạn — admin dùng dữ liệu này tối ưu tốc độ chạy.

    `progress` là 1 snapshot bị GHI ĐÈ mỗi tick. Ta giữ thêm `history`: list mốc
    `{phase, at}` (giờ SERVER, ISO-8601) — CHỈ append khi `phase` ĐỔI so với mốc
    cuối (tick cùng phase chỉ cập nhật snapshot, không thêm mốc → tránh phình).
    Thời lượng 1 phase = `at` mốc kế − `at` mốc này (mốc cuối: tới `completed_at`
    hoặc hiện tại). Không thêm cột DB → không cần migration.
    """
    merged = dict(incoming)
    history = list((prev or {}).get("history") or [])
    phase = incoming.get("phase")
    if phase and (not history or history[-1].get("phase") != phase):
        history.append(
            {"phase": str(phase), "at": datetime.now(timezone.utc).isoformat()}
        )
        if len(history) > _MAX_PHASE_HISTORY:
            history = history[-_MAX_PHASE_HISTORY:]
    merged["history"] = history
    return merged
