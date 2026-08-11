"""Báo cáo tài chính re-baseline (user 2026-07-14):

  - THU = Σ theo từng kỳ của member: đơn giá/tháng hiệu lực × số tháng (mời + gia hạn
    cùng loại phí). Đơn giá = COALESCE(member.fee_vnd, chủ.invite_fee_vnd, global).
  - CHI = hoá đơn Stripe 'paid' có ngày >= workspace.finance_start_at (loại hoá đơn cũ).
  - Member thuộc user is_test bị loại; member chủ workspace (role owner) bị loại;
    member chưa có chủ gộp nhóm "Chưa có chủ" ở đơn giá mặc định.

Bổ sung 2026-08-11: cả THU lẫn CHI ghi nhận DỒN TÍCH THEO NGÀY (phí kỳ rải trên
[start_at, end_at); hoá đơn rải trên [period_start, period_end)). Các test "re-baseline"
dưới đây dùng khoảng truy vấn PHỦ TRỌN mọi kỳ nên tổng vẫn bằng đúng phí cả kỳ; phần
phân bổ lẻ ngày được kiểm riêng ở `test_financial_report_accrual_prorates`.
"""

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import (
    Member,
    MemberSubscriptionCycle,
    PaymentSettings,
    User,
    Workspace,
)
from app.security import hash_password

DEFAULT_FEE = 380_000
AGENT_FEE = 330_000

_now = datetime.now(timezone.utc)
FIN_START = _now - timedelta(days=45)
DATE_OLD = _now - timedelta(days=55)   # trước finance_start → CHI bỏ
DATE_CUR = _now - timedelta(days=40)   # >= finance_start → CHI tính
# Kỳ doanh thu phải rơi SAU mốc SePay (_SEPAY_LIVE_DATE = 10/7/2026) mới được tính THU.
# Dùng mốc gần `now` (now luôn >= hôm nay > 10/7/2026) để test bền qua thời gian.
CYCLE_START = _now - timedelta(days=2)
RENEW_START = _now - timedelta(days=1)
FROM_Q = (_now - timedelta(days=60)).date().isoformat()
# Phủ TRỌN mọi kỳ 1 tháng bắt đầu quanh `now` (dồn tích: chỉ phủ hết kỳ thì tổng THU
# mới bằng đúng phí cả kỳ).
TO_Q = (_now + timedelta(days=90)).date().isoformat()


def _mk_user(db, username, *, is_super=False, is_test=False, fee=None):
    u = User(
        email=f"{username}@example.com",
        username=username,
        password_hash=hash_password("X"),
        is_super_admin=is_super,
        is_active=True,
        is_test=is_test,
        invite_fee_vnd=fee,
        permissions=[],
    )
    db.add(u)
    db.flush()
    return u


_email_seq = [0]


def _mk_member(db, ws, *, owner, role="member", fee=None, joined=CYCLE_START, end=None):
    _email_seq[0] += 1
    m = Member(
        workspace_id=ws.id,
        email=f"m{_email_seq[0]}@x.com",
        status="active",
        chatgpt_role=role,
        invited_by_user_id=(owner.id if owner else None),
        fee_vnd=fee,
        joined_at=joined,
        subscription_end_at=end,
    )
    db.add(m)
    db.flush()
    return m


def _add_cycle(db, member, *, number, months, start):
    db.add(
        MemberSubscriptionCycle(
            member_id=member.id,
            cycle_number=number,
            months=months,
            start_at=start,
            end_at=start + timedelta(days=30 * months),
            payment_status="paid",
            paid_at=start,
        )
    )
    db.flush()


def _seed_scenario():
    db = SessionLocal()
    try:
        settings = db.get(PaymentSettings, 1)
        if settings is None:
            settings = PaymentSettings(id=1, invite_fee_vnd=DEFAULT_FEE, payment_codes=[])
            db.add(settings)
        else:
            settings.invite_fee_vnd = DEFAULT_FEE
        db.flush()

        ws = Workspace(
            name="WS_REPORT",
            extension_api_key="k-report",
            finance_start_at=FIN_START,
            billing_invoices=[
                # Trước mốc → bỏ.
                {"date": DATE_OLD.date().isoformat(), "amount_vnd": 5_000_000, "status": "paid"},
                # Chu kỳ hiện tại → tính = total_vnd + service_fee.
                {
                    "date": DATE_CUR.date().isoformat(),
                    "total_vnd": 10_000_000,
                    "service_fee_vnd": 500_000,
                    "status": "paid",
                    "period_start": DATE_CUR.date().isoformat(),
                },
                # Không 'paid' → bỏ.
                {"date": DATE_CUR.date().isoformat(), "amount_vnd": 9_000_000, "status": "void"},
            ],
        )
        db.add(ws)
        db.flush()

        agent = _mk_user(db, "agentA", fee=AGENT_FEE)
        admin = _mk_user(db, "adminX", is_super=True)  # phí riêng None → default
        tester = _mk_user(db, "testerX", is_test=True, fee=20_000)

        # M1: agent, 1 kỳ mời 1 tháng → 330k
        m1 = _mk_member(db, ws, owner=agent, end=CYCLE_START + timedelta(days=30))
        _add_cycle(db, m1, number=1, months=1, start=CYCLE_START)
        # M2: agent, mời 2 tháng + gia hạn 1 tháng → 660k + 330k
        m2 = _mk_member(db, ws, owner=agent, end=RENEW_START + timedelta(days=30))
        _add_cycle(db, m2, number=1, months=2, start=CYCLE_START)
        _add_cycle(db, m2, number=2, months=1, start=RENEW_START)
        # M3: admin add, không phí riêng → default 380k
        m3 = _mk_member(db, ws, owner=admin, end=CYCLE_START + timedelta(days=30))
        _add_cycle(db, m3, number=1, months=1, start=CYCLE_START)
        # M4: test account → loại hoàn toàn
        m4 = _mk_member(db, ws, owner=tester, end=CYCLE_START + timedelta(days=30))
        _add_cycle(db, m4, number=1, months=1, start=CYCLE_START)
        # M5: chưa có chủ → default 380k, nhóm "Chưa có chủ"
        m5 = _mk_member(db, ws, owner=None, end=CYCLE_START + timedelta(days=30))
        _add_cycle(db, m5, number=1, months=1, start=CYCLE_START)
        # M6: chủ workspace (role owner) → loại
        m6 = _mk_member(db, ws, owner=agent, role="owner", end=CYCLE_START + timedelta(days=30))
        _add_cycle(db, m6, number=1, months=1, start=CYCLE_START)
        # M7: agent nhưng có fee_vnd override 500k → override thắng
        m7 = _mk_member(db, ws, owner=agent, fee=500_000, end=CYCLE_START + timedelta(days=30))
        _add_cycle(db, m7, number=1, months=1, start=CYCLE_START)
        # M8: agent, CÓ hạn nhưng KHÔNG cycle → suy 1 kỳ mời 1 tháng = 330k
        _mk_member(db, ws, owner=agent, joined=CYCLE_START, end=CYCLE_START + timedelta(days=30))

        db.commit()
        return {"agent": str(agent.id), "admin": str(admin.id)}
    finally:
        db.close()


def test_financial_report_rebaseline(client: TestClient, auth_header: dict):
    ids = _seed_scenario()
    r = client.get(
        f"/api/v1/wallet/admin/report?from={FROM_Q}&to={TO_Q}", headers=auth_header
    )
    assert r.status_code == 200, r.text
    data = r.json()

    # THU: M1 330k + M2 (660k+330k) + M3 380k + M5 380k + M7 500k + M8 330k
    assert data["revenue_invite"] == 330_000 + 660_000 + 380_000 + 380_000 + 500_000 + 330_000
    assert data["revenue_renew"] == 330_000
    assert data["revenue"] == 2_910_000

    # CHI: chỉ hoá đơn chu kỳ hiện tại (total 10tr + phí 500k); bỏ 5tr cũ + 9tr void.
    assert data["cost"] == 10_500_000
    assert data["profit"] == 2_910_000 - 10_500_000

    by = {a["username"]: a for a in data["by_agent"]}
    # Test account KHÔNG xuất hiện.
    assert "testerX" not in by
    # Agent: M1+M2+M7+M8 = 330+990+500+330 = 2150k; 4 mời, 1 gia hạn.
    assert by["agentA"]["revenue"] == 2_150_000
    assert by["agentA"]["invite_count"] == 4
    assert by["agentA"]["renew_count"] == 1
    # Admin add: default fee.
    assert by["adminX"]["revenue"] == 380_000
    # Chưa có chủ: default fee, user_id None.
    assert by["Chưa có chủ"]["revenue"] == 380_000
    assert by["Chưa có chủ"]["user_id"] is None


def test_financial_report_finance_start_excludes_old(client: TestClient, auth_header: dict):
    """finance_start_at NULL → fallback created_at: hoá đơn trước created_at vẫn bị bỏ,
    nhưng hoá đơn sau created_at được tính (workspace mới tính từ khi onboard)."""
    db = SessionLocal()
    try:
        s = db.get(PaymentSettings, 1)
        if s is None:
            db.add(PaymentSettings(id=1, invite_fee_vnd=DEFAULT_FEE, payment_codes=[]))
        ws = Workspace(
            name="WS_NEW",
            extension_api_key="k-new",
            finance_start_at=None,  # chưa set
            billing_invoices=[
                {"date": DATE_CUR.date().isoformat(), "total_vnd": 3_000_000, "status": "paid"},
            ],
        )
        ws.created_at = _now - timedelta(days=50)
        db.add(ws)
        db.commit()
    finally:
        db.close()

    r = client.get(
        f"/api/v1/wallet/admin/report?from={FROM_Q}&to={TO_Q}", headers=auth_header
    )
    assert r.status_code == 200, r.text
    # created_at (now-50d) <= hoá đơn (now-40d) → tính.
    assert r.json()["cost"] == 3_000_000


def test_financial_report_accrual_prorates(client: TestClient, auth_header: dict):
    """Đây là ca đã làm sai con số thật (11/08/2026): khoảng xem KHÔNG chứa ngày mời
    lẫn ngày hoá đơn Stripe, nhưng cả hai vẫn phủ những ngày đó.

    Cũ: THU = 0 (kỳ bắt đầu ngoài khoảng) và CHI = 0 (hoá đơn phát hành ngoài khoảng)
    → biên lợi nhuận vô nghĩa. Mới: mỗi vế góp đúng số ngày phủ trong khoảng.
    """
    # Kỳ member: 10 ngày trước → +30 ngày. Hoá đơn ChatGPT: phát hành 10 ngày trước,
    # phủ 30 ngày. Khoảng xem = 5 ngày GẦN ĐÂY (không chứa ngày mời/ngày hoá đơn).
    start = _now - timedelta(days=10)
    win_from = (_now - timedelta(days=4)).date()
    win_to = _now.date()
    win_days = (win_to - win_from).days + 1  # 5 ngày (bao gồm 2 đầu)

    db = SessionLocal()
    try:
        s = db.get(PaymentSettings, 1)
        if s is None:
            db.add(PaymentSettings(id=1, invite_fee_vnd=DEFAULT_FEE, payment_codes=[]))
        else:
            s.invite_fee_vnd = DEFAULT_FEE
        db.flush()
        ws = Workspace(
            name="WS_ACCRUAL",
            extension_api_key="k-accrual",
            finance_start_at=start,
            billing_invoices=[
                {
                    "date": start.date().isoformat(),
                    "total_vnd": 3_000_000,
                    "status": "paid",
                    "period_start": start.date().isoformat(),
                    "period_end": (start + timedelta(days=30)).date().isoformat(),
                }
            ],
        )
        db.add(ws)
        db.flush()
        agent = _mk_user(db, "agentAccrual", fee=AGENT_FEE)
        m = _mk_member(db, ws, owner=agent, joined=start, end=start + timedelta(days=30))
        _add_cycle(db, m, number=1, months=1, start=start)
        db.commit()
    finally:
        db.close()

    r = client.get(
        f"/api/v1/wallet/admin/report?from={win_from.isoformat()}&to={win_to.isoformat()}",
        headers=auth_header,
    )
    assert r.status_code == 200, r.text
    data = r.json()

    # Cả hai vế = phần 5/30 ngày, KHÔNG phải 0 (lỗi cũ) và cũng không phải cả kỳ.
    # Sai số ±1đ: khoảng có thể vắt qua 2 tháng lịch → làm tròn 2 mảnh thay vì 1.
    assert abs(data["revenue"] - round(AGENT_FEE * win_days / 30)) <= 1
    assert abs(data["cost"] - round(3_000_000 * win_days / 30)) <= 1
    assert data["profit"] == data["revenue"] - data["cost"]
    # 1 seat × 5 ngày → 5/30 seat-tháng; giá vốn TB/seat quy về nguyên đơn giá tháng.
    assert data["seat_months"] == round(win_days / 30, 2)
    assert data["avg_cost_per_seat"] == round(data["cost"] / data["seat_months"])
    # Kỳ bắt đầu NGOÀI khoảng → không đếm là "đơn mời" mới, nhưng vẫn có doanh thu.
    by = {a["username"]: a for a in data["by_agent"]}
    assert by["agentAccrual"]["invite_count"] == 0
    assert by["agentAccrual"]["revenue"] == data["revenue"]
    # Tổng các cột tháng khớp đúng tổng (làm tròn 1 lần mỗi mảnh tháng).
    assert sum(b["revenue"] for b in data["monthly"]) == data["revenue"]
    assert sum(b["cost"] for b in data["monthly"]) == data["cost"]


def test_financial_report_excludes_pre_sepay_revenue(client: TestClient, auth_header: dict):
    """Kỳ mời/gia hạn có mốc TRƯỚC _SEPAY_LIVE_DATE (10/7/2026) không tính THU, dù nằm
    trong khoảng truy vấn — dữ liệu cũ chưa đi qua SePay."""
    from app.routers.wallet.report import _SEPAY_LIVE_DATE

    before = datetime.combine(
        _SEPAY_LIVE_DATE - timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc
    )
    on_or_after = datetime.combine(
        _SEPAY_LIVE_DATE, datetime.min.time(), tzinfo=timezone.utc
    ) + timedelta(days=1)

    db = SessionLocal()
    try:
        s = db.get(PaymentSettings, 1)
        if s is None:
            db.add(PaymentSettings(id=1, invite_fee_vnd=DEFAULT_FEE, payment_codes=[]))
        else:
            s.invite_fee_vnd = DEFAULT_FEE
        db.flush()
        ws = Workspace(name="WS_SEPAY", extension_api_key="k-sepay", billing_invoices=[])
        db.add(ws)
        db.flush()
        agent = _mk_user(db, "agentSepay", fee=AGENT_FEE)
        # Kỳ TRƯỚC mốc → bị loại.
        m_old = _mk_member(db, ws, owner=agent, end=before + timedelta(days=30))
        _add_cycle(db, m_old, number=1, months=1, start=before)
        # Kỳ TỪ mốc trở đi → được tính.
        m_new = _mk_member(db, ws, owner=agent, end=on_or_after + timedelta(days=30))
        _add_cycle(db, m_new, number=1, months=1, start=on_or_after)
        db.commit()
    finally:
        db.close()

    # Khoảng truy vấn phủ TRỌN cả hai kỳ để chứng minh việc loại là do mốc SePay, không
    # phải do range cắt (dồn tích: range cắt sẽ chỉ ra phí lẻ ngày, không phải 0).
    from_q = (before - timedelta(days=5)).date().isoformat()
    to_q = (on_or_after + timedelta(days=40)).date().isoformat()
    r = client.get(
        f"/api/v1/wallet/admin/report?from={from_q}&to={to_q}", headers=auth_header
    )
    assert r.status_code == 200, r.text
    by = {a["username"]: a for a in r.json()["by_agent"]}
    # Chỉ kỳ m_new (330k, 1 mời) được tính; m_old bị loại.
    assert by["agentSepay"]["revenue"] == AGENT_FEE
    assert by["agentSepay"]["invite_count"] == 1
