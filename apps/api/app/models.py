from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
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
        UniqueConstraint("topup_code", name="uq_users_topup_code"),
        CheckConstraint("invite_fee_vnd IS NULL OR invite_fee_vnd >= 0", name="ck_users_fee_nonneg"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    username: Mapped[str] = mapped_column(String(64), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_super_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Cấu hình workspace ĐÍCH cho trang "Mời thành viên" (nút ⚙️, super-admin đặt):
    # True = user được add email mới vào MỌI workspace (kể cả tạo mới sau này) → đích
    # chọn NGẪU NHIÊN trong tất cả. False = chỉ các workspace được gán qua
    # workspace_assignments ("chỉ định"); >1 thì đích ngẫu nhiên trong tập đó. Email
    # cũ/gia hạn giữ workspace lịch sử, không áp cờ này. Super-admin không bị ràng buộc.
    invite_all_workspaces: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # Cờ tài khoản TEST (user 2026-07-14). Báo cáo tài chính LOẠI mọi member thuộc
    # user is_test khỏi THU + bảng đại lý (tránh lẫn số liệu thử nghiệm). Bật cho
    # tài khoản seed wallet_tester; super-admin có thể gắn cho tài khoản test khác.
    is_test: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # Cờ thử nghiệm Ví (feature 003-wallet-invite-payment). Chỉ user bật cờ mới
    # thấy menu Ví + bị bắt buộc thanh toán khi mời. Super-admin bật/tắt cho từng
    # user; super-admin KHÔNG bị trừ phí kể cả khi cờ bật.
    wallet_beta: Mapped[bool] = mapped_column(
        # MẶC ĐỊNH MỞ VÍ (cố định — user 2026-07-14): tài khoản mới bật ví-beta ngay.
        Boolean, nullable=False, default=True, server_default="true"
    )
    # Phí mời/gia hạn MẶC ĐỊNH của riêng user (đại lý) — feature 003. NULL = dùng
    # phí mặc định toàn hệ thống (payment_settings.invite_fee_vnd). Phí thực thu cho
    # 1 lời mời/gia hạn = COALESCE(member.fee_vnd, user.invite_fee_vnd, global).
    # Super-admin đặt qua PUT /wallet/admin/users/{id}/fee.
    invite_fee_vnd: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # Mã NẠP TIỀN CỐ ĐỊNH theo user (user 2026-07-14): nội dung CK trên QR nạp =
    # `{NAP}{topup_code}`, KHÔNG đổi giữa các lần nạp. Webhook SePay khớp mã này →
    # cộng ĐÚNG số tiền nhận được cho user (không phụ thuộc "lệnh nạp" nào). Nhờ vậy
    # cùng 1 mã + 1 số tiền thì QR luôn y hệt và user có thể LƯU LẠI QR để tái dùng.
    # Sinh lazy khi tạo lệnh nạp lần đầu (ensure_topup_code); backfill ở migration 0040.
    topup_code: Mapped[str | None] = mapped_column(String(24), nullable=True, index=True)
    token_version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    permissions: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    # --- Nhắc gia hạn qua Telegram (feature 004-telegram-renewal-reminder) ---
    # chat_id RIÊNG của user với bot, có sau khi user bấm deep-link t.me/<bot>?start=<token>
    # (webhook /webhook/telegram xử lý). NULL = chưa liên kết → không nhận nhắc riêng.
    # KHÔNG unique: một người có thể dùng chung 1 Telegram cho nhiều tài khoản dashboard.
    telegram_chat_id: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True, index=True
    )
    # @username Telegram tại thời điểm liên kết (lowercase, KHÔNG có '@'). Chỉ để hiển
    # thị/đối chiếu — Bot API KHÔNG gửi tin theo username nên luôn gửi bằng chat_id.
    telegram_username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    telegram_linked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Công tắc nhận nhắc của riêng user (lệnh /stop trong bot hoặc toggle ở Cài đặt).
    # False = đã liên kết nhưng tạm ngưng nhận — vẫn giữ chat_id để bật lại.
    telegram_notify_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    # Mốc kết thúc lệnh-cấm chống-spam. Khi user lặp lại CÙNG (loại lệnh, email)
    # liên tiếp quá 3 lần (task FAILED không tính), endpoint set cột này = now+10
    # phút + bump token_version (đá session) → mọi request 401, login bị chặn tới
    # mốc này. NULL = không bị cấm. (Thay cho sync_member_cooldown_until cũ.)
    command_ban_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
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


class EmailOtp(Base):
    """Đăng ký ĐANG CHỜ xác thực OTP (feature: tự đăng ký bằng OTP email).

    KHÔNG tạo hàng trong `users` cho tới khi OTP đúng — giữ bảng users sạch, tránh
    rác/đụng unique từ đăng ký bỏ dở. Thông tin đăng ký (email, username,
    password_hash đã hash sẵn) nằm ở đây tới khi verify thì mới INSERT user + xoá
    hàng này. `code_hash` = SHA-256 của OTP (không lưu plaintext). Bản ghi hết hạn
    do job nền dọn (_purge_expired_otps_once trong main.py).
    """

    __tablename__ = "email_otps"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    username: Mapped[str] = mapped_column(String(64), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_sent_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


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

    # Duyệt lệnh (chỉ áp cho task do sub-admin tạo cần admin phê duyệt, vd
    # SET_USAGE_LIMIT). NULL = không cần duyệt (task của super-admin / loại task khác)
    # → extension pick ngay. 'pending' = chờ super-admin duyệt → extension KHÔNG pick.
    # 'approved' = đã duyệt → pick như PENDING thường. 'rejected' = bị từ chối (status
    # chuyển FAILED). Xem queue/execution.py pick_next + queue/admin.py approve/reject.
    approval_status: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)
    approved_by_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    approved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    workspace_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    created_by = relationship("User", foreign_keys=[created_by_id])
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
    # Lịch sử hoá đơn scrape từ /admin/billing — list các transactions. Mỗi phần
    # tử gồm field cơ bản (date/amount_vnd/status) + field CHI TIẾT đọc từ trang
    # hoá đơn Stripe (detail_scraped=True):
    #   {"date": "2026-06-25", "amount_vnd": 10029250, "status": "paid",
    #    "detail_scraped": true, "quantity": 35, "unit_price_vnd": 260500,
    #    "subtotal_vnd": 9117500, "vat_vnd": 911750, "total_vnd": 10029250,
    #    "period_start": "2026-06-25", "period_end": "2026-07-25",
    #    "invoice_number": "MSNS6RGC-0024", "detail_url": "https://invoice.stripe.com/..."}
    # Dashboard dùng để (1) hiển thị lịch sử và (2) tính giá/seat CHÍNH XÁC từ
    # quantity + unit_price_vnd (không còn đoán bằng phép chia); renewal/cycle
    # suy từ period_end/period_start. Hoá đơn cũ thiếu field mới → detail_scraped=false.
    billing_invoices: Mapped[list[dict] | None] = mapped_column(
        JSONB, nullable=True
    )
    # MỐC bắt đầu tính CHI (báo cáo tài chính, user 2026-07-14). CHI chỉ cộng hoá
    # đơn Stripe có ngày >= mốc này — hoá đơn hệ thống cũ / thanh toán ngoài TRƯỚC
    # mốc bị loại (không gộp được vào hệ thống mới). Backfill (migration 0041) =
    # period_start của hoá đơn có chu kỳ mới nhất = đầu chu kỳ hiện tại. Workspace
    # mới: null → billing sync lần đầu tự set = period_start chu kỳ hiện tại; nếu
    # vẫn null, report fallback về created_at.
    finance_start_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Tên miền đã xác minh của workspace (vd "ndaigroup.org") — extension quét 1
    # lần từ /admin/identity rồi lưu. Dùng để quyết định có cần bật toggle "Cho
    # phép lời mời ngoài tên miền" khi invite: nếu MỌI email thuộc domain này thì
    # KHÔNG cần bật (nhanh + an toàn); chỉ bật khi có email ngoài domain.
    verified_domain: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Ngôn ngữ giao diện ChatGPT admin của workspace NÀY ('vi' | 'en' | 'zh').
    # Extension dựa vào để cảnh báo/định vị khi ChatGPT lệch ngôn ngữ lúc sync.
    # TÁCH HẲN khỏi ngôn ngữ HIỂN THỊ dashboard (per-user, localStorage) — đây là
    # cấu hình HỆ THỐNG theo workspace, CHỈ super-admin sửa (trang Cài đặt). Trước
    # đây expected_locale bị suy ra từ ngôn ngữ hiển thị của mỗi user → sai.
    chatgpt_locale: Mapped[str] = mapped_column(
        String(8), nullable=False, default="vi", server_default="vi"
    )
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
    # Ngân sách tín dụng/tháng admin cấp cho sub-admin NÀY trong workspace NÀY: tổng
    # usage_limit_credits sub-admin đặt cho các member của mình không được vượt số
    # này. Mặc định 0 = chưa cấp (sub-admin không đặt được giới hạn nào > 0).
    credit_budget: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    workspace = relationship("Workspace")
    user = relationship("User", foreign_keys=[user_id])


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
        CheckConstraint("fee_vnd IS NULL OR fee_vnd >= 0", name="ck_members_fee_nonneg"),
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
    # Thời điểm member chuyển sang 'removed' (mọi đường: REMOVE/REVOKE/full-sync
    # mark-removed/đổi email). NULL = chưa từng bị xoá HOẶC đã mời lại (invite.py
    # clear về NULL). Mốc đếm retention: job nền hard-delete record + lịch sử khi
    # removed_at <= now - 90 ngày (xem main.py _purge_old_removed_members_once).
    removed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
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
    # Mốc lần đồng bộ gần nhất KHÔNG thấy email ở cả tab Người dùng lẫn tab Lời mời
    # (found_in='none'). NULL = lần sync gần nhất có thấy (hoặc chưa sync bao giờ).
    # Dùng để mở khoá "Mời lại" cho member DB ghi active nhưng thực tế không còn
    # trong workspace — xem reinvite_member (invite.py).
    sync_missing_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Lần CUỐI member được invite/re-invite qua dashboard. Khác created_at (bất
    # biến từ lần đầu) — reconcile bulk-upsert dùng COALESCE(last_invited_at,
    # created_at) để KHÔNG mark removed oan member vừa re-invite (xem reconcile.py).
    last_invited_at: Mapped[datetime | None] = mapped_column(
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
    # Phí mời RIÊNG cho member này (VND) do super-admin đặt (feature 003). NULL =
    # dùng phí mặc định payment_settings.invite_fee_vnd. Phí trừ ví khi user beta
    # mời = COALESCE(fee_vnd, default). BigInteger đồng bộ migration + cột tiền khác.
    fee_vnd: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # "Ngày mua" — MỐC NEO tính hạn do admin đặt trong modal Đổi hạn dùng. NULL = chưa
    # đặt (modal mặc định về COALESCE(last_invited_at, created_at) = "ngày thêm" log).
    # Khi set theo gói tháng: subscription_end_at = subscription_purchased_at + months×30
    # ngày CHÍNH XÁC tới giây (KHÔNG chốt cuối ngày, không dư). Xem subscription.py.
    subscription_purchased_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # usage_limit_credits: giới hạn tín dụng/tháng admin đặt cho member trên trang
    # ChatGPT /admin/billing/manage_member_usage_limit ("Ghi đè mỗi người dùng").
    # NULL = chưa đặt override (dùng mặc định workspace). 0 hợp lệ = chặn dùng.
    # Extension đặt giá trị qua action SET_USAGE_LIMIT; DB sync khi task COMPLETED.
    usage_limit_credits: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Payment tracking (Dashboard-only) — phục vụ tài khoản phụ bán dịch vụ: theo
    # dõi email mình đã add đã trả tiền cho admin hay chưa. KHÔNG liên quan billing
    # workspace. Duyệt 2 bước: unpaid → requested (sub-admin gửi yêu cầu duyệt) →
    # paid (super-admin xác nhận đã thanh toán).
    #   payment_requested_at / payment_requested_by_id = bước 1 (ai gửi yêu cầu, khi nào)
    #   paid_at / paid_marked_by_id                     = bước 2 (super-admin nào xác nhận)
    payment_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="unpaid", server_default="unpaid", index=True
    )
    payment_requested_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    payment_requested_by_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    paid_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    paid_marked_by_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Subscription change approval (Dashboard-only) — đổi hạn dùng PHẢI được admin
    # duyệt. Sub-admin gọi PATCH subscription → KHÔNG áp dụng ngay mà tạo YÊU CẦU
    # chờ duyệt (giống payment 2 bước). Super-admin tự đổi = áp dụng ngay (tự duyệt).
    #   subscription_request_status: 'none' | 'requested'
    #   pending_subscription_months / pending_subscription_end_at = giá trị ĐỀ XUẤT
    #     (end_at đã resolve sẵn từ ngày cụ thể hoặc months×30); áp vào subscription_*
    #     khi super-admin duyệt, xoá khi từ chối.
    subscription_request_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="none", server_default="none", index=True
    )
    pending_subscription_months: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    pending_subscription_end_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    subscription_requested_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    subscription_requested_by_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    # KHOÁ sửa "Ngày gia hạn" (mốc neo = subscription_purchased_at, = ngày add đầu
    # tiên): super-admin sửa ĐÚNG 1 LẦN qua PATCH .../members/{id}/add-date
    # (correct_add_date.py) → cột này set = now, không sửa lại được nữa. NULL = chưa
    # sửa → còn quyền sửa. (Tái dùng cột cũ của tính năng "đồng bộ ngày thêm" đã gỡ.)
    add_date_corrected_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # --- Người nhận nhắc gia hạn RIÊNG cho email này (feature 004) ---
    # Người dùng nhập '@username' hoặc ID số; lưu NGUYÊN VĂN đã chuẩn hoá ở đây để UI
    # hiển thị lại đúng thứ đã nhập. Khi ĐÃ đặt và resolve được chat_id, tin nhắc của
    # email này gửi cho NGƯỜI ĐƯỢC CHỈ ĐỊNH *thay cho* đại lý đã add (nghĩa "chỉ định").
    # Chưa resolve được (người đó chưa bấm /start bot) → tạm gửi về đại lý, không mất tin.
    notify_telegram_target: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # chat_id đã resolve. Nhập ID số → điền ngay; nhập @username → điền khi người đó
    # /start bot (webhook khớp username trong bảng telegram_contacts).
    notify_telegram_chat_id: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True, index=True
    )

    workspace = relationship("Workspace")
    invited_by = relationship("User", foreign_keys=[invited_by_user_id])
    # Sub-admin (hoặc super-admin) đã GỬI yêu cầu duyệt — phục vụ thông báo "ai gửi".
    payment_requested_by = relationship(
        "User", foreign_keys=[payment_requested_by_id]
    )
    # Người GỬI yêu cầu đổi hạn dùng — phục vụ thông báo "ai gửi" cho admin duyệt.
    subscription_requested_by = relationship(
        "User", foreign_keys=[subscription_requested_by_id]
    )
    # Lịch sử CHU KỲ gia hạn (mỗi lần gia hạn = 1 chu kỳ, có trạng thái thanh toán
    # riêng). Sắp theo cycle_number tăng dần. Xem MemberSubscriptionCycle.
    subscription_cycles = relationship(
        "MemberSubscriptionCycle",
        back_populates="member",
        cascade="all, delete-orphan",
        order_by="MemberSubscriptionCycle.cycle_number",
    )


class MemberSubscriptionCycle(Base):
    """1 CHU KỲ gia hạn của member — nguồn sự thật cho lịch sử thanh toán theo kỳ.

    Mỗi lần GIA HẠN (endpoint renew.py) tạo 1 chu kỳ mới (cycle_number tăng dần từ
    1). Mỗi chu kỳ có trạng thái thanh toán RIÊNG (duyệt 2 bước giống payment cấp
    member): unpaid → requested (sub-admin gửi yêu cầu) → paid (super-admin xác nhận).
    `Member.payment_status` là giá trị TỔNG HỢP suy từ các chu kỳ (unpaid nếu còn
    kỳ chưa trả) — xem added_members._recompute_member_payment_status.
    """

    __tablename__ = "member_subscription_cycles"
    __table_args__ = (
        UniqueConstraint(
            "member_id", "cycle_number", name="uq_member_cycle_number"
        ),
    )

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, default=uuid4
    )
    member_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("members.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Thứ tự chu kỳ trong 1 member (1-based). Chu kỳ 1 = lần add/mời đầu tiên
    # (backfill), 2, 3… = các lần gia hạn tiếp theo.
    cycle_number: Mapped[int] = mapped_column(Integer, nullable=False)
    months: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Mốc bắt đầu/kết thúc chu kỳ (tới giây, UTC). start_at = hạn cũ (nếu còn hiệu
    # lực) hoặc thời điểm gia hạn; end_at = start_at + months×30.
    start_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    end_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # unpaid | requested | paid — giống payment cấp member.
    payment_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="unpaid", server_default="unpaid", index=True
    )
    payment_requested_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    payment_requested_by_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    paid_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    paid_marked_by_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    member = relationship("Member", back_populates="subscription_cycles")
    payment_requested_by = relationship(
        "User", foreign_keys=[payment_requested_by_id]
    )


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


# ============================================================================
# Ví & Thanh toán (feature 003-wallet-invite-payment)
# ⚠️ Mọi thay đổi số dư PHẢI đi qua app/services/wallet_service.py (điểm vào duy
# nhất — khoá dòng ví + ghi WalletTransaction bất biến + audit). KHÔNG sửa
# balance/held trực tiếp ở router.
# ============================================================================


class Wallet(Base):
    """Ví của 1 user dashboard (1-1). `balance` = số dư KHẢ DỤNG, `held` = tiền
    đang GIỮ cho yêu cầu rút chờ duyệt. Bất biến: balance ≥ 0, held ≥ 0."""

    __tablename__ = "wallets"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_wallets_user"),
        CheckConstraint("balance >= 0", name="ck_wallets_balance_nonneg"),
        CheckConstraint("held >= 0", name="ck_wallets_held_nonneg"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    # SET NULL (không CASCADE): xoá user vẫn GIỮ ví + sổ cái (nguyên tắc user
    # 2026-07-12 — không mất lịch sử tài chính). NULL = ví mồ côi của user đã xoá.
    user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    balance: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default="0"
    )
    held: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default="0"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=_utcnow
    )

    user = relationship("User")


class WalletTransaction(Base):
    """Sổ cái BẤT BIẾN — mỗi lần số dư đổi = đúng 1 dòng. KHÔNG update (trừ cột
    `reversed` cho invite_fee — cờ refund-once), KHÔNG hard-delete.

    `amount` có dấu: + cộng khả dụng, − trừ khả dụng. Với hold/settle rút thì tiền
    di chuyển qua `held` (xem `held_after`). `balance_after`/`held_after` = trạng
    thái SAU giao dịch, phục vụ đối soát.
    """

    __tablename__ = "wallet_transactions"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    # Số thứ tự ghi tăng đơn điệu (IDENTITY). `id` là uuid4 ngẫu nhiên và nhiều giao
    # dịch trong CÙNG 1 request chia sẻ `created_at` (func.now() = mốc transaction),
    # nên phải dùng `seq` làm khoá sắp xếp/tiebreak để số dư "Còn" (balance_after)
    # đọc đúng thứ tự thời gian. KHÔNG set tay — DB tự cấp.
    seq: Mapped[int] = mapped_column(BigInteger, Identity(), nullable=False, index=True)
    wallet_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("wallets.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # topup | order_topup | invite_fee | invite_refund | renew_fee | withdraw_hold |
    # withdraw_settle | withdraw_refund | adjust
    kind: Mapped[str] = mapped_column(String(24), nullable=False, index=True)
    amount: Mapped[int] = mapped_column(BigInteger, nullable=False)
    balance_after: Mapped[int] = mapped_column(BigInteger, nullable=False)
    held_after: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    # topup | order | invite | renew | withdrawal | null
    ref_type: Mapped[str | None] = mapped_column(String(24), nullable=True)
    ref_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    meta: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # Cờ đã-hoàn cho invite_fee (idempotent refund). Chỉ false → true.
    reversed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false", index=True
    )
    actor_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True
    )

    wallet = relationship("Wallet")


class TopupOrder(Base):
    """Lệnh nạp tiền. Nội dung CK = `{prefix}{ref_code}`; webhook SePay khớp
    `ref_code` để cộng số dư. Chuyển `pending → paid` đúng 1 lần."""

    __tablename__ = "topup_orders"
    __table_args__ = (
        UniqueConstraint("ref_code", name="uq_topup_orders_ref_code"),
        CheckConstraint("amount_vnd > 0", name="ck_topup_amount_pos"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    # SET NULL: giữ lịch sử nạp khi xoá user (xem migration 0032).
    user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    ref_code: Mapped[str] = mapped_column(String(24), nullable=False, index=True)
    amount_vnd: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # pending | paid | expired
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending", server_default="pending", index=True
    )
    paid_amount_vnd: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    provider_txn_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    transaction_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("wallet_transactions.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True
    )
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user = relationship("User")


class PaymentOrder(Base):
    """Hoá đơn thanh toán QR cho MỜI/GIA HẠN khi ví KHÔNG đủ (feature 003 bổ sung).

    Ví đủ → trừ ví thẳng, KHÔNG tạo order. Ví thiếu → tạo order `pending` mang
    intent (mời email nào / gia hạn member nào), trả QR mã ORDER. Khi webhook SePay
    nhận đúng tiền (mã ORDER + số tiền khớp) → credit ví số nhận được → THỰC THI
    intent (mời/gia hạn) rồi trừ phí. `pending → paid` đúng 1 lần.

    Nếu action lỗi sau khi đã nạp → `fulfillment_error` set, phí được hoàn/không trừ
    (tiền QR ở lại ví). Nạp KHÔNG thành công (sai tiền/mã) → order giữ `pending`,
    không đổi gì.
    """

    __tablename__ = "payment_orders"
    __table_args__ = (
        UniqueConstraint("ref_code", name="uq_payment_orders_ref_code"),
        CheckConstraint("amount_vnd > 0", name="ck_payment_orders_amount_pos"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    # SET NULL: giữ lịch sử hoá đơn khi xoá user (đồng bộ nguyên tắc lưu trữ tiền).
    user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    workspace_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="SET NULL"), nullable=True
    )
    ref_code: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    # invite | renew
    kind: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    amount_vnd: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # pending | paid | cancelled | expired
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending", server_default="pending", index=True
    )
    # Intent để REPLAY khi thanh toán xong: invite → {role, entries:[{email,months}]};
    # renew → {member_id, months}. Đủ để perform_*_core chạy lại độc lập.
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    paid_amount_vnd: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    provider_txn_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    transaction_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("wallet_transactions.id", ondelete="SET NULL"), nullable=True
    )
    # Kết quả thực thi sau khi thanh toán: queue task (invite) / member (renew).
    queue_item_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("queue_items.id", ondelete="SET NULL"), nullable=True
    )
    member_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("members.id", ondelete="SET NULL"), nullable=True
    )
    fulfilled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    fulfillment_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=_utcnow
    )
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user = relationship("User")


class WithdrawalRequest(Base):
    """Yêu cầu rút tiền. Tạo yêu cầu → giữ (hold) số dư. Super-admin duyệt:
    `pending → settled` (đã chi) hoặc `pending → rejected` (hoàn held về balance)."""

    __tablename__ = "withdrawal_requests"
    __table_args__ = (
        CheckConstraint("amount_vnd > 0", name="ck_withdrawal_amount_pos"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    # SET NULL: giữ lịch sử rút khi xoá user (xem migration 0032).
    user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    amount_vnd: Mapped[int] = mapped_column(BigInteger, nullable=False)
    bank_account: Mapped[str] = mapped_column(String(255), nullable=False)
    # pending | settled | rejected
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending", server_default="pending", index=True
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    reject_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    hold_txn_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("wallet_transactions.id", ondelete="SET NULL"), nullable=True
    )
    settle_txn_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("wallet_transactions.id", ondelete="SET NULL"), nullable=True
    )
    reviewed_by_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user = relationship("User", foreign_keys=[user_id])
    reviewed_by = relationship("User", foreign_keys=[reviewed_by_id])


class SepayIdem(Base):
    """Chống trùng webhook SePay (bền vững qua restart/multi-worker) — thay
    InMemoryStore của module sepay. `key` = idempotency key của SePay."""

    __tablename__ = "sepay_idem"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class PaymentSettings(Base):
    """Cấu hình thanh toán (singleton id=1). Phí mời + thông tin ngân hàng nhận
    (in lên QR). Secret webhook SePay KHÔNG ở đây — đọc từ env."""

    __tablename__ = "payment_settings"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_payment_settings_singleton"),
        CheckConstraint("invite_fee_vnd >= 0", name="ck_payment_settings_fee_nonneg"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    invite_fee_vnd: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=380000, server_default="380000"
    )
    bank_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    account_number: Mapped[str | None] = mapped_column(String(64), nullable=True)
    account_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    code_prefix: Mapped[str] = mapped_column(
        String(8), nullable=False, default="NAP", server_default="NAP"
    )
    amount_tolerance_vnd: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=1000, server_default="1000"
    )
    # Cấu trúc mã thanh toán đa luồng trên SePay (feature 003 bổ sung). List các luồng:
    # [{"key","label","prefix","suffix_min","suffix_max","suffix_type","enabled"}].
    # Luồng key="topup" (NAP) cộng ví; luồng khác nhận diện được nhưng cần consumer
    # riêng. Webhook match content theo prefix của TỪNG luồng đang bật.
    payment_codes: Mapped[list[dict] | None] = mapped_column(JSONB, nullable=True)
    # Phương thức xác thực webhook SePay: 'none' | 'apikey' | 'hmac'. Secret ở env
    # (SEPAY_APIKEY cho apikey; SEPAY_WEBHOOK_SECRET cho hmac). Bỏ OAuth 2.0.
    sepay_auth_method: Mapped[str] = mapped_column(
        String(16), nullable=False, default="apikey", server_default="apikey"
    )
    updated_by_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=_utcnow
    )


# =============================================================================
# Nhắc gia hạn qua Telegram (feature 004-telegram-renewal-reminder)
# Xem docs/Notifications/Renewal_Reminder_Telegram.md trước khi sửa.
# =============================================================================


class TelegramSettings(Base):
    """Cấu hình bot Telegram do super-admin nhập TỪ GIAO DIỆN (singleton id=1).

    Vì sao có bảng này thay vì chỉ đọc .env: đổi token/nhóm nhận tổng hợp mà phải SSH
    vào VPS sửa .env rồi restart container thì gần như không ai làm. Mô hình này học
    từ dự án Tele_Bot (`master/services/bot_registry_service.py`): **xác thực token
    bằng getMe trước khi lưu**, **mã hoá Fernet khi cất vào DB**, và cache lại để
    khỏi giải mã mỗi lần gửi.

    Thứ tự ưu tiên khi chạy: **.env thắng** (giữ nguyên hành vi cũ cho dev/test và
    cho phép khoá cứng cấu hình ở môi trường nhạy cảm); .env trống thì mới dùng bảng này.

    Khoá Fernet suy ra từ `JWT_SECRET` (không thêm biến môi trường mới — nếu bắt đặt
    thêm 1 biến nữa thì lại phải SSH, đúng thứ đang muốn tránh). Hệ quả: **đổi
    JWT_SECRET ⇒ không giải mã được token cũ** → hệ thống coi như chưa cấu hình và
    super-admin nhập lại token (xem services/telegram._decrypt).
    """

    __tablename__ = "telegram_settings"
    __table_args__ = (CheckConstraint("id = 1", name="ck_telegram_settings_singleton"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    # Token @BotFather đã mã hoá Fernet. NULL = chưa cấu hình qua UI.
    bot_token_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    # @username bot lấy từ getMe lúc lưu (không có '@') — dựng deep-link, khỏi gọi lại.
    bot_username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Secret webhook SINH TỰ ĐỘNG khi lưu token (không bắt admin tự nghĩ chuỗi ngẫu
    # nhiên). Webhook bắt buộc phải có secret — xem routers/telegram.telegram_webhook.
    webhook_secret: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # Nhóm nhận BẢN TỔNG HỢP, nhiều đích ngăn bằng dấu phẩy (ID group thường ÂM).
    admin_chat_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_by_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=_utcnow
    )


class TelegramContact(Base):
    """MỌI người đã từng bấm /start bot — sổ địa chỉ để 'chỉ định bằng @username'.

    LÝ DO TỒN TẠI: Bot API **không gửi được tin theo @username** (chat_id chỉ nhận số,
    hoặc @username của KÊNH công khai) và bot **không được phép nhắn trước** cho người
    chưa /start (403 'bot can't initiate conversation with a user'). Bảng này ghi lại
    (username → chat_id) ngay khi ai đó /start, nhờ vậy admin chỉ định `@ai_do` cho một
    email thì hệ thống tự khớp ra chat_id khi người ấy mở bot.
    """

    __tablename__ = "telegram_contacts"

    # chat_id của cuộc trò chuyện RIÊNG với bot (= user id Telegram, luôn > 0).
    chat_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    # Lowercase, KHÔNG có '@'. NULL = tài khoản Telegram không đặt username → chỉ có
    # thể chỉ định bằng ID số.
    username: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    display_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # Set khi Telegram trả 403 (bot bị chặn / tài khoản bị vô hiệu). Người nhận bị
    # chặn thì KHÔNG gửi nữa cho tới khi họ /start lại (webhook xoá mốc này).
    blocked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class TelegramLinkToken(Base):
    """Mã cho deep-link `t.me/<bot>?start=<token>` — HAI mục đích khác nhau:

    - `purpose='link_self'` (mặc định): chính chủ bấm 'Kết nối Telegram' ở Cài đặt →
      gán chat_id vào tài khoản của họ. **Dùng-một-lần**, hạn ngắn: lộ link cũng không
      chiếm được tài khoản khác.
    - `purpose='invite_sub'`: chủ tài khoản tạo link để **mời NGƯỜI KHÁC nhận thông
      báo của mình** (nhân viên, khách…). Link này **dùng được nhiều lần** tới khi hết
      hạn — chủ tài khoản thường gửi cho vài người; mỗi người bấm Start tạo 1 bản ghi
      `TelegramSubscription` riêng. Phạm vi email **gắn sẵn vào link** (`scope`/
      `member_ids`) nên gửi link nào thì người bấm nhận đúng những email đã chọn cho
      họ — không có khoảng thời gian "lỡ nhận hết rồi mới thu hẹp".
    - `purpose='invite_member'` (kèm `member_id`): link cho **ĐÚNG MỘT EMAIL** — đại lý
      mời email xong bấm nút "Thông báo" là ra link này rồi gửi cho khách; khách bấm
      Start là thành người nhận nhắc gia hạn của riêng email đó (khỏi phải gõ
      `/email <địa chỉ>`). Email đã có người nhận khác thì link báo từ chối.

    ⚠️ Khác biệt "một lần vs nhiều lần" là CỐ Ý: link_self là chứng minh danh tính nên
    phải dùng-một-lần; invite_sub chỉ cấp quyền NHẬN thông báo (không đụng tài khoản),
    và chủ tài khoản có thể gỡ từng người nhận bất cứ lúc nào.
    """

    __tablename__ = "telegram_link_tokens"

    token: Mapped[str] = mapped_column(String(48), primary_key=True)
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # 'link_self' | 'invite_sub' | 'invite_member'
    purpose: Mapped[str] = mapped_column(
        String(16), nullable=False, default="link_self", server_default="link_self"
    )
    # Chỉ dùng với purpose='invite_member': email mà link này gắn thông báo tới.
    member_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("members.id", ondelete="CASCADE"), nullable=True
    )
    # ── Chỉ dùng với purpose='invite_sub' ────────────────────────────────────
    # Tên gợi nhớ do chủ tài khoản đặt ("Nhân viên A", "Kế toán") — cần vì một tài
    # khoản phát NHIỀU link cùng lúc, mỗi link một phạm vi khác nhau.
    label: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Phạm vi gắn sẵn: 'all' | 'selected'. NULL = 'all' (link phát trước khi có cột này).
    scope: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Danh sách member.id (chuỗi UUID) khi scope='selected'.
    member_ids: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class TelegramTemplate(Base):
    """Mẫu nội dung thông báo RIÊNG của một tài khoản (đại lý tự soạn).

    Không đặt gì ⇒ dùng **mẫu gốc** trong `services/renewal_reminder`.

    Một tài khoản có NHIỀU mẫu, mỗi mẫu một PHẠM VI — vì cùng một đại lý cần nói khác
    nhau tuỳ nơi (tin cho khách lẻ của một email khác tin cho nhân viên trực):
      - `scope='all'`    — mẫu chung, dùng khi không có mẫu nào cụ thể hơn.
      - `scope='chat'`   — áp cho mọi tin gửi tới `chat_id` đó.
      - `scope='member'` — áp cho tin nói về đúng email `member_id`.
    Cụ thể hơn thì thắng: member > chat > all (`renewal_reminder._pick_template`).

    Ba ô, đều không bắt buộc (đặt MỘT ô cũng đủ để dòng mẫu tồn tại):
      - `body`: thân tin, chèn `{items}` để bung danh sách email.
      - `item_line`: mẫu MỘT dòng email trong danh sách đó.
      - `renew_url`: trang gia hạn của đại lý, dành cho người nhận không có tài khoản web.
    Chỗ trống dùng biến `{...}` — xem TEMPLATE_PLACEHOLDERS. Biến lạ ⇒ API trả 400
    ngay lúc lưu, không để tới lúc gửi mới hỏng.

    Tin dùng parse_mode=HTML nên đại lý bôi đậm/nghiêng được. HTML hỏng khiến Telegram
    từ chối (400 'can't parse entities') → hệ thống TỰ gửi lại bằng mẫu gốc để thông
    báo không bao giờ bị mất chỉ vì lỗi soạn thảo (xem renewal_reminder.flush_pending).
    """

    __tablename__ = "telegram_templates"
    # Ràng buộc đặt ở DB chứ không chỉ ở tầng API: hai request lưu song song thì kiểm
    # tra trong Python không đủ, mà hai mẫu cùng một phạm vi thì lúc gửi không biết lấy
    # cái nào. Phải khớp từng chữ với migration 0052 — test dựng schema bằng
    # `create_all`, lệch một dấu là test xanh trong khi production đỏ.
    __table_args__ = (
        CheckConstraint(
            "(scope = 'all' AND chat_id IS NULL AND member_id IS NULL)"
            " OR (scope = 'chat' AND chat_id IS NOT NULL AND member_id IS NULL)"
            " OR (scope = 'member' AND member_id IS NOT NULL AND chat_id IS NULL)",
            name="ck_telegram_templates_scope_target",
        ),
        Index(
            "ux_telegram_templates_all",
            "user_id",
            unique=True,
            postgresql_where=text("scope = 'all'"),
        ),
        Index(
            "ux_telegram_templates_chat",
            "user_id",
            "chat_id",
            unique=True,
            postgresql_where=text("scope = 'chat'"),
        ),
        Index(
            "ux_telegram_templates_member",
            "user_id",
            "member_id",
            unique=True,
            postgresql_where=text("scope = 'member'"),
        ),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 'all' | 'chat' | 'member' — DB có check constraint buộc đúng cột đi kèm phạm vi,
    # và unique riêng từng phạm vi để không bao giờ có hai mẫu tranh nhau một chỗ.
    scope: Mapped[str] = mapped_column(String(16), nullable=False, default="all")
    chat_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    member_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("members.id", ondelete="CASCADE"), nullable=True
    )
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    item_line: Mapped[str | None] = mapped_column(Text, nullable=True)
    # TRANG GIA HẠN của riêng đại lý cho phạm vi này (http/https). Đây là thứ thay vào
    # `{link}` khi người nhận KHÔNG đăng nhập được dashboard — khách cuối, người được
    # mời theo dõi. NULL ⇒ `{link}` thành câu "liên hệ người bán để gia hạn".
    # Xem `services/renewal_reminder.link_text`.
    renew_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=_utcnow
    )


class TelegramSubscription(Base):
    """MỘT người nhận thông báo của MỘT tài khoản dashboard, kèm phạm vi nhận.

    Sinh ra khi ai đó bấm link mời (`purpose='invite_sub'`) của chủ tài khoản. Mặc
    định nhận **toàn bộ** thông báo của tài khoản đó; chủ tài khoản có thể thu hẹp
    xuống **chỉ vài email** trong trang Cài đặt → Telegram → Người nhận thông báo.

    Khác `Member.notify_telegram_*` (chỉ định theo TỪNG email, thường là khách cuối):
    bảng này là **danh sách phát** của chủ tài khoản (nhân viên/đối tác), nên người
    nhận ở đây vẫn nhận song song với người được chỉ định theo email.
    """

    __tablename__ = "telegram_subscriptions"
    __table_args__ = (
        UniqueConstraint("user_id", "chat_id", name="uq_tele_sub_user_chat"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    # Chủ tài khoản — NGUỒN thông báo (email do người này add).
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    chat_id: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
    # Tên/@username ghi lại lúc người đó bấm Start — để chủ tài khoản nhận ra ai là ai.
    display_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # Link mời GẦN NHẤT đã đưa người này vào (token). Không đặt FK: link hết hạn/bị gỡ
    # thì người nhận vẫn phải còn. Dùng để phân biệt bấm LẠI đúng link đó (giữ nguyên
    # phạm vi chủ tài khoản đã tinh chỉnh) với bấm link KHÁC (cộng thêm phạm vi của
    # link mới vào phạm vi đang có — bấm link chỉ thêm, không bao giờ bớt).
    invite_token: Mapped[str | None] = mapped_column(String(48), nullable=True)
    # 'all' = mọi email của chủ tài khoản (kể cả email thêm sau này)
    # 'selected' = chỉ các email trong `member_ids`
    scope: Mapped[str] = mapped_column(
        String(16), nullable=False, default="all", server_default="all"
    )
    # Danh sách member.id (chuỗi UUID) khi scope='selected'. Lưu JSONB thay vì bảng
    # nối: chỉ đọc theo cả cụm khi quét nhắc, không cần truy vấn ngược theo member.
    member_ids: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=_utcnow
    )


class TelegramNotification(Base):
    """Nhật ký + KHOÁ CHỐNG TRÙNG của mỗi tin nhắc gia hạn.

    Vòng đời 1 hàng = 1 (email × người nhận × mốc nhắc):
      pending → sent            (gửi được)
              → blocked         (bot bị chặn / người nhận chưa /start → thôi thử lại)
              → failed (retry)  (lỗi tạm: mạng, 429…) — job nền thử lại tới `attempts` = 3
              → skipped         (email đã gia hạn/bị gỡ TRƯỚC khi tin kịp gửi → bỏ,
                                 không gửi thông tin đã sai)

    `dedupe_key` UNIQUE là thứ đảm bảo **mỗi email chỉ nhắc ĐÚNG 1 lần cho mỗi mốc**
    dù job chạy lại bao nhiêu lần (INSERT ... ON CONFLICT DO NOTHING = giành chỗ).
    Nhiều hàng cùng một người nhận được GỘP thành 1 tin nhắn (xem renewal_reminder.py).
    """

    __tablename__ = "telegram_notifications"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    # 'renewal_reminder' (nhắc trước hạn) | 'test' (gửi thử từ Cài đặt).
    event_type: Mapped[str] = mapped_column(String(48), nullable=False, index=True)
    # "<event>:<member_id>:<bucket>d:<chat_id>" — xem renewal_reminder._dedupe_key.
    dedupe_key: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    member_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("members.id", ondelete="CASCADE"), nullable=True, index=True
    )
    # User dashboard liên quan (chủ sở hữu email). NULL nếu người nhận là khách được
    # chỉ định hoặc group admin.
    user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    chat_id: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
    # 'owner' (đại lý đã add email) | 'assignee' (người được chỉ định) | 'admin' (digest).
    # Quyết định LỜI VĂN của tin nhắn — xem renewal_reminder._render_message.
    recipient_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    # Mốc nhắc (số ngày còn lại): 3 hoặc 1 theo RENEWAL_REMINDER_DAYS.
    days_bucket: Mapped[int] = mapped_column(Integer, nullable=False)
    # 'pending' | 'sent' | 'failed' | 'blocked'
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending", server_default="pending", index=True
    )
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    telegram_message_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True
    )
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
