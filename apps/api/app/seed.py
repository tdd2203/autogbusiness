"""Seed super-admin từ env nếu chưa tồn tại. Idempotent."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.config import get_settings
from app.models import User
from app.security import hash_password


def seed_super_admin(db: Session) -> User | None:
    settings = get_settings()
    existing = db.execute(select(User).where(User.is_super_admin.is_(True))).scalar_one_or_none()
    if existing:
        return None

    user = User(
        email=settings.super_admin_email.lower(),
        username=settings.super_admin_username,
        password_hash=hash_password(settings.super_admin_password),
        is_super_admin=True,
        is_active=True,
        permissions=[],
    )
    db.add(user)
    db.flush()
    log_event(
        db,
        actor_type="SYSTEM",
        action="SUPER_ADMIN_SEEDED",
        target_type="USER",
        target_id=str(user.id),
        data={"email": user.email, "username": user.username},
        commit=False,
    )
    db.commit()
    db.refresh(user)
    return user
