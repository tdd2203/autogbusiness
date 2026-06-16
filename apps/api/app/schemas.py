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
    # str (không EmailStr): tài khoản phụ không nhập email sẽ có email nội bộ tự
    # sinh (vd ...@no-email.local) — domain reserved nên không qua được EmailStr.
    email: str
    username: str
    is_super_admin: bool
    is_active: bool
    permissions: list[str]
    created_at: datetime
    updated_at: datetime


class UserCreate(BaseModel):
    # Email tuỳ chọn — tài khoản phụ đăng nhập bằng username. Nếu không gửi,
    # backend tự sinh email nội bộ từ username (xem routers/users.py).
    email: EmailStr | None = None
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
    "CHANGE_LICENSE_TYPE",
    "SYNC_DATA",
    "SYNC_BILLING",
    "REVOKE_INVITES",
    "HARVEST_LABELS",
    "PURCHASE_SEAT",
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
    # Username/email của người tạo task — super-admin xem để biết sub-admin nào
    # đã yêu cầu. Populate ở list_tasks (None nếu task hệ thống / không có creator).
    created_by_username: str | None = None
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
    # Tên miền đã xác minh (vd "ndaigroup.org"). Admin nhập khi tạo, sửa sau.
    verified_domain: str | None = Field(default=None, max_length=255)


class WorkspaceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    chatgpt_id: str | None = Field(default=None, max_length=128)
    plan: WorkspacePlan | None = None
    seat_total: int | None = Field(default=None, ge=0, le=SEAT_TOTAL_MAX)
    verified_domain: str | None = Field(default=None, max_length=255)


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
    verified_domain: str | None = None
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


# Mua thêm seat: cap 20/lần để chống fat-finger gây overcharge (1 click 100 seat).
# Admin muốn nhiều hơn → chia nhiều task.
PURCHASE_SEAT_MAX_PER_TASK = 20


class PurchaseSeatIn(BaseModel):
    """Dashboard yêu cầu extension mua thêm `quantity` seat trên /admin/billing.

    Extension flow: click "Quản lý giấy phép" → tăng input số người dùng lên
    +quantity → click "Tiếp tục". DỪNG trước nút confirm payment cuối — admin
    tự xác nhận thanh toán thật trên ChatGPT (an toàn về tiền bạc).
    """

    quantity: int = Field(default=1, ge=1, le=PURCHASE_SEAT_MAX_PER_TASK)


class WorkspaceWithKey(WorkspaceOut):
    """Trả về kèm extension_api_key — CHỈ dùng khi vừa tạo / regenerate, không trả ở list."""

    extension_api_key: str


class WorkspaceAssignmentCreate(BaseModel):
    user_id: UUID


class WorkspaceAssignmentOut(BaseModel):
    """1 user được gán workspace — kèm thông tin user để hiển thị."""

    model_config = ConfigDict(from_attributes=True)

    user_id: UUID
    email: str
    username: str
    is_active: bool
    created_at: datetime


class WorkspaceMemberStats(BaseModel):
    """Thống kê member của workspace cho user được gán.

    total/active/pending = toàn bộ member workspace (để user biết tổng số);
    own_count = member do user hiện tại mời.
    """

    total: int
    active: int
    pending: int
    seat_total: int | None
    seat_used: int | None
    own_count: int


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
ChatGPTRole = Literal["owner", "admin", "member", "analytics_viewer"]
MemberStatus = Literal["active", "pending", "removed"]
# Loại suất cấp phép trên ChatGPT admin (cột "Loại suất cấp phép").
LicenseType = Literal["ChatGPT", "Codex"]


class MemberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    workspace_id: UUID
    email: EmailStr
    name: str | None
    chatgpt_role: str | None
    license_type: str | None = None
    status: str
    invited_by_user_id: UUID | None
    joined_at: datetime | None
    last_synced_at: datetime | None
    created_at: datetime
    subscription_months: int | None = None
    subscription_end_at: datetime | None = None
    # Payment tracking (Dashboard-only): 'unpaid' | 'paid'.
    payment_status: str = "unpaid"
    paid_at: datetime | None = None


class AddedMemberOut(MemberOut):
    """1 dòng trong tab 'Email đã add' — gom xuyên workspace, kèm tên workspace."""

    workspace_name: str | None = None
    # Username của sub-admin sở hữu email (để super-admin biết email của ai).
    # None nếu là 'email còn lại' (chưa có chủ).
    invited_by_username: str | None = None


class MemberMarkPaidIn(BaseModel):
    """Duyệt/huỷ thanh toán cho nhiều email cùng lúc.

    paid=True → đánh dấu đã thanh toán (set paid_at = now).
    paid=False → trả về chưa thanh toán (clear paid_at).
    """

    member_ids: list[UUID] = Field(min_length=1, max_length=500)
    paid: bool = True


class MemberRevokeOwnerIn(BaseModel):
    """Super-admin thu hồi quyền sở hữu nhiều email (về 'email còn lại')."""

    member_ids: list[UUID] = Field(min_length=1, max_length=500)


class MemberTransferOwnerIn(BaseModel):
    """Super-admin chuyển quyền sở hữu nhiều email sang 1 user (admin hoặc sub-admin).

    Dùng cho cả 'thu hồi' (target = 1 super-admin) lẫn 'chuyển' (target = sub-admin).
    """

    member_ids: list[UUID] = Field(min_length=1, max_length=500)
    target_user_id: UUID


class MemberSetOwnerIn(BaseModel):
    """Admin gán/thu hồi chủ sở hữu 1 member.

    invited_by_user_id = UUID → gán cho user đó.
    invited_by_user_id = None → THU HỒI (member về trạng thái chưa có chủ).
    """

    invited_by_user_id: UUID | None = None


class MemberBulkAssignOwnerIn(BaseModel):
    """Admin gán hàng loạt member cho 1 user (vd quy đám member cũ cho hdh2102).

    Loại trừ: email trong `exclude_emails` (owner + danh sách Excel) và — nếu
    skip_verified_domain — email thuộc verified_domain của workspace.
    only_unassigned=True (mặc định) chỉ đụng member CHƯA có chủ (an toàn, không
    cướp member người khác đã sở hữu).
    """

    target_user_id: UUID
    exclude_emails: list[str] = Field(default_factory=list)
    only_unassigned: bool = True
    skip_verified_domain: bool = True


class MemberUpsert(BaseModel):
    email: EmailStr
    name: str | None = None
    chatgpt_role: ChatGPTRole | None = None
    license_type: LicenseType | None = None
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
    # Subscription tracking — Dashboard-only. Default 1 tháng = 30 ngày.
    # None = không giới hạn (admin tự quản lý). Range 1-60 để tránh nhập nhầm.
    subscription_months: int | None = Field(default=1, ge=1, le=60)


class MemberInviteEntry(BaseModel):
    """1 entry trong bulk-invite: email + subscription_months riêng cho email đó."""

    email: EmailStr
    subscription_months: int | None = Field(default=1, ge=1, le=60)


class MemberBulkInviteIn(BaseModel):
    """Mời nhiều email cùng lúc qua 1 ChatGPT dialog (click 'Thêm nhiều hơn').

    Hai paths:
      - `invites` (preferred, mới 2026-05-19): per-email subscription_months.
        Dashboard form mời gửi shape này.
      - `emails` + `subscription_months` (legacy): tất cả emails dùng chung 1
        subscription_months. Giữ cho backward-compat client cũ.

    Nếu cả 2 đều provided → `invites` thắng.
    """

    emails: list[EmailStr] = Field(default_factory=list, max_length=200)
    invites: list[MemberInviteEntry] | None = Field(default=None, max_length=200)
    role: ChatGPTRole = "member"
    subscription_months: int | None = Field(default=1, ge=1, le=60)

    def resolved_entries(self) -> list[MemberInviteEntry]:
        """Trả list entry chuẩn hóa, bất kể caller dùng path nào.

        Dedupe theo email (lowercase). Nếu cả 2 path đều có cùng email, ưu tiên
        `invites` entry.
        """
        out: dict[str, MemberInviteEntry] = {}
        if self.invites:
            for entry in self.invites:
                key = str(entry.email).lower()
                out[key] = entry
        for email in self.emails:
            key = str(email).lower()
            if key in out:
                continue
            out[key] = MemberInviteEntry(
                email=email,
                subscription_months=self.subscription_months,
            )
        return list(out.values())


class MemberBulkRemoveIn(BaseModel):
    """Xoá hàng loạt member: chọn bằng `member_ids` (checkbox trong bảng) và/hoặc
    `emails` (dán tay giống flow mời). Có thể trộn cả hai — backend gộp & dedupe
    theo member.id, chỉ enqueue member status active/pending còn tồn tại trong DB.
    """

    member_ids: list[UUID] = Field(default_factory=list, max_length=500)
    emails: list[str] = Field(default_factory=list, max_length=500)


class MemberUpdateSubscriptionIn(BaseModel):
    """PATCH subscription_months — extend hoặc đổi vô thời hạn."""

    subscription_months: int | None = Field(default=None, ge=1, le=60)


class MemberChangeRoleIn(BaseModel):
    new_role: ChatGPTRole


class MemberChangeLicenseTypeIn(BaseModel):
    new_license_type: LicenseType


class MemberBulkChangeLicenseTypeIn(BaseModel):
    """Đổi giấy phép hàng loạt: chọn bằng `member_ids` (checkbox) và/hoặc `emails`.
    Backend gộp & dedupe theo member.id, chỉ enqueue member status active còn tồn
    tại trong DB, mỗi member = 1 task CHANGE_LICENSE_TYPE.
    """

    member_ids: list[UUID] = Field(default_factory=list, max_length=500)
    emails: list[str] = Field(default_factory=list, max_length=500)
    new_license_type: LicenseType


class InviteVerifyReconcileIn(BaseModel):
    """Extension báo kết quả verify sau INVITE_MEMBER (scrape tab 'Lời mời').

    Dùng để DỌN phantom: email đã tạo Member status=pending lúc bấm mời nhưng
    KHÔNG xuất hiện trong tab 'Lời mời đang chờ xử lý' khi verify → đánh dấu
    removed (chỉ row đang pending). Nếu `verify_scrape_failed=True` thì KHÔNG dọn
    (không scrape được → giữ nguyên, tránh xoá oan).
    """

    verified_emails: list[str] = Field(default_factory=list)
    unverified_emails: list[str] = Field(default_factory=list)
    verify_scrape_failed: bool = False


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
