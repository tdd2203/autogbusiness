import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.config import get_settings
from app.deps import get_current_user, get_session
from app.models import EmailOtp, User
from app.permissions import ALL_PERMISSIONS
from app.schemas import (
    ChangePasswordIn,
    LoginIn,
    RegisterIn,
    RegisterOut,
    ResendOtpIn,
    TokenOut,
    UserOut,
    VerifyOtpIn,
)
from app.security import create_access_token, hash_password, verify_password
from app.services.email import EmailSendError, send_otp_email

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


def _permissions_for_token(user: User) -> list[str]:
    if user.is_super_admin:
        return [p.value for p in ALL_PERMISSIONS]
    return list(user.permissions or [])


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, db: Session = Depends(get_session)) -> TokenOut:
    ident = body.identifier.strip()
    ident_lower = ident.lower()
    user = db.execute(
        select(User).where(or_(User.email == ident_lower, User.username == ident))
    ).scalar_one_or_none()

    if not user or not verify_password(body.password, user.password_hash):
        log_event(
            db,
            actor_type="ADMIN",
            actor_label=ident,
            action="LOGIN_FAILED",
            result="FAILED",
            data={"identifier": ident},
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Email/Username hoặc mật khẩu không đúng",
        )

    if not user.is_active:
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=user.id,
            actor_label=user.email,
            action="LOGIN_BLOCKED_DISABLED",
            result="FAILED",
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tài khoản đã bị vô hiệu hóa. Vui lòng liên hệ super-admin",
        )

    # Chặn đăng nhập khi đang bị cấm do spam (cùng lệnh+email lặp >3 lần → cấm 10
    # phút). Ban cũng đã bump token_version nên token cũ vô hiệu; chặn login để
    # không lấy được token mới trong thời gian cấm.
    now = datetime.now(timezone.utc)
    if user.command_ban_until and now < user.command_ban_until:
        mins = int((user.command_ban_until - now).total_seconds() // 60) + 1
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=user.id,
            actor_label=user.email,
            action="LOGIN_BLOCKED_SPAM",
            result="FAILED",
            data={"command_ban_until": user.command_ban_until.isoformat()},
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"Tài khoản tạm khoá do thao tác lặp lại quá nhiều lần. "
                f"Vui lòng thử lại sau ~{mins} phút."
            ),
        )

    perms = _permissions_for_token(user)
    token = create_access_token(user.id, user.is_super_admin, perms, user.token_version)

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="LOGIN_SUCCESS",
        result="SUCCESS",
    )
    return TokenOut(access_token=token)


# ---------------------------------------------------------------------------
# Tự đăng ký bằng OTP email
# ---------------------------------------------------------------------------
def _hash_otp(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def _gen_otp() -> str:
    """OTP 6 chữ số (secrets — an toàn mật mã)."""
    return f"{secrets.randbelow(1_000_000):06d}"


def _email_or_username_taken(db: Session, email: str, username: str) -> tuple[bool, bool]:
    """Có User THẬT nào đang chiếm email/username chưa (không tính pending OTP)."""
    rows = db.execute(
        select(User.email, User.username).where(
            or_(User.email == email.lower(), User.username == username)
        )
    ).all()
    email_taken = any(r.email == email.lower() for r in rows)
    username_taken = any(r.username == username for r in rows)
    return email_taken, username_taken


@router.post("/register", response_model=RegisterOut)
def register(body: RegisterIn, db: Session = Depends(get_session)) -> RegisterOut:
    """Bước 1: nhận email/username/mật khẩu → sinh OTP, nhờ HostMail gửi mail.

    KHÔNG tạo User ở bước này — chỉ lưu đăng ký chờ vào email_otps. User được tạo
    khi verify OTP đúng (POST /verify-otp).
    """
    settings = get_settings()
    email = body.email.lower()

    email_taken, username_taken = _email_or_username_taken(db, email, body.username)
    if email_taken or username_taken:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"email_taken": email_taken, "username_taken": username_taken},
        )

    now = datetime.now(timezone.utc)
    ttl = timedelta(minutes=settings.otp_ttl_minutes)
    code = _gen_otp()

    # Ghi đè mọi đăng ký chờ cũ cùng email (đăng ký lại = mã mới, reset số lần thử).
    db.execute(delete(EmailOtp).where(EmailOtp.email == email))
    otp = EmailOtp(
        email=email,
        username=body.username,
        password_hash=hash_password(body.password),
        code_hash=_hash_otp(code),
        attempts=0,
        last_sent_at=now,
        expires_at=now + ttl,
    )
    db.add(otp)
    db.flush()  # chưa commit — nếu gửi mail lỗi thì rollback, không để lại pending.

    try:
        send_otp_email(email, code)
    except EmailSendError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Không gửi được email xác thực, vui lòng thử lại sau.",
        ) from e

    db.commit()
    return RegisterOut(
        message="Đã gửi mã OTP tới email. Vui lòng kiểm tra hộp thư.",
        email=email,
        expires_in_sec=int(ttl.total_seconds()),
    )


@router.post("/verify-otp", response_model=TokenOut)
def verify_otp(body: VerifyOtpIn, db: Session = Depends(get_session)) -> TokenOut:
    """Bước 2: kiểm OTP → tạo User (kích hoạt ngay, quyền rỗng) → trả token (auto-login)."""
    settings = get_settings()
    email = body.email.lower()
    now = datetime.now(timezone.utc)

    otp = db.execute(
        select(EmailOtp).where(EmailOtp.email == email)
    ).scalar_one_or_none()
    if otp is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Chưa có yêu cầu đăng ký cho email này. Vui lòng đăng ký lại.",
        )

    if now > otp.expires_at:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Mã OTP đã hết hạn. Vui lòng bấm gửi lại mã.",
        )

    otp.attempts += 1
    if otp.attempts > settings.otp_max_attempts:
        db.execute(delete(EmailOtp).where(EmailOtp.email == email))
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Bạn đã nhập sai quá số lần cho phép. Vui lòng đăng ký lại.",
        )

    if _hash_otp(body.code) != otp.code_hash:
        remaining = settings.otp_max_attempts - otp.attempts
        db.add(otp)
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Mã OTP không đúng. Còn {max(remaining, 0)} lần thử.",
        )

    # OTP đúng — kiểm unique lần cuối (phòng ai đó chiếm email/username xen giữa).
    email_taken, username_taken = _email_or_username_taken(db, email, otp.username)
    if email_taken or username_taken:
        db.execute(delete(EmailOtp).where(EmailOtp.email == email))
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"email_taken": email_taken, "username_taken": username_taken},
        )

    user = User(
        email=email,
        username=otp.username,
        password_hash=otp.password_hash,  # đã hash lúc register
        is_super_admin=False,
        is_active=True,
        permissions=[],  # quyền rỗng — super-admin cấp sau ở trang Users.
        wallet_beta=True,  # MẶC ĐỊNH MỞ VÍ như tài khoản do admin tạo (users.py).
    )
    db.add(user)
    db.execute(delete(EmailOtp).where(EmailOtp.email == email))
    db.flush()
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="USER_REGISTERED",
        result="SUCCESS",
        target_type="USER",
        target_id=str(user.id),
        data={"email": user.email, "username": user.username, "via": "otp"},
        commit=False,
    )
    db.commit()
    db.refresh(user)

    token = create_access_token(user.id, False, [], user.token_version)
    return TokenOut(access_token=token)


@router.post("/resend-otp", response_model=RegisterOut)
def resend_otp(body: ResendOtpIn, db: Session = Depends(get_session)) -> RegisterOut:
    """Gửi lại OTP cho đăng ký đang chờ. Có cooldown chống spam."""
    settings = get_settings()
    email = body.email.lower()
    now = datetime.now(timezone.utc)

    otp = db.execute(
        select(EmailOtp).where(EmailOtp.email == email)
    ).scalar_one_or_none()
    if otp is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Chưa có yêu cầu đăng ký cho email này. Vui lòng đăng ký lại.",
        )

    elapsed = (now - otp.last_sent_at).total_seconds()
    cooldown = settings.otp_resend_cooldown_sec
    if elapsed < cooldown:
        wait = int(cooldown - elapsed) + 1
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Vui lòng đợi {wait}s trước khi gửi lại mã.",
        )

    ttl = timedelta(minutes=settings.otp_ttl_minutes)
    code = _gen_otp()
    otp.code_hash = _hash_otp(code)
    otp.attempts = 0
    otp.last_sent_at = now
    otp.expires_at = now + ttl
    db.add(otp)
    db.flush()

    try:
        send_otp_email(email, code)
    except EmailSendError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Không gửi được email xác thực, vui lòng thử lại sau.",
        ) from e

    db.commit()
    return RegisterOut(
        message="Đã gửi lại mã OTP tới email.",
        email=email,
        expires_in_sec=int(ttl.total_seconds()),
    )


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)) -> User:
    if user.is_super_admin:
        # trả về permissions đầy đủ cho FE render UI
        user.permissions = [p.value for p in ALL_PERMISSIONS]
    return user


@router.post("/change-password", response_model=TokenOut)
def change_password(
    body: ChangePasswordIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> TokenOut:
    if not verify_password(body.old_password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Mật khẩu cũ không đúng"
        )
    user.password_hash = hash_password(body.new_password)
    user.token_version = user.token_version + 1
    db.add(user)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="PASSWORD_CHANGED",
        result="SUCCESS",
        target_type="USER",
        target_id=str(user.id),
        commit=False,
    )
    db.commit()
    db.refresh(user)
    perms = _permissions_for_token(user)
    new_token = create_access_token(user.id, user.is_super_admin, perms, user.token_version)
    return TokenOut(access_token=new_token)
