"""Seed super-admin từ env nếu chưa tồn tại. Idempotent."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.config import get_settings
from app.models import PaymentSettings, User
from app.permissions import Permission
from app.security import hash_password


def seed_super_admin(db: Session) -> User | None:
    settings = get_settings()
    existing = db.execute(select(User).where(User.is_super_admin.is_(True))).scalar_one_or_none()
    if existing:
        return None

    user = User(
        email=settings.super_admin_email.lower(),
        username=settings.super_admin_username,
        password_hash=hash_password(settings.super_admin_password),
        is_super_admin=True,
        is_active=True,
        permissions=[],
    )
    db.add(user)
    db.flush()
    log_event(
        db,
        actor_type="SYSTEM",
        action="SUPER_ADMIN_SEEDED",
        target_type="USER",
        target_id=str(user.id),
        data={"email": user.email, "username": user.username},
        commit=False,
    )
    db.commit()
    db.refresh(user)
    return user


def seed_payment_settings(db: Session) -> PaymentSettings:
    """Tạo dòng cấu hình thanh toán singleton (id=1) nếu chưa có. Idempotent.

    Phí mời mặc định lấy từ env WALLET_INVITE_FEE_DEFAULT (mặc định 100k). Thông
    tin ngân hàng để trống — super-admin nhập qua UI admin Ví. Seed cấu trúc mã
    đa luồng mặc định (NAP nạp + ORDER đơn) nếu chưa có.
    """
    from app.routers.wallet._shared import DEFAULT_PAYMENT_CODES

    existing = db.get(PaymentSettings, 1)
    if existing:
        if not existing.payment_codes:
            existing.payment_codes = [dict(c) for c in DEFAULT_PAYMENT_CODES]
            db.add(existing)
            db.commit()
            db.refresh(existing)
        return existing
    settings = get_settings()
    row = PaymentSettings(
        id=1,
        invite_fee_vnd=settings.wallet_invite_fee_default,
        payment_codes=[dict(c) for c in DEFAULT_PAYMENT_CODES],
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def seed_wallet_test_account(db: Session) -> User | None:
    """Tạo tài khoản test bật sẵn cờ Ví để xem trước (feature 003). Idempotent.

    CHỈ tạo khi env WALLET_TEST_PASSWORD được set (tránh seed tài khoản mật khẩu
    yếu). Cấp quyền MEMBER_VIEW + MEMBER_INVITE để demo luồng mời có phí. Nếu tài
    khoản đã tồn tại (theo username) → đảm bảo cờ wallet_beta bật, không đổi mật khẩu.
    """
    settings = get_settings()
    password = (settings.wallet_test_password or "").strip()
    username = (settings.wallet_test_username or "wallet_tester").strip()
    if not password:
        return None
    existing = db.execute(
        select(User).where(User.username == username)
    ).scalar_one_or_none()
    if existing:
        dirty = False
        if not existing.wallet_beta:
            existing.wallet_beta = True
            dirty = True
        # Đảm bảo cờ test bật → báo cáo tài chính loại member của tài khoản này.
        if not existing.is_test:
            existing.is_test = True
            dirty = True
        if dirty:
            db.add(existing)
            db.commit()
            db.refresh(existing)
        return existing
    user = User(
        email=f"{username}@wallet-test.local",
        username=username,
        password_hash=hash_password(password),
        is_super_admin=False,
        is_active=True,
        wallet_beta=True,
        is_test=True,
        permissions=[Permission.MEMBER_VIEW.value, Permission.MEMBER_INVITE.value],
    )
    db.add(user)
    db.flush()
    log_event(
        db,
        actor_type="SYSTEM",
        action="WALLET_TEST_ACCOUNT_SEEDED",
        target_type="USER",
        target_id=str(user.id),
        data={"username": user.username, "wallet_beta": True},
        commit=False,
    )
    db.commit()
    db.refresh(user)
    return user
