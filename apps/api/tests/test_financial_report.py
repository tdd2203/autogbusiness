"""Báo cáo tài chính — gốc TIỀN MẶT (chốt user 2026-08-12):

  - THU = Σ phí của các chu kỳ ĐÃ ĐÁNH DẤU TRẢ, tính vào kỳ chứa NGÀY NHẬN TIỀN
    (paid_at, thiếu thì start_at). Phí = đơn giá/tháng × số tháng của kỳ; đơn giá =
    COALESCE(member.fee_vnd, chủ.invite_fee_vnd, global). Kỳ chưa trả = công nợ, KHÔNG
    vào THU. Member không có chu kỳ nào cũng KHÔNG sinh THU (không có tiền nào nhận).
  - CHI = TRỌN tiền hoá đơn Stripe 'paid' có NGÀY HOÁ ĐƠN trong kỳ và >=
    workspace.finance_start_at (loại hoá đơn hệ thống cũ / trả ngoài).
  - Member thuộc user is_test bị loại; member chủ workspace (role owner) bị loại;
    member chưa có chủ gộp nhóm "Chưa có chủ" ở đơn giá mặc định.

Báo cáo THEO CHU KỲ (`/report/cycles`) vẫn tính kỹ theo ngày + tỷ lệ lấp đầy — xem
`test_financial_report_cycles`.
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
                    "period_end": (DATE_CUR + timedelta(days=30)).date().isoformat(),
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

    # THU: M1 330k + M2 (660k+330k) + M3 380k + M5 380k + M7 500k.
    # M8 KHÔNG có chu kỳ nào → không có tiền nào nhận → không vào THU (khác gốc dồn
    # tích trước đây: hồi đó suy ra 1 kỳ mời 330k từ hạn dùng).
    assert data["revenue_invite"] == 330_000 + 660_000 + 380_000 + 380_000 + 500_000
    assert data["revenue_renew"] == 330_000
    assert data["revenue"] == 2_580_000

    # CHI: chỉ hoá đơn chu kỳ hiện tại (total 10tr + phí 500k); bỏ 5tr cũ + 9tr void.
    assert data["cost"] == 10_500_000
    assert data["profit"] == 2_580_000 - 10_500_000

    by = {a["username"]: a for a in data["by_agent"]}
    # Test account KHÔNG xuất hiện.
    assert "testerX" not in by
    # Agent: M1+M2+M7 = 330+990+500 = 1820k; 3 mời, 1 gia hạn (M8 không có chu kỳ).
    assert by["agentA"]["revenue"] == 1_820_000
    assert by["agentA"]["invite_count"] == 3
    assert by["agentA"]["renew_count"] == 1
    # Admin add: default fee.
    assert by["adminX"]["revenue"] == 380_000
    # Chưa có chủ: default fee, user_id None.
    assert by["Chưa có chủ"]["revenue"] == 380_000
    assert by["Chưa có chủ"]["user_id"] is None


def test_financial_report_finance_start_excludes_old(client: TestClient, auth_header: dict):
    """finance_start_at NULL → fallback created_at: hoá đơn trước created_at vẫn bị bỏ,
    nhưng hoá đơn sau created_at được tính (workspace mới tính từ khi onboard).

    Hoá đơn ở đây KHÔNG có period_* — gốc tiền mặt không cần chu kỳ, vẫn tính đủ.
    """
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
    # created_at (now-50d) <= hoá đơn (now-40d) → tính TRỌN, không chia ngày.
    assert r.json()["cost"] == 3_000_000


def test_financial_report_cash_basis_window(client: TestClient, auth_header: dict):
    """Gốc tiền mặt cắt theo NGÀY NHẬN TIỀN và NGÀY HOÁ ĐƠN, không phân bổ.

    Kỳ trả tiền NGOÀI khoảng xem → 0 đồng THU dù member vẫn đang dùng dịch vụ trong
    khoảng đó; hoá đơn phát hành ngoài khoảng → 0 đồng CHI dù nó phủ những ngày đó.
    Đây chính là điều đánh đổi khi chọn tiền mặt thay cho dồn tích.
    """
    paid_on = _now - timedelta(days=20)  # ngày trả tiền & ngày hoá đơn
    db = SessionLocal()
    try:
        s = db.get(PaymentSettings, 1)
        if s is None:
            db.add(PaymentSettings(id=1, invite_fee_vnd=DEFAULT_FEE, payment_codes=[]))
        else:
            s.invite_fee_vnd = DEFAULT_FEE
        db.flush()
        ws = Workspace(
            name="WS_CASH",
            extension_api_key="k-cash",
            finance_start_at=paid_on - timedelta(days=1),
            billing_invoices=[
                {"date": paid_on.date().isoformat(), "total_vnd": 4_000_000, "status": "paid"}
            ],
        )
        db.add(ws)
        db.flush()
        agent = _mk_user(db, "agentCash", fee=AGENT_FEE)
        m = _mk_member(db, ws, owner=agent, joined=paid_on, end=paid_on + timedelta(days=60))
        _add_cycle(db, m, number=1, months=2, start=paid_on)
        db.commit()
    finally:
        db.close()

    # Khoảng CHỨA ngày trả tiền → tính TRỌN 2 tháng phí + trọn hoá đơn.
    inside = client.get(
        f"/api/v1/wallet/admin/report"
        f"?from={(paid_on - timedelta(days=2)).date().isoformat()}"
        f"&to={(paid_on + timedelta(days=2)).date().isoformat()}",
        headers=auth_header,
    ).json()
    assert inside["revenue"] == AGENT_FEE * 2
    assert inside["cost"] == 4_000_000
    assert inside["seat_months"] == 2
    assert inside["avg_price_per_seat"] == AGENT_FEE
    # Hoá đơn không ghi số ghế → không suy được phí seat thực tế.
    assert inside["avg_seat_cost"] is None

    # Khoảng SAU đó (member vẫn còn hạn, hoá đơn vẫn đang phủ) → cả hai vế = 0.
    after = client.get(
        f"/api/v1/wallet/admin/report"
        f"?from={(paid_on + timedelta(days=5)).date().isoformat()}"
        f"&to={(paid_on + timedelta(days=15)).date().isoformat()}",
        headers=auth_header,
    ).json()
    assert after["revenue"] == 0
    assert after["cost"] == 0


def test_financial_report_unpaid_cycle_excluded(client: TestClient, auth_header: dict):
    """Kỳ CHƯA đánh dấu trả = công nợ, không phải tiền mặt → không vào THU."""
    db = SessionLocal()
    try:
        s = db.get(PaymentSettings, 1)
        if s is None:
            db.add(PaymentSettings(id=1, invite_fee_vnd=DEFAULT_FEE, payment_codes=[]))
        db.flush()
        ws = Workspace(name="WS_DEBT", extension_api_key="k-debt", billing_invoices=[])
        db.add(ws)
        db.flush()
        agent = _mk_user(db, "agentDebt", fee=AGENT_FEE)
        m = _mk_member(db, ws, owner=agent, end=CYCLE_START + timedelta(days=30))
        db.add(
            MemberSubscriptionCycle(
                member_id=m.id,
                cycle_number=1,
                months=1,
                start_at=CYCLE_START,
                end_at=CYCLE_START + timedelta(days=30),
                payment_status="unpaid",
            )
        )
        db.commit()
    finally:
        db.close()

    r = client.get(
        f"/api/v1/wallet/admin/report?from={FROM_Q}&to={TO_Q}", headers=auth_header
    )
    assert r.status_code == 200, r.text
    by = {a["username"]: a for a in r.json()["by_agent"]}
    assert "agentDebt" not in by


def test_financial_report_cycles(client: TestClient, auth_header: dict):
    """Báo cáo theo ĐÚNG chu kỳ thanh toán: CHI = TRỌN tiền hoá đơn, THU = doanh thu
    member CỦA WORKSPACE ĐÓ rơi vào đúng những ngày của chu kỳ (vẫn tính theo ngày),
    kèm công suất để suy tỷ lệ lấp đầy."""
    cyc_start = _now - timedelta(days=40)
    cyc_end = cyc_start + timedelta(days=30)
    db = SessionLocal()
    try:
        s = db.get(PaymentSettings, 1)
        if s is None:
            db.add(PaymentSettings(id=1, invite_fee_vnd=DEFAULT_FEE, payment_codes=[]))
        else:
            s.invite_fee_vnd = DEFAULT_FEE
        db.flush()
        ws = Workspace(
            name="WS_CYCLE",
            extension_api_key="k-cycle",
            finance_start_at=cyc_start,
            billing_invoices=[
                {
                    "date": cyc_start.date().isoformat(),
                    "total_vnd": 1_000_000,
                    "status": "paid",
                    "quantity": 3,
                    "period_start": cyc_start.date().isoformat(),
                    "period_end": cyc_end.date().isoformat(),
                }
            ],
        )
        db.add(ws)
        other = Workspace(name="WS_OTHER", extension_api_key="k-other", billing_invoices=[])
        db.add(other)
        db.flush()
        agent = _mk_user(db, "agentCycle", fee=AGENT_FEE)
        m = _mk_member(db, ws, owner=agent, joined=cyc_start, end=cyc_end)
        _add_cycle(db, m, number=1, months=1, start=cyc_start)
        m_other = _mk_member(db, other, owner=agent, joined=cyc_start, end=cyc_end)
        _add_cycle(db, m_other, number=1, months=1, start=cyc_start)
        db.commit()
    finally:
        db.close()

    r = client.get("/api/v1/wallet/admin/report/cycles", headers=auth_header)
    assert r.status_code == 200, r.text
    rows = [c for c in r.json()["cycles"] if c["workspace"] == "WS_CYCLE"]
    assert len(rows) == 1
    c = rows[0]
    assert c["cost"] == 1_000_000  # TRỌN hoá đơn
    assert c["seats"] == 3
    assert c["days"] == 30
    assert c["in_progress"] is False
    # Công suất = 3 ghế × 30 ngày ÷ 30 = 3 seat·tháng; mới bán 1 ghế nên chưa lấp đầy.
    assert c["capacity_seat_months"] == 3.0
    assert c["seat_months"] < c["capacity_seat_months"]
    # Doanh thu kỳ vẫn CẮT MỐC SePay (khác bảng tháng) — tính theo số ngày sau mốc.
    from app.routers.wallet.report import _SEPAY_LIVE_DATE

    paid_days = (cyc_end.date() - max(cyc_start.date(), _SEPAY_LIVE_DATE)).days
    assert abs(c["revenue"] - round(AGENT_FEE * paid_days / 30)) <= 1
    assert c["profit"] == c["revenue"] - 1_000_000
    # Member của workspace khác cùng chủ KHÔNG lẫn vào; WS_OTHER không có hoá đơn.
    assert not [x for x in r.json()["cycles"] if x["workspace"] == "WS_OTHER"]


def test_financial_report_seat_cost(client: TestClient, auth_header: dict):
    """Phí seat thực tế = tiền hoá đơn ÷ ghế·tháng ChatGPT thu tiền, QUY VỀ 30 NGÀY.

    Hoá đơn ChatGPT thường dài 31 ngày còn gói bán cho khách tính tháng 30 ngày —
    không quy đổi thì hai con số lệch ~3% và không so thẳng được với giá bán.
    """
    inv_date = _now - timedelta(days=20)
    db = SessionLocal()
    try:
        s = db.get(PaymentSettings, 1)
        if s is None:
            db.add(PaymentSettings(id=1, invite_fee_vnd=DEFAULT_FEE, payment_codes=[]))
        db.add(
            Workspace(
                name="WS_SEATCOST",
                extension_api_key="k-seatcost",
                finance_start_at=inv_date - timedelta(days=1),
                billing_invoices=[
                    {
                        "date": inv_date.date().isoformat(),
                        "total_vnd": 3_100_000,
                        "status": "paid",
                        "quantity": 10,
                        "period_start": inv_date.date().isoformat(),
                        "period_end": (inv_date + timedelta(days=31)).date().isoformat(),
                    }
                ],
            )
        )
        db.commit()
    finally:
        db.close()

    d = client.get(
        f"/api/v1/wallet/admin/report?from={FROM_Q}&to={TO_Q}", headers=auth_header
    ).json()
    # 10 ghế × 31 ngày ÷ 30 = 10.3333… ghế·tháng (làm tròn 2 số khi trả ra = 10.33).
    # Phí seat = 3.100.000 × 30 ÷ (10 × 31) = 300.000 đ/ghế·tháng chẵn — chia bằng mẫu
    # số CHƯA làm tròn, nên không lệch như khi lấy 10.33.
    assert d["billed_seat_months"] == 10.33
    assert d["avg_seat_cost"] == 300_000
    # Không quy 30 ngày thì sẽ ra 310.000 — sai lệch ~3% so với giá bán tính tháng 30.
    assert d["avg_seat_cost"] != round(3_100_000 / 10)
