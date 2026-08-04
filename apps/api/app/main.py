import logging
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import and_, delete, func, or_, select, text

from app.audit import log_event
from app.config import get_settings
from app.db import SessionLocal
from app.models import (
    AuditLog,
    EmailOtp,
    Invite,
    Member,
    PaymentOrder,
    QueueItem,
    TopupOrder,
)
from app.routers.members._shared import (
    SUBSCRIPTION_GRACE_AFTER_EXPIRY,
    _has_open_remove_task,
    void_refunded_invite_periods,
)
from app.services import wallet_service
from app.routers.members.remove import _build_removal_task
from app.sse import publish_task_event
from app.routers import (
    added_members,
    audit_logs,
    auth,
    auto_invite,
    invite_config,
    members,
    queue,
    sepay_webhook,
    subscription_requests,
    telegram,
    ui_labels,
    users,
    wallet,
    workspaces,
)
from app.seed import seed_payment_settings, seed_super_admin, seed_wallet_test_account

logger = logging.getLogger(__name__)

# Background scheduler — retention/dọn dẹp NẶNG chạy mỗi giờ (không cần realtime).
SUBSCRIPTION_CLEANUP_INTERVAL_SEC = 60 * 60  # 1 giờ
_cleanup_timer: threading.Timer | None = None
_cleanup_lock = threading.Lock()
_expire_lock = threading.Lock()

# AUTO-REMOVE hết hạn phải "NGAY LẬP TỨC" (user 2026-07-27): trước đây gộp chung tick
# hằng-giờ nên email hết hạn phải chờ tới ~1 tiếng mới bị enqueue gỡ → cảm giác "không
# hoạt động". Tách riêng tick NHANH (mỗi 60″, giống order-cleanup 2′) chỉ lo quét
# member hết hạn → enqueue gỡ sát mốc. Quét rẻ (idempotent qua `_has_open_remove_task`).
EXPIRY_CHECK_INTERVAL_SEC = 60  # 1 phút — near-immediate
_expiry_timer: threading.Timer | None = None

# LOOP-GUARD auto-remove (bug user 2026-07-21): nếu đã TỰ ĐỘNG enqueue gỡ 1 member
# >= AUTO_REMOVE_MAX_ATTEMPTS lần trong cửa sổ mà member VẪN quay lại (xoá không có
# hiệu lực phía ChatGPT: owner/quyền/ghế) → NGỪNG xoá-giả lặp vô hạn, ghi
# MEMBER_REMOVE_STUCK cảnh báo admin gỡ tay. Member khoẻ chỉ bị gỡ 1 lần rồi thành
# 'removed' (scheduler thôi chọn) nên không bao giờ chạm ngưỡng.
AUTO_REMOVE_STUCK_WINDOW = timedelta(days=7)
AUTO_REMOVE_MAX_ATTEMPTS = 3

# Retention: member đã 'removed' quá ngưỡng này → hard-delete record + lịch sử
# audit RIÊNG của email đó. Mốc tính từ thời điểm email bị gỡ (removed_at, thường
# do hết hạn). Nếu sau ngưỡng này KHÔNG mua lại thì xoá lịch sử vĩnh viễn; mời lại
# sau đó là email mới hoàn toàn (yêu cầu user: nâng 30 → 90 ngày, 2026-07-19).
REMOVED_MEMBER_RETENTION = timedelta(days=90)
_purge_lock = threading.Lock()

# Chốt limbo lời mời (fix 2026-07-16, bug thuylinhtctbg): guard 10 phút ở
# completion.py CỐ Ý "defer to sync" email vừa mời chưa verify — nhưng KHÔNG có gì
# quay lại chốt nếu lời mời hỏng THẬT → member kẹt 'pending' vĩnh viễn, im lặng như
# "đã mời thành công", giữ "hạn ma" đã trả tiền → mời lại miễn phí oan. Resolver này
# biến "defer to sync" thành cam kết CÓ THỰC THI: sau cửa sổ này mà member vẫn chưa
# từng VERIFIED (không có sự kiện MEMBER_INVITE_VERIFIED nối tiếp) → chốt THẤT BẠI:
# hoàn phí + void kỳ + ghi MEMBER_INVITE_FAILED + xoá phantom. Cửa sổ > 10′ (freshness
# defer) để chừa thời gian ChatGPT index + 1 vòng sync. Nếu lỡ chốt oan lời mời THẬT
# đã vào ChatGPT: sync kế tiếp thấy "rogue pending" → extension auto-revoke (tự lành).
STALE_PENDING_INVITE_WINDOW = timedelta(minutes=20)
_stale_invite_lock = threading.Lock()

# Retention audit log (yêu cầu user 2026-07-12): sự kiện QUAN TRỌNG (thay đổi
# thành viên / thanh toán / ví / workspace / cấu hình…) lưu VÔ THỜI HẠN; còn log
# "ồn ào kiểu đăng nhập" (LOGIN_*) + log nội bộ hiệu chỉnh nhãn UI (UI_LABEL*)
# chỉ giữ 30 ngày rồi hard-delete. Thêm prefix vào đây để mở rộng loại cần dọn.
AUDIT_EPHEMERAL_RETENTION = timedelta(days=30)
AUDIT_EPHEMERAL_PREFIXES = ("LOGIN", "UI_LABEL")
_audit_purge_lock = threading.Lock()
_otp_purge_lock = threading.Lock()

# Dọn LỆNH thanh toán chưa trả tiền quá hạn (user 2026-07-14): đếm ngược = 10′; hết
# 10′ = mã QR hết hạn = lệnh tự huỷ/xoá. Tick nhanh (mỗi 2′) để xoá sát mốc 10′.
#  - TopupOrder pending >10′  → HARD-DELETE (khớp webhook theo MÃ USER cố định, không
#    theo dòng lệnh → xoá an toàn, tiền chuyển trễ vẫn cộng ví).
#  - PaymentOrder (mời/gia hạn) pending >10′ & CHƯA nhận tiền → đánh dấu 'expired' +
#    XOÁ dòng nhật ký 'PAYMENT_ORDER_CREATED' (chưa có tiền chạy qua → không giá trị
#    lưu trữ). GIỮ dòng order (expired) để tiền chuyển TRỄ vẫn khớp mã ORDER → cộng ví.
PENDING_ORDER_TTL = timedelta(minutes=10)
ORDER_CLEANUP_INTERVAL_SEC = 120  # 2 phút
_order_cleanup_timer: threading.Timer | None = None
_order_purge_lock = threading.Lock()

# Nhắc gia hạn qua Telegram (feature 004). Tick 5′ vì hai việc khác nhịp nhau:
#  - QUÉT tạo tin: chỉ chạy trong GIỜ gửi (RENEWAL_REMINDER_HOUR, mặc định 9h VN) →
#    tick 5′ đảm bảo rơi vào giờ đó dù server khởi động lại lúc nào.
#  - GỬI/RETRY: chạy mọi tick → lỗi mạng tạm thời được thử lại trong vòng vài phút.
# Chống trùng nằm ở dedupe_key (UNIQUE) chứ KHÔNG dựa vào nhịp tick, nên tick chạy
# thừa hoàn toàn vô hại. TELEGRAM_BOT_TOKEN rỗng ⇒ tick thoát ngay (tính năng tắt).
TELEGRAM_REMINDER_INTERVAL_SEC = 300  # 5 phút
_reminder_timer: threading.Timer | None = None
_reminder_lock = threading.Lock()


def _purge_stale_orders_once() -> None:
    """Dọn lệnh thanh toán pending quá 10′ chưa trả tiền. Best-effort: lỗi DB chỉ log
    warning, không block lifecycle. Lock riêng tránh race (tick chồng / hot-reload)."""
    if not _order_purge_lock.acquire(blocking=False):
        return
    try:
        with SessionLocal() as db:
            cutoff = datetime.now(timezone.utc) - PENDING_ORDER_TTL

            # 1) TopupOrder pending quá hạn → xoá hẳn (không còn dùng để khớp webhook).
            topup_deleted = (
                db.execute(
                    delete(TopupOrder).where(
                        TopupOrder.status == "pending",
                        TopupOrder.created_at <= cutoff,
                    )
                ).rowcount
                or 0
            )

            # 2) PaymentOrder pending quá hạn & chưa nhận tiền → 'expired' (giữ dòng cho
            #    tiền chuyển trễ), rồi xoá dòng nhật ký "Tạo lệnh" chưa có tiền chạy qua.
            db.execute(
                text(
                    "UPDATE payment_orders SET status='expired' "
                    "WHERE status='pending' AND paid_amount_vnd IS NULL AND created_at <= :cutoff"
                ),
                {"cutoff": cutoff},
            )
            audit_deleted = (
                db.execute(
                    text(
                        "DELETE FROM audit_logs WHERE action='PAYMENT_ORDER_CREATED' "
                        "AND result='PENDING' AND target_type='PAYMENT_ORDER' "
                        "AND target_id IN (SELECT id::text FROM payment_orders "
                        "WHERE status='expired' AND paid_amount_vnd IS NULL)"
                    )
                ).rowcount
                or 0
            )
            db.commit()
            if topup_deleted or audit_deleted:
                logger.info(
                    "[order-cleanup] xoá %d lệnh nạp quá hạn + %d dòng nhật ký lệnh hết hạn (>%d′)",
                    topup_deleted,
                    audit_deleted,
                    int(PENDING_ORDER_TTL.total_seconds() // 60),
                )
    except Exception as e:  # noqa: BLE001
        logger.warning("[order-cleanup] tick failed: %s", e)
    finally:
        _order_purge_lock.release()


def _purge_ephemeral_audit_logs_once() -> None:
    """Hard-delete các audit log 'phù du' (LOGIN_*, UI_LABEL*) quá
    `AUDIT_EPHEMERAL_RETENTION`. Mọi log khác giữ vô thời hạn.

    Best-effort: lỗi DB chỉ log warning, không block lifecycle. Lock riêng
    tránh race (dev hot-reload spawn nhiều timer / tick chồng).
    """
    if not _audit_purge_lock.acquire(blocking=False):
        return
    try:
        with SessionLocal() as db:
            cutoff = datetime.now(timezone.utc) - AUDIT_EPHEMERAL_RETENTION
            prefix_match = or_(
                *(AuditLog.action.like(f"{p}%") for p in AUDIT_EPHEMERAL_PREFIXES)
            )
            result = db.execute(
                delete(AuditLog).where(
                    and_(AuditLog.timestamp <= cutoff, prefix_match)
                )
            )
            deleted = result.rowcount or 0
            db.commit()
            if deleted:
                logger.info(
                    "[audit-retention] hard-deleted %d ephemeral logs (>%dd, prefixes=%s)",
                    deleted,
                    AUDIT_EPHEMERAL_RETENTION.days,
                    ",".join(AUDIT_EPHEMERAL_PREFIXES),
                )
    except Exception as e:  # noqa: BLE001
        logger.warning("[audit-retention] tick failed: %s", e)
    finally:
        _audit_purge_lock.release()


def _purge_expired_otps_once() -> None:
    """Hard-delete các đăng ký chờ OTP đã hết hạn (email_otps.expires_at < now).

    Best-effort như các job dọn khác. Bản ghi hết hạn không còn verify được nên
    xoá để bảng gọn; user muốn tiếp tục thì đăng ký lại.
    """
    if not _otp_purge_lock.acquire(blocking=False):
        return
    try:
        with SessionLocal() as db:
            now = datetime.now(timezone.utc)
            result = db.execute(delete(EmailOtp).where(EmailOtp.expires_at < now))
            deleted = result.rowcount or 0
            db.commit()
            if deleted:
                logger.info("[otp-cleanup] hard-deleted %d expired OTP registration(s)", deleted)
    except Exception as e:  # noqa: BLE001
        logger.warning("[otp-cleanup] tick failed: %s", e)
    finally:
        _otp_purge_lock.release()


def _purge_old_removed_members_once() -> None:
    """Hard-delete member `removed` quá `REMOVED_MEMBER_RETENTION` + lịch sử audit
    RIÊNG của email đó. Sau mốc này email coi như chưa từng tồn tại: mời lại tạo
    record `member.id` MỚI → lịch sử hoàn toàn sạch.

    Xoá gì cho mỗi member quá hạn:
      - audit_logs ĐƠN-MỤC của member (`target_type='MEMBER' AND target_id=id`).
        CỐ Ý KHÔNG xoá row hàng loạt (`data.member_ids` mảng / MEMBER_BULK_INVITE
        theo email) vì chúng tham chiếu NHIỀU email — xoá sẽ mất lịch sử của
        member còn sống. Member này đã bị xoá nên không còn nơi tra cứu; row
        hàng loạt còn lại chỉ nằm ở audit log tổng, không lộ dưới dạng "lịch sử
        của email".
      - Invite rows của email đó trong workspace (dọn sạch, tránh rogue-pending).
      - Member record → cascade tự xoá member_subscription_cycles (ondelete=CASCADE).

    Best-effort: lỗi DB chỉ log warning, không block lifecycle. Lock riêng tránh
    race (dev hot-reload spawn nhiều timer / tick chồng).
    """
    if not _purge_lock.acquire(blocking=False):
        return
    try:
        with SessionLocal() as db:
            now = datetime.now(timezone.utc)
            cutoff = now - REMOVED_MEMBER_RETENTION
            stale = (
                db.execute(
                    select(Member).where(
                        Member.status == "removed",
                        Member.removed_at.isnot(None),
                        Member.removed_at <= cutoff,
                    )
                )
                .scalars()
                .all()
            )
            if not stale:
                return
            for member in stale:
                mid = str(member.id)
                db.execute(
                    delete(AuditLog).where(
                        AuditLog.target_type == "MEMBER",
                        AuditLog.target_id == mid,
                    )
                )
                db.execute(
                    delete(Invite).where(
                        Invite.workspace_id == member.workspace_id,
                        func.lower(Invite.email) == member.email.lower(),
                    )
                )
                db.delete(member)
            db.commit()
            logger.info(
                "[retention] hard-deleted %d removed members (>%dd) + lịch sử riêng",
                len(stale),
                REMOVED_MEMBER_RETENTION.days,
            )
    except Exception as e:  # noqa: BLE001
        logger.warning("[retention] tick failed: %s", e)
    finally:
        _purge_lock.release()


def _enqueue_expired_removals_once() -> None:
    """AUTO-REMOVE khi hết hạn (yêu cầu user 2026-07-13: "khi 1 email hết hạn tự động
    thực hiện lệnh xoá, không confirm thủ công"). Quét MỌI workspace, tìm member
    active/pending đã hết hạn (`subscription_end_at <= now`, không ân hạn) → enqueue
    task gỡ (REVOKE_INVITES cho pending / REMOVE_MEMBER cho active) rồi publish SSE để
    extension pick ngay. Extension mới flip member sang `removed` khi hoàn tất task.

    Cùng RULE với endpoint `POST /cleanup-expired` (remove.py) — nút bấm tay chỉ là
    "làm ngay đừng chờ tick". `_has_open_remove_task` giữ idempotent giữa các tick /
    giữa tick và nút bấm (member vẫn active/pending tới khi extension xong).

    `created_by_id` = người mời member (truy vết); audit actor = SYSTEM (job nền, không
    có user request). Best-effort: lỗi DB chỉ log warning, không block lifecycle. Lock
    riêng tránh race (dev hot-reload spawn nhiều timer / tick chồng)."""
    if not _expire_lock.acquire(blocking=False):
        return
    try:
        with SessionLocal() as db:
            now = datetime.now(timezone.utc)
            cutoff = now - SUBSCRIPTION_GRACE_AFTER_EXPIRY
            expired = (
                db.execute(
                    select(Member).where(
                        Member.status.in_(("active", "pending")),
                        Member.subscription_end_at.isnot(None),
                        Member.subscription_end_at <= cutoff,
                    )
                )
                .scalars()
                .all()
            )
            # (workspace_id, email, task_type) để publish SSE sau commit.
            events: list[tuple[object, str, str]] = []
            stuck_logged = False
            for member in expired:
                if _has_open_remove_task(db, member):
                    continue
                # LOOP-GUARD: đã tự gỡ member này bao nhiêu lần trong cửa sổ? Chỉ
                # vòng lặp xoá-giả (gỡ → đồng bộ hồi sinh → gỡ lại) mới tích luỹ cao.
                attempts = db.execute(
                    select(func.count())
                    .select_from(AuditLog)
                    .where(
                        AuditLog.action == "MEMBER_EXPIRED_REMOVE_QUEUED",
                        AuditLog.target_id == str(member.id),
                        AuditLog.timestamp >= now - AUTO_REMOVE_STUCK_WINDOW,
                    )
                ).scalar_one()
                if attempts >= AUTO_REMOVE_MAX_ATTEMPTS:
                    # ChatGPT không cho xoá tự động → NGỪNG enqueue (hết xoá-giả),
                    # cảnh báo admin gỡ tay. Throttle 1 alert / ngày / member.
                    recent_alert = db.execute(
                        select(AuditLog.id)
                        .where(
                            AuditLog.action == "MEMBER_REMOVE_STUCK",
                            AuditLog.target_id == str(member.id),
                            AuditLog.timestamp >= now - timedelta(days=1),
                        )
                        .limit(1)
                    ).first()
                    if recent_alert is None:
                        log_event(
                            db,
                            actor_type="SYSTEM",
                            action="MEMBER_REMOVE_STUCK",
                            result="ERROR",
                            target_type="MEMBER",
                            target_id=str(member.id),
                            data={
                                "workspace_id": str(member.workspace_id),
                                "email": member.email,
                                "attempts": int(attempts),
                                "window_days": AUTO_REMOVE_STUCK_WINDOW.days,
                                "note": "Đã tự động gỡ nhiều lần nhưng member vẫn còn trên ChatGPT — cần gỡ THỦ CÔNG (có thể do quyền/ghế/owner).",
                            },
                            commit=False,
                        )
                        stuck_logged = True
                    continue
                queue_item, task_type = _build_removal_task(
                    member, member.invited_by_user_id, member.workspace_id
                )
                db.add(queue_item)
                db.flush()
                log_event(
                    db,
                    actor_type="SYSTEM",
                    action="MEMBER_EXPIRED_REMOVE_QUEUED",
                    result="PENDING",
                    target_type="MEMBER",
                    target_id=str(member.id),
                    data={
                        "workspace_id": str(member.workspace_id),
                        "email": member.email,
                        "task_type": task_type,
                        "subscription_end_at": member.subscription_end_at.isoformat()
                        if member.subscription_end_at
                        else None,
                        "queue_item_id": str(queue_item.id),
                        "source": "scheduler",
                    },
                    commit=False,
                )
                events.append((member.workspace_id, member.email, task_type))
            if events or stuck_logged:
                db.commit()
                for workspace_id, email, task_type in events:
                    publish_task_event(
                        workspace_id,
                        {
                            "type": "task-available",
                            "task_type": task_type,
                            "email": email,
                        },
                    )
                logger.info(
                    "[auto-expire] enqueued %d removal task(s) cho member hết hạn",
                    len(events),
                )
    except Exception as e:  # noqa: BLE001
        logger.warning("[auto-expire] tick failed: %s", e)
    finally:
        _expire_lock.release()


def _resolve_stale_pending_invites_once() -> None:
    """Chốt các lời mời KẸT LIMBO: extension đã báo COMPLETED-unverified rồi được guard
    10 phút "defer to sync", nhưng quá `STALE_PENDING_INVITE_WINDOW` vẫn CHƯA có xác
    minh nào (member còn 'pending', không có MEMBER_INVITE_VERIFIED nối tiếp) → lời mời
    hỏng THẬT. Chốt như FAILED: hoàn phí (idempotent) + void kỳ đã trả + ghi
    MEMBER_INVITE_FAILED (timeline lật "Thất bại") + xoá phantom member/invite.

    Nguồn phát hiện = audit `MEMBER_INVITE_PENDING_VERIFY` (completion.py ghi khi defer)
    — gắn member.id + queue_item_id, nên xử lý CHÍNH XÁC TỪNG email (KHÔNG đụng email
    verified cùng task). Bỏ qua nếu: member đã đổi khác 'pending' / đã có
    VERIFIED|FAILED nối tiếp (đã được sync promote hoặc chốt) / vừa được re-invite tươi
    (< cửa sổ) / còn task INVITE_MEMBER đang mở (đang chạy, chưa phải limbo).

    Best-effort: lỗi DB chỉ log warning, không block lifecycle. Lock riêng tránh race."""
    if not _stale_invite_lock.acquire(blocking=False):
        return
    try:
        with SessionLocal() as db:
            now = datetime.now(timezone.utc)
            cutoff = now - STALE_PENDING_INVITE_WINDOW
            # Sự kiện defer quá cửa sổ, mới nhất trước (mỗi member xử lý 1 lần/tick).
            events = (
                db.execute(
                    select(AuditLog)
                    .where(
                        AuditLog.action == "MEMBER_INVITE_PENDING_VERIFY",
                        AuditLog.target_type == "MEMBER",
                        AuditLog.timestamp <= cutoff,
                    )
                    .order_by(AuditLog.timestamp.desc())
                )
                .scalars()
                .all()
            )
            seen: set[str] = set()
            resolved = 0
            for ev in events:
                mid = ev.target_id
                if not mid or mid in seen:
                    continue
                seen.add(mid)
                member = db.get(Member, UUID(mid))
                if member is None or member.status != "pending":
                    continue
                # Vừa re-invite tươi → chưa phải limbo (cửa sổ mới khởi động lại).
                anchor = member.last_invited_at or member.created_at
                if anchor is not None and anchor > cutoff:
                    continue
                # Đã có kết luận nối tiếp (sync promote / chốt fail trước) → bỏ qua.
                resolved_after = db.execute(
                    select(AuditLog.id).where(
                        AuditLog.target_type == "MEMBER",
                        AuditLog.target_id == mid,
                        AuditLog.action.in_(
                            ("MEMBER_INVITE_VERIFIED", "MEMBER_INVITE_FAILED")
                        ),
                        AuditLog.timestamp > ev.timestamp,
                    ).limit(1)
                ).first()
                if resolved_after is not None:
                    continue
                email = member.email.lower()
                # Còn task mời đang chạy/chờ → chưa kết thúc, không chốt vội.
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
                    continue

                qid = (ev.data or {}).get("queue_item_id")
                ws_id = member.workspace_id
                # 1. Timeline FAILED (TRƯỚC khi xoá member để lookup còn thấy).
                log_event(
                    db,
                    actor_type="SYSTEM",
                    actor_label="system:stale-invite-resolver",
                    action="MEMBER_INVITE_FAILED",
                    result="FAILED",
                    target_type="MEMBER",
                    target_id=mid,
                    data={
                        "email": email,
                        "workspace_id": str(ws_id),
                        "queue_item_id": qid,
                        "verified_at": now.isoformat(),
                        "error_code": "INVITE_UNVERIFIED_TIMEOUT",
                    },
                    commit=False,
                )
                # 2. Hoàn phí (idempotent) + void kỳ đã trả.
                if qid:
                    wallet_service.refund_invite(db, UUID(qid), emails=[email])
                void_refunded_invite_periods(
                    db, workspace_id=ws_id, emails=[email], now=now
                )
                # 3. Xoá phantom member + invite (email này CHƯA từng tham gia).
                db.execute(
                    delete(Invite).where(
                        Invite.workspace_id == ws_id,
                        func.lower(Invite.email) == email,
                    )
                )
                db.delete(member)
                resolved += 1
            if resolved:
                db.commit()
                logger.info(
                    "[stale-invite] chốt FAILED %d lời mời kẹt limbo (>%d phút)",
                    resolved,
                    int(STALE_PENDING_INVITE_WINDOW.total_seconds() // 60),
                )
    except Exception as e:  # noqa: BLE001
        logger.warning("[stale-invite] tick failed: %s", e)
    finally:
        _stale_invite_lock.release()


def _schedule_expiry_tick() -> None:
    """Tick NHANH (mỗi `EXPIRY_CHECK_INTERVAL_SEC`) chỉ lo AUTO-REMOVE member hết hạn
    (user 2026-07-13: "khi 1 email hết hạn tự động thực hiện lệnh xoá, không confirm
    thủ công"; 2026-07-27: phải NGAY LẬP TỨC, không chờ tick hằng-giờ).

    Tách khỏi tick hằng-giờ để enqueue gỡ SÁT mốc hết hạn (ân hạn = 0). Nút "Dọn member
    hết hạn" (POST /cleanup-expired) vẫn còn để admin remove tức thì không đợi tick kế.
    """
    global _expiry_timer
    try:
        _enqueue_expired_removals_once()
    finally:
        _expiry_timer = threading.Timer(
            EXPIRY_CHECK_INTERVAL_SEC, _schedule_expiry_tick
        )
        _expiry_timer.daemon = True
        _expiry_timer.start()


def _schedule_cleanup_tick() -> None:
    """Tự reschedule sau mỗi tick. Hoạt động trong main process thread.

    Lo các job retention/dọn dẹp NẶNG không cần realtime: chốt lời mời kẹt limbo +
    retention hard-delete (member removed >90d + log phù du + OTP hết hạn). AUTO-REMOVE
    hết hạn ĐÃ TÁCH sang `_schedule_expiry_tick` (tick nhanh) để gỡ ngay khi hết hạn.
    """
    global _cleanup_timer
    try:
        _resolve_stale_pending_invites_once()
        _purge_old_removed_members_once()
        _purge_ephemeral_audit_logs_once()
        _purge_expired_otps_once()
    finally:
        _cleanup_timer = threading.Timer(
            SUBSCRIPTION_CLEANUP_INTERVAL_SEC, _schedule_cleanup_tick
        )
        _cleanup_timer.daemon = True
        _cleanup_timer.start()


def _run_renewal_reminder_once() -> None:
    """Quét email sắp hết hạn → gửi nhắc Telegram. Best-effort: mọi lỗi chỉ log.

    Đứng NGOÀI lifecycle nghiệp vụ: Telegram hỏng KHÔNG được phép ảnh hưởng tới
    mời/gia hạn/auto-remove. Lock riêng chặn tick chồng (hot-reload / tick chậm)."""
    from app.services import renewal_reminder, telegram

    if not telegram.bot_configured():
        return
    if not _reminder_lock.acquire(blocking=False):
        return
    try:
        with SessionLocal() as db:
            renewal_reminder.run_tick(db)
    except Exception as e:  # noqa: BLE001
        logger.warning("[tele-reminder] tick failed: %s", e)
    finally:
        _reminder_lock.release()


def _schedule_reminder_tick() -> None:
    """Tự reschedule mỗi `TELEGRAM_REMINDER_INTERVAL_SEC` (xem chú thích hằng số)."""
    global _reminder_timer
    try:
        _run_renewal_reminder_once()
    finally:
        _reminder_timer = threading.Timer(
            TELEGRAM_REMINDER_INTERVAL_SEC, _schedule_reminder_tick
        )
        _reminder_timer.daemon = True
        _reminder_timer.start()


def _schedule_order_cleanup_tick() -> None:
    """Tick nhanh (mỗi 2′) dọn lệnh thanh toán pending quá 10′ chưa trả tiền — tách
    khỏi tick hằng-giờ để xoá sát mốc hết hạn 10′ (user 2026-07-14)."""
    global _order_cleanup_timer
    try:
        _purge_stale_orders_once()
    finally:
        _order_cleanup_timer = threading.Timer(
            ORDER_CLEANUP_INTERVAL_SEC, _schedule_order_cleanup_tick
        )
        _order_cleanup_timer.daemon = True
        _order_cleanup_timer.start()


def _run_alembic_upgrade_head() -> None:
    """Tự động chạy `alembic upgrade head` mỗi lần startup — đảm bảo schema DB
    luôn match với code hiện tại trong môi trường local dev.

    Lý do: trước đây user phải nhớ chạy `alembic upgrade head` mỗi khi
    pull code mới. Nếu quên, các column model mới (vd `subscription_months`)
    sẽ không tồn tại trong DB → mọi SELECT trên bảng đó fail SQL → các flow
    sync/invite đều fail không rõ lý do. Auto-upgrade tránh hẳn class lỗi này.

    Best-effort: log warning nếu fail, không block startup (DB có thể đã ở
    head, hoặc alembic_version corrupted — user vẫn cần debug).
    """
    try:
        from alembic import command
        from alembic.config import Config as AlembicConfig
    except ImportError:
        logger.warning("[startup] alembic không cài, skip auto-migration")
        return
    api_root = Path(__file__).resolve().parents[1]
    ini = api_root / "alembic.ini"
    if not ini.exists():
        logger.warning("[startup] alembic.ini không tìm thấy ở %s, skip", ini)
        return
    try:
        cfg = AlembicConfig(str(ini))
        cfg.set_main_option("script_location", str(api_root / "alembic"))
        command.upgrade(cfg, "head")
        logger.info("[startup] alembic upgrade head OK")
    except Exception as e:  # noqa: BLE001 — log + continue
        logger.warning(
            "[startup] alembic upgrade head FAILED (%s) — chạy thủ công nếu cần",
            e,
        )


def _apply_thread_limit() -> None:
    """Hạ trần threadpool anyio từ 40 (mặc định) xuống `THREAD_POOL_SIZE`.

    MỌI endpoint trong dự án này khai báo `def` (sync, không phải `async def`) nên
    Starlette đẩy hết vào threadpool anyio. Trần 40 vừa tốn stack thread vừa vô
    nghĩa: gần như request nào cũng chạm DB, mà pool DB chỉ mở tối đa
    `DB_POOL_SIZE + DB_MAX_OVERFLOW` (=15) kết nối → 25 thread còn lại chỉ nằm
    chờ checkout chứ không chạy nhanh hơn. Đặt 16 = pool DB + biên cho endpoint
    không đụng DB (vd /health, gọi Telegram/HostMail qua urllib).

    KHÔNG ảnh hưởng SSE `/queue/stream`: chỗ đó dùng `asyncio.to_thread` (executor
    mặc định của asyncio, một pool KHÁC), không lấy token của limiter này.

    Phải gọi TRONG event loop đang chạy — limiter là RunVar gắn theo loop.
    """
    import anyio.to_thread

    size = max(1, get_settings().thread_pool_size)
    anyio.to_thread.current_default_thread_limiter().total_tokens = size
    logger.info("[startup] threadpool anyio giới hạn %d thread (mặc định 40)", size)


@asynccontextmanager
async def lifespan(_: FastAPI):
    _apply_thread_limit()
    _run_alembic_upgrade_head()
    with SessionLocal() as db:
        seed_super_admin(db)
        seed_payment_settings(db)
        seed_wallet_test_account(db)
    # Start background scheduler — mỗi tick chạy ngay 1 lần rồi tự reschedule:
    #  - _schedule_expiry_tick   : AUTO-REMOVE member hết hạn NGAY (mỗi 60″, user 2026-07-27)
    #  - _schedule_cleanup_tick  : retention/dọn dẹp nặng (mỗi giờ)
    #  - _schedule_order_cleanup_tick : dọn lệnh thanh toán quá hạn (mỗi 2′)
    #  - _schedule_reminder_tick : nhắc gia hạn qua Telegram (mỗi 5′, feature 004)
    _schedule_expiry_tick()
    _schedule_cleanup_tick()
    _schedule_order_cleanup_tick()
    _schedule_reminder_tick()
    try:
        yield
    finally:
        global _cleanup_timer, _order_cleanup_timer, _expiry_timer, _reminder_timer
        if _expiry_timer is not None:
            _expiry_timer.cancel()
            _expiry_timer = None
        if _cleanup_timer is not None:
            _cleanup_timer.cancel()
            _cleanup_timer = None
        if _order_cleanup_timer is not None:
            _order_cleanup_timer.cancel()
            _order_cleanup_timer = None
        if _reminder_timer is not None:
            _reminder_timer.cancel()
            _reminder_timer = None


def _configure_app_logging() -> None:
    """Cho logger `app.*` (INFO) hiển thị qua handler của uvicorn.

    Trước đây chỉ `logging.getLogger(__name__)` khắp nơi mà KHÔNG cấu hình handler →
    root logger mặc định level WARNING nuốt hết `logger.info(...)`. Hậu quả: các job nền
    (auto-expire, order-cleanup, retention) chạy im lặng, không có cách nào quan sát →
    "tưởng không hoạt động". Gắn handler uvicorn + set INFO để mọi tick log ra stdout.
    """
    app_logger = logging.getLogger("app")
    if app_logger.handlers:  # đã cấu hình (vd reload) → khỏi gắn trùng
        return
    uvicorn_logger = logging.getLogger("uvicorn")
    if uvicorn_logger.handlers:
        app_logger.handlers = uvicorn_logger.handlers
    app_logger.setLevel(logging.INFO)
    app_logger.propagate = False


def create_app() -> FastAPI:
    _configure_app_logging()
    settings = get_settings()
    app = FastAPI(
        title="AutoGPT Dashboard API",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.frontend_origin],
        allow_origin_regex=r"chrome-extension://.*",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def private_network_access(request: Request, call_next):
        """Cho phép Chrome extension fetch tới localhost (Private Network Access)."""
        response = await call_next(request)
        if request.headers.get("access-control-request-private-network") == "true":
            response.headers["Access-Control-Allow-Private-Network"] = "true"
        return response
    app.include_router(auth.router)
    app.include_router(users.router)
    app.include_router(workspaces.router)
    app.include_router(members.router)
    app.include_router(auto_invite.router)
    app.include_router(invite_config.router)
    app.include_router(added_members.router)
    app.include_router(subscription_requests.router)
    app.include_router(queue.router)
    app.include_router(audit_logs.router)
    app.include_router(ui_labels.router)
    app.include_router(wallet.router)
    app.include_router(sepay_webhook.router)
    app.include_router(telegram.router)

    @app.get("/health", tags=["meta"])
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
