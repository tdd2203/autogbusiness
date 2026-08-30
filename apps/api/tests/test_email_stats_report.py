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


def test_agent_rows_carry_the_emails_behind_the_numbers(client: TestClient, auth_header: dict):
    """Mở dòng đại lý ra phải thấy đúng email nào đã cộng vào con số."""
    ids = _seed()
    data = _fetch(client, auth_header)
    by_id = {a["user_id"]: a for a in data["by_agent"]}

    agent = by_id[ids["agent"]]
    assert len(agent["emails"]) == agent["total"]
    assert {(e["email"], e["date"], e["kind"], e["ok"]) for e in agent["emails"]} == {
        ("e1@x.com", DAY_A.isoformat(), "new", True),
        ("e3@x.com", DAY_A.isoformat(), "new", True),
        ("e2@x.com", DAY_A.isoformat(), "new", False),
        ("e1@x.com", DAY_B.isoformat(), "renew", True),
    }
    # Ngày mới nhất lên trước, trong ngày thì email hỏng lên trước.
    assert agent["emails"][0]["date"] == DAY_B.isoformat()
    assert agent["emails"][1]["email"] == "e2@x.com"

    # Dòng đại lý trong từng ngày cũng có danh sách, và chỉ có email của ngày đó.
    for d in data["days"]:
        for a in d["by_agent"]:
            assert len(a["emails"]) == a["total"]
            assert all(e["date"] == d["date"] for e in a["emails"])


def test_requires_super_admin(client: TestClient):
    r = client.get(f"/api/v1/wallet/admin/report/emails?from={FROM_Q}&to={TO_Q}")
    assert r.status_code in (401, 403)


# ── ĐỔI EMAIL ───────────────────────────────────────────────────────────────
# Chốt user 2026-08-30: đổi email A→B là THAY TÊN trên đúng một chu kỳ đã bán,
# không bán thêm ghế nào.
#   - Ô của A (ngày mời/gia hạn gốc) đổi tên thành email CUỐI chuỗi A→B→C, kèm cờ
#     `changed` để bảng hiện nhãn ĐỔI + MỚI (ô add mới) / ĐỔI + CŨ (ô gia hạn).
#   - Lượt mời của B do lần đổi sinh ra KHÔNG đếm thành add mới ngày đổi — đếm là
#     một ghế ăn hai lượt.
#   - Chu kỳ của A nằm NGOÀI kỳ báo cáo → 1 dòng ở NGÀY ĐỔI, tính vào gia hạn ✓.

DAY_OLD = _TODAY_VN - timedelta(days=40)  # trước FROM_Q → ngoài kỳ báo cáo


def _log_change(db, *, when, old_member, new_member, old_email, new_email, actor_id):
    ev = AuditLog(
        timestamp=when,
        actor_type="ADMIN",
        actor_id=actor_id,
        actor_label="t",
        action="MEMBER_EMAIL_CHANGED",
        result="PENDING",
        target_type="MEMBER",
        target_id=str(new_member),
        data={
            "old_email": old_email,
            "new_email": new_email,
            "old_member_id": str(old_member),
        },
    )
    db.add(ev)
    db.flush()
    return ev


def _seed_change():
    db = SessionLocal()
    try:
        ws = Workspace(name="WS_EMAILCHG", extension_api_key="k-emailchg")
        db.add(ws)
        agent = _mk_user(db, "agentG")
        db.flush()

        def member(email):
            m = Member(
                workspace_id=ws.id,
                email=email,
                status="active",
                invited_by_user_id=agent.id,
            )
            db.add(m)
            db.flush()
            return m

        def invited(email, when):
            m = member(email)
            _log(db, action="MEMBER_INVITE_VERIFIED", result="COMPLETED", when=when,
                 email=email, target_id=m.id)
            return m

        # c1: mời ngày A, ngày B đổi sang c1b → ô ngày A mang tên c1b, ngày B trống.
        m1 = invited("c1@x.com", _at(DAY_A, 9))
        m1b = invited("c1b@x.com", _at(DAY_B, 11))
        _log_change(db, when=_at(DAY_B, 10), old_member=m1.id, new_member=m1b.id,
                    old_email="c1@x.com", new_email="c1b@x.com", actor_id=agent.id)

        # c2: chuỗi 2 chặng trong cùng ngày B → ô ngày A mang tên chặng CUỐI.
        m2 = invited("c2@x.com", _at(DAY_A, 9))
        m2b = invited("c2b@x.com", _at(DAY_B, 11))
        m2c = invited("c2c@x.com", _at(DAY_B, 13))
        _log_change(db, when=_at(DAY_B, 10), old_member=m2.id, new_member=m2b.id,
                    old_email="c2@x.com", new_email="c2b@x.com", actor_id=agent.id)
        _log_change(db, when=_at(DAY_B, 12), old_member=m2b.id, new_member=m2c.id,
                    old_email="c2b@x.com", new_email="c2c@x.com", actor_id=agent.id)

        # c3: ô bị thay là GIA HẠN (email đã qua ≥1 chu kỳ) → nhãn ĐỔI + CŨ.
        m3 = member("c3@x.com")
        _log(db, action="MEMBER_SUBSCRIPTION_RENEWED", result="OK", when=_at(DAY_A, 9),
             email="c3@x.com", target_id=m3.id, actor_id=agent.id)
        m3b = invited("c3b@x.com", _at(DAY_B, 11))
        _log_change(db, when=_at(DAY_B, 10), old_member=m3.id, new_member=m3b.id,
                    old_email="c3@x.com", new_email="c3b@x.com", actor_id=agent.id)

        # c4: chu kỳ gốc NGOÀI kỳ báo cáo → không có ô nào để thay tên, lần đổi tự
        #     dựng 1 dòng ở ngày B và tính vào gia hạn ✓.
        m4 = invited("c4@x.com", _at(DAY_OLD, 9))
        m4b = invited("c4b@x.com", _at(DAY_B, 11))
        _log_change(db, when=_at(DAY_B, 10), old_member=m4.id, new_member=m4b.id,
                    old_email="c4@x.com", new_email="c4b@x.com", actor_id=agent.id)

        db.commit()
        return {"agent": str(agent.id)}
    finally:
        db.close()


def _entries(data: dict) -> dict[tuple[str, str], dict]:
    """(ngày, email) → ô, gom từ mọi đại lý của tab Theo ngày."""
    out: dict[tuple[str, str], dict] = {}
    for day in data["days"]:
        for row in day["by_agent"]:
            for e in row["emails"]:
                out[(day["date"], e["email"])] = e
    return out


def test_email_change_renames_the_slot_of_the_original_day(client, auth_header):
    _seed_change()
    got = _entries(_fetch(client, auth_header))
    da, dbb = DAY_A.isoformat(), DAY_B.isoformat()

    # Ngày A hiện email MỚI của chuỗi, kèm cờ đổi và email gốc để tra ngược.
    slot = got[(da, "c1b@x.com")]
    assert slot["kind"] == "new" and slot["ok"] is True
    assert slot["changed"] is True and slot["old_email"] == "c1@x.com"
    assert (da, "c1@x.com") not in got

    # Lượt mời của c1b ngày B là phần vật lý của lần đổi → KHÔNG đếm thêm.
    assert (dbb, "c1b@x.com") not in got


def test_email_change_chain_shows_the_last_email(client, auth_header):
    _seed_change()
    got = _entries(_fetch(client, auth_header))
    da, dbb = DAY_A.isoformat(), DAY_B.isoformat()
    assert got[(da, "c2c@x.com")]["changed"] is True
    assert (da, "c2@x.com") not in got
    assert (da, "c2b@x.com") not in got
    assert (dbb, "c2b@x.com") not in got and (dbb, "c2c@x.com") not in got


def test_email_change_on_a_renew_slot_stays_a_renew(client, auth_header):
    _seed_change()
    got = _entries(_fetch(client, auth_header))
    slot = got[(DAY_A.isoformat(), "c3b@x.com")]
    # Ô gia hạn bị đổi tên vẫn là gia hạn (frontend hiện ĐỔI + CŨ), không hoá add mới.
    assert slot["kind"] == "renew" and slot["changed"] is True
    assert slot["old_email"] == "c3@x.com"


def test_email_change_outside_the_range_lands_on_the_change_day(client, auth_header):
    _seed_change()
    data = _fetch(client, auth_header)
    got = _entries(data)
    slot = got[(DAY_B.isoformat(), "c4b@x.com")]
    assert slot["kind"] == "renew" and slot["ok"] is True and slot["changed"] is True
    assert slot["old_email"] == "c4@x.com"

    # Tổng kỳ: 2 add mới (c1, c2) + 2 gia hạn (c3 đổi tên, c4 dòng ngày đổi).
    assert (data["new_ok"], data["new_failed"]) == (2, 0)
    assert (data["renew_ok"], data["renew_failed"]) == (2, 0)
    assert data["total"] == 4
    assert data["unique_emails"] == 4
