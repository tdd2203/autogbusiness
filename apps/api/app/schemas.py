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


# ---------- Tự đăng ký bằng OTP email ----------
class RegisterIn(BaseModel):
    email: EmailStr
    username: str = Field(..., min_length=3, max_length=64)
    password: str = Field(..., min_length=8)


class RegisterOut(BaseModel):
    message: str
    email: EmailStr
    # Giây tới khi OTP hết hạn — FE hiển thị đếm ngược.
    expires_in_sec: int


class VerifyOtpIn(BaseModel):
    email: EmailStr
    code: str = Field(..., min_length=4, max_length=12)


class ResendOtpIn(BaseModel):
    email: EmailStr


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
    # Cờ thử nghiệm Ví — FE dùng để hiện/ẩn menu Ví + bật enforcement khi mời.
    wallet_beta: bool = False
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

# Ngôn ngữ giao diện ChatGPT admin của workspace (cấu hình HỆ THỐNG, super-admin
# đặt theo từng workspace). Tách khỏi ngôn ngữ HIỂN THỊ dashboard (per-user).
ChatGPTLocale = Literal["vi", "en", "zh"]


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
    # Ngôn ngữ ChatGPT của workspace (super-admin đặt ở Cài đặt). Tách khỏi
    # ngôn ngữ hiển thị dashboard (per-user).
    chatgpt_locale: ChatGPTLocale | None = None


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
    chatgpt_locale: str = "vi"
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
    # Phí dịch vụ ngân hàng (ngoài Stripe) admin NHẬP TAY khi thanh toán qua thẻ/
    # bank — KHÔNG scrape được. Cộng vào tổng thực trả chu kỳ. Bảo toàn khi extension
    # sync ghi đè (billing.py merge theo invoice_number / date+amount). NULL/0 = chưa
    # có phí. Xem `BillingInvoiceFeeIn` + endpoint set_invoice_fee.
    service_fee_vnd: int | None = Field(default=None, ge=0)


class BillingInvoiceFeeIn(BaseModel):
    """Admin nhập/xoá phí dịch vụ ngân hàng cho 1 hoá đơn cụ thể.

    Hoá đơn được định danh ưu tiên bằng `invoice_number` (mã Stripe, ổn định); nếu
    hoá đơn cũ chưa có mã thì fallback khớp theo `date` + `amount_vnd`. Gửi
    `service_fee_vnd=None` (hoặc 0) để xoá phí.
    """

    invoice_number: str | None = Field(default=None, max_length=64)
    date: datetime
    amount_vnd: int = Field(ge=0)
    service_fee_vnd: int | None = Field(default=None, ge=0)


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


class BillingPasteIn(BaseModel):
    """Super-admin DÁN chi tiết 1 hoá đơn (parse phía web) → lưu vào workspace.

    Thay cho việc để extension scrape trang chi tiết hoá đơn Stripe (mong manh).
    Web parse text dán ra các field này rồi POST lên. Endpoint lưu hoá đơn vào
    `billing_invoices` + set `renewal_date` = period_end + `seat_total` = quantity.
    """

    quantity: int | None = Field(default=None, ge=0, le=SEAT_TOTAL_MAX)
    unit_price_vnd: int | None = Field(default=None, ge=0)
    subtotal_vnd: int | None = Field(default=None, ge=0)
    vat_vnd: int | None = Field(default=None, ge=0)
    total_vnd: int | None = Field(default=None, ge=0)
    period_start: datetime | None = None
    period_end: datetime | None = None
    invoice_number: str | None = Field(default=None, max_length=64)
    status: str = Field(default="paid", max_length=16)
    # Ngày thanh toán + số tiền hoá đơn (= total) cho dòng list.
    date: datetime | None = None
    amount_vnd: int | None = Field(default=None, ge=0)


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
    # Phí mời RIÊNG của member (VND) do super-admin đặt (feature 003). NULL = dùng
    # phí mặc định payment_settings.invite_fee_vnd.
    fee_vnd: int | None = None
    # Người nhận nhắc gia hạn CHỈ ĐỊNH cho email này (feature 004). NULL = nhắc về
    # đại lý đã add. `notify_telegram_chat_id` NULL trong khi target là '@username'
    # nghĩa là người đó CHƯA bấm /start bot → UI hiện "chờ kết nối".
    notify_telegram_target: str | None = None
    notify_telegram_chat_id: int | None = None
    # Lịch sử chu kỳ gia hạn (sắp theo cycle_number) — trạng thái thanh toán từng kỳ.
    # Endpoint không kèm chu kỳ để rỗng; danh sách member workspace + tab "Email đã add"
    # đổ đầy để modal "Chi tiết thành viên" hiện mục "Kỳ thanh toán" GIỐNG NHAU ở cả hai
    # nơi (cùng component MemberDetailModal). Xem [[multi-cycle-payment-display]].
    cycles: list[SubscriptionCycleOut] = Field(default_factory=list)


class MemberFeeIn(BaseModel):
    """Super-admin đặt/xoá phí mời riêng cho 1 member. None = về phí mặc định."""

    fee_vnd: int | None = Field(default=None, ge=0)


class AddedMemberOut(MemberOut):
    """1 dòng trong tab 'Email đã add' — gom xuyên workspace, kèm tên workspace.

    `cycles` kế thừa từ MemberOut (đổ đầy trong added_members.list_added_members)."""

    workspace_name: str | None = None
    # Username của sub-admin sở hữu email (để super-admin biết email của ai).
    # None nếu là 'email còn lại' (chưa có chủ).
    invited_by_username: str | None = None


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
    vào tab "Người dùng" (Users) ĐÚNG 1 lần, tìm từng email → có = đã tham gia
    (promote active), không = giữ pending. Thay cho việc fan-out N task SYNC_MEMBER.

    Hai cách gọi:
      - `emails`: danh sách cụ thể (thanh bulk ở tab "Chờ tham gia" — các dòng đã chọn).
      - `all_pending=true`: BỎ QUA `emails`, backend tự gom TOÀN BỘ member đang
        pending của workspace (nút "Đồng bộ lời mời" ở header — user 2026-07-15).
    """

    emails: list[EmailStr] = Field(default_factory=list, max_length=500)
    all_pending: bool = Field(
        default=False,
        description="True = gom toàn bộ member pending của workspace, bỏ qua `emails`.",
    )


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
    # Tên workspace suy từ data.workspace_id (hoặc target khi target_type=WORKSPACE) —
    # để nhật ký hiện "mời/xoá ở workspace nào". None nếu không gắn workspace.
    workspace_name: str | None = None


# ---------- Ví & Thanh toán (feature 003-wallet-invite-payment) ----------
class WalletOut(BaseModel):
    balance: int
    held: int
    total: int
    wallet_beta: bool
    invite_fee_vnd: int


class WalletTxnOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    kind: str
    amount: int
    balance_after: int
    held_after: int
    ref_type: str | None
    ref_id: str | None
    meta: dict | None
    created_at: datetime


class WalletTxnPage(BaseModel):
    items: list[WalletTxnOut]
    next_cursor: str | None = None


class TopupCreateIn(BaseModel):
    amount_vnd: int = Field(..., gt=0, description="Số tiền nạp (VND), > 0")


class TopupOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    ref_code: str
    amount_vnd: int
    status: str
    paid_amount_vnd: int | None = None
    created_at: datetime
    paid_at: datetime | None = None


class TopupCreatedOut(TopupOut):
    """Response tạo lệnh nạp — kèm thông tin QR + chuyển khoản cho FE hiển thị."""

    note: str
    bank_name: str | None = None
    account_number: str | None = None
    account_name: str | None = None
    qr_url: str | None = None


class PaymentOrderOut(BaseModel):
    """Hoá đơn thanh toán QR cho mời/gia hạn (feature 003) — dùng để poll trạng thái."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    ref_code: str
    kind: str  # invite | renew
    amount_vnd: int
    status: str  # pending | paid | cancelled | expired
    paid_amount_vnd: int | None = None
    # Kết quả thực thi sau khi thanh toán (liên kết task mời / member gia hạn).
    queue_item_id: UUID | None = None
    member_id: UUID | None = None
    fulfillment_error: str | None = None
    created_at: datetime
    paid_at: datetime | None = None


class PaymentOrderQrOut(PaymentOrderOut):
    """Response khi tạo hoá đơn (kèm QR + nội dung CK) — trả trong HTTP 402."""

    note: str
    bank_name: str | None = None
    account_number: str | None = None
    account_name: str | None = None
    qr_url: str | None = None


class WithdrawalCreateIn(BaseModel):
    amount_vnd: int = Field(..., gt=0)
    bank_account: str = Field(..., min_length=3, max_length=255)
    note: str | None = None


class WithdrawalOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    amount_vnd: int
    bank_account: str
    status: str
    note: str | None = None
    reject_reason: str | None = None
    created_at: datetime
    reviewed_at: datetime | None = None


class WithdrawalAdminOut(WithdrawalOut):
    user_id: UUID
    username: str | None = None
    user_email: str | None = None


class WithdrawalRejectIn(BaseModel):
    reason: str | None = None


class PaymentCodeFlow(BaseModel):
    """1 luồng mã thanh toán trên SePay (vd Nạp tiền=NAP, Đơn hàng=ORDER)."""

    key: str = Field(..., min_length=1, max_length=32)
    label: str = Field(default="", max_length=64)
    prefix: str = Field(..., min_length=2, max_length=6)
    suffix_min: int = Field(default=3, ge=1, le=64)
    suffix_max: int = Field(default=30, ge=1, le=64)
    # Kiểu hậu tố: 'numeric' = chỉ số (\d), 'alphanumeric' = số & chữ ([A-Za-z0-9]).
    suffix_type: Literal["numeric", "alphanumeric"] = "alphanumeric"
    enabled: bool = True


SepayAuthMethod = Literal["none", "apikey", "hmac"]


class PaymentSettingsOut(BaseModel):
    invite_fee_vnd: int
    bank_name: str | None = None
    account_number: str | None = None
    account_name: str | None = None
    code_prefix: str
    amount_tolerance_vnd: int
    payment_codes: list[PaymentCodeFlow] = Field(default_factory=list)
    # Phương thức xác thực webhook đang chọn + trạng thái secret tương ứng (env).
    sepay_auth_method: SepayAuthMethod = "apikey"
    sepay_apikey_configured: bool = False
    sepay_hmac_secret_configured: bool = False
    sepay_webhook_configured: bool = False  # secret của method đang chọn đã có chưa
    # URL webhook để dán vào SePay dashboard (từ PUBLIC_URL) — có nút Copy trên UI.
    webhook_url: str = ""


class PaymentSettingsIn(BaseModel):
    invite_fee_vnd: int | None = Field(default=None, ge=0)
    bank_name: str | None = None
    account_number: str | None = None
    account_name: str | None = None
    code_prefix: str | None = Field(default=None, min_length=2, max_length=6)
    amount_tolerance_vnd: int | None = Field(default=None, ge=0)
    payment_codes: list[PaymentCodeFlow] | None = None
    sepay_auth_method: SepayAuthMethod | None = None


class WalletBetaIn(BaseModel):
    enabled: bool


class WalletAdjustIn(BaseModel):
    amount_vnd: int = Field(..., description="Số tiền điều chỉnh (có dấu, VND)")
    reason: str | None = None


class UserFeeIn(BaseModel):
    """Super-admin đặt/xoá phí mời mặc định của 1 user (đại lý). None = về phí global."""

    invite_fee_vnd: int | None = Field(default=None, ge=0)


class WalletAdminUserOut(BaseModel):
    user_id: UUID
    username: str
    email: str
    wallet_beta: bool
    is_super_admin: bool
    balance: int
    held: int
    # Phí mời mặc định RIÊNG của user (đại lý). NULL = dùng phí mặc định toàn hệ thống.
    invite_fee_vnd: int | None = None


# ── Báo cáo tài chính (super-admin) ─────────────────────────────────────────
# Doanh thu (THU) = Σ theo từng kỳ của mọi member (không test, không chủ workspace):
# PHÍ MỜI hiệu lực (đơn giá/tháng) × số tháng của kỳ — mời lần đầu + gia hạn cùng loại
# phí. Chi phí (CHI) = hoá đơn Stripe 'paid' có ngày >= workspace.finance_start_at
# (total_vnd + phí NH). Lợi nhuận = THU − CHI. Tất cả VND số nguyên.

class FinancialReportBucket(BaseModel):
    """1 tháng trong biểu đồ (theo lịch, YYYY-MM)."""

    month: str
    revenue: int
    cost: int
    profit: int


class FinancialReportAgent(BaseModel):
    """Doanh thu 1 chủ sở hữu (đại lý) trong kỳ. user_id=None → nhóm 'chưa có chủ'
    (member không gắn chủ), username hiển thị 'Chưa có chủ'."""

    user_id: UUID | None = None
    username: str | None = None
    email: str | None = None
    revenue: int
    invite_count: int
    renew_count: int


class FinancialReportOut(BaseModel):
    from_date: str  # ISO date (YYYY-MM-DD) — đầu kỳ (bao gồm)
    to_date: str    # ISO date — cuối kỳ (bao gồm)
    revenue: int
    revenue_invite: int
    revenue_renew: int
    cost: int
    profit: int
    monthly: list[FinancialReportBucket]
    by_agent: list[FinancialReportAgent]
    # Số workspace chưa đồng bộ hoá đơn 'paid' → giá vốn thiếu (CHI có thể thấp hơn thực).
    cost_missing_workspaces: int
    # Tổng "seat-tháng" có phát sinh THU trong kỳ (Σ số tháng của mọi kỳ được tính).
    seat_months: int = 0
    # Giá vốn TB mỗi seat/tháng = cost ÷ seat_months (None khi seat_months = 0).
    avg_cost_per_seat: int | None = None
