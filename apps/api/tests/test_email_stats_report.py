"""Thống kê email add mới / gia hạn theo NGÀY (`GET /wallet/admin/report/emails`).

Luật chốt (user 2026-08-29): ĐƠN VỊ ĐẾM = 1 EMAIL TRONG 1 NGÀY (giờ VN), không
phải 1 lượt thao tác.
  - Cùng email mời hỏng rồi mời lại thành công trong 1 ngày → 1 email THÀNH CÔNG
    (không phải 1 hỏng + 1 thành công).
  - Cùng email add mới hôm nay + gia hạn hôm khác → 2 lượt, nhưng `unique_emails` = 1.
  - "Của ai" lấy từ sự kiện MỜI (extension không mang actor_id); mời hỏng đã xoá
    phantom member nên chỉ còn đường này.
  - Đại lý is_test bị loại y như báo cáo tiền.
"""

from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import AuditLog, Member, User, Workspace
from app.security import hash_password

VN_TZ = timezone(timedelta(hours=7))

# Mốc giữa ngày theo giờ VN → không bao giờ rơi lệch ngày khi quy đổi UTC.
_TODAY_VN = datetime.now(VN_TZ).date()
DAY_A = _TODAY_VN - timedelta(days=3)
DAY_B = _TODAY_VN - timedelta(days=1)
FROM_Q = (_TODAY_VN - timedelta(days=10)).isoformat()
TO_Q = _TODAY_VN.isoformat()


def _at(day, hour: int) -> datetime:
    return datetime(day.year, day.month, day.day, hour, 0, tzinfo=VN_TZ)


def _mk_user(db, username, *, is_test=False):
    u = User(
        email=f"{username}@example.com",
        username=username,
        password_hash=hash_password("X"),
        is_super_admin=False,
        is_active=True,
        is_test=is_test,
        permissions=[],
    )
    db.add(u)
    db.flush()
    return u


def _log(db, *, action, result, when, email, target_id, actor_id=None, entries=None):
    data = {"email": email} if entries is None else {"entries": entries}
    ev = AuditLog(
        timestamp=when,
        actor_type="ADMIN" if actor_id else "EXTENSION",
        actor_id=actor_id,
        actor_label="t",
        action=action,
        result=result,
        target_type="MEMBER" if entries is None else "QUEUE_ITEM",
        target_id=str(target_id),
        data=data,
    )
    db.add(ev)
    db.flush()
    return ev


def _seed():
    db = SessionLocal()
    try:
        ws = Workspace(name="WS_EMAILSTATS", extension_api_key="k-emailstats")
        db.add(ws)
        agent = _mk_user(db, "agentE")
        other = _mk_user(db, "agentF")
        tester = _mk_user(db, "testerE", is_test=True)
        db.flush()

        def member(email, owner):
            m = Member(
                workspace_id=ws.id,
                email=email,
                status="active",
                invited_by_user_id=owner.id if owner else None,
            )
            db.add(m)
            db.flush()
            return m

        # ── NGÀY A ──────────────────────────────────────────────────────────
        # e1: agentE mời → HỎNG lúc 9h → mời lại → THÀNH CÔNG lúc 11h.
        #     Kỳ vọng: ngày A đếm 1 email add mới THÀNH CÔNG (không thêm 1 thất bại).
        m1 = member("e1@x.com", agent)
        _log(db, action="MEMBER_INVITE_QUEUED", result="PENDING", when=_at(DAY_A, 8),
             email="e1@x.com", target_id=m1.id, actor_id=agent.id)
        _log(db, action="MEMBER_INVITE_FAILED", result="FAILED", when=_at(DAY_A, 9),
             email="e1@x.com", target_id=m1.id)
        _log(db, action="MEMBER_INVITE_QUEUED", result="PENDING", when=_at(DAY_A, 10),
             email="e1@x.com", target_id=m1.id, actor_id=agent.id)
        _log(db, action="MEMBER_INVITE_VERIFIED", result="COMPLETED", when=_at(DAY_A, 11),
             email="e1@x.com", target_id=m1.id)

        # e2: agentE mời HÀNG LOẠT (audit ghi data.entries) → hỏng, member phantom
        #     đã bị xoá nên KHÔNG có Member nào — chủ phải ra từ sự kiện mời.
        phantom_id = uuid4()
        _log(db, action="MEMBER_BULK_INVITE_QUEUED", result="PENDING", when=_at(DAY_A, 8),
             email=None, target_id=uuid4(), actor_id=agent.id,
             entries=[{"email": "e2@x.com"}, {"email": "e3@x.com"}])
        _log(db, action="MEMBER_INVITE_FAILED", result="FAILED", when=_at(DAY_A, 9),
             email="e2@x.com", target_id=phantom_id)

        # e3: cùng mẻ, thành công.
        m3 = member("e3@x.com", agent)
        _log(db, action="MEMBER_INVITE_VERIFIED", result="COMPLETED", when=_at(DAY_A, 9),
             email="e3@x.com", target_id=m3.id)

        # e4: đại lý TEST → loại khỏi mọi con số.
        m4 = member("e4@x.com", tester)
        _log(db, action="MEMBER_INVITE_QUEUED", result="PENDING", when=_at(DAY_A, 8),
             email="e4@x.com", target_id=m4.id, actor_id=tester.id)
        _log(db, action="MEMBER_INVITE_VERIFIED", result="COMPLETED", when=_at(DAY_A, 9),
             email="e4@x.com", target_id=m4.id)

        # e5: KHÔNG có sự kiện mời (dữ liệu cũ) → vớt chủ từ Member.invited_by_user_id.
        m5 = member("e5@x.com", other)
        _log(db, action="MEMBER_INVITE_VERIFIED", result="COMPLETED", when=_at(DAY_A, 9),
             email="e5@x.com", target_id=m5.id)

        # e6: treo, chưa phán → KHÔNG vào bảng.
        m6 = member("e6@x.com", agent)
        _log(db, action="MEMBER_INVITE_UNVERIFIABLE", result="ERROR", when=_at(DAY_A, 9),
             email="e6@x.com", target_id=m6.id)

        # ── NGÀY B ──────────────────────────────────────────────────────────
        # e1 gia hạn (cùng email ngày khác → lượt riêng, nhưng vẫn 1 email duy nhất).
        _log(db, action="MEMBER_SUBSCRIPTION_RENEWED", result="OK", when=_at(DAY_B, 10),
             email="e1@x.com", target_id=m1.id, actor_id=agent.id)
        # e5 gia hạn 2 lần trong CÙNG ngày → vẫn 1 email.
        _log(db, action="MEMBER_SUBSCRIPTION_RENEWED", result="OK", when=_at(DAY_B, 10),
             email="e5@x.com", target_id=m5.id, actor_id=other.id)
        _log(db, action="MEMBER_SUBSCRIPTION_RENEWED", result="OK", when=_at(DAY_B, 15),
             email="e5@x.com", target_id=m5.id, actor_id=other.id)

        db.commit()
        return {"agent": str(agent.id), "other": str(other.id)}
    finally:
        db.close()


def _fetch(client: TestClient, auth_header: dict) -> dict:
    r = client.get(
        f"/api/v1/wallet/admin/report/emails?from={FROM_Q}&to={TO_Q}", headers=auth_header
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_totals_count_each_email_once_per_day(client: TestClient, auth_header: dict):
    _seed()
    data = _fetch(client, auth_header)

    # Ngày A: e1 THÀNH CÔNG (hỏng rồi mời lại được), e3 thành công, e2 thất bại,
    # e5 thành công. e4 (test) và e6 (treo) không tính.
    # Ngày B: e1 + e5 gia hạn = 2 (e5 gia hạn 2 lượt vẫn là 1).
    assert data["new_ok"] == 3
    assert data["new_failed"] == 1
    assert data["renew_ok"] == 2
    assert data["renew_failed"] == 0
    assert data["total"] == 6
    # e1, e2, e3, e5 → 4 email khác nhau (e1/e5 xuất hiện ở cả 2 ngày).
    assert data["unique_emails"] == 4


def test_days_are_split_and_sum_to_total(client: TestClient, auth_header: dict):
    _seed()
    data = _fetch(client, auth_header)
    days = {d["date"]: d for d in data["days"]}

    a = days[DAY_A.isoformat()]
    assert (a["new_ok"], a["new_failed"], a["renew_ok"], a["total"]) == (3, 1, 0, 4)
    b = days[DAY_B.isoformat()]
    assert (b["new_ok"], b["new_failed"], b["renew_ok"], b["total"]) == (0, 0, 2, 2)

    # Mọi ngày trong kỳ đều có mặt (kể cả ngày trống) và cộng lại đúng bằng tổng.
    assert len(data["days"]) == 11
    assert sum(d["total"] for d in data["days"]) == data["total"]


def test_attribution_by_agent(client: TestClient, auth_header: dict):
    ids = _seed()
    data = _fetch(client, auth_header)
    by_id = {a["user_id"]: a for a in data["by_agent"]}

    # agentE: e1 (add ok) + e3 (add ok) + e2 (add fail) ngày A, e1 gia hạn ngày B.
    agent = by_id[ids["agent"]]
    assert (agent["new_ok"], agent["new_failed"], agent["renew_ok"], agent["total"]) == (2, 1, 1, 4)
    assert agent["username"] == "agentE"

    # agentF: e5 add ok (vớt từ Member) + e5 gia hạn.
    other = by_id[ids["other"]]
    assert (other["new_ok"], other["new_failed"], other["renew_ok"], other["total"]) == (1, 0, 1, 2)

    # Đại lý test không xuất hiện.
    assert all(a["username"] != "testerE" for a in data["by_agent"])

    # Chi tiết trong từng ngày cộng lại bằng số của ngày đó.
    for d in data["days"]:
        assert sum(a["total"] for a in d["by_agent"]) == d["total"]


def test_requires_super_admin(client: TestClient):
    r = client.get(f"/api/v1/wallet/admin/report/emails?from={FROM_Q}&to={TO_Q}")
    assert r.status_code in (401, 403)
