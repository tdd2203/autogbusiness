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
    # Quyền yêu cầu đặt giới hạn tín dụng/tháng cho member. Sub-admin có quyền này
    # vẫn phải được super-admin DUYỆT từng lệnh + chỉ đặt trong ngân sách được cấp.
    MEMBER_SET_USAGE_LIMIT = "MEMBER_SET_USAGE_LIMIT"
    # 2 mục MỚI trong menu "..." của member đã tham gia trên ChatGPT (2026-08).
    # Cả 2 KHÔNG nằm trong quyền mặc định của tài khoản phụ và KHÔNG backfill cho
    # tài khoản cũ ⇒ mặc định CHỈ super-admin dùng được; super-admin cấp tay mới mở.
    # MEMBER_EXPORT_DATA: yêu cầu ChatGPT xuất dữ liệu (hội thoại) của 1 member.
    MEMBER_EXPORT_DATA = "MEMBER_EXPORT_DATA"
    # MEMBER_DELETE_DATA: XOÁ TOÀN BỘ dữ liệu của 1 member — KHÔNG HOÀN TÁC, phá huỷ
    # nặng hơn cả MEMBER_REMOVE (remove chỉ gỡ khỏi workspace, dữ liệu còn nguyên).
    MEMBER_DELETE_DATA = "MEMBER_DELETE_DATA"
    # Sync 1 member lẻ / batch pending (tab "Chờ tham gia") + sync billing. Mặc định
    # BẬT cho sub-admin — thao tác nhẹ, chỉ đọc lại trạng thái vài email.
    WORKSPACE_SYNC_TRIGGER = "WORKSPACE_SYNC_TRIGGER"
    # Nút TO "Đồng bộ từ ChatGPT" (full-sync toàn workspace: scrape TOÀN BỘ member/
    # invite). Tách riêng để KHOÁ ĐỘC LẬP với sync lẻ — mặc định TẮT (không nằm trong
    # perms mặc định của sub-admin), super-admin cấp thủ công mới có.
    WORKSPACE_FULL_SYNC = "WORKSPACE_FULL_SYNC"
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
        Permission.MEMBER_SET_USAGE_LIMIT,
        # Cấp được nhưng KHÔNG default-on (không có trong perms mặc định sub-admin,
        # không migration backfill) ⇒ khoá sẵn với mọi tài khoản phụ cũ lẫn mới.
        Permission.MEMBER_EXPORT_DATA,
        Permission.MEMBER_DELETE_DATA,
        Permission.WORKSPACE_SYNC_TRIGGER,
        Permission.WORKSPACE_FULL_SYNC,
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
