"""Chức năng: DANH TÍNH NGƯỜI DÙNG ĐI XUYÊN CÁC EMAIL (chuyển hạn sử dụng).

Một người dùng = một EMAIL GỐC. Đổi email hay chuyển hạn sang email khác đều là
*cùng người đó dùng địa chỉ khác*, nên bản ghi member nào cũng mang theo:

  - `origin_email` — đầu chuỗi A→B→C (NULL ⇒ chính nó là gốc);
  - `transferred_from_*` — bản ghi đã trao hạn cho nó (chỉ ca TIẾP QUẢN);
  - `transferred_to_*` — bản ghi đã nhận hạn từ nó (ghi cho CẢ hai kiểu chuyển).

Vì sao là cột chứ không phải nhật ký (migration 0066): trước 4/9/2026 chuỗi cũ→mới
chỉ nằm trong `MEMBER_EMAIL_CHANGED`, nên mỗi nơi cần nó lại tự dò một kiểu (mũi tên
tab "Đã xoá", ô gộp tiền của email cũ, kế thừa trạng thái thanh toán, timeline hai
chiều) và nhật ký `MEMBER_SUBSCRIPTION_TRANSFERRED` thì KHÔNG nơi nào đọc — gộp hai
chức năng về một mà giữ cách đó là mất trắng cả chuỗi lẫn tiền.

LUẬT "MỖI NGƯỜI DÙNG CHỈ CHUYỂN 1 LẦN" (user chốt 4/9/2026): bản ghi nào đã có
`origin_email` nghĩa là nó vốn sinh ra từ một lần chuyển ⇒ lần chuyển tiếp (B → C)
bị TỪ CHỐI — nhưng CHỈ tính những lần chuyển ghi từ `REPEAT_RULE_FROM` trở đi
("các email cũ đã đổi thì cứ kệ nó, giờ bắt đầu áp dụng"). Ca CỘNG DỒN không ghi
`origin_email` lên email nhận (họ giữ nguyên danh tính của chính mình, chỉ được tặng
thêm ngày) nên không bao giờ bị chặn.

Đường B → C sẽ được mở lại KÈM THU PHÍ; chốt chặn vì thế gom vào ĐÚNG một cờ
`ALLOW_REPEAT_TRANSFER` + một hàm sinh câu chữ, để lúc mở chỉ phải bật cờ và nối
phần tính phí chứ không phải đi lục lại từng nơi.
"""

from datetime import datetime, timezone

from app.models import Member

# Kiểu chuyển ghi trên bản ghi CHO.
TRANSFER_KIND_TAKEOVER = "takeover"  # email nhận tiếp quản danh tính (có mời vào)
TRANSFER_KIND_ACCUMULATE = "accumulate"  # cộng dồn vào email đang dùng

# CÔNG TẮC DUY NHẤT của luật "1 người dùng chuyển 1 lần".
#   False (hiện tại) → lần chuyển thứ 2+ bị từ chối, câu chữ lấy từ
#     `repeat_transfer_notice`; cột `origin_email`/`transferred_*` vẫn ghi đủ nên dữ
#     liệu sẵn sàng cho lúc mở.
#   True  → cho chuyển tiếp; NHỚ nối phần THU PHÍ trước khi bật (user 4/9/2026).
ALLOW_REPEAT_TRANSFER = False

# LUẬT CHỈ TÍNH TỪ MỐC NÀY (user chốt 4/9/2026: "các email cũ đã đổi thì cứ kệ nó,
# giờ bắt đầu áp dụng"). Migration 0066 backfill đủ chuỗi của 52 lần đổi email cũ —
# dữ liệu giữ nguyên để tra lịch sử, nhưng 32 email đang hoạt động đã từng đổi 1 lần
# KHÔNG bị khoá vì lần đổi đó xảy ra khi chưa có luật. Chỉ lần chuyển ghi TỪ mốc này
# trở đi mới tiêu một lượt.
#
# Mốc = lúc luật lên production, không phải 0h: sáng 4/9 vẫn còn một lần đổi email
# chạy theo luật cũ, lấy đầu ngày là phạt oan đúng khách đó.
REPEAT_RULE_FROM = datetime(2026, 9, 4, 8, 0, tzinfo=timezone.utc)


def _counts_for_rule(moment: datetime | None) -> bool:
    """Lần chuyển ở mốc này có tính vào luật "1 lần" không.

    `None` (dòng cũ chưa có cột, hoặc backfill thiếu mốc) → KHÔNG tính: thà bỏ sót
    còn hơn khoá nhầm một khách chưa từng dùng lượt nào dưới luật mới.
    """
    if moment is None:
        return False
    aware = moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
    return aware >= REPEAT_RULE_FROM


def origin_email_of(member: Member) -> str:
    """Email GỐC của người dùng đứng sau bản ghi này (chính nó nếu là gốc)."""
    return (member.origin_email or member.email or "").lower()


def repeat_transfer_notice(member: Member) -> str | None:
    """Câu "người dùng này đã chuyển hạn rồi" — preview và lệnh thật dùng CHUNG.

    Trả None nếu đây là lần chuyển đầu TÍNH THEO LUẬT (lần chuyển trước `REPEAT_RULE_FROM`
    không tiêu lượt). Có câu ⇒ đây là lần thứ 2+ của CÙNG một người dùng;
    `ALLOW_REPEAT_TRANSFER` quyết định câu đó là lời từ chối (hiện tại) hay chỉ là ghi
    chú (khi đã mở kèm thu phí).
    """
    if _counts_for_rule(member.transferred_out_at):
        to = member.transferred_to_email or "email khác"
        return (
            f"{member.email} đã chuyển hạn sang {to} rồi — mỗi người dùng chỉ được "
            "chuyển hạn 1 lần."
        )
    if member.origin_email and _counts_for_rule(member.transferred_in_at):
        frm = member.transferred_from_email or member.origin_email
        return (
            f"{member.email} vốn nhận hạn chuyển từ {frm} (email gốc: "
            f"{member.origin_email}) — mỗi người dùng chỉ được chuyển hạn 1 lần, "
            "chưa mở đường chuyển tiếp sang email thứ ba."
        )
    return None


def repeat_transfer_block(member: Member) -> str | None:
    """Lý do TỪ CHỐI lần chuyển thứ 2+, hoặc None nếu được phép.

    Một chỗ duy nhất cho cả preview lẫn lệnh thật ⇒ modal khoá nút với ĐÚNG câu mà
    endpoint sẽ trả 409, không lệch chữ.
    """
    if ALLOW_REPEAT_TRANSFER:
        return None
    return repeat_transfer_notice(member)


def record_transfer(
    source: Member,
    target: Member,
    *,
    takeover: bool,
    now: datetime,
) -> None:
    """Ghi CẢ HAI đầu của một lần chuyển hạn lên bản ghi member.

    `takeover=True` (email nhận được tạo mới / tái dùng row đã xoá ⇒ có lệnh mời):
    email nhận tiếp quản danh tính của email cho — nhận cả `origin_email`.
    `takeover=False` (cộng dồn vào email đang dùng): CHỈ ghi đầu CHO; email nhận giữ
    nguyên danh tính của chính họ, tra ngược bằng `transferred_to_member_id`.
    """
    source.transferred_to_member_id = target.id
    source.transferred_to_email = target.email
    source.transferred_out_at = now
    source.transfer_kind = (
        TRANSFER_KIND_TAKEOVER if takeover else TRANSFER_KIND_ACCUMULATE
    )
    if takeover:
        target.transferred_from_member_id = source.id
        target.transferred_from_email = source.email
        target.transferred_in_at = now
        target.origin_email = origin_email_of(source)
