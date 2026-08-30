"""Hạn mức THAO TÁC của người dùng dashboard — khoảng cách tối thiểu giữa hai lần
cùng một người bấm cùng một nút nặng.

Khác gì `ratelimit.py`? Hai thứ không thay được nhau:

  * `ratelimit.py` là hạn mức HẠ TẦNG: đếm số request/phút theo IP và theo băm
    token, chạy ở middleware TRƯỚC router nên không biết ai đang gọi, cũng không
    biết request này tốn 5ms hay kéo theo một lượt quét ChatGPT 2 phút. Trần của
    nó phải đặt rất cao (900/phút) để dashboard load trang không tự đá mình.
  * Module này là hạn mức NGHIỆP VỤ: sau khi đã xác thực, biết user nào bấm nút
    nào trên workspace nào. Một người bấm "Đồng bộ hoá đơn" 20 lần trong 10 giây
    nằm gọn trong 900/phút nhưng đẻ 20 task cho extension chạy lần lượt — đó mới
    là "thao tác liên tục" mà người dùng thấy.

Ba lựa chọn thiết kế, ghi lại để lần sau khỏi phải suy luận lại:

  1. **Đếm trong bộ nhớ, không dùng DB/Redis.** API chạy MỘT worker uvicorn nên
     bộ đếm trong-process là chính xác tuyệt đối (cùng lý do với `ratelimit.py`).
     Khởi động lại container thì bộ đếm sạch — chấp nhận được với mốc vài chục
     giây, nên mốc DÀI (đồng bộ toàn bộ, mặc định 5 tiếng) vẫn tính theo DB qua
     `QueueItem.created_at`, xem `routers/workspaces/triggers.py`.
  2. **Khoá đếm gồm cả workspace.** Dashboard có nhiều chỗ lặp qua từng workspace
     rồi gọi một request cho mỗi cái (thu hồi lời mời hàng loạt xuyên workspace,
     mời trộn nhiều workspace). Đếm theo mình user là chặn ngay chính những luồng
     hợp lệ đó.
  3. **Số giây nằm trong DB, không phải hằng số.** Sửa hằng số nghĩa là phải
     deploy mới nới được — lúc đại lý kêu bị chặn giữa đợt mời thì không kịp.
     Super-admin chỉnh trực tiếp ở Cài đặt (xem `routers/admin_limits.py`).

Extension (gọi bằng `X-API-KEY`) KHÔNG đi qua đây: nó là máy chạy theo lệnh, siết
nó là làm hỏng đồng bộ. Hạn mức của extension nằm ở `ratelimit.py`.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import RateLimitSettings, User


@dataclass(frozen=True)
class ActionSpec:
    """Một nút nặng có thể đặt hạn mức.

    `key` đi vào JSONB `rate_limit_settings.cooldowns` nên ĐỪNG đổi tên khi đã
    chạy production — đổi là mất giá trị super-admin đã chỉnh (rơi về mặc định).
    """

    key: str
    label: str  # tên nút theo cách gọi trong sản phẩm — hiện thẳng lên giao diện
    hint: str  # vì sao nút này nặng
    default_sec: int
    max_sec: int
    scope: str  # 'workspace' = mỗi workspace một bộ đếm | 'user' = chung cho user


# Trần chỉnh tay: 12 tiếng cho nhóm quét toàn workspace, 1 tiếng cho nhóm còn lại.
# Có trần để một lần gõ nhầm (thêm số 0) không khoá cứng cả hệ thống nhiều ngày.
_MAX_SCAN = 12 * 3600
_MAX_ACTION = 3600

ACTIONS: tuple[ActionSpec, ...] = (
    ActionSpec(
        key="WORKSPACE_FULL_SYNC",
        label="Đồng bộ toàn bộ workspace",
        hint="Extension quét cả tab Người dùng lẫn Lời mời — lượt nặng nhất, 15-150 giây.",
        default_sec=5 * 3600,
        max_sec=_MAX_SCAN,
        scope="workspace",
    ),
    ActionSpec(
        key="WORKSPACE_SYNC_BATCH",
        label="Đồng bộ hàng loạt email",
        hint="Gom nhiều email vào một lượt quét tab Người dùng.",
        default_sec=60,
        max_sec=_MAX_ACTION,
        scope="workspace",
    ),
    ActionSpec(
        key="WORKSPACE_SYNC_BILLING",
        label="Đồng bộ hoá đơn và suất",
        hint="Mở trang thanh toán ChatGPT đọc số suất, gói và danh sách hoá đơn.",
        default_sec=60,
        max_sec=_MAX_ACTION,
        scope="workspace",
    ),
    ActionSpec(
        key="WORKSPACE_PURCHASE_SEAT",
        label="Mua thêm suất",
        hint="Chạm tới tiền thật trên ChatGPT — không nên bấm dồn.",
        default_sec=60,
        max_sec=_MAX_ACTION,
        scope="workspace",
    ),
    ActionSpec(
        key="WORKSPACE_REVOKE_INVITES",
        label="Thu hồi lời mời",
        hint="Mỗi lần bấm là một lượt extension vào tab Lời mời đang chờ.",
        default_sec=15,
        max_sec=_MAX_ACTION,
        scope="workspace",
    ),
    ActionSpec(
        key="WORKSPACE_HARVEST_LABELS",
        label="Quét nhãn giao diện ChatGPT",
        hint="Extension đi qua 4 trang quản trị của ChatGPT để đọc nhãn.",
        default_sec=300,
        max_sec=_MAX_SCAN,
        scope="workspace",
    ),
    ActionSpec(
        key="MEMBER_BULK_INVITE",
        label="Mời thành viên",
        hint="Trừ phí trong ví và đẩy một mẻ lời mời cho extension.",
        default_sec=15,
        max_sec=_MAX_ACTION,
        scope="workspace",
    ),
    ActionSpec(
        key="MEMBER_BULK_REMOVE",
        label="Gỡ hàng loạt và dọn email hết hạn",
        hint="Mỗi mẻ là một loạt task gỡ cho extension chạy lần lượt.",
        default_sec=15,
        max_sec=_MAX_ACTION,
        scope="workspace",
    ),
    ActionSpec(
        key="WALLET_TOPUP",
        label="Tạo lệnh nạp tiền",
        hint="Mỗi lần bấm sinh một mã nạp mới chờ đối soát với ngân hàng.",
        default_sec=30,
        max_sec=_MAX_ACTION,
        scope="user",
    ),
    ActionSpec(
        key="WALLET_WITHDRAW",
        label="Tạo lệnh rút tiền",
        hint="Mỗi lệnh rút là một việc chờ super-admin xử lý tay.",
        default_sec=60,
        max_sec=_MAX_ACTION,
        scope="user",
    ),
    ActionSpec(
        key="MEMBER_PAY",
        label="Thanh toán từ ví",
        hint="Trừ tiền thật trong ví hoặc sinh hoá đơn chuyển khoản.",
        default_sec=20,
        max_sec=_MAX_ACTION,
        scope="user",
    ),
)

ACTION_BY_KEY: dict[str, ActionSpec] = {a.key: a for a in ACTIONS}


@dataclass(frozen=True)
class LimitConfig:
    """Ảnh chụp cấu hình đang hiệu lực (đã trộn mặc định với giá trị trong DB)."""

    enabled: bool
    exempt_super_admin: bool
    cooldowns: dict[str, int]

    def seconds_for(self, key: str) -> int:
        return self.cooldowns.get(key, ACTION_BY_KEY[key].default_sec)


def _clamp(spec: ActionSpec, raw: object) -> int | None:
    """Ép một giá trị thô trong JSONB về khoảng hợp lệ. `None` = bỏ qua (dùng mặc định)."""
    try:
        value = int(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return max(0, min(spec.max_sec, value))


# --- Cache cấu hình --------------------------------------------------------
# Hạn mức được đọc ở MỌI lần bấm nút nặng. Một truy vấn DB cho mỗi lần bấm thì
# không đáng lo, nhưng cũng không cần: cấu hình chỉ đổi khi super-admin bấm lưu,
# và lúc đó `invalidate_config_cache()` xoá cache ngay. TTL chỉ là lưới an toàn
# cho trường hợp sửa thẳng vào DB bằng tay.
_CONFIG_TTL_SEC = 30.0
_config_lock = threading.Lock()
_config_cache: LimitConfig | None = None
_config_at = 0.0


def invalidate_config_cache() -> None:
    """Gọi sau khi ghi `rate_limit_settings` để lần đọc kế tiếp lấy giá trị mới."""
    global _config_cache
    with _config_lock:
        _config_cache = None


def _env_enabled() -> bool:
    """Công tắc TẮT KHẨN CẤP dùng chung với rate-limit hạ tầng.

    `RATE_LIMIT_ENABLED=false` tắt CẢ HAI tầng: nghi hệ thống chặn nhầm thì chỉ
    phải nhớ đúng một biến (xem `ratelimit.md` mục "Tắt khẩn cấp"). Suite test
    cũng đặt biến này = false nên hàng trăm test nghiệp vụ bấm hai lần liên tiếp
    không bị cooldown chặn — test riêng của cooldown tự bật lại.
    """
    return get_settings().rate_limit_enabled


def load_config(db: Session) -> LimitConfig:
    """Cấu hình đang hiệu lực. Chưa có dòng nào trong DB → toàn bộ mặc định."""
    global _config_cache, _config_at
    now = time.monotonic()
    with _config_lock:
        if _config_cache is not None and now - _config_at < _CONFIG_TTL_SEC:
            return _config_cache

    row = db.get(RateLimitSettings, 1)
    cooldowns: dict[str, int] = {a.key: a.default_sec for a in ACTIONS}
    if row is not None:
        for key, raw in (row.cooldowns or {}).items():
            spec = ACTION_BY_KEY.get(key)
            if spec is None:
                continue  # key của phiên bản cũ — bỏ qua, không làm hỏng cấu hình
            value = _clamp(spec, raw)
            if value is not None:
                cooldowns[key] = value
    config = LimitConfig(
        enabled=_env_enabled() and (True if row is None else bool(row.enabled)),
        exempt_super_admin=True if row is None else bool(row.exempt_super_admin),
        cooldowns=cooldowns,
    )
    with _config_lock:
        _config_cache = config
        _config_at = time.monotonic()
    return config


# --- Bộ đếm ----------------------------------------------------------------
# key -> thời điểm (monotonic) của lần CHO QUA gần nhất. LRU có trần cứng vì cùng
# lý do với `ratelimit.py`: một dict không giới hạn tự nó là lỗ hổng DoS bộ nhớ.
_MAX_KEYS = 20_000
_hits: OrderedDict[str, float] = OrderedDict()
_hits_lock = threading.Lock()


def _bucket_key(user_id: object, action: str, scope_key: object) -> str:
    return f"{user_id}|{action}|{scope_key or '-'}"


def reset_state() -> None:
    """Xoá sạch bộ đếm + cache cấu hình (dùng trong test)."""
    with _hits_lock:
        _hits.clear()
    invalidate_config_cache()


def _cooldown_exc(spec: ActionSpec, limit: int, remaining: float) -> HTTPException:
    retry = max(1, int(remaining + 0.999))
    reset_at = datetime.now(timezone.utc) + timedelta(seconds=retry)
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail={
            "code": "ACTION_COOLDOWN",
            "action": spec.key,
            "message": (
                f"{spec.label}: hai lần phải cách nhau ít nhất "
                f"{describe_seconds(limit)}. Chờ thêm {describe_seconds(retry)} "
                f"rồi thử lại."
            ),
            "retry_after_sec": retry,
            "reset_at": reset_at.isoformat(),
        },
        headers={"Retry-After": str(retry)},
    )


def describe_seconds(total: int) -> str:
    """Số giây → câu tiếng Việt ngắn ('45 giây', '2 phút', '5 tiếng')."""
    if total < 60:
        return f"{total} giây"
    if total < 3600:
        minutes = total // 60
        rest = total % 60
        return f"{minutes} phút" if rest == 0 else f"{minutes} phút {rest} giây"
    hours = total // 3600
    rest_min = (total % 3600) // 60
    return f"{hours} tiếng" if rest_min == 0 else f"{hours} tiếng {rest_min} phút"


def cooldown_remaining(
    db: Session, user: User, action: str, scope_key: object = None
) -> float:
    """Số giây còn phải chờ (0.0 = bấm được ngay). KHÔNG tiêu lượt.

    Dùng cho endpoint "còn bấm được không" mà dashboard hỏi để ẩn/mờ nút.
    """
    spec = ACTION_BY_KEY[action]
    config = load_config(db)
    if not config.enabled:
        return 0.0
    if user.is_super_admin and config.exempt_super_admin:
        return 0.0
    limit = config.seconds_for(action)
    if limit <= 0:
        return 0.0
    key = _bucket_key(user.id, action, scope_key)
    now = time.monotonic()
    with _hits_lock:
        last = _hits.get(key)
    if last is None:
        return 0.0
    return max(0.0, limit - (now - last))


def enforce_action_cooldown(
    db: Session, user: User, action: str, scope_key: object = None
) -> None:
    """Chặn nếu `user` vừa bấm `action` trên `scope_key` chưa đủ lâu.

    Gọi SAU các kiểm tra rẻ (quyền, 404, body rỗng) và TRƯỚC khi tạo task/ghi DB:
    một lượt bị 400 vì body sai không nên ăn mất lượt bấm của người dùng.

    Raise 429 kèm `detail.retry_after_sec` để dashboard đếm ngược đúng.
    """
    spec = ACTION_BY_KEY[action]
    config = load_config(db)
    if not config.enabled:
        return
    if user.is_super_admin and config.exempt_super_admin:
        return
    limit = config.seconds_for(action)
    if limit <= 0:
        return

    key = _bucket_key(user.id, action, scope_key)
    now = time.monotonic()
    with _hits_lock:
        last = _hits.get(key)
        if last is not None:
            elapsed = now - last
            if elapsed < limit:
                _hits.move_to_end(key)
                remaining = limit - elapsed
                raise _cooldown_exc(spec, limit, remaining)
        _hits[key] = now
        _hits.move_to_end(key)
        # Dọn LRU: entry cũ hơn mốc dài nhất có thể đặt thì chắc chắn vô dụng.
        while len(_hits) > _MAX_KEYS:
            _hits.popitem(last=False)
