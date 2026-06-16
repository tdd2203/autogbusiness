import re
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_session, require_super_admin
from app.models import User
from app.permissions import validate_grantable
from app.schemas import ResetPasswordIn, UserCreate, UserOut, UserUpdate
from app.security import hash_password

router = APIRouter(prefix="/api/v1/users", tags=["users"])


# Domain nội bộ cho email tự sinh khi tạo tài khoản phụ không nhập email.
# Tài khoản phụ đăng nhập bằng username; email chỉ để thoả ràng buộc NOT NULL +
# unique của cột. ".local" là TLD dành riêng, không định tuyến ra ngoài.
SYNTHETIC_EMAIL_DOMAIN = "no-email.local"


def _synthesize_email(username: str) -> str:
    """Sinh email nội bộ hợp lệ (EmailStr) từ username.

    Lọc ký tự không hợp lệ ở local-part; username là unique nên email sinh ra
    gần như luôn unique (va chạm hiếm sẽ bị bắt bởi check unique → 409).
    """
    local = re.sub(r"[^a-z0-9._%+-]", "", username.lower()).strip(".") or "user"
    return f"{local}@{SYNTHETIC_EMAIL_DOMAIN}"


def _email_or_username_taken(db: Session, email: str, username: str) -> tuple[bool, bool]:
    rows = db.execute(
        select(User.email, User.username).where(
            or_(User.email == email.lower(), User.username == username)
        )
    ).all()
    email_taken = any(r.email == email.lower() for r in rows)
    username_taken = any(r.username == username for r in rows)
    return email_taken, username_taken


@router.get("", response_model=list[UserOut])
def list_users(
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
) -> list[User]:
    return list(db.execute(select(User).order_by(User.created_at.desc())).scalars())


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(
    body: UserCreate,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> User:
    try:
        perms = validate_grantable(body.permissions)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e

    email = body.email.lower() if body.email else _synthesize_email(body.username)
    email_taken, username_taken = _email_or_username_taken(db, email, body.username)
    if email_taken or username_taken:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "email_taken": email_taken,
                "username_taken": username_taken,
            },
        )

    user = User(
        email=email,
        username=body.username,
        password_hash=hash_password(body.password),
        is_super_admin=False,
        is_active=True,
        permissions=[p.value for p in perms],
        created_by_id=actor.id,
    )
    db.add(user)
    db.flush()
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="USER_CREATED",
        result="SUCCESS",
        target_type="USER",
        target_id=str(user.id),
        data={
            "email": user.email,
            "username": user.username,
            "permissions": user.permissions,
        },
        commit=False,
    )
    db.commit()
    db.refresh(user)
    return user


@router.patch("/{user_id}", response_model=UserOut)
def update_user(
    user_id: UUID,
    body: UserUpdate,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> User:
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User không tồn tại")
    if target.is_super_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Không thể chỉnh sửa super-admin qua endpoint này",
        )

    changes: dict = {}

    if body.permissions is not None:
        try:
            perms = validate_grantable(body.permissions)
        except ValueError as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
            ) from e
        new_perms = [p.value for p in perms]
        if new_perms != (target.permissions or []):
            changes["permissions"] = {"before": target.permissions, "after": new_perms}
            target.permissions = new_perms

    if body.is_active is not None and body.is_active != target.is_active:
        changes["is_active"] = {"before": target.is_active, "after": body.is_active}
        target.is_active = body.is_active
        if not body.is_active:
            target.token_version = target.token_version + 1

    if not changes:
        return target

    db.add(target)
    action = "USER_UPDATED"
    if "is_active" in changes:
        action = "USER_DISABLED" if not target.is_active else "USER_ENABLED"
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action=action,
        result="SUCCESS",
        target_type="USER",
        target_id=str(target.id),
        data=changes,
        commit=False,
    )
    db.commit()
    db.refresh(target)
    return target


@router.post("/{user_id}/reset-password", status_code=status.HTTP_204_NO_CONTENT)
def reset_password(
    user_id: UUID,
    body: ResetPasswordIn,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> None:
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User không tồn tại")
    if target.is_super_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Super-admin phải tự đổi password qua /auth/change-password",
        )
    target.password_hash = hash_password(body.new_password)
    target.token_version = target.token_version + 1
    db.add(target)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="USER_PASSWORD_RESET",
        result="SUCCESS",
        target_type="USER",
        target_id=str(target.id),
        commit=False,
    )
    db.commit()
