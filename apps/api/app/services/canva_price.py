"""Bảng giá nhánh CANVA — bậc thang theo số tháng (user 2026-09-01).

VÌ SAO KHÔNG DÙNG CHUNG VỚI CHATGPT: ChatGPT tính `đơn giá 1 tháng × số tháng`, một
con số nhân lên là xong. Canva bán theo GÓI, mua càng dài càng rẻ:

    1 tháng   15.000     (15.000/tháng)
    3 tháng   40.000     (13.333/tháng)
    6 tháng   70.000     (11.667/tháng)
    12 tháng 100.000     ( 8.333/tháng)

Không có cách nào nhét bốn mức đó vào một ô "đơn giá". Nhét đại bằng cách lấy
100.000/12 = 8.333 rồi nhân lên thì người mua 1 tháng trả 8.333 thay vì 15.000 —
mất tiền thật ở mọi đơn ngắn hạn.

BA TẦNG GIÁ (giống tinh thần nhánh GPT, thiếu tầng member):
    bảng riêng của đại lý (users.canva_price_tiers)
    → bảng mặc định hệ thống (payment_settings.canva_price_tiers)
    → DEFAULT_TIERS trong file này.

KHÔNG có tầng "giá riêng cho một email" (`members.fee_vnd`) như ChatGPT: giá Canva là
GÓI chứ không phải đơn giá, "giá riêng cho email này" sẽ không rõ là bậc nào. Chốt
với user 2026-09-01, cần thì sau này làm dạng giảm theo %.
"""

from __future__ import annotations

from math import ceil

# Bảng gốc — dùng khi chưa ai cấu hình gì. Số của user chốt 2026-09-01.
DEFAULT_TIERS: tuple[dict[str, int], ...] = (
    {"months": 1, "price_vnd": 15_000},
    {"months": 3, "price_vnd": 40_000},
    {"months": 6, "price_vnd": 70_000},
    {"months": 12, "price_vnd": 100_000},
)

# Phần tháng LẺ (không rơi đúng bậc nào) được quy về bội số 1.000đ, làm TRÒN LÊN.
# Tiền lẻ hàng trăm đồng trên hoá đơn chuyển khoản chỉ tổ gây lệch khi đối soát.
_ROUND_TO = 1_000


def normalize_tiers(raw: object) -> list[dict[str, int]]:
    """Đọc bảng giá từ JSONB về dạng chuẩn, bỏ qua dòng hỏng.

    Dữ liệu vào là JSONB do người dùng nhập nên phải phòng thủ: thiếu khoá, số âm,
    chữ thay vì số, trùng số tháng. Bảng rỗng/hỏng hoàn toàn → trả [] để caller rơi
    về tầng dưới, KHÔNG ném lỗi giữa luồng mời.
    """
    if not isinstance(raw, (list, tuple)):
        return []
    by_months: dict[int, int] = {}
    for row in raw:
        if not isinstance(row, dict):
            continue
        try:
            months = int(row["months"])
            price = int(row["price_vnd"])
        except (KeyError, TypeError, ValueError):
            continue
        if months < 1 or price < 0:
            continue
        by_months[months] = price  # dòng sau ghi đè dòng trước nếu trùng số tháng
    return [{"months": m, "price_vnd": by_months[m]} for m in sorted(by_months)]


def resolve_tiers(settings_row: object, user: object) -> list[dict[str, int]]:
    """Bảng giá có hiệu lực cho `user`: riêng đại lý → mặc định hệ thống → bảng gốc."""
    for source in (
        getattr(user, "canva_price_tiers", None),
        getattr(settings_row, "canva_price_tiers", None),
    ):
        tiers = normalize_tiers(source)
        if tiers:
            return tiers
    return [dict(t) for t in DEFAULT_TIERS]


def fee_for_months(tiers: list[dict[str, int]], months: int | None) -> int:
    """Giá bán cho `months` tháng theo bảng bậc.

    - Rơi đúng một bậc → lấy thẳng giá bậc đó (đường đi thường gặp: trang mời Canva
      chỉ cho chọn đúng các mốc trong bảng).
    - Dài hơn bậc lớn nhất → giá bậc lớn nhất, cộng phần dư tính theo đơn giá/tháng
      CỦA BẬC ĐÓ. 24 tháng = 100.000 + 12 × 8.333 → 200.000, đúng như mua hai lần
      gói năm, không tự dưng đắt lên.
    - Nằm giữa hai bậc → giá bậc thấp hơn gần nhất + phần dư theo đơn giá bậc đó.
      8 tháng = 70.000 + 2 × 11.667 → 93.000 (làm tròn lên 1.000).
    - Ngắn hơn bậc nhỏ nhất (bảng bắt đầu từ 3 tháng chẳng hạn) → tính theo đơn giá
      của bậc nhỏ nhất, không miễn phí.

    `months` None/≤0 → tính 1 tháng: mời không đặt hạn vẫn thu tiền, khớp quy tắc
    của nhánh GPT (`effective_fee_for_months`).
    """
    n = months if months and months >= 1 else 1
    table = tiers or [dict(t) for t in DEFAULT_TIERS]

    exact = next((t for t in table if t["months"] == n), None)
    if exact is not None:
        return int(exact["price_vnd"])

    lower = [t for t in table if t["months"] < n]
    base_tier = max(lower, key=lambda t: t["months"]) if lower else min(
        table, key=lambda t: t["months"]
    )
    base_months = int(base_tier["months"])
    base_price = int(base_tier["price_vnd"])
    per_month = base_price / base_months if base_months else base_price

    if base_months <= n:
        raw_total = base_price + (n - base_months) * per_month
    else:
        # n ngắn hơn cả bậc nhỏ nhất → chỉ tính theo đơn giá của bậc đó.
        raw_total = n * per_month

    return int(ceil(raw_total / _ROUND_TO) * _ROUND_TO)


def sellable_months(tiers: list[dict[str, int]]) -> list[int]:
    """Các mốc tháng trang mời Canva được phép chào bán (đúng các bậc trong bảng)."""
    return [int(t["months"]) for t in (tiers or [dict(t) for t in DEFAULT_TIERS])]
