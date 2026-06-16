"""Permission catalog cho Dashboard.

Quy ước:
- SUPER_ADMIN_ONLY: 5 permission cứng, chỉ super-admin có. KHÔNG cấp được cho sub-admin.
- GRANTABLE: 6 permission có thể tick cho từng sub-admin khi tạo/sửa.
- ALL_PERMISSIONS: union; super-admin mặc định có toàn bộ.
"""

from enum import StrEnum


class Permission(StrEnum):
    USER_MANAGE = "USER_MANAGE"
    EXTENSION_CONFIG = "EXTENSION_CONFIG"
    BILLING_VIEW = "BILLING_VIEW"
    BILLING_PAY = "BILLING_PAY"
    MEMBER_CHANGE_ROLE = "MEMBER_CHANGE_ROLE"
    UI_LABEL_MANAGE = "UI_LABEL_MANAGE"

    MEMBER_VIEW = "MEMBER_VIEW"
    MEMBER_INVITE = "MEMBER_INVITE"
    MEMBER_REMOVE = "MEMBER_REMOVE"
    WORKSPACE_SYNC_TRIGGER = "WORKSPACE_SYNC_TRIGGER"
    QUEUE_VIEW = "QUEUE_VIEW"
    AUDIT_LOG_VIEW = "AUDIT_LOG_VIEW"


SUPER_ADMIN_ONLY: frozenset[Permission] = frozenset(
    {
        Permission.USER_MANAGE,
        Permission.EXTENSION_CONFIG,
        Permission.BILLING_PAY,
        Permission.MEMBER_CHANGE_ROLE,
        Permission.UI_LABEL_MANAGE,
    }
)

GRANTABLE: frozenset[Permission] = frozenset(
    {
        Permission.MEMBER_VIEW,
        Permission.MEMBER_INVITE,
        Permission.MEMBER_REMOVE,
        Permission.WORKSPACE_SYNC_TRIGGER,
        Permission.QUEUE_VIEW,
        Permission.AUDIT_LOG_VIEW,
        # BILLING_VIEW: cấp được cho sub-admin (CHỈ xem thanh toán). BILLING_PAY
        # (thực hiện thanh toán) vẫn super-admin-only.
        Permission.BILLING_VIEW,
    }
)

ALL_PERMISSIONS: frozenset[Permission] = SUPER_ADMIN_ONLY | GRANTABLE


def validate_grantable(perms: list[str]) -> list[Permission]:
    """Validate input list — reject keys lạ và permission cứng. Trả về list Permission đã chuẩn hoá."""
    result: list[Permission] = []
    for raw in perms:
        try:
            p = Permission(raw)
        except ValueError as e:
            raise ValueError(f"Permission không hợp lệ: '{raw}'") from e
        if p in SUPER_ADMIN_ONLY:
            raise ValueError(
                f"Permission '{p.value}' chỉ thuộc super-admin, không cấp được cho sub-admin"
            )
        result.append(p)
    # dedupe, giữ order
    seen: set[Permission] = set()
    out: list[Permission] = []
    for p in result:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out
