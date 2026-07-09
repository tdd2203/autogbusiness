"""Chức năng: MEMBER LOOKUP (tra cứu member theo danh sách email).

⚠️ ĐỌC `lookup.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.

Phục vụ panel "xem trước" của modal Cập nhật hàng loạt: admin dán email → trả về
thông tin từng member trong WORKSPACE hiện tại (thời gian add, hạn dùng, chủ sở
hữu) + danh sách email không khớp member nào. Query-only, không ghi.

Endpoint:
  - POST /lookup  → lookup_members
"""

from uuid import UUID

from fastapi import Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.deps import assert_workspace_access, get_session, require_permission
from app.models import Member, User
from app.permissions import Permission
from app.schemas import MemberLookupIn, MemberLookupOut, MemberLookupRow

from ._shared import router, _get_workspace_or_404, _visibility_filter


@router.post("/lookup", response_model=MemberLookupOut)
def lookup_members(
    workspace_id: UUID,
    body: MemberLookupIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_VIEW)),
) -> MemberLookupOut:
    """Tra cứu member trong workspace theo email (panel xem trước modal hàng loạt).

    - Chỉ member còn trong team (`status != 'removed'`).
    - Sub-admin chỉ thấy member mình mời (visibility filter); super-admin thấy hết.
    - `found`: email khớp 1 member; `not_found`: email còn lại (sai chính tả, đã
      rời team, hoặc ngoài tầm nhìn của user) — khớp cách bulk-remove bỏ qua chúng.
    """
    _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)

    # Dedupe + chuẩn hoá lowercase: so khớp không phân biệt hoa thường.
    wanted = {e.strip().lower() for e in body.emails if e.strip()}

    stmt = (
        select(Member)
        .options(selectinload(Member.invited_by))
        .where(
            Member.workspace_id == workspace_id,
            Member.status != "removed",
            func.lower(Member.email).in_(wanted),
        )
    )
    stmt = _visibility_filter(stmt, user)

    found: list[MemberLookupRow] = []
    matched: set[str] = set()
    for m in db.execute(stmt).scalars():
        matched.add(m.email.lower())
        found.append(
            MemberLookupRow(
                member_id=m.id,
                email=m.email,
                name=m.name,
                status=m.status,
                license_type=m.license_type,
                # Khớp cột "Ngày thêm" của dashboard: re-invite giữ created_at cũ.
                added_at=m.last_invited_at or m.created_at,
                subscription_end_at=m.subscription_end_at,
                usage_limit_credits=m.usage_limit_credits,
                owner_user_id=m.invited_by_user_id,
                owner_username=m.invited_by.username if m.invited_by else None,
            )
        )

    not_found = sorted(wanted - matched)
    return MemberLookupOut(found=found, not_found=not_found)
