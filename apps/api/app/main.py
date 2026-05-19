import logging
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.models import Member, QueueItem
from app.routers import audit_logs, auth, members, queue, ui_labels, users, workspaces
from app.seed import seed_super_admin
from app.sse import publish_task_event
from app.audit import log_event

logger = logging.getLogger(__name__)

# Background scheduler — cleanup expired subscriptions mỗi giờ.
SUBSCRIPTION_CLEANUP_INTERVAL_SEC = 60 * 60  # 1 giờ
_cleanup_timer: threading.Timer | None = None
_cleanup_lock = threading.Lock()


def _cleanup_expired_subscriptions_once() -> None:
    """Quét MỌI workspace tìm member có subscription_end_at <= now và status
    active/pending → enqueue 1 REMOVE_MEMBER task cho mỗi member.

    Best-effort: lỗi DB không block lifecycle, chỉ log warning. Lock để tránh
    race condition (vd dev hot reload spawn nhiều timer).
    """
    if not _cleanup_lock.acquire(blocking=False):
        return
    try:
        with SessionLocal() as db:
            now = datetime.now(timezone.utc)
            expired = (
                db.execute(
                    select(Member).where(
                        Member.status.in_(("active", "pending")),
                        Member.subscription_end_at.isnot(None),
                        Member.subscription_end_at <= now,
                    )
                )
                .scalars()
                .all()
            )
            if not expired:
                return
            # Group theo workspace để publish event 1 lần / workspace
            ws_emails: dict = {}
            for member in expired:
                queue_item = QueueItem(
                    type="REMOVE_MEMBER",
                    status="PENDING",
                    workspace_id=member.workspace_id,
                    payload={"member_id": str(member.id), "email": member.email},
                    created_by_id=None,  # system-initiated
                )
                db.add(queue_item)
                db.flush()
                log_event(
                    db,
                    actor_type="SYSTEM",
                    actor_id=None,
                    actor_label="auto-cleanup-scheduler",
                    action="MEMBER_EXPIRED_REMOVE_QUEUED",
                    result="PENDING",
                    target_type="MEMBER",
                    target_id=str(member.id),
                    data={
                        "workspace_id": str(member.workspace_id),
                        "email": member.email,
                        "subscription_end_at": member.subscription_end_at.isoformat()
                        if member.subscription_end_at
                        else None,
                        "queue_item_id": str(queue_item.id),
                        "trigger": "scheduler",
                    },
                    commit=False,
                )
                ws_emails.setdefault(member.workspace_id, []).append(member.email)
            db.commit()
            for ws_id, emails in ws_emails.items():
                for email in emails:
                    try:
                        publish_task_event(
                            ws_id,
                            {
                                "type": "task-available",
                                "task_type": "REMOVE_MEMBER",
                                "email": email,
                            },
                        )
                    except Exception:  # noqa: BLE001
                        pass
            logger.info(
                "[cleanup-scheduler] enqueued %d REMOVE_MEMBER tasks across %d workspaces",
                len(expired),
                len(ws_emails),
            )
    except Exception as e:  # noqa: BLE001
        logger.warning("[cleanup-scheduler] tick failed: %s", e)
    finally:
        _cleanup_lock.release()


def _schedule_cleanup_tick() -> None:
    """Tự reschedule sau mỗi tick. Hoạt động trong main process thread."""
    global _cleanup_timer
    try:
        _cleanup_expired_subscriptions_once()
    finally:
        _cleanup_timer = threading.Timer(
            SUBSCRIPTION_CLEANUP_INTERVAL_SEC, _schedule_cleanup_tick
        )
        _cleanup_timer.daemon = True
        _cleanup_timer.start()


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


@asynccontextmanager
async def lifespan(_: FastAPI):
    _run_alembic_upgrade_head()
    with SessionLocal() as db:
        seed_super_admin(db)
    # Start background scheduler — tick ngay 1 lần để cleanup các member đã hết
    # hạn từ trước, sau đó reschedule mỗi giờ.
    _schedule_cleanup_tick()
    try:
        yield
    finally:
        global _cleanup_timer
        if _cleanup_timer is not None:
            _cleanup_timer.cancel()
            _cleanup_timer = None


def create_app() -> FastAPI:
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
    app.include_router(queue.router)
    app.include_router(audit_logs.router)
    app.include_router(ui_labels.router)

    @app.get("/health", tags=["meta"])
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
