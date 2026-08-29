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

from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, Query, status
from sqlalchemy import or_, select, text
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    get_session,
    require_extension_workspace,
)
from app.models import QueueItem, Workspace, WorkspaceSettings
from app.schemas import QueueOut, QueueProgressUpdate
from app.services import task_merge

from ._shared import router
from .completion import defer_unverified_invite, reconcile_failed_invite

# Task còn BÁO NHỊP (progress tick) thì chưa phải task chết — nhưng cũng không
# được sống mãi: trần tuyệt đối = ngưỡng của loại task × hệ số này, tính từ
# `picked_at`. Extension kẹt trong một vòng lặp vẫn báo phase sẽ bị dọn ở mốc đó.
_ALIVE_HARD_CAP = 2


def _progress_beat_at(progress: dict | None) -> datetime | None:
    """Mốc tick tiến độ GẦN NHẤT extension gửi (`progress.at`, giờ server ISO-8601).

    `update_progress` đóng dấu mốc này ở MỌI tick — khác `progress.history` vốn chỉ
    thêm mốc khi phase ĐỔI, nên một bước chờ dài (mua suất chờ ChatGPT xử lý giao
    dịch) không để lại dấu vết nào trong history dù extension vẫn báo nhịp đều.
    """
    raw = (progress or {}).get("at")
    if not isinstance(raw, str):
        return None
    try:
        beat = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return beat if beat.tzinfo else beat.replace(tzinfo=timezone.utc)


def stuck_verdict(
    picked_at: datetime,
    progress: dict | None,
    now: datetime,
    threshold: timedelta,
) -> tuple[bool, str, int, int]:
    """Task IN_PROGRESS này coi là TREO chưa? → (treo?, lý do, giây im lặng, giây tổng).

    Ngưỡng đếm từ mốc SỐNG GẦN NHẤT (`max(picked_at, tick tiến độ cuối)`), không
    phải từ `picked_at`.

    ⚠️ CA THẬT 26/8/2026 (3 lệnh mời phải mua suất — fdeeadc5, cd03d5ff, 3bc11c7b):
    mua suất chờ ChatGPT xử lý giao dịch tốn ~3,5′, cộng bước mời + xác minh là
    chạm trần 8′ của INVITE_MEMBER ⇒ backend chốt TIMEOUT trong khi extension vẫn
    đang chạy và lời mời ĐÃ đi thật. Đếm theo im lặng thì task còn báo nhịp không
    bị giết oan, mà task chết im (service worker MV3 chết, tab đóng, kênh đứt) vẫn
    bị dọn đúng như cũ — đó mới là thứ ngưỡng này sinh ra để bắt.

    Trần tuyệt đối `threshold × _ALIVE_HARD_CAP` chặn ca extension kẹt trong vòng
    lặp báo nhịp vô tận: hàng đợi chạy tuần tự, một task như thế mà sống mãi là
    chặn mọi lệnh sau nó.
    """
    beat = _progress_beat_at(progress)
    last_alive = max(picked_at, beat) if beat is not None else picked_at
    silent_sec = int((now - last_alive).total_seconds())
    total_sec = int((now - picked_at).total_seconds())
    if now - last_alive > threshold:
        return True, "silent", silent_sec, total_sec
    if now - picked_at > threshold * _ALIVE_HARD_CAP:
        return True, "hard_cap", silent_sec, total_sec
    return False, "alive", silent_sec, total_sec


# Loại lệnh mà MẺ GỘP làm việc TUẦN TỰ từng email (gỡ từng người, thu hồi từng
# lời mời) ⇒ mẻ n lệnh tốn xấp xỉ n lần thời gian. Ngưỡng treo phải nhân theo,
# không thì mẻ đang chạy thật bị dọn giữa chừng.
#
# INVITE_MEMBER CỐ Ý không nằm ở đây: gộp lời mời là gộp vào MỘT lần mở hộp mời,
# thời gian gần như không đổi dù 1 hay 5 email. Nhân ngưỡng cho nó chỉ khiến một
# mẻ mời CHẾT phải nằm chờ gấp mấy lần trước khi được dọn — mà dọn muộn là tiền
# của đại lý về ví muộn.
_MERGE_SEQUENTIAL_TYPES = frozenset({"REMOVE_MEMBER", "REVOKE_INVITES"})


def merged_threshold_factor(item: QueueItem) -> int:
    """Hệ số nhân ngưỡng treo cho lệnh chạy tuần tự nhiều lượt (1 = một lượt).

    Hai nguồn, lấy cái lớn hơn:

    * `merged_size` — ghi lúc pick lên CẢ lệnh dẫn đầu lẫn lệnh được gộp, nên
      lệnh nào trong mẻ cũng có cùng hệ số.
    * số email trong `payload.emails` của `REVOKE_INVITES` — dashboard phát hiện
      lời mời lạ thì gửi MỘT lệnh mang nhiều email (`workspaces/triggers.py`).
      Lệnh đó không phải mẻ gộp nhưng extension vẫn thu hồi tuần tự từng lời
      mời, và từ 29/8/2026 mỗi lời mời còn phải hỏi lại ChatGPT tới 60s trước khi
      dám kết luận (ca ickj886@gmail.com: thu hồi trót lọt mà bị chốt là hỏng vì
      đóng sổ ở giây thứ 12-17). Giữ hệ số 1 cho nó thì ngưỡng 3 phút dọn đúng
      lệnh đang chạy thật.
    """
    if item.type not in _MERGE_SEQUENTIAL_TYPES:
        return 1
    factor = 1
    raw = (item.payload or {}).get("merged_size")
    if isinstance(raw, int) and not isinstance(raw, bool) and raw >= 1:
        factor = raw
    if item.type == "REVOKE_INVITES":
        emails = (item.payload or {}).get("emails")
        if isinstance(emails, list):
            factor = max(
                factor,
                sum(1 for e in emails if isinstance(e, str) and "@" in e),
            )
    return min(max(factor, 1), task_merge.MAX_MERGED_TASKS)


@router.get("/next", response_model=QueueOut | None)
def pick_next(
    merge: bool = Query(
        False,
        description=(
            "Extension có biết chạy MẺ GỘP không (`merged_tasks` trong payload). "
            "Bản cũ không gửi cờ này → backend không bao giờ gộp cho nó."
        ),
    ),
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
    # Ngưỡng treo theo loại task. Tính từ p50/max thực đo (xem execution.md mục 5):
    # INVITE max 79s, SYNC_DATA max 137s, các UI op khác <45s. Ngưỡng để dư buffer
    # trên max thực nhưng vẫn thấp hơn nhiều so với 5 phút cũ.
    STUCK_THRESHOLDS = {
        # INVITE_MEMBER (từ 2026-08-22): trước khi mời, extension kiểm tra số suất
        # còn trống và MUA BÙ nếu thiếu (modal Quản lý suất → Xem lại giao dịch
        # mua → Xác nhận mua). Một lần mua tốn tương đương PURCHASE_SEAT, nên
        # ngưỡng 3' cũ sẽ giết task GIỮA LÚC đang thanh toán → tiền đã trừ mà task
        # báo treo. Nâng ngang PURCHASE_SEAT. Ca mời thường vẫn xong trong ~80s.
        "INVITE_MEMBER": timedelta(minutes=8),
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
    # Ngưỡng đếm từ mốc SỐNG GẦN NHẤT (tick tiến độ cuối), không phải từ `picked_at`
    # — xem `stuck_verdict`. Task còn báo nhịp = còn chạy, giết nó là giết oan.
    stuck_tasks: list[tuple[QueueItem, str, int, int]] = []
    for t in in_progress:
        if t.picked_at is None:
            continue
        verdict, reason, silent_sec, total_sec = stuck_verdict(
            t.picked_at,
            t.progress,
            now,
            STUCK_THRESHOLDS.get(t.type, DEFAULT_STUCK_THRESHOLD)
            * merged_threshold_factor(t),
        )
        if verdict:
            stuck_tasks.append((t, reason, silent_sec, total_sec))
    for stuck, reason, silent_sec, age_sec in stuck_tasks:
        threshold = STUCK_THRESHOLDS.get(
            stuck.type, DEFAULT_STUCK_THRESHOLD
        ) * merged_threshold_factor(stuck)
        threshold_min = int(threshold.total_seconds() // 60)
        stuck.status = "FAILED"
        stuck.error_code = "TIMEOUT"
        stuck.error_message = (
            (
                f"Extension IM LẶNG {silent_sec}s (quá ngưỡng {threshold_min} phút) — "
                f"không báo tiến độ, không trả kết quả. Tổng {age_sec}s kể từ lúc nhận task."
                if reason == "silent"
                else f"Task chạy {age_sec}s — quá trần tuyệt đối "
                f"{threshold_min * _ALIVE_HARD_CAP} phút dù vẫn báo tiến độ (nhịp cuối "
                f"{silent_sec}s trước). Dọn để hàng đợi chạy tiếp."
            )
            + " Auto-cleanup lúc pick task tiếp theo."
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
            data={
                "age_sec": age_sec,
                "silent_sec": silent_sec,
                "timeout_reason": reason,
                "workspace_id": str(workspace.id),
            },
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
    picked_at = datetime.now(timezone.utc)
    item.status = "IN_PROGRESS"
    item.picked_at = picked_at
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

    # ---- GỘP LỆNH CÙNG LOẠI ĐANG CHỜ (user 2026-08-28) ----
    # Kéo thêm các lệnh CÙNG LOẠI, cùng workspace, đang PENDING vào chạy một lượt
    # với lệnh vừa pick. Luật gộp + điều kiện suất nằm ở `services/task_merge.py`.
    #
    # Hai điều bất di bất dịch ở đây:
    #   1. Chỉ gộp khi extension NÓI là biết chạy mẻ (`?merge=1`). Bản cũ nhận mẻ
    #      sẽ chỉ báo kết quả cho lệnh dẫn đầu → các lệnh còn lại kẹt IN_PROGRESS
    #      tới lúc bị dọn vì treo.
    #   2. Payload TRONG DB của từng lệnh KHÔNG bị trộn email của nhau. Danh sách
    #      gộp chỉ nằm trong RESPONSE (`merged_tasks`); mỗi lệnh vẫn tự báo kết
    #      quả của chính nó nên tiền/bản ghi/hoàn phí không xê dịch một ly.
    merged_payload: dict | None = None
    if merge and item.type in task_merge.MERGEABLE_TYPES:
        plan = task_merge.plan_merge(db, item, workspace)
        if plan:
            size = len(plan.tasks)
            child_ids = [str(t.id) for t in plan.followers]
            for follower in plan.followers:
                follower.status = "IN_PROGRESS"
                follower.picked_at = picked_at
                follower.payload = {
                    **(follower.payload or {}),
                    "merged_into": str(item.id),
                    "merged_size": size,
                }
                # Đóng dấu nhịp sống ngay từ lúc pick: lệnh được gộp không tự báo
                # tiến độ, nhịp của nó do lệnh dẫn đầu bơm sang (`update_progress`).
                follower.progress = {
                    **(follower.progress or {}),
                    "at": picked_at.isoformat(),
                    "merged_into": str(item.id),
                }
                db.add(follower)
                log_event(
                    db,
                    actor_type="EXTENSION",
                    actor_label=f"workspace:{workspace.name}",
                    action=f"QUEUE_PICKED:{follower.type}",
                    result="PENDING",
                    target_type="QUEUE_ITEM",
                    target_id=str(follower.id),
                    data={"merged_into": str(item.id)},
                    commit=False,
                )
            item.payload = {
                **(item.payload or {}),
                "merged_children": child_ids,
                "merged_size": size,
            }
            db.add(item)
            log_event(
                db,
                actor_type="EXTENSION",
                actor_label=f"workspace:{workspace.name}",
                action=f"QUEUE_MERGED:{item.type}",
                result="PENDING",
                target_type="QUEUE_ITEM",
                target_id=str(item.id),
                data={
                    "merged_task_ids": child_ids,
                    "merged_size": size,
                    "emails": plan.emails,
                    "seat_need": plan.seat_need,
                    "seat_free": plan.seat_free,
                },
                commit=False,
            )
            merged_payload = task_merge.merged_response_payload(db, item, plan, workspace)

    db.commit()
    db.refresh(item)
    response_payload = merged_payload if merged_payload is not None else None
    # ---- DRY-RUN: báo extension BỎ QUA thao tác thật ----
    # `dry_run_mode` nằm ở bảng WorkspaceSettings (không có row = mặc định False).
    # Đính cờ vào payload của RESPONSE để extension short-circuit task phá huỷ
    # (invite/remove/change-role/...). Dùng expunge để KHÔNG persist thay đổi này
    # vào DB — payload gốc của task giữ nguyên (nguồn sự thật không đổi).
    settings = db.get(WorkspaceSettings, workspace.id)
    if settings is not None and settings.dry_run_mode:
        response_payload = {**(response_payload or item.payload or {}), "dry_run": True}
    if response_payload is not None:
        item.payload = response_payload
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
    _beat_merged_children(db, item)
    db.commit()
    db.refresh(item)
    return item


def _beat_merged_children(db: Session, leader: QueueItem) -> None:
    """Bơm NHỊP SỐNG của lệnh dẫn đầu sang các lệnh đang được gộp cùng nó.

    Lệnh được gộp không tự gửi tick nào (extension chỉ báo tiến độ theo lệnh dẫn
    đầu), nên nếu không có chỗ này thì `pick_next` nhìn chúng như đang IM LẶNG từ
    lúc pick và sẽ dọn chúng khi mẻ chạy dài — giết oan lệnh đang chạy thật, đúng
    lớp lỗi đã xảy ra ngày 26/8/2026 với lệnh mời phải mua suất.

    Chỉ chạm `progress.at` (dấu nhịp), KHÔNG đụng `phase`/`history` của lệnh đó —
    lịch sử pha là của riêng từng lệnh. KHÔNG commit: caller commit.
    """
    child_ids = (leader.payload or {}).get("merged_children")
    if not isinstance(child_ids, list) or not child_ids:
        return
    db.execute(
        text(
            """
            UPDATE queue_items
               SET progress = jsonb_set(
                       COALESCE(progress, '{}'::jsonb), '{at}', to_jsonb(CAST(:at AS text))
                   )
             WHERE id = ANY(CAST(:ids AS uuid[]))
               AND status = 'IN_PROGRESS'
            """
        ),
        {"at": datetime.now(timezone.utc).isoformat(), "ids": [str(i) for i in child_ids]},
    )


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
    # Dấu NHỊP SỐNG: đóng ở MỌI tick (khác `history` chỉ thêm mốc khi phase đổi).
    # `pick_next` đọc mốc này để không giết oan task đang chạy thật — xem
    # `stuck_verdict` và ca 26/8/2026 (mua suất chờ giao dịch ~3,5′ trong im lặng
    # của history nhưng vẫn báo nhịp mỗi 10s).
    merged["at"] = datetime.now(timezone.utc).isoformat()
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
