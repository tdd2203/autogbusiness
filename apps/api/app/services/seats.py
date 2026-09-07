"""Chức năng: NGUỒN SUẤT (seat) DÙNG CHUNG cho toàn hệ thống.

Trước file này mỗi nơi tự viết lại câu đếm suất: `crud._apply_effective_seat_used`,
`stats.member_stats`, `auto_invite._seat_used_map`, `invite._seat_hint` và
`invite._assert_seat_available`. Năm bản sao cùng một quy tắc là năm cơ hội lệch
nhau — đã xảy ra (2026-07-08: dashboard "44/35" vì một nhánh còn blend `max()` với
số scrape cũ). Mọi nơi cần con số suất phải gọi vào đây, không tự viết `func.count`.

Hai con số, hai nguồn KHÁC nhau:

- `seat_total` = cột `Workspace.seat_total`, SCRAPE từ ChatGPT (task SYNC_BILLING
  hoặc hộp "Quản lý suất"). Chỉ đổi khi chạy sync → có thể CŨ. Không suy ra được
  từ DB, cũng KHÔNG được lấy từ hoá đơn (xem test_seat_total_source.py).
- `seat_used` = ĐẾM LẠI TRONG DB mỗi lần đọc, KHÔNG dùng cột `Workspace.seat_used`
  (scrape, lệch được cả hai chiều: vừa mời thêm chưa kịp sync thì THẤP, vừa xoá bớt
  chưa kịp sync thì CAO). DB là nguồn thật thời gian thực.

`seat_used` đếm member CHƯA bị gỡ = `active` + `pending`: lời mời đang chờ cũng nợ
một suất vì người ta bấm nhận lúc nào cũng được. Riêng guard chặn mời
(`active_used`) chỉ đếm `active` — xem docstring hàm đó.

TRẦN THÀNH VIÊN (`Workspace.invite_member_cap`) là con số THỨ BA, đừng lẫn với hai
con số trên: super-admin tự gõ = số suất đã mua thật, chạm là mọi lệnh mời vào
workspace đó dừng lại. Đo bằng `seat_used` (đã vào + đang chờ) chứ không phải
`active_used`, vì lời mời treo rồi cũng thành người thật.

Câu báo cho đại lý do admin SOẠN (bảng `invite_settings`, một câu dùng chung), thay
động `{ten}` / `{conlai}` / `{ngay}` ở `render_cap_message` — chỗ DUY NHẤT biết luật
thay chỗ, dùng chung cho cả câu 409 lẫn câu hiện trên trang Mời.

Nhánh Canva có thêm SUẤT GIỮ CHỖ CHO CHỦ ĐỘI: 50 suất của gói đã kể cả chủ đội, mà
chủ đội chỉ vào bảng `members` sau khi CANVA_SYNC quét trang People. Xem
`owner_reserve_map`.
"""

from datetime import date, datetime, timezone
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import (
    PLATFORM_CANVA,
    InviteSettings,
    Member,
    MemberSubscriptionCycle,
    Workspace,
)

# Trần overcommit khi mời: cho phép vượt `seat_total` tới +50% rồi mới chặn, vì
# `seat_total` là số scrape có thể cũ — chặn đúng bằng nó sẽ khoá oan lúc admin vừa
# mua thêm suất mà chưa sync.
SEAT_OVERCOMMIT_RATIO = 1.5

#: Câu MẶC ĐỊNH khi workspace hết chỗ tới TRẦN THÀNH VIÊN. Admin soạn lại được ở
#: nút ⚙️ trang Mời (bảng `invite_settings`, dùng chung mọi workspace); câu này chỉ
#: là bản dự phòng khi chưa ai sửa. Ba chỗ thay động, xem `render_cap_message`.
DEFAULT_CAP_MESSAGE = (
    "Workspace này chỉ còn lại {conlai} suất. Đang tạm ngưng mở thêm suất do admin "
    "đã khoá. Sẽ mở lại vào ngày {ngay}."
)

#: Thay cho `{ngay}` khi workspace chưa được đặt ngày mở lại.
NO_REOPEN_DATE = "chưa thông báo"


def seat_used_map(db: Session, workspace_ids: list[UUID]) -> dict[UUID, int]:
    """workspace_id -> số member CHƯA bị gỡ (active + pending). Một truy vấn gộp.

    Workspace không có member nào vắng mặt trong map trả về — người gọi tự `.get(id, 0)`
    hoặc dùng `seat_used()` cho một workspace.
    """
    if not workspace_ids:
        return {}
    rows = db.execute(
        select(Member.workspace_id, func.count(Member.id))
        .where(Member.workspace_id.in_(workspace_ids), Member.status != "removed")
        .group_by(Member.workspace_id)
    ).all()
    return {wid: int(n) for wid, n in rows}


def seat_used(db: Session, workspace_id: UUID, *, exclude_emails: list[str] | None = None) -> int:
    """Số suất đang bị chiếm ở 1 workspace = member `active` + `pending`.

    `exclude_emails` loại vài email ra khỏi phép đếm — luồng mời cần nó để không
    đếm hai lần chính những email của lệnh mời đang chạy (đếm thừa ⇒ mua thừa suất
    bằng tiền thật, xem `invite._seat_hint`).
    """
    stmt = (
        select(func.count(Member.id))
        .where(Member.workspace_id == workspace_id, Member.status != "removed")
    )
    lowered = [e.strip().lower() for e in (exclude_emails or []) if e]
    if lowered:
        stmt = stmt.where(Member.email.notin_(lowered))
    return int(db.execute(stmt).scalar_one() or 0)


def pending_count(db: Session, workspace_id: UUID, *, exclude_emails: list[str] | None = None) -> int:
    """Riêng số lời mời đang CHỜ nhận. Extension cần tách con số này ra khỏi
    `seat_used` để tính nợ suất khi đối chiếu với "đã gán" của ChatGPT (chỉ đếm
    người ĐÃ tham gia)."""
    stmt = (
        select(func.count(Member.id))
        .where(Member.workspace_id == workspace_id, Member.status == "pending")
    )
    lowered = [e.strip().lower() for e in (exclude_emails or []) if e]
    if lowered:
        stmt = stmt.where(Member.email.notin_(lowered))
    return int(db.execute(stmt).scalar_one() or 0)


def active_used(db: Session, workspace_id: UUID) -> int:
    """Riêng member ĐÃ THAM GIA (`active`) — mẫu số của guard chặn mời.

    Guard cố tình KHÔNG cộng `pending`: lời mời chờ chưa chiếm suất thật trên
    ChatGPT (đo trên production 24/8/2026), cộng vào sẽ chặn oan lúc workspace đang
    có nhiều lời mời treo. Hiển thị thì ngược lại — cộng `pending` cho an toàn.
    """
    return int(
        db.execute(
            select(func.count(Member.id)).where(
                Member.workspace_id == workspace_id, Member.status == "active"
            )
        ).scalar_one()
        or 0
    )


def new_seat_count(db: Session, workspace_id: UUID, emails: list[str]) -> int:
    """Trong `emails`, bao nhiêu email SẼ làm `seat_used` tăng thêm.

    Email đã có dòng member chưa bị gỡ ở CHÍNH workspace này (`active` hoặc
    `pending`) thì đang giữ chỗ rồi — gia hạn hay mời lại họ không đẩy con số lên,
    cộng vào là chặn oan cả mẻ toàn email cũ.

    Khác `invite._count_new_invite_seats` (chỉ trừ `active`) đúng ở chỗ trừ luôn
    `pending`: hàm kia phục vụ guard suất ChatGPT (đếm theo người ĐÃ tham gia), hàm
    này phục vụ TRẦN THÀNH VIÊN (đếm theo `seat_used` = đã vào + đang chờ).
    """
    lowered = [e.strip().lower() for e in emails if e]
    if not lowered:
        return 0
    holding = set(
        db.execute(
            select(Member.email).where(
                Member.workspace_id == workspace_id,
                Member.email.in_(lowered),
                Member.status != "removed",
            )
        )
        .scalars()
        .all()
    )
    return sum(1 for e in lowered if e not in holding)


def paid_seat_emails(
    db: Session, workspace_id: UUID, emails: list[str], *, now: datetime | None = None
) -> set[str]:
    """Trong `emails`, những email ĐÃ TRẢ TIỀN cho chính workspace này, kỳ CÒN HẠN.

    Đây là nhóm được MIỄN TRẦN THÀNH VIÊN (chốt user 7/9/2026): tiền đã thu rồi thì
    chỗ ngồi là món nợ của mình với khách, không phải một quyết định chi tiêu mới.
    Trần sinh ra để gác chuyện mua suất cho NGƯỜI MỚI; chặn cả khách đã trả tiền là
    bắt họ chờ tới ngày admin mở trần — trong khi hạn của họ vẫn trôi.

    Ca sinh ra luật (GPT1, `mme.hebrahimi` 6/9/2026): lệnh mời chết vì hết giờ nên
    backend hoàn phí + xoá bản ghi, gói vẫn còn hạn tới 5/10. Mời lại thì trần
    388/388 chặn — khách đã trả tiền mà không có đường vào.

    "Đã trả tiền" đọc y hệt `_period_is_funded` bên `routers/members/_shared.py`:
    nhãn `payment_status='paid'` cấp member, HOẶC còn một chu kỳ `paid` phủ hiện tại.
    Giữ hai vế vì tài khoản được miễn phí (super-admin, đại lý chưa bật Ví) không có
    bút toán nào nhưng vẫn là kỳ có tiền.

    CÒN HẠN là bắt buộc và mốc phải CỤ THỂ: hết hạn rồi thì lần mời sau là một chu
    kỳ MỚI có phí, tức chi tiêu mới — chuyện đó vẫn phải xin phép trần. Vô thời hạn
    (`subscription_end_at` NULL) cũng không tính, cùng cách hiểu với
    `_is_paid_period_active`.

    CHỈ dòng `removed` — người đã trả tiền mà HIỆN KHÔNG có chỗ ngồi. `active` và
    `pending` đang giữ chỗ sẵn nên không cần miễn gì (`new_seat_count` vốn đã bỏ họ
    ra), mà nới cho họ là phá luật "lời mời chờ chưa nhận không phải khách cũ" chốt
    cùng ngày: bản ghi `pending` chưa ai bấm nhận thì chưa từng tốn một suất nào.
    """
    lowered = [e.strip().lower() for e in emails if e]
    if not lowered:
        return set()
    at = now or datetime.now(timezone.utc)
    funded_cycle = (
        select(MemberSubscriptionCycle.id)
        .where(
            MemberSubscriptionCycle.member_id == Member.id,
            MemberSubscriptionCycle.payment_status == "paid",
            or_(
                MemberSubscriptionCycle.end_at.is_(None),
                MemberSubscriptionCycle.end_at > at,
            ),
        )
        .exists()
    )
    rows = (
        db.execute(
            select(Member.email).where(
                Member.workspace_id == workspace_id,
                Member.email.in_(lowered),
                Member.status == "removed",
                Member.subscription_end_at.isnot(None),
                Member.subscription_end_at > at,
                or_(Member.payment_status == "paid", funded_cycle),
            )
        )
        .scalars()
        .all()
    )
    return {str(e).strip().lower() for e in rows}


def paid_new_seats(db: Session, workspace_id: UUID, emails: list[str]) -> int:
    """Bao nhiêu suất MỚI trong `emails` là của khách ĐÃ TRẢ TIỀN (miễn trần).

    Dùng để NỚI trần đúng bằng ngần ấy khi gửi giấy phép mua suất xuống extension —
    xem `purchase_allowance`. Không phải nới trần vĩnh viễn: chỉ lệnh này, chỉ ngần
    này suất, chỉ cho những email đã có tiền nằm trong két.
    """
    lowered = [e.strip().lower() for e in emails if e]
    if not lowered:
        return 0
    paid = paid_seat_emails(db, workspace_id, lowered)
    return new_seat_count(db, workspace_id, [e for e in lowered if e in paid])


def cap_new_seats(db: Session, workspace_id: UUID, emails: list[str]) -> int:
    """`new_seat_count` nhưng BỎ RA khách đã trả tiền — con số đem so với TRẦN.

    Mọi đường tạo lệnh mời phải gác trần bằng hàm này chứ không phải `new_seat_count`
    thô, nếu không khách đã trả tiền lại bị chính cái trần đó chặn. Xem
    `paid_seat_emails`.
    """
    lowered = [e.strip().lower() for e in emails if e]
    if not lowered:
        return 0
    paid = paid_seat_emails(db, workspace_id, lowered)
    return new_seat_count(db, workspace_id, [e for e in lowered if e not in paid])


def cap_used(db: Session, workspace: Workspace) -> int:
    """Con số đem so với TRẦN THÀNH VIÊN — đúng bằng `seat_used` dashboard đang hiện.

    Gồm cả suất giữ chỗ cho chủ đội Canva để trần không bị lệch một suất so với
    ô "đã dùng" người đặt trần đang nhìn khi họ gõ số.
    """
    return seat_used(db, workspace.id) + owner_reserve(db, workspace)


def cap_reached(db: Session, workspace: Workspace, *, additional: int = 0) -> bool:
    """Workspace đã chạm/vượt trần chưa (kèm `additional` email sắp mời thêm)?

    Không đặt trần (`invite_member_cap` NULL) ⇒ luôn False. Trần 0 nghĩa là NGƯNG
    HẲN — hợp lệ, khác hẳn để trống.
    """
    cap = workspace.invite_member_cap
    if cap is None:
        return False
    return cap_used(db, workspace) + max(additional, 0) > int(cap)


def cap_left(db: Session, workspace: Workspace) -> int | None:
    """Còn bao nhiêu suất nữa mới chạm TRẦN THÀNH VIÊN. `None` khi không đặt trần.

    Kẹp về 0: đang vượt trần (admin hạ trần xuống dưới số người đang có) thì "còn 0",
    không phải số âm.
    """
    cap = workspace.invite_member_cap
    if cap is None:
        return None
    return max(int(cap) - cap_used(db, workspace), 0)


def cap_message_template(db: Session) -> str:
    """Câu thông báo admin đang dùng, hoặc `DEFAULT_CAP_MESSAGE` khi chưa ai sửa.

    Để trống hẳn cũng quay về câu mặc định: một lệnh mời bị từ chối mà không nói lý
    do thì đại lý sẽ bấm lại tới lúc hết kiên nhẫn rồi mới nhắn hỏi.
    """
    row = db.get(InviteSettings, 1)
    saved = (row.cap_message if row is not None else None) or ""
    return saved.strip() or DEFAULT_CAP_MESSAGE


def render_cap_message(
    template: str, *, name: str, left: int, reopen_at: date | None
) -> str:
    """Thay `{ten}` / `{conlai}` / `{ngay}` vào câu admin soạn.

    Thay bằng `str.replace` chứ KHÔNG dùng `str.format`: câu do người gõ, lỡ có một
    dấu ngoặc nhọn lạc (hay chính chữ `{}`) là `format` ném lỗi ngay giữa đường chốt
    lệnh mời. Chỗ thay động lạ thì cứ để nguyên văn cho admin nhìn thấy mà sửa.
    """
    return (
        template.replace("{ten}", name)
        .replace("{conlai}", str(left))
        .replace(
            "{ngay}",
            f"{reopen_at.day}/{reopen_at.month}/{reopen_at.year}"
            if reopen_at is not None
            else NO_REOPEN_DATE,
        )
    )


def cap_message(db: Session, workspace: Workspace) -> str | None:
    """Câu thông báo ĐÃ THAY ĐỘNG cho 1 workspace. `None` khi không đặt trần."""
    left = cap_left(db, workspace)
    if left is None:
        return None
    return render_cap_message(
        cap_message_template(db),
        name=workspace.name,
        left=left,
        reopen_at=workspace.invite_cap_reopen_at,
    )


def assert_under_cap(db: Session, workspace: Workspace, additional: int = 0) -> None:
    """Chặn lệnh mời khi vượt TRẦN THÀNH VIÊN. 409 kèm câu thông báo admin soạn.

    KHÔNG chừa cửa cho super-admin (khác `invite._assert_seat_available`): trần là
    số suất đã mua thật, vượt là mất tiền thật, mà chính super-admin sửa được con số
    trong một cú bấm ở nút ⚙️ trang Mời — không cần đường vòng.
    """
    if cap_reached(db, workspace, additional=additional):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=cap_message(db, workspace) or DEFAULT_CAP_MESSAGE,
        )


def returning_emails(db: Session, workspace_id: UUID, emails: list[str]) -> set[str]:
    """Trong `emails`, những email ĐÃ TỪNG THAM GIA chính workspace này.

    "Đã từng tham gia" = có mốc `joined_at` (đồng bộ/xác minh đã thấy họ trong tab
    "Người dùng" của ChatGPT), hoặc đang `active`. KHÔNG tính lời mời chờ chưa bao
    giờ được nhận: `pending` + `joined_at` NULL là người CHƯA vào đội — cùng cách
    hiểu `auto_invite` và `queue/completion` đang dùng để nhận ra "lời mời ma".

    Vẫn nhận `status='active'` làm bằng chứng dự phòng vì vài bản ghi cũ (trước khi
    có cột `joined_at`) không có mốc: 2 dòng active + 3 dòng removed trên production
    ngày 7/9/2026. Thiếu lưới đó thì chính khách cũ bị chặn oan.
    """
    lowered = [e.strip().lower() for e in emails if e]
    if not lowered:
        return set()
    rows = (
        db.execute(
            select(Member.email).where(
                Member.workspace_id == workspace_id,
                Member.email.in_(lowered),
                or_(Member.joined_at.isnot(None), Member.status == "active"),
            )
        )
        .scalars()
        .all()
    )
    return {str(e).strip().lower() for e in rows}


def purchase_allowance(db: Session, workspace: Workspace, emails: list[str]) -> dict:
    """GIẤY PHÉP MUA SUẤT gửi kèm lệnh mời — extension chỉ được trừ tiền khi có nó.

    Vì sao phải có (ca thật GPT1 7/9/2026, task `b7ced59e`): trần thành viên đang
    đặt 387 mà lệnh mời `tnguyen281187` vẫn nâng suất ChatGPT lên 388 và bị trừ
    ₫41.452 ngay lập tức. Trần chỉ gác ở cửa TẠO lệnh (`assert_under_cap`, đếm
    người trong DB), còn khâu MUA nằm bên extension và không biết gì về trần: nó
    thấy ChatGPT hết chỗ là mua. ChatGPT không có bước xác nhận thanh toán — bấm
    Continue trong hộp "Quản lý suất" là tiền đi khỏi thẻ.

    Hai điều kiện, user chốt 7/9/2026, phải ĐỦ CẢ HAI mới được mua:

    1. MỌI email của lệnh đều đã từng tham gia workspace này (khách cũ quay lại
       hoặc gia hạn — xem `returning_emails`) HOẶC đã trả tiền và còn hạn ở đây
       (`paid_seat_emails`). Suất cho người mới chưa trả đồng nào là quyết định
       tiêu tiền, phải do người bấm, không để lệnh tự làm.
    2. Tổng suất SAU khi mua không vượt TRẦN THÀNH VIÊN (`invite_member_cap`) —
       con số super-admin tự gõ, đọc là "số suất tôi duyệt chi". Không đặt trần
       (`None`) ⇒ điều kiện này không chặn gì. Trần gửi xuống được NỚI đúng bằng
       số suất của khách đã trả tiền trong chính lệnh này (`paid_new_seats`): tiền
       đã thu thì chỗ ngồi là nợ phải trả, không phải khoản chi mới xin duyệt.

    Điều kiện 2 CỐ Ý để extension chốt, không chốt sẵn ở đây: tổng suất thật nằm
    trên ChatGPT (`workspace.seat_total` chỉ là số scrape, có thể cũ hàng ngày),
    còn con số vừa đọc tận nơi thì extension mới có. Backend gửi cái trần, bên kia
    so với số thật.

    Trả về dict đi thẳng vào `payload["seat_purchase"]`:
      * `allowed` — điều kiện 1 đã đạt chưa.
      * `max_total` — trần suất, `None` khi workspace không đặt trần.
      * `reason` — câu giải thích cho người dùng khi `allowed=False`.

    ⚠️ THIẾU field này trong payload nghĩa là CẤM MUA (extension fail-closed). Đừng
    "dọn" bằng cách bỏ qua khi mảng email rỗng — mọi đường tạo INVITE_MEMBER phải
    gắn nó, kể cả đổi email và chuyển hạn.
    """
    lowered = [e.strip().lower() for e in emails if e]
    cap = workspace.invite_member_cap
    # KHÁCH ĐÃ TRẢ TIỀN NỚI ĐƯỢC TRẦN, đúng bằng số suất họ cần (chốt user
    # 7/9/2026). Không nới thì hai điều kiện dưới mâu thuẫn nhau ở đúng ca hay gặp
    # nhất: backend cho lệnh chạy vì khách đã trả tiền (`cap_new_seats` bỏ họ ra),
    # rồi extension tới nơi lại từ chối mua vì tổng suất sau khi mua vượt trần —
    # lệnh đi hết 5 phút để về tay không. Nới có giới hạn: chỉ lệnh này, chỉ ngần
    # ấy suất, và chỉ cho email có tiền nằm sẵn trong két (xem `paid_seat_emails`).
    paid_stretch = paid_new_seats(db, workspace.id, lowered)
    max_total = None if cap is None else int(cap) + paid_stretch
    # Khách đã trả tiền tính là "người của mình" kể cả khi CHƯA từng vào đội được:
    # `returning_emails` đòi mốc `joined_at`, mà đúng ca cần cứu nhất là lời mời đầu
    # tiên chết giữa chừng nên họ chưa có mốc nào (`mme.hebrahimi` 6/9/2026).
    known = returning_emails(db, workspace.id, lowered) | paid_seat_emails(
        db, workspace.id, lowered
    )
    newcomers = [e for e in lowered if e not in known]
    if newcomers:
        shown = ", ".join(newcomers[:3])
        more = f" và {len(newcomers) - 3} email nữa" if len(newcomers) > 3 else ""
        return {
            "allowed": False,
            "max_total": max_total,
            "reason": (
                f"Lệnh có email chưa từng tham gia không gian này ({shown}{more}) "
                "nên không được mua thêm suất. Mua suất trước trên ChatGPT rồi chạy "
                "lại lệnh, hoặc mời họ vào không gian còn chỗ trống."
            ),
        }
    return {"allowed": True, "max_total": max_total, "reason": None}


def owner_reserve_map(db: Session, workspaces: list[Workspace]) -> dict[UUID, int]:
    """workspace_id -> suất phải GIỮ CHỖ cho chủ đội Canva (1 hoặc 0).

    Gói Canva có 50 suất và chủ đội ngồi một trong số đó (user chốt 2026-09-01).
    Chủ đội chỉ vào bảng `members` sau khi CANVA_SYNC quét được trang People —
    trước lần sync đầu, hay khi sync hỏng, không giữ chỗ thì dashboard báo thừa
    một suất và guard mời cho tràn thêm một người: Canva từ chối tại chỗ sau khi
    đã trừ tiền khách.

    Trả 0 khi đã có dòng member vai trò `owner` chưa bị gỡ — lúc đó họ nằm sẵn
    trong `seat_used`, cộng thêm nữa là đếm hai lần. Nhánh GPT luôn 0: tổng suất
    bên đó scrape từ billing, chủ đội đã nằm trong danh sách quét về.
    """
    canva_ids = [ws.id for ws in workspaces if ws.platform == PLATFORM_CANVA]
    if not canva_ids:
        return {}
    have_owner = set(
        db.execute(
            select(Member.workspace_id)
            .where(
                Member.workspace_id.in_(canva_ids),
                Member.status != "removed",
                Member.chatgpt_role == "owner",
            )
            .distinct()
        ).scalars()
    )
    return {wid: (0 if wid in have_owner else 1) for wid in canva_ids}


def owner_reserve(db: Session, workspace: Workspace) -> int:
    """Bản một workspace của `owner_reserve_map`."""
    return owner_reserve_map(db, [workspace]).get(workspace.id, 0)


def seat_left(seat_total: int | None, used: int) -> int | None:
    """Suất còn TRỐNG để hiển thị. `None` khi workspace chưa từng sync `seat_total`
    (chưa biết tổng thì không được đoán bừa là 0 — người dùng sẽ tưởng hết suất).
    Âm được kẹp về 0: đang overcommit thì "còn 0", không phải "còn -3"."""
    if seat_total is None:
        return None
    return max(seat_total - used, 0)


def seat_snapshot(db: Session, workspaces: list[Workspace]) -> list[dict]:
    """Ảnh chụp suất của nhiều workspace cho endpoint/hiển thị — hai truy vấn gộp.

    `seat_used` trả về ĐÃ CỘNG suất giữ chỗ của chủ đội Canva, nên có thể lớn hơn số
    dòng trong bảng thành viên đúng 1 — chủ đội là người chiếm suất thật nhưng chưa
    chắc đã nằm trong danh sách quét về.
    """
    used = seat_used_map(db, [ws.id for ws in workspaces])
    reserve = owner_reserve_map(db, workspaces)
    # Đọc câu thông báo MỘT LẦN cho cả danh sách — endpoint này bị poll 15 giây/lần,
    # và chỉ đọc khi thật sự có workspace đặt trần.
    template = (
        cap_message_template(db)
        if any(ws.invite_member_cap is not None for ws in workspaces)
        else DEFAULT_CAP_MESSAGE
    )
    out: list[dict] = []
    for ws in workspaces:
        u = used.get(ws.id, 0) + reserve.get(ws.id, 0)
        cap = ws.invite_member_cap
        left = None if cap is None else max(int(cap) - u, 0)
        out.append(
            {
                "workspace_id": str(ws.id),
                "name": ws.name,
                "platform": ws.platform,
                "seat_total": ws.seat_total,
                "seat_used": u,
                "seat_left": seat_left(ws.seat_total, u),
                # `u` ở trên ĐÃ là `cap_used` (đã cộng suất giữ chỗ chủ đội) nên so
                # thẳng, khỏi thêm truy vấn cho một endpoint bị poll 15 giây/lần.
                "invite_member_cap": cap,
                "invite_cap_reached": cap is not None and u >= int(cap),
                "invite_cap_left": left,
                # Câu ĐÃ thay động sẵn: trang Mời chỉ việc in ra, không phải biết
                # luật thay chỗ — sửa lời lẽ ở backend là mọi nơi đổi theo.
                "invite_cap_message": None
                if left is None
                else render_cap_message(
                    template,
                    name=ws.name,
                    left=left,
                    reopen_at=ws.invite_cap_reopen_at,
                ),
            }
        )
    return out
