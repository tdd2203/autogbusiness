"""Shared router + helpers cho package `ui_labels`.

Mọi sub-module (manage.py, harvest.py) import `router` và các helper/const từ đây
để đăng ký endpoint lên CÙNG một APIRouter
(prefix `/api/v1/ui-labels`, tags `ui-labels`).

Đây KHÔNG phải nơi chứa business logic của 1 chức năng cụ thể — chỉ những thứ
dùng chung giữa nhiều chức năng (ma trận locale × page, helper push history). Mỗi
chức năng có module + file docs (.md) riêng.
"""

from uuid import UUID

from fastapi import APIRouter
from sqlalchemy.orm import Session

from app.models import UiLabel, UiLabelHistory

router = APIRouter(prefix="/api/v1/ui-labels", tags=["ui-labels"])


LOCALES: tuple[str, ...] = ("vi", "en", "zh")
PAGES: tuple[str, ...] = (
    "/admin/members",
    "/admin/billing",
    "/admin/billing?tab=invoices",
    "/admin/identity",
)
CONTROL_KEYS_BY_PAGE: dict[str, tuple[str, ...]] = {
    "/admin/members": (
        "tab_active_members",
        "tab_pending_invites",
        "tab_pending_requests",
        "invite_button_open",
        "invite_add_more_button",
        "invite_role_owner",
        "invite_role_admin",
        "invite_role_member",
        "invite_submit_button",
        # member_row_menu_button: icon-only button (chỉ aria-label hoặc rỗng),
        # extension dùng CSS selector tìm — không cần text label trong DB.
        "menu_remove_member",
        "menu_change_role",
        "confirm_remove_button",
        "menu_revoke_invite",
        "confirm_revoke_button",
    ),
    "/admin/billing": ("tab_billing_plan", "tab_billing_invoices"),
    "/admin/billing?tab=invoices": ("tab_billing_invoices",),
    "/admin/identity": ("toggle_external_invites",),
}


def _push_history(db: Session, label: UiLabel, actor_id: UUID | None) -> None:
    db.add(
        UiLabelHistory(
            label_id=label.id,
            version=label.version,
            label_text=label.label_text,
            aria_label=label.aria_label,
            notes=label.notes,
            created_by_id=actor_id,
        )
    )
