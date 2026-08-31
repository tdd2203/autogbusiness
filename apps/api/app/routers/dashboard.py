"""Trang "Tổng quan" — mọi con số của MỘT đại lý, gom về một lượt gọi.

Vì sao một endpoint chứ không để trang tự cộng từ `/added-members`: danh sách đó
trả TOÀN BỘ member kèm chu kỳ, không phân trang (đại lý lớn nhất đang 510 ghế), và
nó không có ghế đã gỡ nên không dựng được đường "ghế đang phục vụ" theo ngày.

NGUỒN CỦA TỪNG SỐ — đây là chỗ dễ lệch nhất nên ghi rõ:

  • Thẻ "Hôm nay" gọi thẳng `_summary_for` của trang Ví. KHÔNG chép lại công thức:
    hai màn hình chốt số của cùng một ngày mà lệch nhau là lỗi người dùng thấy
    ngay (cùng lý do trang Quản trị Ví dùng chung code với trang Ví).
  • TÀI KHOẢN MIỄN PHÍ (super-admin, đại lý chưa bật Ví) không có bút toán nào nên
    mọi con số dựng từ sổ cái đứng im ở 0 — với họ, "mới / gia hạn" đọc từ NHẬT KÝ
    (`_LogRows`), cả thẻ "Hôm nay" lẫn biểu đồ lẫn tỉ lệ gia hạn.
  • Add mới / gia hạn theo ngày (biểu đồ) áp ĐÚNG quy tắc của thẻ đó, mở rộng cho
    cả khoảng: mốc là NGÀY TRẢ TIỀN, và "gia hạn" = email ĐÃ từng trả tiền thành
    công trước ngày đó — kể cả khi lượt này đi qua luồng mời mới vì gói cũ đã hết
    hạn. Điểm cuối của biểu đồ được ép bằng đúng số của thẻ, khỏi lệch một đơn vị.
  • Ghế đang phục vụ theo ngày ĐẾM THẲNG từ bản ghi member (đã add tới ngày đó,
    chưa bị gỡ tính tới ngày đó). KHÔNG suy ngược từ chênh lệch mới/hỏng: email
    mời hỏng chưa từng vào team nên không làm giảm ghế nào, còn ghế bị gỡ vì hết
    hạn thì không nằm trong phép trừ đó.
  • Lượt mời hỏng lấy từ nhật ký `MEMBER_INVITE_FAILED` (bảng `members` không dùng
    được: lời mời hỏng bị xoá phantom). Sự kiện này do extension ghi nên KHÔNG
    mang `actor_id` — quy chủ bằng cách chỉ đếm email nằm trong các sự kiện MỜI do
    CHÍNH user này bấm (giống `wallet/email_stats.py`).

TỈ LỆ GIA HẠN = gia hạn / (mới + gia hạn) trong kỳ — chốt user 2026-08-30. Cùng
đơn vị EMAIL với bảng thống kê email. Nó nói tiền trong kỳ đến từ khách cũ hay
khách mới, KHÔNG phải tỉ lệ giữ khách.

Chỉ ĐỌC, không ghi gì.
"""

from __future__ import annotations

from datetime import date as date_type
from datetime import datetime, time, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.deps import get_current_user, get_session
from app.models import AuditLog, Member, User, Wallet, WalletTransaction, Workspace
from app.routers.wallet._shared import get_payment_settings
from app.routers.wallet.daily import _summary_for
from app.services.payment_flow import is_chargeable_user
from app.schemas import (
    DashboardCompare,
    DashboardDueDay,
    DashboardDueMember,
    DashboardDueWeek,
    DashboardFailedEmail,
    DashboardFailReason,
    DashboardOverviewOut,
    DashboardQuality,
    DashboardRenewalRate,
    DashboardSeriesDay,
    DashboardServing,
    DashboardToday,
    DashboardTodos,
    DashboardWallet,
)
from app.services.task_errors import friendly_error_message, short_error_label

router = APIRouter(prefix="/api/v1/dashboard", tags=["dashboard"])

# VN không có DST → offset cứng là đủ (giống daily.py / email_stats.py).
VN_TZ = timezone(timedelta(hours=7))

# Trần số ngày một lần gọi được vẽ. Ghế đã gỡ bị hard-delete sau 90 ngày
# (REMOVED_MEMBER_RETENTION) nên đường ghế xa hơn mốc đó chỉ còn đếm được phần
# chưa bị dọn — cho phép xin dài hơn, nhưng đừng đọc như số liệu đầy đủ.
_MAX_DAYS = 180

# Lùi thêm khi nạp sự kiện MỜI để quy chủ: lời mời bấm hôm trước mà hôm sau
# extension mới chốt kết quả là chuyện thường (cùng lý do với email_stats.py).
_ATTR_LOOKBACK_DAYS = 30

_FEE_KINDS = ("invite_fee", "renew_fee")
_QUEUED = ("MEMBER_INVITE_QUEUED", "MEMBER_BULK_INVITE_QUEUED")
_NEW_OK = "MEMBER_INVITE_VERIFIED"
_NEW_FAILED = "MEMBER_INVITE_FAILED"
_RENEW_OK = "MEMBER_SUBSCRIPTION_RENEWED"

# Cửa sổ của khối "Tỉ lệ gia hạn" và "Chất lượng lượt mời" — cố định 30 ngày, độc
# lập với `days` của biểu đồ (đổi khoảng biểu đồ không được làm nhảy hai thẻ kia).
_RATE_DAYS = 30

# Khoảng nhìn tới của khối "Sắp đến hạn".
_DUE_DAYS = 30

# Mã lỗi KHÔNG đưa vào bảng "vấn đề thường gặp" (chốt user 2026-08-31): bật cờ
# mời ngoài tên miền là việc hệ thống tự làm trong luồng mời, ca hỏng ở đó không
# phải một loại vấn đề để đại lý phải đọc. Email dính mã này VẪN nằm trong danh
# sách "lời mời lỗi, chưa được mời lại" — ghế đó khách đã trả tiền mà chưa có.
_REASON_HIDDEN = {"EXTERNAL_TOGGLE_FAILED"}

# Ngưỡng "đến hạn tới nơi": 7 ngày (chốt user 2026-08-31 — thử 3 ngày rồi bỏ, để
# khớp với cửa sổ tiền của thẻ Ví). Dùng chung cho cả hai chỗ, không ai tự tính lại.
_DUE_SOON_DAYS = 7


def _aware(dt: datetime | None) -> datetime | None:
    """Mốc trong DB luôn là UTC; vá tzinfo cho driver nào trả naive."""
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _vn_day(dt: datetime) -> date_type:
    return _aware(dt).astimezone(VN_TZ).date()  # type: ignore[union-attr]


def _emails_of_queued(ev: AuditLog) -> list[str]:
    """Email của 1 sự kiện MỜI: mời lẻ ghi `data.email`, mời hàng loạt ghi
    `data.entries[].email` (xem members/invite.py)."""
    data = ev.data or {}
    single = data.get("email")
    if isinstance(single, str) and single:
        return [single.strip().lower()]
    out: list[str] = []
    for entry in data.get("entries") or []:
        if isinstance(entry, dict):
            em = entry.get("email")
            if isinstance(em, str) and em:
                out.append(em.strip().lower())
    return out


def _owned_emails(db: Session, user_id: UUID, since: datetime) -> set[str]:
    """Email mà CHÍNH user này đã bấm mời từ `since` — dùng quy chủ cho các sự kiện
    kết quả (VERIFIED/FAILED) vốn không mang actor_id."""
    rows = db.execute(
        select(AuditLog).where(
            AuditLog.action.in_(_QUEUED),
            AuditLog.actor_id == user_id,
            AuditLog.timestamp >= since,
        )
    ).scalars()
    owned: set[str] = set()
    for ev in rows:
        owned.update(_emails_of_queued(ev))
    return owned


class _Outcomes:
    """Kết quả mời của user, gom theo NGÀY VN.

    ĐƠN VỊ ĐẾM = 1 EMAIL TRONG 1 NGÀY, và trong ngày đó **có lượt nào thành công
    thì cả ngày tính THÀNH CÔNG** — đúng quy ước của bảng thống kê email. Mời hỏng
    thì luôn có lượt mời lại ngay sau đó; đếm từng lượt thì một email hỏng rồi mời
    lại được sẽ vừa cộng vào "thất bại" vừa cộng vào "thành công".

    KHÔNG trừ xuyên ngày: email hỏng hôm nay rồi mai mời lại được thì hôm nay vẫn
    là một ngày hỏng — nếu không, con số "hỏng hôm nay" sẽ tự bốc hơi vào hôm sau
    và không ai đối chiếu lại được.
    """

    def __init__(self, db: Session, owned: set[str], start: datetime, end: datetime):
        self.ok: dict[date_type, set[str]] = {}
        self.failed: dict[date_type, set[str]] = {}
        # (ngày, email) → mã lỗi của lượt hỏng CUỐI trong ngày (phán quyết mới nhất).
        self.code: dict[tuple[date_type, str], str] = {}
        # Email hỏng ít nhất một lượt NHƯNG vẫn xong trong cùng ngày. Không phải
        # "hỏng" (không còn việc phải làm) nhưng cũng không phải trơn tru — đây là
        # phần công mời lại mà quy ước đếm theo ngày làm biến mất.
        self.retried: dict[date_type, set[str]] = {}
        # Lượt hỏng THÔ theo ngày — giữ nguyên cả ca sau đó mời lại được. Khối
        # "vấn đề thường gặp" phải xếp hạng trên cái này: 65 ca phải mời lại đều
        # có nguyên nhân, trừ hết đi thì bảng chỉ còn vài ca lẻ không nói lên gì.
        self.raw_failed: dict[date_type, set[str]] = {}
        # Phán quyết CUỐI của từng email trong kỳ — để biết email nào ĐANG còn hỏng.
        self.last_fail: dict[str, datetime] = {}
        self.last_ok: dict[str, datetime] = {}
        if not owned:
            return
        rows = db.execute(
            select(AuditLog.action, AuditLog.timestamp, AuditLog.data)
            .where(
                AuditLog.action.in_((_NEW_OK, _NEW_FAILED)),
                AuditLog.timestamp >= start,
                AuditLog.timestamp < end,
            )
            .order_by(AuditLog.timestamp)
        ).all()
        for action, ts, data in rows:
            data = data or {}
            email = str(data.get("email") or "").strip().lower()
            if not email or email not in owned:
                continue
            day = _vn_day(ts)
            ts = _aware(ts)
            if action == _NEW_OK:
                self.ok.setdefault(day, set()).add(email)
                self.last_ok[email] = ts
            else:
                self.failed.setdefault(day, set()).add(email)
                self.raw_failed.setdefault(day, set()).add(email)
                self.code[(day, email)] = str(data.get("error_code") or "")
                self.last_fail[email] = ts
        for day, emails in self.failed.items():
            done = self.ok.get(day, set())
            self.retried[day] = emails & done
            emails -= done

    def failed_on(self, day: date_type) -> int:
        return len(self.failed.get(day, ()))

    def totals(
        self, days: list[date_type]
    ) -> tuple[int, int, int, dict[str, int]]:
        """(thành công, hỏng, phải mời lại mới xong, đếm theo mã lỗi) trên `days`.

        `by_code` đếm MỌI lượt hỏng, kể cả ca sau đó mời lại được — đó mới là các
        vấn đề thực tế đã xảy ra. Hai số `failed`/`retried` vẫn tách bạch chuyện
        còn việc phải làm hay không.
        """
        ok = sum(len(self.ok.get(d, ())) for d in days)
        retried = sum(len(self.retried.get(d, ())) for d in days)
        failed = sum(len(self.failed.get(d, ())) for d in days)
        by_code: dict[str, int] = {}
        for d in days:
            for email in self.raw_failed.get(d, ()):
                code = self.code.get((d, email), "")
                by_code[code] = by_code.get(code, 0) + 1
        return ok, failed, retried, by_code

    def pending_reinvite(
        self, in_team: set[str], since: datetime
    ) -> list[tuple[str, str, datetime]]:
        """(email, mã lỗi, mốc hỏng) của các email ĐANG còn hỏng: lượt cuối cùng là
        HỎNG và email hiện không nằm trong team.

        Kiểm cả `in_team` chứ không chỉ dựa vào nhật ký: một lời mời chốt hỏng oan
        rồi lượt đồng bộ sau thấy email vẫn trong workspace sẽ không sinh sự kiện
        THÀNH CÔNG nào — chỉ nhìn nhật ký thì email đó nằm mãi trong danh sách
        "chờ mời lại" dù nó đang dùng ngon lành.
        """
        out: list[tuple[str, str, datetime]] = []
        for email, at in self.last_fail.items():
            # Bó trong `since` (30 ngày): lỗi từ hai tháng trước mà tới giờ chưa ai
            # mời lại thì không còn là việc của hôm nay, để đó chỉ làm dòng đếm
            # phình lên và không bao giờ về 0.
            if at < since:
                continue
            ok_at = self.last_ok.get(email)
            if ok_at is not None and ok_at >= at:
                continue
            if email in in_team:
                continue
            day = at.astimezone(VN_TZ).date()
            out.append((email, self.code.get((day, email), ""), at))
        out.sort(key=lambda r: r[2], reverse=True)
        return out


class _FeeRows:
    """Bút toán phí của user trong kỳ, đã phân loại MỚI / GIA HẠN theo từng ngày.

    Quy tắc y hệt thẻ "Đã add" ở trang Ví (`daily.py::_summary_for`):
      - Mốc = NGÀY TRẢ TIỀN (bút toán), không phải ngày tạo bản ghi member. Bản ghi
        bị xoá lúc chốt hỏng oan rồi dựng lại hôm sau sẽ nhảy nguyên sang ngày mới.
      - GIA HẠN nếu bút toán là `renew_fee`, HOẶC email đã trả tiền thành công
        trước ngày đó, HOẶC bản ghi member cũ nhất của email có trước ngày đó.
      - Email KHÔNG còn giữ ghế (mời hỏng thật, bị thu hồi, hết hạn) bị loại; email
        `removed` vì ĐỔI EMAIL vẫn tính là còn ghế — ghế đó nằm dưới tên mới.
    """

    def __init__(self, db: Session, user_id: UUID, start: datetime, end: datetime):
        rows = db.execute(
            select(
                WalletTransaction.kind,
                WalletTransaction.reversed,
                WalletTransaction.created_at,
                WalletTransaction.meta,
            )
            .where(
                WalletTransaction.user_id == user_id,
                WalletTransaction.kind.in_(_FEE_KINDS),
                WalletTransaction.created_at >= start,
                WalletTransaction.created_at < end,
            )
            .order_by(WalletTransaction.created_at)
        ).all()

        # (ngày, email) → tập kind. Gộp mọi bút toán của cùng email trong cùng ngày.
        self.by_day: dict[date_type, dict[str, set[str]]] = {}
        emails: set[str] = set()
        for kind, _rev, created, meta in rows:
            email = str((meta or {}).get("email") or "").lower()
            if not email:
                continue
            emails.add(email)
            self.by_day.setdefault(_vn_day(created), {}).setdefault(email, set()).add(kind)

        self.holds_seat: set[str] = set()
        self.first_record_at: dict[str, datetime] = {}
        if emails:
            for email, status, reason, created in db.execute(
                select(
                    func.lower(Member.email),
                    Member.status,
                    Member.removed_reason,
                    Member.created_at,
                ).where(
                    Member.invited_by_user_id == user_id,
                    func.lower(Member.email).in_(sorted(emails)),
                )
            ).all():
                if status != "removed" or reason == "email_changed":
                    self.holds_seat.add(email)
                oldest = self.first_record_at.get(email)
                created = _aware(created)
                if oldest is None or created < oldest:
                    self.first_record_at[email] = created

        # Email → mốc SỚM NHẤT từng trả tiền thành công (cả lịch sử, không chặn theo
        # kỳ báo cáo). Lượt đã hoàn phí không tính: email đó chưa tốn đồng nào.
        self.first_paid_at: dict[str, datetime] = {}
        if emails:
            email_col = func.lower(WalletTransaction.meta["email"].astext)
            for email, first_at in db.execute(
                select(email_col, func.min(WalletTransaction.created_at))
                .where(
                    WalletTransaction.user_id == user_id,
                    WalletTransaction.kind.in_(_FEE_KINDS),
                    WalletTransaction.reversed.is_(False),
                    email_col.in_(sorted(emails)),
                )
                .group_by(email_col)
            ).all():
                if email:
                    self.first_paid_at[email] = _aware(first_at)

    def count(self, day: date_type) -> tuple[int, int]:
        """(mới, gia hạn) của một ngày."""
        day_start = datetime.combine(day, time.min, tzinfo=VN_TZ)
        new = renew = 0
        for email, kinds in self.by_day.get(day, {}).items():
            if email not in self.holds_seat:
                continue  # lượt hỏng thật: email không vào team, hoặc đã bị gỡ
            paid_before = self.first_paid_at.get(email)
            oldest = self.first_record_at.get(email)
            if (
                "renew_fee" in kinds
                or (paid_before is not None and paid_before < day_start)
                or (oldest is not None and oldest < day_start)
            ):
                renew += 1
            else:
                new += 1
        return new, renew


class _LogRows:
    """Add mới / gia hạn theo ngày cho tài khoản KHÔNG bị tính phí.

    Super-admin và đại lý chưa bật Ví được miễn phí (`is_chargeable_user`) nên SỔ
    CÁI không có một dòng nào của họ — mọi con số dựng từ bút toán đứng im ở 0 dù
    họ mời và gia hạn thật (user 2026-08-31: tài khoản admin gia hạn 2 email ngày
    30/8 mà biểu đồ trống trơn). Với những tài khoản đó, đọc NHẬT KÝ, đúng bộ sự
    kiện của bảng thống kê email:

      • MEMBER_INVITE_VERIFIED — lượt mời vào được team (email do CHÍNH user này
        bấm mời, đã quy chủ sẵn trong `_Outcomes`);
      • MEMBER_SUBSCRIPTION_RENEWED — gia hạn, sự kiện này có sẵn `actor_id`.

    Đơn vị đếm vẫn là EMAIL-NGÀY như bên sổ cái: một email mời đi mời lại rồi gia
    hạn trong cùng ngày chỉ tính MỘT lần. Ba nhóm phân đúng như thẻ "Đã add" của
    trang Ví, chỉ đổi cách nhận ra "có bán thêm kỳ hay không" (không có tiền để
    soi thì soi bản ghi ghế):

      • MỚI = email chưa từng có bản ghi ghế trước ngày đó;
      • GIA HẠN = có sự kiện gia hạn, HOẶC ghế cũ được mua thêm một kỳ ngay trong
        ngày (mời lại email đã hết hạn — lượt này đi qua luồng mời nhưng vẫn là
        bán tiếp một kỳ);
      • MỜI LẠI MIỄN PHÍ = mời lại email ĐANG còn hạn: không thêm ghế, không bán
        thêm kỳ nào, nên KHÔNG cộng vào tổng (y hệt quy ước bên sổ cái).

    Dấu hiệu "có mua thêm kỳ" là `subscription_purchased_at` — mốc bắt đầu kỳ đang
    dùng, chỉ nhảy khi thật sự mua (luồng mời đặt bằng NGÀY MỜI, mời lại gói còn
    hạn thì giữ nguyên mốc cũ). KHÔNG soi được bằng `removed_at`/hạn: mời lại ghế
    đã chết dùng LẠI đúng bản ghi cũ và xoá sạch dấu vết gỡ. Hệ quả phải chấp
    nhận: ghế mua thêm kỳ rồi sau đó lại gia hạn nữa thì mốc dời theo kỳ mới nhất,
    ngày mua cũ tụt về nhóm "mời lại" — thà hụt còn hơn khai khống một lượt bán.

    KHÔNG lọc "email còn giữ ghế" như `_FeeRows`: bên kia đối chiếu được từng dòng
    phí với ghế đang tồn, còn ở đây lọc thế là xoá luôn lịch sử của ghế đã hết hạn
    rồi bị gỡ — ngày cũ tự rỗng đi mỗi lần nhìn lại.
    """

    def __init__(
        self,
        db: Session,
        user_id: UUID,
        outcomes: "_Outcomes",
        start: datetime,
        end: datetime,
    ):
        # ngày → email → ngày đó có sự kiện GIA HẠN hay không.
        self.by_day: dict[date_type, dict[str, bool]] = {}
        emails: set[str] = set()
        for day, day_emails in outcomes.ok.items():
            slot = self.by_day.setdefault(day, {})
            for email in day_emails:
                slot.setdefault(email, False)
                emails.add(email)
        for ts, data in db.execute(
            select(AuditLog.timestamp, AuditLog.data).where(
                AuditLog.action == _RENEW_OK,
                AuditLog.actor_id == user_id,
                AuditLog.timestamp >= start,
                AuditLog.timestamp < end,
            )
        ).all():
            email = str((data or {}).get("email") or "").strip().lower()
            if not email:
                continue
            emails.add(email)
            self.by_day.setdefault(_vn_day(ts), {})[email] = True

        # Bản ghi ghế của từng email: mốc TẠO (email đã có mặt từ bao giờ) và mốc
        # BẮT ĐẦU KỲ ĐANG DÙNG (mua thêm kỳ hay chưa).
        self.records: dict[str, list[tuple[datetime, datetime | None]]] = {}
        if emails:
            for email, created, purchased in db.execute(
                select(
                    func.lower(Member.email),
                    Member.created_at,
                    Member.subscription_purchased_at,
                ).where(
                    Member.invited_by_user_id == user_id,
                    func.lower(Member.email).in_(sorted(emails)),
                )
            ).all():
                created = _aware(created)
                if created is None:
                    continue
                self.records.setdefault(email, []).append((created, _aware(purchased)))

    def _kind(self, day_start: datetime, day_end: datetime, email: str, renewed: bool) -> str:
        """"renew" | "free" | "new" cho một email trong một ngày."""
        if renewed:
            return "renew"
        records = self.records.get(email, ())
        if not any(created < day_start for created, _p in records):
            return "new"
        bought = any(
            p is not None and day_start <= p < day_end for _created, p in records
        )
        return "renew" if bought else "free"

    def _split(self, day: date_type) -> tuple[int, int, int]:
        """(mới, gia hạn, mời lại miễn phí) của một ngày."""
        day_start = datetime.combine(day, time.min, tzinfo=VN_TZ)
        day_end = day_start + timedelta(days=1)
        new = renew = free = 0
        for email, renewed in self.by_day.get(day, {}).items():
            kind = self._kind(day_start, day_end, email, renewed)
            if kind == "renew":
                renew += 1
            elif kind == "free":
                free += 1
            else:
                new += 1
        return new, renew, free

    def count(self, day: date_type) -> tuple[int, int]:
        """(mới, gia hạn) của một ngày — cùng chữ ký với `_FeeRows.count`."""
        new, renew, _free = self._split(day)
        return new, renew

    def free_reinvite(self, day: date_type) -> int:
        return self._split(day)[2]


def _seats_curve(
    db: Session, user_id: UUID, days: list[date_type]
) -> dict[date_type, int]:
    """Số ghế còn phục vụ tính tới CUỐI mỗi ngày trong `days`.

    Ghế đã gỡ quá 90 ngày bị hard-delete (main.py) nên phần xa của đường có thể
    thiếu những ghế đã sống rồi chết trước mốc đó — đường vẫn đúng xu hướng, nhưng
    đừng đọc như kiểm kê tuyệt đối.
    """
    # Mốc vào = `created_at` (BẤT BIẾN), KHÔNG phải COALESCE(last_invited_at,
    # created_at) như cột "Ngày thêm". Đây là đường TỒN KHO: ghế mời từ tháng 6 mà
    # hôm qua mời lại vẫn là ghế đã tồn tại suốt, lấy mốc mời lại thì cả kho dồn
    # hết về mấy ngày gần đây và đường vẽ ra một cú tăng trưởng không có thật.
    rows = db.execute(
        select(Member.created_at, Member.removed_at, Member.status).where(
            Member.invited_by_user_id == user_id
        )
    ).all()
    out: dict[date_type, int] = {}
    marks = [datetime.combine(d, time.max, tzinfo=VN_TZ) for d in days]
    for i, d in enumerate(days):
        mark = marks[i]
        n = 0
        for added, removed, status in rows:
            added = _aware(added)
            removed = _aware(removed)
            if added is None or added > mark:
                continue
            if removed is not None and removed <= mark:
                continue
            # Bản ghi `removed` mà THIẾU removed_at (dữ liệu cũ) coi như đã gỡ từ
            # đầu — thà hụt còn hơn khoe ghế không tồn tại.
            if removed is None and status == "removed":
                continue
            n += 1
        out[d] = n
    return out


def _member_fee(member_fee: int | None, user_fee: int | None, default_fee: int) -> int:
    """Phí thực thu 1 kỳ: phí riêng của email → phí riêng của đại lý → phí hệ thống
    (đúng thứ tự đang dùng ở luồng mời/gia hạn)."""
    if member_fee is not None:
        return int(member_fee)
    if user_fee is not None:
        return int(user_fee)
    return default_fee


@router.get("/overview", response_model=DashboardOverviewOut)
def overview(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
    days: int = Query(default=30, ge=1, le=_MAX_DAYS),
) -> DashboardOverviewOut:
    """Toàn bộ số của trang Tổng quan cho CHÍNH người đang đăng nhập.

    `days` chỉ đổi khoảng của biểu đồ tăng trưởng; thẻ tỉ lệ gia hạn và khối chất
    lượng lượt mời luôn là 30 ngày.
    """
    now_vn = datetime.now(VN_TZ)
    today = now_vn.date()
    series_days = [today - timedelta(days=i) for i in range(days - 1, -1, -1)]
    # Nạp bút toán đủ cho biểu đồ, cửa sổ 30 ngày của thẻ tỉ lệ gia hạn, VÀ cả
    # tháng trước — mốc so sánh "cùng kỳ tháng trước" nằm ngoài mọi cửa sổ kia, quên
    # nó là mốc đó lặng lẽ về 0 và tháng nào cũng khoe tăng trưởng vô hạn.
    span_days = max(days, _RATE_DAYS)
    prev_month_end = today.replace(day=1) - timedelta(days=1)
    prev_month_start = prev_month_end.replace(day=1)
    span_from = min(today - timedelta(days=span_days - 1), prev_month_start)
    span_start = datetime.combine(span_from, time.min, tzinfo=VN_TZ)
    end_excl = datetime.combine(today + timedelta(days=1), time.min, tzinfo=VN_TZ)

    fees = _FeeRows(db, user.id, span_start, end_excl)
    owned = _owned_emails(db, user.id, span_start - timedelta(days=_ATTR_LOOKBACK_DAYS))
    outcomes = _Outcomes(db, owned, span_start, end_excl)
    seats = _seats_curve(db, user.id, series_days)
    # Nguồn của "mới / gia hạn": SỔ CÁI với đại lý có trả phí (khớp từng đồng với
    # trang Ví), NHẬT KÝ với tài khoản được miễn phí (sổ cái của họ trống nên đọc
    # bút toán là mọi con số nằm im ở 0 — xem `_LogRows`).
    charged = is_chargeable_user(user)
    flow: _FeeRows | _LogRows = (
        fees if charged else _LogRows(db, user.id, outcomes, span_start, end_excl)
    )

    # ── Thẻ "Hôm nay" — lấy nguyên số của trang Ví ─────────────────────────
    card = _summary_for(db, user.id, today)
    if charged:
        new_today = card.added_new_count
        renew_today = card.added_renew_count
        free_today = card.added_free_reinvite_count
    else:
        # Thẻ của trang Ví đếm bằng bút toán, tài khoản miễn phí không có dòng nào
        # → lấy đúng bộ số của nhật ký, khỏi lệch với biểu đồ ngay bên dưới.
        new_today, renew_today = flow.count(today)
        free_today = flow.free_reinvite(today)
    today_card = DashboardToday(
        date=card.date,
        new_count=new_today,
        renew_count=renew_today,
        free_reinvite_count=free_today,
        failed_count=outcomes.failed_on(today),
        fee_net=card.fee_net,
        fee_refunded=card.fee_refunded,
    )

    # ── Biểu đồ ────────────────────────────────────────────────────────────
    series: list[DashboardSeriesDay] = []
    for d in series_days:
        new, renew = flow.count(d)
        if d == today:
            # Ép bằng thẻ: hai chỗ cùng một ngày phải ra cùng một số.
            new, renew = today_card.new_count, today_card.renew_count
        series.append(
            DashboardSeriesDay(
                date=d.isoformat(),
                new_count=new,
                renew_count=renew,
                failed_count=outcomes.failed_on(d),
                seats_end=seats.get(d, 0),
            )
        )

    # ── Ba mốc so sánh (đơn vị: mới + gia hạn, KHÔNG gồm hỏng) ─────────────
    def _flow(d: date_type) -> int:
        if d == today:
            return today_card.new_count + today_card.renew_count
        new, renew = flow.count(d)
        return new + renew

    def _sum(from_d: date_type, to_d: date_type) -> int:
        n = 0
        d = from_d
        while d <= to_d:
            n += _flow(d)
            d += timedelta(days=1)
        return n

    week = _sum(today - timedelta(days=6), today)
    prev_week = _sum(today - timedelta(days=13), today - timedelta(days=7))
    mtd = _sum(today.replace(day=1), today)
    # Cùng SỐ NGÀY đầu tháng trước (kẹp khi tháng trước ngắn hơn) — so cả tháng
    # trước với vài ngày đầu tháng này thì ngày nào cũng ra "giảm".
    prev_mtd_end = min(
        prev_month_end, prev_month_start + timedelta(days=(today - today.replace(day=1)).days)
    )
    compare = DashboardCompare(
        today=_flow(today),
        avg7=round(week / 7, 1),
        week=week,
        prev_week=prev_week,
        mtd=mtd,
        prev_mtd=_sum(prev_month_start, prev_mtd_end),
    )

    # ── Tỉ lệ gia hạn 30 ngày ──────────────────────────────────────────────
    rate_new = rate_renew = 0
    for i in range(_RATE_DAYS):
        d = today - timedelta(days=i)
        if d == today:
            n, r = today_card.new_count, today_card.renew_count
        else:
            n, r = flow.count(d)
        rate_new += n
        rate_renew += r
    rate_total = rate_new + rate_renew
    renewal_rate = DashboardRenewalRate(
        days=_RATE_DAYS,
        new_count=rate_new,
        renew_count=rate_renew,
        total=rate_total,
        pct=round(rate_renew * 100 / rate_total, 1) if rate_total else None,
    )

    # ── Đang phục vụ + việc cần làm (một lượt quét member) ─────────────────
    now_utc = datetime.now(timezone.utc)
    # Mốc đầu cửa sổ 30 ngày, dùng chung cho "email lỗi chờ mời lại" và khối chất
    # lượng lượt mời — hai chỗ nói về cùng một quãng thời gian.
    rate_start = datetime.combine(
        today - timedelta(days=_RATE_DAYS - 1), time.min, tzinfo=VN_TZ
    )
    # ĐẾM TRỌN NGÀY (chốt user 2026-08-31): "trong 7 ngày" = tới HẾT ngày thứ 7
    # theo lịch VN, không phải đúng 168 giờ kể từ bây giờ. Cắt theo giờ thì ghế hết
    # hạn buổi chiều ngày cuối rơi ra ngoài, đại lý lo thiếu tiền cho đúng hôm đó.
    def _end_of_day_after(days: int) -> datetime:
        return datetime.combine(
            today + timedelta(days=days + 1), time.min, tzinfo=VN_TZ
        )

    due_limit = _end_of_day_after(_DUE_DAYS)
    soon_limit = _end_of_day_after(_DUE_SOON_DAYS)
    settings = get_payment_settings(db)
    default_fee = int(settings.invite_fee_vnd or 0)

    active = pending = unpaid = due_soon = due_soon_money = unbound = 0
    due_by_day: dict[date_type, list[int]] = {}
    in_team: set[str] = set()
    member_rows = db.execute(
        select(
            Member.email,
            Member.status,
            Member.payment_status,
            Member.subscription_end_at,
            Member.email_change_stuck_at,
            Member.notify_telegram_chat_id,
            Member.fee_vnd,
        ).where(
            Member.invited_by_user_id == user.id,
            Member.status.in_(("active", "pending")),
        )
    ).all()
    for email, status, pay, end_at, _stuck_at, chat_id, fee_vnd in member_rows:
        in_team.add(email.strip().lower())
        if status == "active":
            active += 1
        else:
            pending += 1
        if pay == "unpaid":
            unpaid += 1
        if chat_id is None:
            unbound += 1
        end_at = _aware(end_at)
        if end_at is None or end_at <= now_utc:
            # Hết hạn là hệ thống gỡ luôn, không có trạng thái "chờ gỡ" để hiện.
            continue
        fee = _member_fee(fee_vnd, user.invite_fee_vnd, default_fee)
        if end_at < soon_limit:
            due_soon += 1
            due_soon_money += fee
        if end_at < due_limit:
            due_by_day.setdefault(_vn_day(end_at), []).append(fee)

    serving = DashboardServing(seats=active + pending, active=active, pending=pending)

    # ── Email lỗi CHƯA được mời lại ────────────────────────────────────────
    # Tiền của từng lượt hỏng: đọc SỔ CÁI, không suy đoán. Lượt mời hỏng thường đã
    # được hoàn phí, nên KHÔNG được trình bày như ghế khách đã trả tiền mà chưa
    # nhận (chốt user 2026-08-31). Ca giữ tiền (hết suất → mời lại miễn phí) thì
    # cờ `reversed` vẫn false và phải nói đúng như vậy.
    pending_rows = outcomes.pending_reinvite(in_team, rate_start)
    fee_state: dict[str, str] = {}
    if pending_rows:
        fee_email_col = func.lower(WalletTransaction.meta["email"].astext)
        for email, was_reversed in db.execute(
            select(fee_email_col, WalletTransaction.reversed)
            .where(
                WalletTransaction.user_id == user.id,
                WalletTransaction.kind == "invite_fee",
                fee_email_col.in_([e for e, _c, _a in pending_rows]),
            )
            .order_by(WalletTransaction.seq)
        ).all():
            # Bút toán SAU đè bút toán trước → còn lại là lượt thu phí gần nhất.
            fee_state[email] = "refunded" if was_reversed else "held"
    failed_emails = [
        DashboardFailedEmail(
            email=email,
            failed_at=at.astimezone(VN_TZ).date().isoformat(),
            fee_state=fee_state.get(email, "none"),
        )
        for email, _code, at in pending_rows
    ]
    todos = DashboardTodos(
        failed_pending_reinvite=len(failed_emails),
        pending=pending,
        unpaid=unpaid,
        due_soon=due_soon,
        due_soon_money=due_soon_money,
        unbound_notify=unbound,
    )

    # ── Sắp đến hạn, GOM THEO TUẦN (chốt user 2026-08-30) ──────────────────
    # Đáo hạn dồn cục: có ngày 127 ghế. Liệt kê từng ngày thì 23 dòng mà không ai
    # nhìn ra cụm; gom tuần rồi mở ra từng ngày mới thấy được chỗ cần lo tiền.
    weeks: dict[date_type, list[date_type]] = {}
    for d in sorted(due_by_day):
        monday = d - timedelta(days=d.weekday())
        weeks.setdefault(monday, []).append(d)
    due_weeks = [
        DashboardDueWeek(
            from_date=monday.isoformat(),
            to_date=(monday + timedelta(days=6)).isoformat(),
            seats=sum(len(due_by_day[d]) for d in ds),
            money=sum(sum(due_by_day[d]) for d in ds),
            days=[
                DashboardDueDay(
                    date=d.isoformat(),
                    seats=len(due_by_day[d]),
                    money=sum(due_by_day[d]),
                )
                for d in ds
            ],
        )
        for monday, ds in sorted(weeks.items())
    ]

    # ── Chất lượng lượt mời 30 ngày ────────────────────────────────────────
    rate_days = [today - timedelta(days=i) for i in range(_RATE_DAYS)]
    ok_count, fail_count, retried_count, by_code = outcomes.totals(rate_days)
    # Gộp theo NHÃN chứ không theo mã: bốn mã của chặng suất cùng là "Mua suất thất
    # bại" với người bán, tách ra thành bốn dòng chỉ làm loãng thứ cần nhìn.
    by_label: dict[str, list[int | bool]] = {}
    for code, n in by_code.items():
        if code in _REASON_HIDDEN:
            continue
        label, self_serve = short_error_label(code)
        row = by_label.setdefault(label, [0, self_serve, code])
        row[0] = int(row[0]) + n
    reasons = [
        DashboardFailReason(
            code=str(row[2]),
            label=label,
            message=friendly_error_message(str(row[2]), str(row[2])) or "",
            count=int(row[0]),
            self_serve=bool(row[1]),
        )
        for label, row in sorted(by_label.items(), key=lambda kv: -int(kv[1][0]))
    ]
    q_total = ok_count + fail_count
    quality = DashboardQuality(
        days=_RATE_DAYS,
        ok_count=ok_count,
        failed_count=fail_count,
        retried_count=retried_count,
        total=q_total,
        fail_pct=round(fail_count * 100 / q_total, 1) if q_total else None,
        reasons=reasons,
    )

    # ── Ví ─────────────────────────────────────────────────────────────────
    wallet_out: DashboardWallet | None = None
    if user.wallet_beta or user.is_super_admin:
        w = db.execute(select(Wallet).where(Wallet.user_id == user.id)).scalar_one_or_none()
        fee = int(user.invite_fee_vnd) if user.invite_fee_vnd is not None else default_fee
        balance = int(w.balance) if w else 0
        wallet_out = DashboardWallet(
            balance=balance,
            held=int(w.held) if w else 0,
            fee=fee,
            invites_left=(balance // fee) if fee > 0 else 0,
        )

    return DashboardOverviewOut(
        username=user.username,
        now=now_vn.isoformat(),
        today=today_card,
        serving=serving,
        wallet=wallet_out,
        renewal_rate=renewal_rate,
        series=series,
        compare=compare,
        todos=todos,
        failed_emails=failed_emails,
        due_weeks=due_weeks,
        quality=quality,
    )


@router.get("/due-members", response_model=list[DashboardDueMember])
def due_members(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
    from_: str = Query(alias="from"),
    to: str = Query(),
) -> list[DashboardDueMember]:
    """Ghế của CHÍNH user đến hạn trong [from, to] (ISO date, giờ VN, bao gồm 2 đầu).

    Tách khỏi `/overview` và chỉ gọi khi mở popup một tuần: nhồi 510 email vào
    payload của trang chủ là bắt mọi lượt làm mới 60 giây gánh mấy chục KB mà 99%
    thời gian không ai mở tới.
    """
    from_date = date_type.fromisoformat(from_)
    to_date = date_type.fromisoformat(to)
    if to_date < from_date:
        from_date, to_date = to_date, from_date
    start = datetime.combine(from_date, time.min, tzinfo=VN_TZ)
    end = datetime.combine(to_date + timedelta(days=1), time.min, tzinfo=VN_TZ)
    default_fee = int(get_payment_settings(db).invite_fee_vnd or 0)

    rows = db.execute(
        select(Member, Workspace.name)
        .join(Workspace, Workspace.id == Member.workspace_id, isouter=True)
        .where(
            Member.invited_by_user_id == user.id,
            Member.status.in_(("active", "pending")),
            Member.subscription_end_at >= start,
            Member.subscription_end_at < end,
        )
        .order_by(Member.subscription_end_at)
    ).all()
    return [
        DashboardDueMember(
            member_id=str(m.id),
            workspace_id=str(m.workspace_id),
            workspace_name=ws_name,
            email=m.email,
            end_at=_aware(m.subscription_end_at).isoformat(),  # type: ignore[union-attr]
            fee=_member_fee(m.fee_vnd, user.invite_fee_vnd, default_fee),
            payment_status=m.payment_status,
        )
        for m, ws_name in rows
    ]
