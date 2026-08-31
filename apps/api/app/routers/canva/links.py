"""Chức năng: LƯU LIÊN KẾT MỜI DUY NHẤT của Canva (extension gọi sau khi mời xong).

Canva sinh cho MỖI email một liên kết riêng, chỉ chính email đó dùng được. Extension
bắt lại chuỗi lúc bấm "Sao chép liên kết" rồi gửi lên đây; dashboard hiện nút sao chép
ở dòng thành viên tương ứng.

Endpoint (đăng ký lên router dùng chung từ `_shared`, prefix `/api/v1/canva`):
  - POST /invite-links  → save_invite_links (auth X-API-KEY của workspace)
"""

from uuid import UUID

from fastapi import Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import get_session, require_extension_workspace
from app.models import Member, Workspace

from ._shared import router


class CanvaInviteLinksIn(BaseModel):
    workspace_id: UUID
    #: {email: liên kết}. Email không có trong team thì bỏ qua, không báo lỗi.
    links: dict[str, str] = Field(default_factory=dict)


@router.post("/invite-links", response_model=dict)
def save_invite_links(
    body: CanvaInviteLinksIn,
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> dict:
    """Gắn liên kết mời vào đúng member. Bỏ qua email lạ thay vì báo lỗi.

    Link là TIỆN ÍCH đi kèm một lệnh mời ĐÃ gửi thật và ĐÃ trừ tiền: lỗi ở đây tuyệt
    đối không được làm hỏng lệnh mời đó. Vì vậy mọi trường hợp "không khớp" chỉ đơn
    giản là không lưu, và số lưu được trả về để extension ghi log.
    """
    if body.workspace_id != workspace.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Khoá API không thuộc không gian này.",
        )

    wanted = {
        email.strip().lower(): link.strip()
        for email, link in body.links.items()
        if email and link and link.strip().lower().startswith("http")
    }
    if not wanted:
        return {"updated": 0}

    members = (
        db.execute(
            select(Member).where(
                Member.workspace_id == workspace.id,
                Member.email.in_(list(wanted)),
            )
        )
        .scalars()
        .all()
    )
    for m in members:
        m.invite_link = wanted[m.email]
        db.add(m)
    db.commit()
    return {"updated": len(members)}
