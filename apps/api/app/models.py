from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("email", name="uq_users_email"),
        UniqueConstraint("username", name="uq_users_username"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    username: Mapped[str] = mapped_column(String(64), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_super_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    token_version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    permissions: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    created_by_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=_utcnow
    )

    created_by = relationship("User", remote_side=[id], post_update=True)


class QueueItem(Base):
    """Task để Chrome Extension poll và thực thi trên ChatGPT Business UI."""

    __tablename__ = "queue_items"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    # INVITE_MEMBER | REMOVE_MEMBER | CHANGE_ROLE | SYNC_DATA | SYNC_BILLING
    type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    # PENDING | IN_PROGRESS | COMPLETED | FAILED
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="PENDING", index=True
    )
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    progress: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_by_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True
    )
    picked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    workspace_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    created_by = relationship("User")
    workspace = relationship("Workspace")


class AuditLog(Base):
    """Bản ghi audit bất biến — không sửa, không xoá."""

    __tablename__ = "audit_logs"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True
    )
    # ADMIN | EXTENSION | SYSTEM
    actor_type: Mapped[str] = mapped_column(String(16), nullable=False)
    actor_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True, index=True)
    actor_label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    action: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    # SUCCESS | FAILED | PENDING
    result: Mapped[str] = mapped_column(String(16), nullable=False)
    target_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    target_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)


class Workspace(Base):
    """Workspace ChatGPT Business mà admin quản lý qua Extension."""

    __tablename__ = "workspaces"
    __table_args__ = (
        UniqueConstraint("chatgpt_id", name="uq_workspaces_chatgpt_id"),
        UniqueConstraint("extension_api_key", name="uq_workspaces_extension_api_key"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    chatgpt_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    plan: Mapped[str | None] = mapped_column(String(32), nullable=True)
    seat_total: Mapped[int | None] = mapped_column(Integer, nullable=True)
    seat_used: Mapped[int | None] = mapped_column(Integer, nullable=True)
    extension_api_key: Mapped[str] = mapped_column(String(128), nullable=False)
    last_synced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    chatgpt_user_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    chatgpt_user_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    last_extension_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Billing fields đồng bộ từ trang chatgpt.com/admin/billing
    # billing_status: PAID | UNPAID | UNKNOWN
    billing_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    renewal_date: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_billing_synced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Lịch sử hoá đơn scrape từ /admin/billing — list các transactions:
    #   [{"date": "2026-05-17", "amount_vnd": 230535, "quantity": 1, "status": "paid"}]
    # Dashboard dùng để (1) hiển thị lịch sử và (2) ước tính giá per-slot hôm
    # nay dựa trên transaction gần nhất + days_until_renewal.
    billing_invoices: Mapped[list[dict] | None] = mapped_column(
        JSONB, nullable=True
    )
    # Tên miền đã xác minh của workspace (vd "ndaigroup.org") — extension quét 1
    # lần từ /admin/identity rồi lưu. Dùng để quyết định có cần bật toggle "Cho
    # phép lời mời ngoài tên miền" khi invite: nếu MỌI email thuộc domain này thì
    # KHÔNG cần bật (nhanh + an toàn); chỉ bật khi có email ngoài domain.
    verified_domain: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=_utcnow
    )


class WorkspaceAssignment(Base):
    """Gán quyền sở hữu 1 Workspace cho 1 sub-admin user.

    Many-to-many: 1 user quản nhiều workspace, 1 workspace có thể gán cho ≥1 user.
    Super-admin KHÔNG cần row này (thấy mọi workspace). Sub-admin chỉ thấy & thao
    tác trên workspace có assignment tương ứng — xem `assert_workspace_access`.
    """

    __tablename__ = "workspace_assignments"
    __table_args__ = (
        UniqueConstraint(
            "workspace_id", "user_id", name="uq_workspace_assignments_ws_user"
        ),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    workspace_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    assigned_by_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    workspace = relationship("Workspace")
    user = relationship("User", foreign_keys=[user_id])
    assigned_by = relationship("User", foreign_keys=[assigned_by_id])


class WorkspaceSettings(Base):
    """Cấu hình rate limit + dry-run cho từng workspace."""

    __tablename__ = "workspace_settings"

    workspace_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        primary_key=True,
    )
    rate_limit_invite_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=5000)
    rate_limit_role_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=3000)
    rate_limit_remove_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=5000)
    dry_run_mode: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class Member(Base):
    """Member của 1 Workspace ChatGPT — đồng bộ từ scrape Extension hoặc tạo qua invite."""

    __tablename__ = "members"
    __table_args__ = (
        UniqueConstraint("workspace_id", "email", name="uq_members_workspace_email"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    workspace_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # owner | admin | member
    chatgpt_role: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # Loại suất cấp phép trên ChatGPT admin: ChatGPT | Codex. NULL = chưa scrape.
    license_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # active | pending | removed
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active", index=True)
    invited_by_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    joined_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_synced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # Subscription tracking (Dashboard-only, ChatGPT không có khái niệm này).
    # subscription_months: số tháng admin commit cho member (mặc định 1, NULL = unlimited).
    # subscription_end_at: derived = created_at + subscription_months × 30 days; store
    # explicit để query/index nhanh + cho phép extend riêng end_at mà không đổi months.
    subscription_months: Mapped[int | None] = mapped_column(Integer, nullable=True)
    subscription_end_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    # Payment tracking (Dashboard-only) — phục vụ tài khoản phụ bán dịch vụ: theo
    # dõi email mình đã add đã trả tiền cho admin hay chưa. KHÔNG liên quan billing
    # workspace. unpaid | paid. paid_at = thời điểm duyệt; paid_marked_by_id = ai duyệt.
    payment_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="unpaid", server_default="unpaid", index=True
    )
    paid_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    paid_marked_by_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    workspace = relationship("Workspace")
    invited_by = relationship("User", foreign_keys=[invited_by_user_id])


class UiLabel(Base):
    """Label UI ChatGPT đã calibrate cho 1 (locale, page, control_key).

    Khi extension thực thi action, đọc label_text từ đây để match DOM —
    KHÔNG hardcode trong code. Khi ChatGPT đổi UI, chỉ cần harvest lại đúng
    page/locale bị lỗi qua trang Settings → UI Labels.
    """

    __tablename__ = "ui_labels"
    __table_args__ = (
        UniqueConstraint(
            "locale", "page", "control_key", name="uq_ui_labels_locale_page_key"
        ),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    locale: Mapped[str] = mapped_column(String(8), nullable=False, index=True)
    page: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    control_key: Mapped[str] = mapped_column(String(64), nullable=False)
    label_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    aria_label: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    stale: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    stale_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    stale_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    updated_by_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=_utcnow
    )

    updated_by = relationship("User")


class UiLabelHistory(Base):
    """Snapshot mỗi version trước đó của 1 UiLabel — rollback khi harvest sai."""

    __tablename__ = "ui_label_history"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    label_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("ui_labels.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    label_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    aria_label: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_by_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Invite(Base):
    """Bản ghi lời mời thành viên (tracking song song với QueueItem INVITE_MEMBER)."""

    __tablename__ = "invites"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    workspace_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # pending | accepted | expired | revoked | failed
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending", index=True)
    queue_item_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("queue_items.id", ondelete="SET NULL"),
        nullable=True,
    )
    invited_by_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    workspace = relationship("Workspace")
    invited_by = relationship("User")
    queue_item = relationship("QueueItem")
