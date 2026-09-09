"""payment_flow — "Ví trước, QR sau" cho phí MỜI/GIA HẠN (feature 003, user 2026-07-13).

Quy tắc (chốt bởi user):
  - Chỉ user bật cờ Ví & KHÔNG phải super-admin mới bị tính phí (`is_chargeable_user`).
  - Phí 1 lần mời/gia hạn = COALESCE(member.fee_vnd, user.invite_fee_vnd, global default)
    (`effective_fee`). Hai tầng: mặc định theo đại lý (user), override theo member.
  - Ví ĐỦ → trừ ví thẳng, KHÔNG xuất QR.
  - Ví THIẾU/không có → tạo `PaymentOrder` (mã ORDER) + trả QR; CHỜ thanh toán rồi
    webhook mới thực thi mời/gia hạn (xem sepay_integration.handle_order).

Từ 2026-08-29 dùng chung cả cho `kind='cycle'` — đại lý trả KỲ CÒN NỢ của email đã
add (dịch vụ đã giao rồi mới thu), xem added_members.pay_member_cycles.

Module này CHỈ lo cơ chế tiền (quyết định trừ/def, tạo order, dựng QR). Logic tạo
member/queue (perform_invite_core) và gia hạn (perform_renew_core) nằm ở router
tương ứng để webhook replay dùng chung.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models import (
    PLATFORM_CANVA,
    PLATFORM_GPT,
    PRICE_ROUND_TO_VND_DEFAULT,
    Member,
    PaymentOrder,
    PaymentSettings,
    User,
)
from app.routers.wallet._shared import get_payment_settings, order_prefix
from app.sepay import build_transfer_note, qr_image_url
from app.services import canva_price, wallet_service

# Kết quả decide_payment.
FREE = "free"      # miễn phí (super-admin / non-beta / phí ≤ 0) → thực thi ngay
WALLET = "wallet"  # ví đủ → trừ ví + thực thi ngay
DEFER = "defer"    # ví thiếu → tạo QR hoá đơn, chờ thanh toán

# Mã QR hoá đơn chỉ tồn tại 10 phút (user 2026-07-14: thống nhất 10′ cho đồng đều —
# đếm ngược = lúc hết hạn = lúc lệnh chưa trả tiền bị tự huỷ/xoá). Quá hạn: UI hiện
# "hết hạn"; nếu tiền VẪN về (chuyển trễ) → credit vào ví (không mất tiền), KHÔNG thực
# thi mã cũ. Job nền dọn lệnh pending quá hạn (main._purge_stale_orders_once).
ORDER_TTL_SECONDS = 10 * 60


def is_order_expired(order: PaymentOrder) -> bool:
    """Hoá đơn đã quá 10 phút kể từ lúc tạo chưa (mã QR hết hiệu lực)."""
    if order.created_at is None:
        return False
    return (datetime.now(timezone.utc) - order.created_at).total_seconds() > ORDER_TTL_SECONDS


def is_chargeable_user(user: User) -> bool:
    """User có bị tính phí mời/gia hạn không (feature 003). Super-admin & user chưa
    bật cờ Ví → miễn phí, giữ nguyên luồng cũ."""
    return bool(user.wallet_beta) and not user.is_super_admin


def effective_fee(member_fee: int | None, user: User, default_fee: int) -> int:
    """Phí MỖI THÁNG thực thu = COALESCE(member.fee_vnd, user.invite_fee_vnd, global
    default).

    `member_fee`: `members.fee_vnd` của member liên quan (None nếu member chưa tồn
    tại hoặc chưa đặt riêng). Ưu tiên override theo member > phí mặc định của user
    (đại lý) > phí mặc định toàn hệ thống.

    Đây là ĐƠN GIÁ 1 THÁNG — phí thực thu 1 lần mời/gia hạn = đơn giá × số tháng
    (xem `effective_fee_for_months`)."""
    if member_fee is not None:
        return int(member_fee)
    if user.invite_fee_vnd is not None:
        return int(user.invite_fee_vnd)
    return int(default_fee)


def effective_fee_for_months(
    member_fee: int | None, user: User, default_fee: int, months: int | None
) -> int:
    """Phí 1 lần mời/gia hạn = đơn giá/tháng (2 tầng) × SỐ THÁNG (user 2026-07-13:
    "phí × số tháng"). `months` None/<1 → tính tối thiểu 1 tháng (mời không đặt hạn
    vẫn thu 1 tháng)."""
    per_month = effective_fee(member_fee, user, default_fee)
    n = months if months and months >= 1 else 1
    return per_month * n


def prorated_fee(
    per_month: int, prorated_half_days: int, cycle_days: int, round_to: int
) -> int:
    """Tiền của PHẦN LẺ ở chế độ `cycle_aligned` — EXPIRY_RULES §3.6.5.

        đơn_giá_tháng × số_nửa_ngày / (2 × số_ngày_chu_kỳ),  làm tròn LÊN bội `round_to`

    Đơn vị vào là NỬA NGÀY (số nguyên) nên không có phép chia số thực nào lọt vào
    tiền. Làm tròn lên bội 1.000đ vì tiền lẻ hàng trăm đồng chỉ tổ lệch khi đối soát
    chuyển khoản (cùng lý do với `canva_price._ROUND_TO`).

    Hàm THUẦN — không đụng DB — để test khoá số gọi thẳng được.
    """
    if prorated_half_days <= 0 or cycle_days <= 0 or per_month <= 0:
        return 0
    step = max(1, int(round_to))
    # Gộp phép chia theo chu kỳ VÀ phép làm tròn lên bội `step` vào MỘT phép chia lấy
    # trần bằng số nguyên (`-(-a // b)`), để câu "không có phép chia số thực nào lọt
    # vào tiền" ở trên là sự thật chứ không phải lời hứa. Đi qua `float` thì một cửa
    # sổ đáng lẽ ra tròn bội `step` có thể ra 1000.0000000000001 rồi bị đội lên đúng
    # MỘT bậc làm tròn — mã QR in số này, webhook đối chiếu tiền ngân hàng thực nhận
    # thấy lệch và bỏ qua, khách trả tiền rồi mà lệnh không bao giờ chạy.
    tu_so = per_month * prorated_half_days
    mau_so = 2 * cycle_days * step
    return -(-tu_so // mau_so) * step


def fee_window_parts(
    db: Session,
    user: User,
    *,
    prorated_half_days: int,
    cycle_days: int,
    whole_months: int,
    member_fee: int | None = None,
    default_fee: int = 0,
    settings_row: PaymentSettings | None = None,
) -> tuple[int, int]:
    """`(tiền phần lẻ, tiền các chu kỳ trọn)` của một lượt bán `cycle_aligned`.

    Tách ra để màn hình bày được PHÉP TÍNH ("2 ngày lẻ 21.300đ + 1 tháng trọn
    330.000đ = 351.300đ") mà không phải tự nhân chia lại ở web — tự tính ở đó là
    dựng nguồn sự thật thứ hai cho tiền, có ngày nó lệch với số thật bị trừ.
    Tổng hai phần LUÔN bằng `fee_for_window` vì chính hàm đó gọi hàm này.
    """
    row = settings_row if settings_row is not None else get_payment_settings(db)
    per_month = effective_fee(member_fee, user, default_fee)
    # Bước làm tròn là THAM SỐ (EXPIRY_RULES §3.6.6) — giá trị dự phòng phải là chính
    # hằng của `models.py`, không phải một số 1000 gõ lại ở đây: hai nơi giữ cùng một
    # con số thì sớm muộn cũng có nơi đổi mà nơi kia quên, và chênh lệch chỉ lộ ra ở
    # số tiền trên mã QR. `getattr` giữ lại để hàng cấu hình giả trong test (không có
    # cột này) vẫn chạy được.
    round_to = int(getattr(row, "price_round_to_vnd", None) or PRICE_ROUND_TO_VND_DEFAULT)
    lele = prorated_fee(per_month, prorated_half_days, cycle_days, round_to)
    return lele, per_month * max(0, int(whole_months))


def fee_for_window(
    db: Session,
    user: User,
    *,
    prorated_half_days: int,
    cycle_days: int,
    whole_months: int,
    member_fee: int | None = None,
    default_fee: int = 0,
    settings_row: PaymentSettings | None = None,
) -> int:
    """Phí MỘT lượt bán ở chế độ `cycle_aligned` = phần lẻ + các chu kỳ TRỌN.

    Ba con số đầu lấy từ `CycleQuote` (`members/_shared.quote_cycle`) — nhận rời từng
    số chứ KHÔNG nhận cả object, vì `import app.routers.members._shared` sẽ chạy
    `members/__init__.py`, mà file đó import ngược lại chính module này ⇒ vòng import.

    Một chu kỳ TRỌN = đúng MỘT đơn giá tháng, bất kể chu kỳ dài 28 hay 31 ngày —
    giống hệt cách ChatGPT tính cho ta (`quantity × đơn_giá_tháng`).

    Đơn giá tháng vẫn ba tầng như cũ: `members.fee_vnd` → `users.invite_fee_vnd` →
    `payment_settings.invite_fee_vnd` (`effective_fee`). Nhánh Canva KHÔNG dùng hàm
    này — Canva bán theo GÓI bậc thang, không có chu kỳ hoá đơn để neo vào.
    """
    lele, tron = fee_window_parts(
        db,
        user,
        prorated_half_days=prorated_half_days,
        cycle_days=cycle_days,
        whole_months=whole_months,
        member_fee=member_fee,
        default_fee=default_fee,
        settings_row=settings_row,
    )
    return lele + tron


def bank_configured(settings_row: PaymentSettings) -> bool:
    """Đã cấu hình tài khoản ngân hàng nhận (đủ để dựng QR) chưa."""
    return bool(settings_row.bank_name and settings_row.account_number)


def decide_payment(db: Session, user: User, amount: int) -> str:
    """Quyết định: miễn phí / trừ ví / tạo QR. Khoá dòng ví khi kiểm số dư để
    nguyên tử với thao tác trừ phí ngay sau đó (chống double-spend đồng thời)."""
    if not is_chargeable_user(user) or amount <= 0:
        return FREE
    available = wallet_service.available_balance(db, user.id, lock=True)
    return WALLET if available >= amount else DEFER


def member_platform(member: Member) -> str:
    """Nhánh sản phẩm của một member — suy từ workspace, nguồn thật duy nhất.

    Member không mang cột nhánh riêng (xem models.PLATFORM_*): hai nguồn cho cùng
    một sự thật là mở đường cho lệch dữ liệu. `member.workspace` được nạp lười, và
    một lần mời chỉ đụng vài workspace nên identity map của session gánh hết.
    """
    ws = getattr(member, "workspace", None)
    return ws.platform if ws is not None else PLATFORM_GPT


def fee_for_months(
    db: Session,
    user: User,
    *,
    months: int | None,
    platform: str = PLATFORM_GPT,
    member_fee: int | None = None,
    default_fee: int = 0,
    settings_row: PaymentSettings | None = None,
) -> int:
    """Phí MỘT LẦN mời/gia hạn, định tuyến theo nhánh. Điểm vào DUY NHẤT của mọi
    chỗ tính tiền — thêm nhánh mới thì sửa ở đây, không rải `if` khắp router.

    - `gpt`   : đơn giá/tháng (2 tầng: member → đại lý → hệ thống) × số tháng.
    - `canva` : tra BẢNG BẬC (đại lý → hệ thống → bảng gốc). Mua càng dài càng rẻ
      nên KHÔNG nhân đơn giá, và KHÔNG dùng `member_fee` — xem services/canva_price.
    """
    if platform == PLATFORM_CANVA:
        row = settings_row if settings_row is not None else get_payment_settings(db)
        return canva_price.fee_for_months(canva_price.resolve_tiers(row, user), months)
    return effective_fee_for_months(member_fee, user, default_fee, months)


def order_ref_code(platform: str) -> str:
    """Sinh mã hoá đơn ngẫu nhiên; nhánh Canva mang hai ký tự cuối 'cv'.

    Tiền tố (AN/AO…) vẫn do cấu hình thanh toán quyết định và GIỮ NGUYÊN cho cả hai
    nhánh (user 2026-09-01) — chỉ hai ký tự CUỐI cho biết tiền của Canva, để nhìn
    sao kê ngân hàng là phân biệt được ngay mà không phải tra hệ thống.

    Độ dài giữ đúng 20 ký tự ở cả hai nhánh (Canva: 18 hex + 'cv'), nằm trong dải
    suffix 6..30 của luồng `order` và khớp lớp ký tự alphanumeric mà webhook dùng để
    tách mã → không phải đổi cấu hình thanh toán.
    """
    if platform == PLATFORM_CANVA:
        return f"{secrets.token_hex(9)}cv"
    return secrets.token_hex(10)


def create_order(
    db: Session,
    user: User,
    *,
    kind: str,
    amount: int,
    payload: dict,
    workspace_id: UUID | None = None,
    platform: str = PLATFORM_GPT,
    priced_at: datetime | None = None,
) -> PaymentOrder:
    """Tạo hoá đơn `pending` mang intent (mời/gia hạn) khi ví không đủ. ref_code
    ngẫu nhiên (khớp id_pattern luồng order). KHÔNG commit — caller lo.

    `priced_at` = ĐÓNG DẤU đồng hồ đã dùng để báo giá. Ở chế độ `cycle_aligned` giá và
    hạn cùng đo từ ĐIỂM NỐI, nên nếu webhook lấy giờ lúc tiền về thì trong khoảng chờ
    chuyển khoản điểm nối có thể vượt ngưỡng ép thêm tháng hoặc vượt luôn mốc chốt ⇒
    hạn giao ra nhảy thêm nguyên một mốc trong khi tiền vẫn là số đã in trên mã QR.
    Đọc dấu này lại bằng `priced_at_of`.

    Mặc định `None` = KHÔNG đóng dấu, giữ nguyên payload cũ từng byte cho mọi luồng
    chưa đổi.
    """
    if priced_at is not None:
        # Dựng dict MỚI thay vì gắn khoá vào dict của caller: caller còn dùng chính
        # payload đó để ghi nhật ký, thêm khoá vào tại chỗ là đổi luôn bản ghi đó.
        payload = {**payload, "priced_at": priced_at.isoformat()}
    order = PaymentOrder(
        user_id=user.id,
        workspace_id=workspace_id,
        ref_code=order_ref_code(platform),
        platform=platform,
        kind=kind,
        amount_vnd=int(amount),
        status="pending",
        payload=payload,
    )
    db.add(order)
    db.flush()
    return order


def priced_at_of(order: PaymentOrder) -> datetime:
    """Đồng hồ ĐÃ DÙNG ĐỂ BÁO GIÁ hoá đơn này (dấu do `create_order` đóng vào payload).

    Webhook phải áp lại ĐÚNG cửa sổ đã bán chứ không phải cửa sổ của lúc tiền về —
    xem `create_order`. Chiều lệch luôn là "giao nhiều hơn số đã bán", nên bỏ qua chỗ
    này là mất tiền thật.

    TUYỆT ĐỐI KHÔNG ĐƯỢC NÉM ngoại lệ: hàm nằm trên đường webhook, ném ở đây là
    fulfillment hỏng trong khi tiền khách ĐÃ về ví. Dấu thiếu hoặc hỏng (hoá đơn tạo
    từ trước khi có dấu này, hoặc payload bị sửa tay) rơi về `order.created_at` — báo
    giá và tạo hoá đơn nằm trong CÙNG một request nên hai mốc cách nhau vài mili giây,
    đủ chính xác cho mọi phép đo nửa ngày.

    Mốc naive coi như đã là UTC (DB lưu UTC), giống `_shared._as_utc`.
    """
    payload = order.payload if isinstance(order.payload, dict) else {}
    raw = payload.get("priced_at")
    if isinstance(raw, str):
        try:
            at = datetime.fromisoformat(raw)
        except ValueError:
            at = None
        if at is not None:
            return at if at.tzinfo is not None else at.replace(tzinfo=timezone.utc)
    created = order.created_at
    if created is None:
        # Hoá đơn chưa flush — không xảy ra trên đường webhook, nhưng thà lấy giờ hiện
        # tại còn hơn ném lỗi ở nơi tiền đã vào ví rồi.
        return datetime.now(timezone.utc)
    return created if created.tzinfo is not None else created.replace(tzinfo=timezone.utc)


def build_order_qr(settings_row: PaymentSettings, order: PaymentOrder) -> dict:
    """Dữ liệu QR + chuyển khoản cho hoá đơn (dùng lại build_transfer_note + qr_image_url
    như luồng nạp ví). Nội dung CK = {ORDER_PREFIX}{ref_code} — webhook khớp lại."""
    note = build_transfer_note(order_prefix(settings_row), order.ref_code)
    qr = qr_image_url(
        settings_row.bank_name or "",
        settings_row.account_number or "",
        settings_row.account_name or "",
        int(order.amount_vnd),
        note,
    )
    # CHỈ field JSON-thô (str/int/None) — dict này đi thẳng vào HTTPException.detail
    # (402) mà FastAPI KHÔNG jsonable_encode → tránh datetime gây lỗi serialize.
    return {
        "id": str(order.id),
        "ref_code": order.ref_code,
        "kind": order.kind,
        "amount_vnd": int(order.amount_vnd),
        "status": order.status,
        "note": note,
        "bank_name": settings_row.bank_name,
        "account_number": settings_row.account_number,
        "account_name": settings_row.account_name,
        "qr_url": qr,
        # ISO string (JSON-safe cho HTTPException.detail) — FE dựng đếm ngược 10 phút.
        "created_at": order.created_at.isoformat() if order.created_at else None,
    }


def raise_payment_required(settings_row: PaymentSettings, order: PaymentOrder) -> None:
    """Ném HTTP 402 `PAYMENT_QR_REQUIRED` kèm QR — client mở modal QR + poll order."""
    what = {"renew": "gia hạn", "subscription": "đổi hạn", "cycle": "trả kỳ"}.get(
        order.kind, "mời"
    )
    raise HTTPException(
        status_code=status.HTTP_402_PAYMENT_REQUIRED,
        detail={
            "code": "PAYMENT_QR_REQUIRED",
            "message": (
                f"Số dư Ví không đủ — quét QR thanh toán {int(order.amount_vnd):,}đ để {what}. "
                f"Nhận đủ tiền sẽ tự động xử lý."
            ),
            "order": build_order_qr(settings_row, order),
        },
    )
