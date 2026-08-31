"""Tổng quan — tài khoản KHÔNG bị tính phí vẫn phải thấy add mới / gia hạn.

Super-admin và đại lý chưa bật Ví được miễn phí nên sổ cái ví không có dòng nào
của họ. Trang Tổng quan dựng "mới / gia hạn" từ bút toán, nên với các tài khoản
này biểu đồ, thẻ Hôm nay và tỉ lệ gia hạn đứng im ở 0 dù có thao tác thật (user
2026-08-31: tài khoản admin gia hạn 2 email ngày 30/8 mà biểu đồ trống). Bản vá
cho các tài khoản đó đọc NHẬT KÝ thay sổ cái — file này khoá đúng hành vi ấy.

Ba nhóm phải tách y như thẻ "Đã add" của trang Ví:
  - MỚI = email chưa từng có bản ghi ghế trước ngày đó;
  - GIA HẠN = có sự kiện gia hạn, hoặc ghế cũ mua thêm một kỳ ngay trong ngày;
  - MỜI LẠI MIỄN PHÍ = mời lại email ĐANG còn hạn → không cộng vào tổng.

Mời lại DÙNG LẠI đúng bản ghi ghế cũ (khoá duy nhất workspace+email) nên seed ở
đây cũng vậy: khác biệt duy nhất giữa hai ca là `subscription_purchased_at` — mua
thêm kỳ thì mốc nhảy sang ngày mời, mời lại gói còn hạn thì giữ nguyên mốc cũ.
"""

from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, Member, User, Workspace

VN_TZ = timezone(timedelta(hours=7))

_TODAY = datetime.now(VN_TZ).date()
DAY_NEW = _TODAY - timedelta(days=6)
DAY_FREE = _TODAY - timedelta(days=4)
DAY_REDO = _TODAY - timedelta(days=2)


def _at(day, hour: int) -> datetime:
    """Giữa ngày theo giờ VN → không rơi lệch ngày khi quy đổi UTC."""
    return datetime(day.year, day.month, day.day, hour, 0, tzinfo=VN_TZ)


def _log(db, *, action, when, email, target_id, actor_id=None):
    db.add(
        AuditLog(
            timestamp=when,
            actor_type="ADMIN" if actor_id else "EXTENSION",
            actor_id=actor_id,
            actor_label="t",
            action=action,
            result="OK",
            target_type="MEMBER",
            target_id=str(target_id),
            data={"email": email},
        )
    )
    db.flush()


def _seed() -> None:
    db = SessionLocal()
    try:
        admin = db.execute(select(User).where(User.is_super_admin.is_(True))).scalars().first()
        assert admin is not None
        ws = Workspace(name="WS_DASHFREE", extension_api_key="k-dashfree")
        db.add(ws)
        db.flush()

        def member(email, *, created, purchased=None, end_at=None, status="active"):
            m = Member(
                workspace_id=ws.id,
                email=email,
                status=status,
                invited_by_user_id=admin.id,
                created_at=created,
                subscription_purchased_at=purchased,
                subscription_end_at=end_at,
            )
            db.add(m)
            db.flush()
            return m

        def invited(email, member_id, day, hour=9):
            """Một lượt mời do chính admin bấm → extension chốt THÀNH CÔNG."""
            _log(db, action="MEMBER_INVITE_QUEUED", when=_at(day, hour - 1),
                 email=email, target_id=member_id, actor_id=admin.id)
            _log(db, action="MEMBER_INVITE_VERIFIED", when=_at(day, hour),
                 email=email, target_id=member_id)

        # e1 — email mới toanh: bản ghi ghế sinh đúng ngày mời ⇒ ADD MỚI.
        m1 = member(
            "e1@x.com",
            created=_at(DAY_NEW, 9),
            purchased=_at(DAY_NEW, 9),
            end_at=_at(_TODAY + timedelta(days=20), 9),
        )
        invited("e1@x.com", m1.id, DAY_NEW)

        # e2 — mời lại email ĐANG còn hạn: ghế có từ lâu, kỳ đang dùng vẫn là kỳ cũ
        # ⇒ MIỄN PHÍ, không thêm ghế nào nên không được cộng vào tổng.
        m2 = member(
            "e2@x.com",
            created=_at(_TODAY - timedelta(days=25), 9),
            purchased=_at(_TODAY - timedelta(days=25), 9),
            end_at=_at(_TODAY + timedelta(days=10), 9),
        )
        invited("e2@x.com", m2.id, DAY_FREE)

        # e3 — ghế cũ đã hết hạn, nay mời vào lại: cùng bản ghi nhưng kỳ mới bắt đầu
        # ĐÚNG ngày mời ⇒ bán tiếp một kỳ, tính GIA HẠN.
        m3 = member(
            "e3@x.com",
            created=_at(_TODAY - timedelta(days=25), 9),
            purchased=_at(DAY_REDO, 9),
            end_at=_at(_TODAY + timedelta(days=22), 9),
        )
        invited("e3@x.com", m3.id, DAY_REDO)

        # e4 — gia hạn thẳng bằng nút Gia hạn: sự kiện mang sẵn actor_id.
        m4 = member(
            "e4@x.com",
            created=_at(_TODAY - timedelta(days=30), 9),
            purchased=_at(_TODAY - timedelta(days=30), 9),
            end_at=_at(_TODAY + timedelta(days=30), 9),
        )
        _log(db, action="MEMBER_SUBSCRIPTION_RENEWED", when=_at(_TODAY, 10),
             email="e4@x.com", target_id=m4.id, actor_id=admin.id)

        # e5 — lượt mời của NGƯỜI KHÁC (không có sự kiện mời của admin) ⇒ không
        # được rơi vào số của admin.
        _log(db, action="MEMBER_INVITE_VERIFIED", when=_at(DAY_NEW, 9),
             email="e5@x.com", target_id=uuid4())

        db.commit()
    finally:
        db.close()


def _series(client: TestClient, auth_header: dict) -> dict:
    r = client.get("/api/v1/dashboard/overview?days=30", headers=auth_header)
    assert r.status_code == 200, r.text
    body = r.json()
    return body, {d["date"]: d for d in body["series"]}


def test_free_account_sees_new_and_renew(client: TestClient, auth_header: dict):
    _seed()
    body, days = _series(client, auth_header)

    assert (days[DAY_NEW.isoformat()]["new_count"], days[DAY_NEW.isoformat()]["renew_count"]) == (1, 0)
    # Mời lại email còn hạn: không phải ghế mới, cũng không phải kỳ bán thêm.
    assert (days[DAY_FREE.isoformat()]["new_count"], days[DAY_FREE.isoformat()]["renew_count"]) == (0, 0)
    # Ghế chết rồi mời vào lại = gia hạn.
    redo = days[DAY_REDO.isoformat()]
    assert (redo["new_count"], redo["renew_count"]) == (0, 1)


def test_today_card_matches_chart(client: TestClient, auth_header: dict):
    _seed()
    body, days = _series(client, auth_header)

    # Gia hạn hôm nay phải hiện ở CẢ thẻ Hôm nay lẫn điểm cuối biểu đồ.
    assert (body["today"]["new_count"], body["today"]["renew_count"]) == (0, 1)
    today_point = days[_TODAY.isoformat()]
    assert (today_point["new_count"], today_point["renew_count"]) == (0, 1)
    assert body["today"]["free_reinvite_count"] == 0


def test_renewal_rate_counts_the_period(client: TestClient, auth_header: dict):
    _seed()
    body, _days = _series(client, auth_header)

    # e1 mới; e3 (mời lại sau khi chết) + e4 (nút Gia hạn) = 2 gia hạn; e2 miễn phí
    # và e5 của người khác không tính.
    rate = body["renewal_rate"]
    assert (rate["new_count"], rate["renew_count"], rate["total"]) == (1, 2, 3)
