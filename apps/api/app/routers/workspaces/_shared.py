"""Shared router + helpers cho package `workspaces`.

Mọi sub-module (crud.py, assignment.py, ...) import `router` và các helper từ đây
để đăng ký endpoint lên CÙNG một APIRouter (prefix `/api/v1/workspaces`).

Đây KHÔNG phải nơi chứa business logic của 1 chức năng cụ thể — chỉ những thứ
dùng chung giữa nhiều chức năng (lookup workspace, generate API key, normalize
domain). Mỗi chức năng có module + file docs (.md) riêng.
"""

import secrets
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from sqlalchemy.orm import Session

from app.models import Workspace

router = APIRouter(prefix="/api/v1/workspaces", tags=["workspaces"])


def _generate_api_key() -> str:
    """48-char URL-safe random string (≈288 bits entropy)."""
    return secrets.token_urlsafe(36)[:48]


def _get_workspace_or_404(db: Session, workspace_id: UUID) -> Workspace:
    ws = db.get(Workspace, workspace_id)
    if not ws:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace không tồn tại")
    return ws


def _normalize_domain(domain: str | None) -> str | None:
    """Chuẩn hoá tên miền: trim, bỏ '@'/scheme, lowercase. Rỗng → None."""
    if domain is None:
        return None
    d = domain.strip().lower().lstrip("@")
    d = d.removeprefix("https://").removeprefix("http://").rstrip("/")
    return d or None
