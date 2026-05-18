from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field


# ---------- Auth ----------
class LoginIn(BaseModel):
    identifier: str = Field(..., description="Email hoặc username")
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"


class ChangePasswordIn(BaseModel):
    old_password: str
    new_password: str = Field(..., min_length=8)


# ---------- User ----------
class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    email: EmailStr
    username: str
    is_super_admin: bool
    is_active: bool
    permissions: list[str]
    created_at: datetime
    updated_at: datetime


class UserCreate(BaseModel):
    email: EmailStr
    username: str = Field(..., min_length=3, max_length=64)
    password: str = Field(..., min_length=8)
    permissions: list[str] = Field(default_factory=list)


class UserUpdate(BaseModel):
    permissions: list[str] | None = None
    is_active: bool | None = None


class ResetPasswordIn(BaseModel):
    new_password: str = Field(..., min_length=8)


# ---------- Queue ----------
QueueType = Literal[
    "INVITE_MEMBER",
    "REMOVE_MEMBER",
    "CHANGE_ROLE",
    "SYNC_DATA",
    "SYNC_BILLING",
    "REVOKE_INVITES",
    "HARVEST_LABELS",
]
QueueStatus = Literal["PENDING", "IN_PROGRESS", "COMPLETED", "FAILED"]


class QueueCreate(BaseModel):
    type: QueueType
    workspace_id: UUID | None = None
    payload: dict = Field(default_factory=dict)


class QueueUpdate(BaseModel):
    status: QueueStatus
    result: dict | None = None
    error_code: str | None = None
    error_message: str | None = None


class QueueOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    type: str
    status: str
    payload: dict
    result: dict | None
    progress: dict | None
    error_code: str | None
    error_message: str | None
    workspace_id: UUID | None
    created_by_id: UUID | None
    created_at: datetime
    picked_at: datetime | None
    completed_at: datetime | None


class QueueProgressUpdate(BaseModel):
    """Extension báo tiến độ real-time cho task dài (sync 500 members, v.v.)."""

    progress: dict


# ---------- Workspace ----------
WorkspacePlan = Literal["business", "enterprise"]


# ChatGPT Business cho phép mua tối đa 999 ghế.
SEAT_TOTAL_MAX = 999

BillingStatus = Literal["PAID", "UNPAID", "UNKNOWN"]


class WorkspaceCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    chatgpt_id: str | None = Field(default=None, max_length=128)
    plan: WorkspacePlan | None = None
    seat_total: int | None = Field(default=None, ge=0, le=SEAT_TOTAL_MAX)


class WorkspaceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    chatgpt_id: str | None = Field(default=None, max_length=128)
    plan: WorkspacePlan | None = None
    seat_total: int | None = Field(default=None, ge=0, le=SEAT_TOTAL_MAX)


class WorkspaceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    chatgpt_id: str | None
    plan: str | None
    seat_total: int | None
    seat_used: int | None
    last_synced_at: datetime | None
    chatgpt_user_email: str | None
    chatgpt_user_name: str | None
    last_extension_seen_at: datetime | None
    billing_status: str | None
    renewal_date: datetime | None
    last_billing_synced_at: datetime | None
    billing_invoices: list[dict] | None = None
    created_at: datetime
    updated_at: datetime


class BillingInvoice(BaseModel):
    """Một dòng trong bảng "Hoá đơn" trên /admin/billing."""

    date: datetime
    amount_vnd: int = Field(ge=0)
    status: str = Field(default="unknown", max_length=16)


class BillingSyncIn(BaseModel):
    """Extension báo billing scraped từ chatgpt.com/admin/billing.

    Tất cả field optional — extension chỉ gửi field nào scrape được.
    """

    plan: str | None = Field(default=None, max_length=32)
    seat_total: int | None = Field(default=None, ge=0, le=SEAT_TOTAL_MAX)
    seat_used: int | None = Field(default=None, ge=0, le=SEAT_TOTAL_MAX)
    billing_status: BillingStatus | None = None
    renewal_date: datetime | None = None
    invoices: list[BillingInvoice] | None = None


class ExtensionInfoIn(BaseModel):
    """Extension report ChatGPT user đang đăng nhập trên browser."""

    email: str | None = None
    name: str | None = None


class WorkspaceWithKey(WorkspaceOut):
    """Trả về kèm extension_api_key — CHỈ dùng khi vừa tạo / regenerate, không trả ở list."""

    extension_api_key: str


class WorkspaceSettingsOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    workspace_id: UUID
    rate_limit_invite_ms: int
    rate_limit_role_ms: int
    rate_limit_remove_ms: int
    dry_run_mode: bool


class WorkspaceSettingsUpdate(BaseModel):
    rate_limit_invite_ms: int | None = Field(default=None, ge=0, le=600_000)
    rate_limit_role_ms: int | None = Field(default=None, ge=0, le=600_000)
    rate_limit_remove_ms: int | None = Field(default=None, ge=0, le=600_000)
    dry_run_mode: bool | None = None


# ---------- Member ----------
ChatGPTRole = Literal["owner", "admin", "member"]
MemberStatus = Literal["active", "pending", "removed"]


class MemberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    workspace_id: UUID
    email: EmailStr
    name: str | None
    chatgpt_role: str | None
    status: str
    invited_by_user_id: UUID | None
    joined_at: datetime | None
    last_synced_at: datetime | None
    created_at: datetime


class MemberUpsert(BaseModel):
    email: EmailStr
    name: str | None = None
    chatgpt_role: ChatGPTRole | None = None
    status: MemberStatus = "active"
    joined_at: datetime | None = None


class MemberBulkUpsert(BaseModel):
    """Extension gọi sau khi scrape danh sách member của workspace."""

    members: list[MemberUpsert]
    is_full_sync: bool = True  # legacy: True = reconcile active+pending; False = không reconcile
    # Mới (override is_full_sync): liệt kê status nào đã scrape. Backend sẽ
    # mark "removed" chỉ những member trong DB có status thuộc danh sách này
    # mà KHÔNG xuất hiện trong scrape. Vd:
    #   - sync 1 tab "Người dùng" → scraped_statuses=["active"] → chỉ reconcile active
    #   - sync 3 tab → scraped_statuses=["active","pending"] → reconcile cả 2
    scraped_statuses: list[Literal["active", "pending"]] | None = None


class MemberInviteIn(BaseModel):
    email: EmailStr
    role: ChatGPTRole = "member"


class MemberBulkInviteIn(BaseModel):
    """Mời nhiều email cùng lúc qua 1 ChatGPT dialog (click 'Thêm nhiều hơn')."""

    emails: list[EmailStr] = Field(min_length=1, max_length=200)
    role: ChatGPTRole = "member"


class MemberChangeRoleIn(BaseModel):
    new_role: ChatGPTRole


# ---------- Invite ----------
InviteStatus = Literal["pending", "accepted", "expired", "revoked", "failed"]


class InviteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    workspace_id: UUID
    email: EmailStr
    role: str | None
    status: str
    queue_item_id: UUID | None
    invited_by_user_id: UUID | None
    created_at: datetime
    expires_at: datetime | None


# ---------- UI Labels ----------
UiLabelLocale = Literal["vi", "en", "zh"]
UiLabelPage = Literal[
    "/admin/members",
    "/admin/billing",
    "/admin/billing?tab=invoices",
    "/admin/identity",
]


class UiLabelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    locale: str
    page: str
    control_key: str
    label_text: str | None
    aria_label: str | None
    notes: dict | None
    stale: bool
    stale_reason: str | None
    stale_count: int
    version: int
    updated_by_id: UUID | None
    created_at: datetime
    updated_at: datetime


class UiLabelItemIn(BaseModel):
    control_key: str = Field(..., min_length=1, max_length=64)
    label_text: str | None = Field(default=None, max_length=512)
    aria_label: str | None = Field(default=None, max_length=512)
    notes: dict | None = None


class UiLabelBulkIn(BaseModel):
    """Console harvester / Settings page gửi 1 lần cho 1 (locale, page)."""

    locale: UiLabelLocale
    page: UiLabelPage
    labels: list[UiLabelItemIn] = Field(min_length=1, max_length=64)
    scrape_notes: dict | None = None


class UiLabelUpdate(BaseModel):
    label_text: str | None = Field(default=None, max_length=512)
    aria_label: str | None = Field(default=None, max_length=512)
    notes: dict | None = None


class UiLabelReportIn(BaseModel):
    """Extension báo: chạy action mà không match được label DB → mark stale."""

    locale: UiLabelLocale
    page: UiLabelPage
    control_key: str = Field(..., min_length=1, max_length=64)
    expected: str | None = Field(default=None, max_length=512)
    dom_sample: str | None = Field(default=None, max_length=2000)


class UiLabelHarvestPageIn(BaseModel):
    """1 page trong payload auto-harvest từ extension."""

    page: UiLabelPage
    labels: list[UiLabelItemIn] = Field(default_factory=list)


class UiLabelHarvestIn(BaseModel):
    """Extension auto-quét DOM trên chatgpt.com → bulk upsert nhiều page cùng locale."""

    locale: UiLabelLocale
    pages: list[UiLabelHarvestPageIn] = Field(min_length=1, max_length=8)


class UiLabelHarvestOut(BaseModel):
    locale: str
    pages: dict[str, int]  # page → số label upsert
    total: int


class UiLabelHistoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    label_id: UUID
    version: int
    label_text: str | None
    aria_label: str | None
    notes: dict | None
    created_by_id: UUID | None
    created_at: datetime


class UiLabelCoverageCell(BaseModel):
    total: int
    filled: int
    stale: int


class UiLabelCoverageOut(BaseModel):
    """Matrix coverage cho UI: page × locale → {total, filled, stale}."""

    pages: list[str]
    locales: list[str]
    matrix: dict[str, dict[str, UiLabelCoverageCell]]


class UiLabelBundleOut(BaseModel):
    """Bundle cho extension cache — nested dict locale → page → control_key."""

    version: int
    generated_at: datetime
    labels: dict[str, dict[str, dict[str, dict]]]


# ---------- Audit Log ----------
class AuditLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    timestamp: datetime
    actor_type: str
    actor_id: UUID | None
    actor_label: str | None
    action: str
    result: str
    target_type: str | None
    target_id: str | None
    data: dict | None
