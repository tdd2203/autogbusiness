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
    "SYNC_MEMBER",
    "CHANGE_ROLE",
    "CHANGE_LICENSE_TYPE",
    "SYNC_DATA",
    "SYNC_BILLING",
    "REVOKE_INVITES",
    "HARVEST_LABELS",
    "PURCHASE_SEAT",
    "SET_USAGE_LIMIT",
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
    # Username/email của người tạo task — CHỈ super-admin mới thấy (để biết sub-admin
    # nào đã yêu cầu). Sub-admin luôn nhận None (ẩn danh tính người thực hiện).
    # Populate ở list_tasks (None nếu task hệ thống / không có creator).
    created_by_username: str | None = None
    # Người xem hiện tại có được phép HUỶ task này không (super-admin: mọi task;
    # sub-admin: chỉ task mình tạo). UI dùng ẩn/hiện nút Huỷ. Populate ở list_tasks.
    can_cancel: bool = False
    # Duyệt lệnh: NULL = không cần duyệt; 'pending' = chờ super-admin; 'approved';
    # 'rejected'. UI hiện badge "Chờ duyệt" + nút Duyệt/Từ chối (super-admin).
    approval_status: str | None = None
    approved_at: datetime | None = None
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
    """Một dòng trong bảng "Hoá đơn" trên /admin/billing.

    Các field `detail_*`/số lượng/đơn giá/period là dữ liệu ĐỌC CHÍNH XÁC từ trang
    chi tiết hoá đơn (invoice.stripe.com) — thay cho việc đoán số seat bằng phép
    chia tổng tiền. Tất cả optional để tương thích ngược với hoá đơn cũ (chỉ có
    date/amount_vnd/status) và với hoá đơn chưa mở được chi tiết.
    """

    date: datetime
    amount_vnd: int = Field(ge=0)
    status: str = Field(default="unknown", max_length=16)
    # --- Chi tiết đọc từ trang hoá đơn Stripe ---
    detail_scraped: bool = False
    detail_url: str | None = None
    quantity: int | None = Field(default=None, ge=0)
    unit_price_vnd: int | None = Field(default=None, ge=0)
    subtotal_vnd: int | None = Field(default=None, ge=0)
    vat_vnd: int | None = Field(default=None, ge=0)
    total_vnd: int | None = Field(default=None, ge=0)
    period_start: datetime | None = None
    period_end: datetime | None = None
    invoice_number: str | None = Field(default=None, max_length=64)


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
    # Ngân sách tín dụng/tháng cấp cho sub-admin này trong workspace này (re-POST để
    # đổi). Mặc định giữ nguyên giá trị cũ nếu None (chỉ gán/không đụng ngân sách).
    credit_budget: int | None = Field(default=None, ge=0, le=10_000_000)


class WorkspaceAssignmentOut(BaseModel):
    """1 user được gán workspace — kèm thông tin user để hiển thị."""

    model_config = ConfigDict(from_attributes=True)

    user_id: UUID
    email: str
    username: str
    is_active: bool
    credit_budget: int = 0
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
    # Lần CUỐI invite/re-invite qua dashboard (NULL nếu member chỉ đến từ SYNC).
    # Dashboard hiển thị COALESCE(last_invited_at, created_at) cho cột "Ngày thêm"
    # để khớp thời điểm task INVITE trong Queue (re-invite giữ created_at cũ).
    last_invited_at: datetime | None = None
    subscription_months: int | None = None
    subscription_end_at: datetime | None = None
    # Ngày mua (mốc neo) admin đặt trong modal Đổi hạn. NULL = chưa đặt (UI mặc định về
    # ngày thêm log = COALESCE(last_invited_at, created_at)).
    subscription_purchased_at: datetime | None = None
    # Giới hạn tín dụng/tháng đặt cho member (NULL = chưa đặt override; 0 = chặn).
    usage_limit_credits: int | None = None
    # Payment tracking (Dashboard-only), duyệt 2 bước: 'unpaid' | 'requested' | 'paid'.
    # requested = sub-admin đã gửi yêu cầu duyệt, chờ super-admin xác nhận.
    payment_status: str = "unpaid"
    payment_requested_at: datetime | None = None
    paid_at: datetime | None = None
    # Subscription change approval — 'none' | 'requested'. Khi 'requested', UI hiện
    # nhãn "chờ duyệt" + giá trị đề xuất (pending_*) để admin/người gửi cùng thấy.
    subscription_request_status: str = "none"
    pending_subscription_months: int | None = None
    pending_subscription_end_at: datetime | None = None
    subscription_requested_at: datetime | None = None
    # Đã dùng quyền sửa "ngày thêm" 1 lần chưa (NULL = chưa → super-admin còn sửa được).
    add_date_corrected_at: datetime | None = None


class SubscriptionCycleOut(BaseModel):
    """1 chu kỳ gia hạn của member — hiển thị lịch sử + trạng thái thanh toán theo kỳ."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    cycle_number: int
    months: int | None = None
    start_at: datetime | None = None
    end_at: datetime | None = None
    # unpaid | requested | paid (riêng cho từng chu kỳ).
    payment_status: str = "unpaid"
    payment_requested_at: datetime | None = None
    paid_at: datetime | None = None


class AddedMemberOut(MemberOut):
    """1 dòng trong tab 'Email đã add' — gom xuyên workspace, kèm tên workspace."""

    workspace_name: str | None = None
    # Username của sub-admin sở hữu email (để super-admin biết email của ai).
    # None nếu là 'email còn lại' (chưa có chủ).
    invited_by_username: str | None = None
    # Lịch sử chu kỳ gia hạn (sắp theo cycle_number) — trạng thái thanh toán từng kỳ.
    cycles: list[SubscriptionCycleOut] = []


class PaymentRequestNotice(BaseModel):
    """1 thông báo 'chờ duyệt thanh toán' cho super-admin: ai gửi, email gì, khi nào.

    Hiển thị dạng tin nhắn trong dropdown chuông; kèm `member_id` để nút 'Xác nhận'
    gọi thẳng /mark-paid cho email đó.
    """

    member_id: UUID
    email: EmailStr
    workspace_name: str | None = None
    # Người GỬI yêu cầu (payment_requested_by). Fallback owner nếu thiếu (dữ liệu cũ).
    requested_by_username: str | None = None
    requested_at: datetime | None = None


class SubscriptionRequestNotice(BaseModel):
    """1 thông báo 'chờ duyệt đổi hạn dùng' cho admin: ai gửi, email gì, hạn cũ→mới.

    Hiển thị trong dropdown chuông; kèm member_id để nút 'Duyệt' gọi thẳng
    /subscription-requests/approve cho email đó.
    """

    member_id: UUID
    email: EmailStr
    workspace_name: str | None = None
    requested_by_username: str | None = None
    requested_at: datetime | None = None
    # Hạn hiện tại (đang áp dụng) và hạn đề xuất chờ duyệt — để admin so sánh.
    current_end_at: datetime | None = None
    requested_end_at: datetime | None = None
    requested_months: int | None = None


class SubscriptionApproveIn(BaseModel):
    """Super-admin duyệt (approve=True) hoặc từ chối (approve=False) yêu cầu đổi hạn.

    approve=True : áp pending_subscription_* vào subscription_* + clear request.
    approve=False: chỉ clear request (giữ nguyên hạn cũ).
    """

    member_ids: list[UUID] = Field(min_length=1, max_length=500)
    approve: bool = True


class MemberLookupIn(BaseModel):
    """Tra cứu thông tin member trong 1 workspace theo danh sách email (modal
    'Cập nhật hàng loạt' — panel xem trước)."""

    emails: list[EmailStr] = Field(min_length=1, max_length=500)


class MemberLookupRow(BaseModel):
    """1 dòng kết quả tra cứu: đủ thông tin cho panel xem trước + chuyển chủ."""

    member_id: UUID
    email: EmailStr
    name: str | None = None
    status: str
    license_type: str | None = None
    # Thời gian add: COALESCE(last_invited_at, created_at) — khớp cột "Ngày thêm".
    added_at: datetime
    subscription_end_at: datetime | None = None
    # Giới hạn tín dụng/tháng hiện tại (NULL = chưa đặt) — hiện ở panel xem trước.
    usage_limit_credits: int | None = None
    owner_user_id: UUID | None = None
    owner_username: str | None = None


class MemberLookupOut(BaseModel):
    """`found`: email khớp member (còn trong team). `not_found`: email không khớp."""

    found: list[MemberLookupRow]
    not_found: list[str]


class MemberRequestPaymentIn(BaseModel):
    """Bước 1 — sub-admin gửi/rút yêu cầu duyệt thanh toán cho nhiều email.

    requested=True  → gửi yêu cầu: 'unpaid' -> 'requested' (set payment_requested_at).
    requested=False → rút yêu cầu: 'requested' -> 'unpaid' (clear payment_requested_*).

    Thao tác theo CHU KỲ (cycle_ids) hoặc theo email (member_ids — áp cho MỌI chu kỳ
    outstanding của email đó). Cần ít nhất 1 trong 2. Member.payment_status được tính
    lại tự động sau khi đổi chu kỳ.
    """

    member_ids: list[UUID] = Field(default_factory=list, max_length=500)
    cycle_ids: list[UUID] = Field(default_factory=list, max_length=1000)
    requested: bool = True


class MemberMarkPaidIn(BaseModel):
    """Bước 2 — super-admin xác nhận/huỷ thanh toán theo CHU KỲ hoặc theo email.

    paid=True → xác nhận đã thanh toán: -> 'paid' (set paid_at = now).
    paid=False → trả về chưa thanh toán: -> 'unpaid' (clear paid_at + payment_requested_*).
    cycle_ids: xác nhận từng chu kỳ; member_ids: áp cho mọi chu kỳ của email. Cần ≥1.
    """

    member_ids: list[UUID] = Field(default_factory=list, max_length=500)
    cycle_ids: list[UUID] = Field(default_factory=list, max_length=1000)
    paid: bool = True


class MemberExpiryItem(BaseModel):
    """1 dòng cập nhật hạn dùng: member nào → ngày hết hạn mới (đã resolve sẵn).

    `end_at` do frontend tính (vd ngày add + 30 ngày, chốt 23:59) rồi gửi lên dưới
    dạng ISO; None = đặt VÔ THỜI HẠN (xoá hạn).
    """

    member_id: UUID
    end_at: datetime | None = None


class MemberBulkSetExpiryIn(BaseModel):
    """Cập nhật hàng loạt hạn dùng (subscription_end_at) theo từng email.

    Phục vụ nút 'Cập nhật hạn hàng loạt' ở tab Email đã add: dán bảng Excel (hoặc chỉ
    danh sách email + tự đặt ngày) → web khớp email + tính ngày → gửi (member_id,
    end_at) đã chốt. Super-admin áp ngay; sub-admin tạo yêu cầu chờ duyệt (chỉ email
    mình sở hữu) — xem bulk_set_members_expiry.
    """

    items: list[MemberExpiryItem] = Field(min_length=1, max_length=1000)


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


class MemberBulkSetOwnerIn(BaseModel):
    """Chuyển chủ NHANH: gán/thu hồi chủ sở hữu cho đúng các member đã CHỌN (id).

    Khác `MemberBulkAssignOwnerIn` (quét toàn workspace theo bộ lọc) — cái này chỉ
    đụng đúng `member_ids`. invited_by_user_id=None → thu hồi (về "chưa có chủ").
    """

    member_ids: list[UUID]
    invited_by_user_id: UUID | None = None


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
    # Khi sync số lượng lớn, extension chia `members` thành nhiều chunk (200/lần)
    # rồi gọi bulk-upsert nhiều lần. Reconcile KHÔNG được chạy theo từng chunk
    # (mỗi chunk chỉ thấy email của nó → mark removed oan member của chunk khác).
    # Vì vậy extension upsert các chunk KHÔNG reconcile, rồi gọi 1 lần cuối với
    # `reconcile_emails` = TẤT CẢ email đã scrape (+ `reconcile_pending_emails`
    # cho rogue-pending). Khi set, dùng các list này làm tập "đã scrape" thay vì
    # suy ra từ `members` của riêng request này.
    reconcile_emails: list[str] | None = None
    reconcile_pending_emails: list[str] | None = None
    # Tổng active ChatGPT báo ở header (vd 49) tại thời điểm scrape. Dùng làm
    # "nguồn sự thật" chống RECONCILE khi sync THIẾU: nếu số active scrape được
    # ≪ expected_total → list chưa render hết (bug), backend BỎ QUA mark-removed
    # để không xoá oan cả team + phá dữ liệu lịch sử. Phân biệt với "admin xoá
    # thật còn ít" vì khi đó header ChatGPT cũng giảm theo (expected_total ≈ scrape).
    # None = extension cũ không gửi → backend dùng heuristic fallback.
    expected_total: int | None = None


class MemberInviteIn(BaseModel):
    email: EmailStr
    role: ChatGPTRole = "member"
    # Subscription tracking — Dashboard-only. Default 1 tháng = 30 ngày.
    # None = không giới hạn (admin tự quản lý). Range 1-60 để tránh nhập nhầm.
    subscription_months: int | None = Field(default=1, ge=1, le=60)


class MemberChangeEmailIn(BaseModel):
    """Body cho "đổi email member" (POST /{workspace_id}/members/{id}/change-email).

    Đổi email = xoá email cũ + mời email mới, NHƯNG GIỮ NGUYÊN hạn dùng cũ
    (subscription_end_at copy y nguyên, KHÔNG tính lại theo months × 30 ngày).
    """

    new_email: EmailStr


class SyncMemberIn(BaseModel):
    """Body cho "đồng bộ 1 tài khoản lẻ" (POST /{workspace_id}/sync-member)."""

    email: EmailStr


class SyncMembersBatchIn(BaseModel):
    """Body cho "đồng bộ hàng loạt" (POST /{workspace_id}/sync-members-batch).

    Gom 1 DANH SÁCH email pending vào ĐÚNG MỘT task SYNC_MEMBERS_BATCH — extension
    quét tab "Lời mời đang chờ xử lý" 1 lần rồi đối chiếu, thay cho việc fan-out N
    task SYNC_MEMBER (mỗi task lại quét lại toàn bộ pending — thừa).
    """

    emails: list[EmailStr] = Field(..., min_length=1, max_length=500)


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
    """PATCH subscription — đặt hạn theo NGÀY MUA + SỐ THÁNG (chu kỳ) hoặc VÔ THỜI HẠN.

      - subscription_months (1..60): SỐ THÁNG = số chu kỳ sử dụng của email.
      - subscription_purchased_at (ISO): NGÀY MUA (mốc neo). Gửi kèm months → BE tính
        hạn = ngày mua + months×30 ngày CHÍNH XÁC tới giây (đường đi chính của modal
        "Đổi hạn dùng"). BE tự tính & lưu subscription_end_at + subscription_purchased_at.
      - subscription_end_at (ISO): dự phòng — ngày hết hạn cụ thể client tự tính. Có →
        BE dùng TRỰC TIẾP (vd bulk-set-expiry). Ưu tiên cao nhất.
      - Chỉ gửi months (không ngày mua, không end_at) → GIA HẠN CỘNG DỒN: còn hạn →
        hạn cũ + N×30 ngày; hết hạn → BÂY GIỜ + N×30 ngày.
      - Tất cả None = VÔ THỜI HẠN (xoá hạn).

    Lưu ý duyệt: super-admin gọi = áp dụng ngay; sub-admin gọi = tạo yêu cầu chờ
    super-admin duyệt (xem routers/members/subscription.py + subscription_requests.py).
    """

    subscription_months: int | None = Field(default=None, ge=1, le=60)
    # Ngày mua (mốc neo). Gửi kèm months → BE tính hạn = ngày mua + tháng×30 (exact).
    subscription_purchased_at: datetime | None = None
    # Ngày hết hạn cụ thể (dự phòng bulk-set-expiry). Có → dùng trực tiếp, ưu tiên nhất.
    subscription_end_at: datetime | None = None


class MemberRenewIn(BaseModel):
    """POST renew — GIA HẠN (cộng tháng), ÁP DỤNG NGAY, KHÔNG cần duyệt.

    Khác PATCH subscription: gia hạn là quyền tự phục vụ của cả sub-admin lẫn
    super-admin (yêu cầu user 2026-07-08). BE cộng dồn hạn (còn hạn → hạn cũ + N×30;
    hết hạn → bây giờ + N×30), tạo 1 CHU KỲ mới (payment_status='unpaid') và RESET
    trạng thái thanh toán của member về 'chưa thanh toán'.
    """

    months: int = Field(ge=1, le=60)


class MemberCorrectAddDateIn(BaseModel):
    """PATCH add-date — SỬA "Ngày gia hạn / ngày add đầu tiên" (mốc neo) ĐÚNG 1 LẦN.

    Chỉ super-admin, chỉ khi CHƯA từng sửa (add_date_corrected_at IS NULL). BE đặt
    subscription_purchased_at = add_date, tính lại hạn = add_date + tháng×30 (nếu có
    subscription_months), rồi KHOÁ (add_date_corrected_at = now → không sửa được nữa).

    `months` (tuỳ chọn): NEO LẠI cả số tháng — hạn = add_date + months×30 và lưu
    subscription_months = months. Modal Đổi hạn dùng gửi kèm để "Số tháng" tính từ
    ngày thêm mới (không cộng dồn). Bỏ trống → giữ subscription_months hiện tại.

    `end_at` (tuỳ chọn, "sự kết hợp"): đặt THẲNG ngày hết hạn admin đã tinh chỉnh ±ngày
    (chế độ Theo ngày cụ thể) → subscription_end_at = end_at, subscription_months = None
    (hạn thủ công). Ưu tiên hơn `months`.

    `clear_end` (tuỳ chọn): Vô thời hạn — xoá subscription_end_at + subscription_months.
    Ưu tiên cao nhất.
    """

    add_date: datetime
    months: int | None = Field(default=None, ge=1, le=60)
    end_at: datetime | None = None
    clear_end: bool = False


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


class UsageLimitItem(BaseModel):
    """1 cặp (email, mức tín dụng/tháng) cho chế độ đặt RIÊNG từng member."""

    email: str
    limit_credits: int = Field(ge=0, le=1_000_000)


class MemberBulkSetUsageLimitIn(BaseModel):
    """Đặt giới hạn tín dụng/tháng hàng loạt (trang ChatGPT
    /admin/billing/manage_member_usage_limit). Mỗi member = 1 task SET_USAGE_LIMIT
    (extension đặt từng người một). Hỗ trợ 2 chế độ, có thể trộn:

      - CHUNG: `limit_credits` áp cho mọi member trong `member_ids` (checkbox) +
        `emails` (dán tay).
      - RIÊNG: `items` = danh sách (email, limit_credits) — giá trị riêng từng người,
        ưu tiên hơn `limit_credits` chung nếu trùng email.

    Cần ít nhất `limit_credits`+(member_ids|emails) HOẶC `items`. Backend dedupe
    theo member.id, chỉ enqueue member active còn tồn tại, bỏ qua member đã đúng mức.
    """

    member_ids: list[UUID] = Field(default_factory=list, max_length=500)
    emails: list[str] = Field(default_factory=list, max_length=500)
    limit_credits: int | None = Field(default=None, ge=0, le=1_000_000)
    items: list[UsageLimitItem] = Field(default_factory=list, max_length=500)


class MemberUsageLimitBudgetOut(BaseModel):
    """Ngân sách tín dụng của caller trong 1 workspace (cho modal đặt giới hạn).

    super-admin: unlimited=True (không bị ràng buộc ngân sách, không cần duyệt).
    sub-admin: budget = ngân sách được cấp; used = tổng đã cam kết (giới hạn hiện tại
    + các yêu cầu đang chờ duyệt) cho member của mình; remaining = budget - used.
    """

    unlimited: bool = False
    budget: int = 0
    used: int = 0
    remaining: int = 0


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
