from collections.abc import Iterator
from uuid import UUID

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from sqlalchemy import select

from app.db import get_db
from app.models import User, Workspace, WorkspaceAssignment
from app.permissions import Permission
from app.security import decode_access_token

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)


def get_session() -> Iterator[Session]:
    yield from get_db()


def get_current_user(
    token: str | None = Depends(oauth2_scheme),
    db: Session = Depends(get_session),
) -> User:
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token")
    try:
        payload = decode_access_token(token)
        user_id = UUID(payload["sub"])
        token_version = int(payload.get("tv", -1))
    except (ValueError, KeyError) as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token"
        ) from e
    user = db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="User inactive or not found"
        )
    if token_version != user.token_version:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token đã bị thu hồi, vui lòng đăng nhập lại",
        )
    return user


def require_permission(perm: Permission):
    """Dependency factory: require `perm` (super-admin luôn pass)."""

    def _checker(user: User = Depends(get_current_user)) -> User:
        if user.is_super_admin:
            return user
        if perm.value not in (user.permissions or []):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Thiếu permission: {perm.value}",
            )
        return user

    return _checker


def require_super_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_super_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Chỉ super-admin được phép"
        )
    return user


def user_can_access_workspace(db: Session, user: User, workspace_id: UUID) -> bool:
    """True nếu user được phép thao tác trên workspace.

    Super-admin: luôn True. Sub-admin: phải có row WorkspaceAssignment tương ứng.
    """
    if user.is_super_admin:
        return True
    row = db.execute(
        select(WorkspaceAssignment.id).where(
            WorkspaceAssignment.workspace_id == workspace_id,
            WorkspaceAssignment.user_id == user.id,
        )
    ).first()
    return row is not None


def assert_workspace_access(db: Session, user: User, workspace_id: UUID) -> None:
    """Raise 404 nếu sub-admin không được gán workspace này.

    Dùng 404 (không 403) để không tiết lộ sự tồn tại của workspace — đồng bộ với
    `_member_or_404_visible` ('không tồn tại hoặc bạn không có quyền truy cập').
    """
    if not user_can_access_workspace(db, user, workspace_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace không tồn tại hoặc bạn không có quyền truy cập",
        )


def require_extension_workspace(
    x_api_key: str | None = Header(default=None),
    db: Session = Depends(get_session),
) -> Workspace:
    """Extension auth: tra X-API-KEY → workspace tương ứng. 401 nếu không khớp.

    Side effect: cập nhật `last_extension_seen_at = NOW()` để dashboard biết extension đang online.
    """
    if not x_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing X-API-KEY header"
        )
    workspace = db.execute(
        select(Workspace).where(Workspace.extension_api_key == x_api_key)
    ).scalar_one_or_none()
    if not workspace:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API Key"
        )
    # Update last seen — separate transaction để tránh impact request chính
    from datetime import datetime, timezone

    workspace.last_extension_seen_at = datetime.now(timezone.utc)
    db.add(workspace)
    db.commit()
    db.refresh(workspace)
    return workspace
