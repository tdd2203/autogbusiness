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

TRẦN SỐ LẦN CHUYỂN CỦA MỘT NGƯỜI DÙNG (user chốt 4/9/2026): mỗi lần chuyển ghi lên
chuỗi `origin_email` / `transferred_*` tiêu một lượt của CÙNG một người dùng, quá trần
thì lần chuyển tiếp (B → C) bị TỪ CHỐI — nhưng CHỈ tính những lần chuyển ghi từ
`REPEAT_RULE_FROM` trở đi ("các email cũ đã đổi thì cứ kệ nó, giờ bắt đầu áp dụng").
Ca CỘNG DỒN không ghi `origin_email` lên email nhận (họ giữ nguyên danh tính của chính
mình, chỉ được tặng thêm ngày) nên không bao giờ tiêu lượt.

SUPER-ADMIN KHÔNG BỊ TRẦN (user 8/9/2026): admin đổi hộ khách thì đổi được, trần chỉ
áp cho tài khoản phụ. Admin vẫn ĐỌC được câu nhắc "người này đã chuyển rồi" —
`repeat_transfer_notice` trả câu đó kể cả khi không chặn.

Mọi con số của luật nằm ở khối THAM SỐ ngay dưới đây — nâng trần hay mở/khoá miễn trừ
là sửa ĐÚNG một dòng, không đi lục logic hay câu chữ (câu từ chối tự sinh theo trần).
"""

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models import Member, User

# Kiểu chuyển ghi trên bản ghi CHO.
TRANSFER_KIND_TAKEOVER = "takeover"  # email nhận tiếp quản danh tính (có mời vào)
TRANSFER_KIND_ACCUMULATE = "accumulate"  # cộng dồn vào email đang dùng

# ═══════════════════════════════════════════════════════════════════════════════
# THAM SỐ CỦA LUẬT — đổi số Ở ĐÂY, tuyệt đối không viết số vào logic hay câu chữ
# ═══════════════════════════════════════════════════════════════════════════════

# Trần số lần chuyển hạn của MỘT người dùng (tính theo email gốc; chỉ đếm những lần
# ghi từ `REPEAT_RULE_FROM` trở đi). `None` = không giới hạn.
# Mở đường B → C kèm THU PHÍ thì nâng số này rồi nối phần tính phí — câu từ chối tự
# đổi theo, không phải sửa chữ ở đâu khác (user 4/9/2026).
MAX_TRANSFERS_PER_USER: int | None = 1

# Super-admin có được vượt trần không (user 8/9/2026: "admin đổi thì cho phép, người
# dùng thì bị giới hạn"). True = admin đổi hộ khách lúc nào cũng được; tài khoản phụ
# luôn theo trần trên. Đổi thành False là siết cả admin, không cần đụng chỗ nào khác.
SUPER_ADMIN_EXEMPT = True

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
    """Lần chuyển ở mốc này có tiêu một lượt của người dùng không.

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


def transfers_used(db: Session, member: Member) -> int:
    """Số lượt chuyển hạn mà NGƯỜI DÙNG đứng sau bản ghi này đã tiêu.

    Đi ngược chuỗi `transferred_from_member_id` (A ← B ← C): mỗi mắt xích là một lần
    chuyển, cộng thêm một lượt nếu chính bản ghi này cũng đã trao hạn đi rồi. Chỉ
    đếm mắt xích ghi từ `REPEAT_RULE_FROM` trở đi.

    Đếm bằng chuỗi chứ không bằng cột đếm sẵn: chuỗi là thứ đã có và luôn đúng, còn
    một cột đếm là thêm chỗ để lệch. `seen` chặn vòng lặp nếu dữ liệu cũ có mắt xích
    trỏ vòng.
    """
    used = 1 if _counts_for_rule(member.transferred_out_at) else 0
    seen = {member.id}
    node = member
    while node.transferred_from_member_id is not None:
        if _counts_for_rule(node.transferred_in_at):
            used += 1
        previous = db.get(Member, node.transferred_from_member_id)
        if previous is None or previous.id in seen:
            break
        seen.add(previous.id)
        node = previous
    return used


def actor_exempt(user: User) -> bool:
    """Người đang thao tác có được miễn trần không (admin đổi hộ khách)."""
    return SUPER_ADMIN_EXEMPT and bool(user.is_super_admin)


def repeat_transfer_notice(db: Session, member: Member) -> str | None:
    """Câu "người dùng này hết lượt chuyển rồi" — preview và lệnh thật dùng CHUNG.

    Trả None khi còn lượt (lần chuyển trước `REPEAT_RULE_FROM` không tiêu lượt). Có
    câu ⇒ đã chạm trần `MAX_TRANSFERS_PER_USER`; câu đó là lời TỪ CHỐI với tài khoản
    phụ, còn với admin chỉ là ghi chú (xem `repeat_transfer_block`).
    """
    limit = MAX_TRANSFERS_PER_USER
    if limit is None:
        return None
    used = transfers_used(db, member)
    if used < limit:
        return None
    quota = f"mỗi người dùng chỉ được chuyển hạn {limit} lần (đã dùng {used})"
    if _counts_for_rule(member.transferred_out_at):
        to = member.transferred_to_email or "email khác"
        return f"{member.email} đã chuyển hạn sang {to} rồi — {quota}."
    frm = member.transferred_from_email or member.origin_email or "email khác"
    return (
        f"{member.email} vốn nhận hạn chuyển từ {frm} "
        f"(email gốc: {origin_email_of(member)}) — {quota}."
    )


def repeat_transfer_block(db: Session, member: Member, *, actor: User) -> str | None:
    """Lý do TỪ CHỐI lần chuyển này, hoặc None nếu được phép.

    Một chỗ duy nhất cho cả preview lẫn lệnh thật ⇒ modal khoá nút với ĐÚNG câu mà
    endpoint sẽ trả 409, không lệch chữ.
    """
    if actor_exempt(actor):
        return None
    return repeat_transfer_notice(db, member)


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
