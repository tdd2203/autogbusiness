from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_current_user, get_session
from app.models import User
from app.permissions import ALL_PERMISSIONS
from app.schemas import ChangePasswordIn, LoginIn, TokenOut, UserOut
from app.security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


def _permissions_for_token(user: User) -> list[str]:
    if user.is_super_admin:
        return [p.value for p in ALL_PERMISSIONS]
    return list(user.permissions or [])


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, db: Session = Depends(get_session)) -> TokenOut:
    ident = body.identifier.strip()
    ident_lower = ident.lower()
    user = db.execute(
        select(User).where(or_(User.email == ident_lower, User.username == ident))
    ).scalar_one_or_none()

    if not user or not verify_password(body.password, user.password_hash):
        log_event(
            db,
            actor_type="ADMIN",
            actor_label=ident,
            action="LOGIN_FAILED",
            result="FAILED",
            data={"identifier": ident},
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Email/Username hoặc mật khẩu không đúng",
        )

    if not user.is_active:
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=user.id,
            actor_label=user.email,
            action="LOGIN_BLOCKED_DISABLED",
            result="FAILED",
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tài khoản đã bị vô hiệu hóa. Vui lòng liên hệ super-admin",
        )

    perms = _permissions_for_token(user)
    token = create_access_token(user.id, user.is_super_admin, perms, user.token_version)

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="LOGIN_SUCCESS",
        result="SUCCESS",
    )
    return TokenOut(access_token=token)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)) -> User:
    if user.is_super_admin:
        # trả về permissions đầy đủ cho FE render UI
        user.permissions = [p.value for p in ALL_PERMISSIONS]
    return user


@router.post("/change-password", response_model=TokenOut)
def change_password(
    body: ChangePasswordIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> TokenOut:
    if not verify_password(body.old_password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Mật khẩu cũ không đúng"
        )
    user.password_hash = hash_password(body.new_password)
    user.token_version = user.token_version + 1
    db.add(user)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="PASSWORD_CHANGED",
        result="SUCCESS",
        target_type="USER",
        target_id=str(user.id),
        commit=False,
    )
    db.commit()
    db.refresh(user)
    perms = _permissions_for_token(user)
    new_token = create_access_token(user.id, user.is_super_admin, perms, user.token_version)
    return TokenOut(access_token=new_token)
