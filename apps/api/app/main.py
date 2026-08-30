import hashlib
import logging
import threading
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
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
    QueueItem,
    TopupOrder,
    Workspace,
)
from app.ratelimit import RateLimitMiddleware
from app.routers.members._shared import (
    SUBSCRIPTION_GRACE_AFTER_EXPIRY,
    _has_open_remove_task,
)
from app.routers.queue.completion import enqueue_sync_probe, fail_deferred_invite
from app.routers.members.remove import _build_removal_task
from app.sse import publish_task_event
from app.routers import (
    added_members,
    admin_limits,
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

# ĐỒNG BỘ ĐỊNH KỲ tự động (2026-08-12, sau sự cố XOÁ-GIẢ 03→12/8): trước đây
# SYNC_DATA CHỈ chạy khi có người bấm nút — thực tế 01/8 rồi im tới 12/8 (11 ngày).
# Trong khoảng mù đó, mọi sai lệch giữa DB và ChatGPT không có đường nào lộ ra:
# 4 email bị mark removed OAN (extension kết luận vắng mặt mà không click xoá) vẫn
# nằm trên ChatGPT ăn ghế, còn dashboard giấu luôn khỏi danh sách gia hạn vì chỉ
# hiện active/pending. Đồng bộ là NGUỒN ĐỐI CHIẾU duy nhất — để nó phụ thuộc vào
# việc admin có nhớ bấm hay không là bỏ ngỏ.
#
# Nên backend tự enqueue SYNC_DATA cho từng workspace:
#  - scope 'both' (cả tab "Người dùng" LẪN "Lời mời đang chờ") — user chốt
#    2026-08-24, thay scope 'members' của bản đầu.
#
#    Vì sao phải có tab Lời mời: một member rời tab Lời mời có HAI nguyên nhân
#    không phân biệt được nếu chỉ nhìn một tab — đã nhận lời mời, hay lời mời bị
#    thu hồi/hết hạn. Nên `reconcile` cố tình KHÔNG cho scope 'members' xoá
#    pending (xem members/reconcile.py). Hệ quả của bản 'members': chiều "đã tham
#    gia → active" tự lành mỗi ngày, còn chiều "lời mời chết → removed" thì KHÔNG
#    BAO GIỜ tự lành — phải có người nhớ bấm sync tay. Thực đo 7 ngày (17–24/8):
#    đúng 2 lượt 'both', cả hai đều do người bấm.
#
#    Giá phải trả, đo trên production: GPT1 (~150 dòng) 'members' 31–60s →
#    'both' 35–148s; CHATGPT PRO (~60 dòng) 14–19s → 19–28s. Tức thêm 15–90 giây,
#    MỘT LẦN MỘT NGÀY. Trần cứng `MAX_SYNC_MS` 5 phút và ngưỡng treo SYNC_DATA
#    6 phút đều còn dư rộng.
#
#    Kéo theo: `invites_scanned` nay bật ở lượt sync TỰ ĐỘNG, nên đường tự mua bù
#    suất (`_auto_buy_seats_for_pending`) chạy được mà không cần ai bấm — đó là
#    chủ ý của user, không phải hệ quả ngoài ý muốn.
#  - `created_by_id = NULL` ⇒ KHÔNG đụng cooldown 5 tiếng của admin phụ
#    (`_last_full_sync_at` lọc theo người tạo — xem workspaces/triggers.py).
#  - Guard "đã có SYNC_DATA đang mở thì thôi" ⇒ extension offline lâu ngày cũng
#    chỉ đọng ĐÚNG 1 task, không đẻ hàng đống lệnh chờ.
#
# NHỊP: **1 NGÀY 1 LẦN, GIỜ NGẪU NHIÊN** (chốt user 2026-08-13). Bản đầu (12/8) để
# 2 tiếng/lần là do phiên trước tự chọn, KHÔNG phải user duyệt — user thấy nhật ký
# dày đặc mới biết. Một ngày một lần là đủ cho việc đối chiếu, và giờ ngẫu nhiên để
# lượt quét không đóng khung một khung giờ cố định.
#  - Mốc rơi trong khung `AUTO_SYNC_WINDOW_*` GIỜ VN (mặc định 8h–22h): extension
#    chạy trong Chrome của người dùng, rơi lúc 3h sáng thì lệnh nằm chờ tới sáng và
#    guard "đang có lệnh mở" chặn luôn mốc hôm sau ⇒ mất ngày. Muốn rải cả 24h thì
#    đổi hai hằng số dưới thành 0 và 24.
#  - "Ngày" tính theo GIỜ VN (`AUTO_SYNC_TZ`) cho khớp cách người dùng nhìn nhật ký.
#  - Mốc NGẪU NHIÊN nhưng TẤT ĐỊNH theo (workspace, ngày) — xem `_auto_sync_slot_at`.
# Tick 10′ chỉ để rơi đúng mốc; chống trùng nằm ở các guard chứ không ở nhịp tick.
AUTO_SYNC_TZ = timezone(timedelta(hours=7))  # VN không có DST → offset cứng là đủ
AUTO_SYNC_WINDOW_START_HOUR = 8
AUTO_SYNC_WINDOW_END_HOUR = 22
AUTO_SYNC_CHECK_INTERVAL_SEC = 600  # 10 phút
_auto_sync_timer: threading.Timer | None = None
_auto_sync_lock = threading.Lock()

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
# Treo "chờ xác minh" quá lâu mà CHƯA có lượt đồng bộ nào đi xem (extension tắt, tab
# ChatGPT hỏng…) → kêu MỘT tiếng lên Nhật ký cho admin xử tay. Vẫn KHÔNG tự hoàn phí:
# xem khối "chặn hoàn phí mù" trong `_resolve_stale_pending_invites_once`.
STALE_INVITE_BLIND_ESCALATE = timedelta(hours=6)
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


def _batch_verified_siblings(db, queue_item_id: str, email: str) -> list[str]:
    """Email CÙNG MỘT MẺ MỜI đã được xác minh (audit `MEMBER_INVITE_VERIFIED` mang
    cùng `queue_item_id`), bỏ chính email đang xét.

    Mời một mẻ là MỘT thao tác trên ChatGPT: dialog nhận cả danh sách rồi gửi một
    lần, nên mẻ đi được thì đi cả mẻ. Danh sách trả về không rỗng = có bằng chứng
    DƯƠNG rằng cú gửi ấy trót lọt."""
    rows = (
        db.execute(
            select(AuditLog.data).where(
                AuditLog.action == "MEMBER_INVITE_VERIFIED",
                AuditLog.data["queue_item_id"].astext == queue_item_id,
            )
        )
        .scalars()
        .all()
    )
    out = {
        str((d or {}).get("email") or "").lower()
        for d in rows
    }
    out.discard("")
    out.discard(email.lower())
    return sorted(out)


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
            # Số email được GỠ khỏi limbo bằng bằng chứng đồng bộ (không hoàn phí).
            confirmed = 0
            # Số email GIỮ NGUYÊN vì chưa ai đi xem (chặn hoàn phí mù) + số mẻ sync
            # vừa xếp để đi xem, gom theo workspace.
            blind = 0
            probed = 0
            # Số email GIỮ LẠI vì cùng mẻ mời với email đã xác minh (không hoàn phí).
            held = 0
            blind_by_ws: dict[UUID, list[str]] = {}
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
                # ĐỒNG BỘ ĐÃ NHÌN THẤY email này SAU mốc hoãn ⇒ lời mời ĐI ĐƯỢC.
                #
                # `last_synced_at` chỉ được chạm khi extension quét ChatGPT và thấy
                # email trong tab "Lời mời" hoặc "Người dùng"; `sync_missing_at`
                # NULL nghĩa là lần quét gần nhất KHÔNG phải loại "không thấy đâu
                # cả" (found_in='none'). Hai điều đó cộng lại là bằng chứng DƯƠNG,
                # mạnh ngang việc member đã sang 'active' — chỉ khác là người được
                # mời chưa bấm nhận, mà đó không phải lỗi của dịch vụ đã giao.
                #
                # ⚠️ CA THẬT 26/8/2026 (mẻ 5 email, task 76d68e55): mời đi thật,
                # `SYNC_MEMBERS_BATCH` ngay sau đó trả `found_in='pending'` cho cả 5
                # — nhưng nhánh reconcile của batch chỉ chạm `last_synced_at`, KHÔNG
                # ghi `MEMBER_INVITE_VERIFIED`, nên bằng chứng ấy vô hình với vòng
                # kiểm tra bên trên. Đủ 20′ là resolver hoàn 5×330.000đ + void kỳ +
                # xoá sạch bản ghi của những lời mời đang nằm chờ thật trong ChatGPT.
                # `completion.py` nay ghi VERIFIED ngay khi sync thấy; lớp này giữ
                # cho các bản ghi ĐÃ lỡ hoãn trước bản vá (sync của chúng chạy xong
                # rồi, không còn mẻ nào quay lại ghi giúp).
                if (
                    member.sync_missing_at is None
                    and member.last_synced_at is not None
                    and member.last_synced_at > ev.timestamp
                ):
                    log_event(
                        db,
                        actor_type="SYSTEM",
                        actor_label="system:stale-invite-resolver",
                        action="MEMBER_INVITE_VERIFIED",
                        result="COMPLETED",
                        target_type="MEMBER",
                        target_id=mid,
                        data={
                            "email": email,
                            "workspace_id": str(member.workspace_id),
                            "queue_item_id": (ev.data or {}).get("queue_item_id"),
                            "verified_at": now.isoformat(),
                            "error_code": None,
                            "reason": "sync_saw_member_after_defer",
                            "last_synced_at": member.last_synced_at.isoformat(),
                        },
                        commit=False,
                    )
                    confirmed += 1
                    continue
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

                # ── CHƯA AI ĐI XEM ⇒ KHÔNG ĐƯỢC CHỐT HỎNG (chặn hoàn phí mù) ────
                # Tới đây nghĩa là nhánh bằng chứng DƯƠNG ở trên không nổ. Có hai
                # ca hoàn toàn khác nhau, trước đây bị gộp làm một rồi hoàn phí cả
                # hai:
                #   (a) đã có lượt sync SAU mốc hoãn mà KHÔNG thấy email đâu
                #       (`sync_missing_at` mới hơn mốc) → bằng chứng ÂM thật, chốt
                #       hỏng là đúng;
                #   (b) CHƯA từng có lượt sync nào sau mốc hoãn → không ai đi xem,
                #       chốt hỏng chỉ là đoán. Hết 20′ không phải bằng chứng.
                #
                # CA THẬT 28-29/8/2026: mời 8 email, extension timeout 300s ở Phase
                # A' nên quét tab Lời mời chỉ ra 1/8; 7 email kia bị hoãn rồi 62′
                # sau resolver hoàn phí + xoá bản ghi — trong khi cả 7 ĐANG ở trong
                # team thật. Auto-sync 1 lần/ngày nên nhánh bằng chứng dương không
                # bao giờ kịp nổ. Tổng 12 email, 3.960.000đ hoàn oan, dịch vụ vẫn
                # giao. Giả định tự lành ghi ở `STALE_PENDING_INVITE_WINDOW` ("sync
                # kế tiếp thấy rogue pending → auto-revoke") cũng sai nốt: email đã
                # ACTIVE thì không còn là rogue pending, không ai thu hồi.
                #
                # Nay ca (b) KHÔNG chốt: xếp mẻ sync đi xem rồi để tick sau xử. Giam
                # tiền thêm vài phút là chuyện sửa được bằng một cú hoàn tay; hoàn
                # phí + xoá bản ghi một lời mời THÀNH CÔNG thì phải truy thu từng
                # khách. Xem [[hoan-phi-mu-khi-mời-khong-kiem-chung]].
                looked_after_defer = (
                    member.last_synced_at is not None
                    and member.last_synced_at > ev.timestamp
                ) or (
                    member.sync_missing_at is not None
                    and member.sync_missing_at > ev.timestamp
                )
                if not looked_after_defer:
                    # Gom theo workspace rồi xếp MỘT mẻ ở cuối tick: `enqueue_sync_probe`
                    # dedup theo workspace, gọi ngay trong vòng lặp thì email đầu tiên
                    # chiếm mất mẻ và 7 email còn lại của cùng mẻ mời không có tên
                    # trong payload — đúng kiểu bỏ sót đã gây ra ca này.
                    blind_by_ws.setdefault(member.workspace_id, []).append(email)
                    blind += 1
                    # Mù quá lâu = extension không chạy/không quét tới email này.
                    # Kêu MỘT lần cho admin nhìn thấy trên Nhật ký, vẫn KHÔNG hoàn
                    # phí: người xử lý tay quyết định đúng hơn một cái đồng hồ.
                    if now - ev.timestamp >= STALE_INVITE_BLIND_ESCALATE:
                        escalated = db.execute(
                            select(AuditLog.id)
                            .where(
                                AuditLog.action == "MEMBER_INVITE_UNVERIFIABLE",
                                AuditLog.target_type == "MEMBER",
                                AuditLog.target_id == mid,
                                AuditLog.timestamp > ev.timestamp,
                            )
                            .limit(1)
                        ).first()
                        if escalated is None:
                            log_event(
                                db,
                                actor_type="SYSTEM",
                                actor_label="system:stale-invite-resolver",
                                action="MEMBER_INVITE_UNVERIFIABLE",
                                result="ERROR",
                                target_type="MEMBER",
                                target_id=mid,
                                data={
                                    "email": email,
                                    "workspace_id": str(member.workspace_id),
                                    "queue_item_id": (ev.data or {}).get(
                                        "queue_item_id"
                                    ),
                                    "deferred_at": ev.timestamp.isoformat(),
                                    "blind_hours": round(
                                        (now - ev.timestamp).total_seconds() / 3600, 1
                                    ),
                                    "note": (
                                        "Lời mời treo 'chờ xác minh' quá lâu mà CHƯA "
                                        "có lượt đồng bộ nào đi xem — hệ thống KHÔNG "
                                        "tự hoàn phí để tránh hoàn oan lời mời đã đi "
                                        "thật. Mở ChatGPT kiểm tra email này: đã vào "
                                        "team thì bấm Đồng bộ, chưa vào thì hoàn phí "
                                        "tay."
                                    ),
                                },
                                commit=False,
                            )
                    continue

                # ── CẢ MẺ ĐI ĐƯỢC THÌ KHÔNG LỖI LẺ MỘT EMAIL ────────────────────
                # Mời một mẻ là MỘT lần bấm gửi: 16 email vào được mà email thứ
                # 17 hỏng RIÊNG là chuyện không xảy ra (user 29/8/2026). Cái
                # thường xảy ra là email đó được CHẤP NHẬN NGAY nên rời tab "Lời
                # mời" sang tab "Người dùng" — lượt quét chỉ nhìn tab "Lời mời"
                # thì không thấy, rồi mọi lớp phía sau đọc "không thấy" thành
                # "hỏng".
                #
                # CA THẬT 29/8/2026 (task e3380978, mẻ 17 email): 16 email
                # VERIFIED lúc 18:11, email còn lại bị hoãn; 42 phút sau resolver
                # chốt hỏng + hoàn 330.000đ + xoá bản ghi — 5 phút sau đồng bộ
                # thấy nó ĐANG Ở TRONG TEAM (`MEMBER_REFUND_WHILE_IN_TEAM`), tức
                # dịch vụ đã giao mà thực thu 0đ, phải truy thu tay.
                #
                # Nên: còn anh em cùng mẻ đã xác minh ⇒ GIỮ NGUYÊN, cử người đi
                # xem, để bằng chứng THẬT quyết. Đồng bộ thấy email → VERIFIED;
                # đồng bộ quét cả hai tab vẫn không thấy → nhánh
                # `close_invite_defer_with_missing_evidence` hoàn phí như cũ.
                # Hết giờ không phải bằng chứng.
                qid = (ev.data or {}).get("queue_item_id")
                siblings = _batch_verified_siblings(db, str(qid), email) if qid else []
                if siblings:
                    # Kêu MỘT lần cho mỗi mốc hoãn, không lặp mỗi tick.
                    already_held = db.execute(
                        select(AuditLog.id)
                        .where(
                            AuditLog.action == "MEMBER_INVITE_BATCH_HOLD",
                            AuditLog.target_type == "MEMBER",
                            AuditLog.target_id == mid,
                            AuditLog.timestamp > ev.timestamp,
                        )
                        .limit(1)
                    ).first()
                    if already_held is None:
                        log_event(
                            db,
                            actor_type="SYSTEM",
                            actor_label="system:stale-invite-resolver",
                            action="MEMBER_INVITE_BATCH_HOLD",
                            result="PENDING",
                            target_type="MEMBER",
                            target_id=mid,
                            data={
                                "email": email,
                                "workspace_id": str(member.workspace_id),
                                "queue_item_id": qid,
                                "verified_siblings": siblings[:20],
                                "sibling_count": len(siblings),
                                "note": (
                                    "Cùng mẻ mời với email đã xác minh nên lời mời "
                                    "này coi như đã gửi đi được — KHÔNG hoàn phí "
                                    "theo đồng hồ. Đang cử đồng bộ đi xem: thấy "
                                    "trong ChatGPT thì chốt thành công, quét cả hai "
                                    "tab vẫn không thấy mới hoàn phí."
                                ),
                            },
                            commit=False,
                        )
                    blind_by_ws.setdefault(member.workspace_id, []).append(email)
                    held += 1
                    continue

                # Ghi FAILED + hoàn phí + void kỳ + xoá phantom — MỘT bản dùng
                # chung với nhánh "đồng bộ không thấy email" (`completion.py`), để
                # đường tiền không có hai phiên bản trôi dạt khỏi nhau.
                fail_deferred_invite(
                    db,
                    member,
                    queue_item_id=(ev.data or {}).get("queue_item_id"),
                    actor_type="SYSTEM",
                    actor_label="system:stale-invite-resolver",
                    error_code="INVITE_UNVERIFIED_TIMEOUT",
                    now=now,
                )
                resolved += 1
            # Cử người ĐI XEM cho mọi email đang mù — một mẻ/workspace, đủ tên.
            for ws_id, ws_emails in blind_by_ws.items():
                if enqueue_sync_probe(db, workspace_id=ws_id, emails=ws_emails):
                    probed += 1
            # `blind` cũng phải commit: nhánh đó xếp mẻ sync + có thể ghi audit
            # MEMBER_INVITE_UNVERIFIABLE. Quên thì tick sau lại mù y hệt.
            if resolved or confirmed or blind or held:
                db.commit()
            if resolved:
                logger.info(
                    "[stale-invite] chốt FAILED %d lời mời kẹt limbo (>%d phút)",
                    resolved,
                    int(STALE_PENDING_INVITE_WINDOW.total_seconds() // 60),
                )
            if confirmed:
                logger.info(
                    "[stale-invite] GIỮ NGUYÊN %d lời mời: đồng bộ đã thấy email "
                    "trong ChatGPT sau mốc hoãn (không hoàn phí, không xoá)",
                    confirmed,
                )
            if held:
                logger.info(
                    "[stale-invite] GIỮ LẠI %d lời mời: cùng mẻ với email đã xác "
                    "minh ⇒ cả mẻ đã gửi đi được (không hoàn phí, chờ đồng bộ)",
                    held,
                )
            if blind:
                logger.info(
                    "[stale-invite] HOÃN TIẾP %d lời mời: chưa lượt đồng bộ nào đi "
                    "xem sau mốc hoãn → KHÔNG hoàn phí (xếp %d mẻ sync đi kiểm)",
                    blind,
                    probed,
                )
    except Exception as e:  # noqa: BLE001
        logger.warning("[stale-invite] tick failed: %s", e)
    finally:
        _stale_invite_lock.release()


def _auto_sync_slot_at(workspace_id: object, day: date) -> datetime:
    """Mốc chạy NGẪU NHIÊN của 1 workspace trong `day` (ngày theo giờ VN) → trả UTC.

    Ngẫu nhiên nhưng **tất định** theo (workspace, ngày): băm sha256 rồi lấy dư số
    phút trong khung giờ. Vì sao không `random`/`hash()`: mốc phải SỐNG SÓT qua khởi
    động lại API (deploy, restart container) — `random` cho mốc mới mỗi lần chạy, còn
    `hash()` của Python có salt riêng mỗi tiến trình. Tất định ⇒ tick 10′ nào trong
    ngày cũng nhìn thấy CÙNG một mốc, và test kiểm được.

    Hai workspace khác nhau (hoặc cùng workspace ngày khác nhau) rơi mốc khác nhau —
    lượt quét rải ra, không dồn một khung giờ.
    """
    span_minutes = (AUTO_SYNC_WINDOW_END_HOUR - AUTO_SYNC_WINDOW_START_HOUR) * 60
    digest = hashlib.sha256(f"{workspace_id}:{day.isoformat()}".encode()).digest()
    offset = int.from_bytes(digest[:8], "big") % span_minutes
    local = datetime(
        day.year,
        day.month,
        day.day,
        AUTO_SYNC_WINDOW_START_HOUR,
        tzinfo=AUTO_SYNC_TZ,
    ) + timedelta(minutes=offset)
    return local.astimezone(timezone.utc)


def _enqueue_periodic_sync_once() -> None:
    """ĐỒNG BỘ ĐỊNH KỲ: mỗi workspace 1 LẦN/NGÀY, vào mốc ngẫu nhiên của ngày đó →
    enqueue SYNC_DATA scope 'both' + publish SSE cho extension pick.

    Vì sao cần (xem khối hằng số trên): sync là nguồn đối chiếu DUY NHẤT giữa DB và
    ChatGPT — nó chỉ chạy khi có người bấm thì mọi lưới an toàn dựa trên sync
    (`_flag_fake_removals`, `MEMBER_SYNC_MISMATCH`, rogue pending) đều nằm chờ vô
    thời hạn. Job này biến "khi nào admin nhớ" thành "chậm nhất là ngày mai".

    KHÔNG tự chữa gì cả — chỉ tạo lệnh đối chiếu; mọi quyết định (mark removed,
    hồi sinh, cảnh báo lệch) vẫn nằm ở `bulk-upsert` với đủ guard sẵn có.

    Best-effort: lỗi DB chỉ log warning, không block lifecycle. Lock riêng tránh
    tick chồng (hot-reload spawn nhiều timer).
    """
    if not _auto_sync_lock.acquire(blocking=False):
        return
    try:
        with SessionLocal() as db:
            now = datetime.now(timezone.utc)
            today = now.astimezone(AUTO_SYNC_TZ).date()
            # Đầu ngày HÔM NAY theo giờ VN — mốc so "đã sync trong ngày chưa".
            day_start = datetime(
                today.year, today.month, today.day, tzinfo=AUTO_SYNC_TZ
            ).astimezone(timezone.utc)
            workspace_ids = db.execute(select(Workspace.id)).scalars().all()
            queued: list[tuple[object, str]] = []
            for workspace_id in workspace_ids:
                # (a) Đang có lệnh sync chờ/đang chạy → khỏi chồng thêm. Đây cũng là
                # cái chặn đọng lệnh khi extension offline dài ngày.
                open_task = db.execute(
                    select(QueueItem.id)
                    .where(
                        QueueItem.workspace_id == workspace_id,
                        QueueItem.type == "SYNC_DATA",
                        QueueItem.status.in_(("PENDING", "IN_PROGRESS")),
                    )
                    .limit(1)
                ).first()
                if open_task is not None:
                    continue
                # (b) Chưa tới mốc ngẫu nhiên của workspace này hôm nay → chờ tick sau.
                slot_at = _auto_sync_slot_at(workspace_id, today)
                if now < slot_at:
                    continue
                # (c) Hôm nay (giờ VN) đã có lệnh sync rồi → thôi, đúng 1 lần/ngày.
                # Tính MỌI status (kể cả FAILED) và mọi nguồn (tay lẫn tự động): admin
                # vừa bấm sync tay thì job nền không cần chen vào nữa.
                last_at = db.execute(
                    select(func.max(QueueItem.created_at)).where(
                        QueueItem.workspace_id == workspace_id,
                        QueueItem.type == "SYNC_DATA",
                    )
                ).scalar_one_or_none()
                if last_at is not None:
                    if last_at.tzinfo is None:
                        last_at = last_at.replace(tzinfo=timezone.utc)
                    if last_at >= day_start:
                        continue
                queue_item = QueueItem(
                    type="SYNC_DATA",
                    status="PENDING",
                    workspace_id=workspace_id,
                    # scope 'both': quét CẢ tab "Người dùng" lẫn "Lời mời đang
                    # chờ" — chỉ khi có cả hai thì reconcile mới dám dọn lời mời
                    # chết (xem chú thích đầu file). Giữ đúng khoá payload mà
                    # extension đọc (xem workspaces/triggers.py::trigger_sync).
                    payload={
                        "sync_scope": "both",
                        "include_pending": True,
                        "source": "scheduler",
                    },
                    # NULL: job nền không có user → cooldown 5 tiếng của admin phụ
                    # (lọc theo created_by_id) không bị job này ăn mất.
                    created_by_id=None,
                )
                db.add(queue_item)
                db.flush()
                log_event(
                    db,
                    actor_type="SYSTEM",
                    action="WORKSPACE_SYNC_QUEUED",
                    result="PENDING",
                    target_type="WORKSPACE",
                    target_id=str(workspace_id),
                    data={
                        "queue_item_id": str(queue_item.id),
                        "sync_scope": "both",
                        "source": "scheduler",
                        "last_sync_at": last_at.isoformat() if last_at else None,
                        # Mốc ngẫu nhiên đã chọn cho ngày hôm nay — có trong nhật ký
                        # thì lần sau khỏi phải hỏi "sao nó chạy giờ này".
                        "slot_at": slot_at.isoformat(),
                        "cadence": "daily-random",
                    },
                    commit=False,
                )
                queued.append((workspace_id, str(queue_item.id)))
            if queued:
                db.commit()
                for workspace_id, task_id in queued:
                    publish_task_event(
                        workspace_id,
                        {
                            "type": "task-available",
                            "task_id": task_id,
                            "task_type": "SYNC_DATA",
                        },
                    )
                logger.info(
                    "[auto-sync] enqueued %d lệnh đồng bộ định kỳ (1 lần/ngày, "
                    "mốc ngẫu nhiên %d–%dh giờ VN)",
                    len(queued),
                    AUTO_SYNC_WINDOW_START_HOUR,
                    AUTO_SYNC_WINDOW_END_HOUR,
                )
    except Exception as e:  # noqa: BLE001
        logger.warning("[auto-sync] tick failed: %s", e)
    finally:
        _auto_sync_lock.release()


def _schedule_auto_sync_tick() -> None:
    """Tick 10′ cho đồng bộ định kỳ. Nhịp tick chỉ quyết định độ SÁT mốc; chống
    trùng nằm ở guard trong `_enqueue_periodic_sync_once`."""
    global _auto_sync_timer
    try:
        _enqueue_periodic_sync_once()
    finally:
        _auto_sync_timer = threading.Timer(
            AUTO_SYNC_CHECK_INTERVAL_SEC, _schedule_auto_sync_tick
        )
        _auto_sync_timer.daemon = True
        _auto_sync_timer.start()


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
    #  - _schedule_auto_sync_tick : đồng bộ đối chiếu với ChatGPT (1 lần/ngày/workspace,
    #                               mốc ngẫu nhiên trong khung giờ VN — user 2026-08-13)
    _schedule_expiry_tick()
    _schedule_cleanup_tick()
    _schedule_order_cleanup_tick()
    _schedule_reminder_tick()
    _schedule_auto_sync_tick()
    try:
        yield
    finally:
        global _cleanup_timer, _order_cleanup_timer, _expiry_timer, _reminder_timer
        global _auto_sync_timer
        if _auto_sync_timer is not None:
            _auto_sync_timer.cancel()
            _auto_sync_timer = None
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
    # ⚠️ THỨ TỰ: `add_middleware` bọc từ trong ra ngoài, cái thêm SAU nằm NGOÀI.
    # Rate-limit thêm TRƯỚC CORS ⇒ nằm TRONG CORS ⇒ response 429/503 vẫn được
    # CORSMiddleware gắn header `Access-Control-Allow-Origin`. Nếu để rate-limit
    # ra ngoài cùng, extension (origin `chrome-extension://…`) sẽ thấy "network
    # error" thay vì đọc được mã lỗi + `retry_after_sec` để tự lùi nhịp.
    app.add_middleware(RateLimitMiddleware)
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
    app.include_router(admin_limits.router)

    @app.get("/health", tags=["meta"])
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
