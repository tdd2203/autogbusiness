"""RÚT NGẮN HẠN THÌ SỔ PHẢI GHI ÍT ĐI — không bao giờ nhiều hơn.

Công thức tiền phần lẻ (EXPIRY_RULES §3.6.5) cần bốn số, ba số nằm sẵn trên dòng kỳ
còn số thứ tư — ĐỘ DÀI CHU KỲ HOÁ ĐƠN — thì trước đây phải suy ngược từ `end_at` với
giả định `end_at` là một mốc chốt. Cắt kỳ phá đúng giả định đó, và hỏng theo hai
đường cùng lúc:

  · `_months_between` có SÀN 1 tháng, nên kỳ khai "0 tháng + N nửa ngày" bị cắt cho
    NGẮN ĐI lại thành "1 tháng + N nửa ngày" — báo cáo cộng cả hai khoản.
  · Mẫu số suy ngược nhảy 28/29/30/31 theo ngày bị cắt rơi vào đâu, nên kể cả khi số
    tháng đúng thì tiền vẫn xê dịch.

Nay `cycle_days` được ghi thẳng lúc bán, và dòng cũ (cột còn NULL) được đóng băng giá
trị ngay trước khi `end_at` bị đụng tới. Mẫu số đứng yên, hai ô còn lại chỉ được giảm
⇒ tiền của một kỳ đã bán xong không thể tự phình ra.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from tests.wallet_helpers import (
    assign,
    bearer,
    create_ws,
    make_beta_sub,
    set_settings,
)

FEE = 330_000


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _anchor_giua_chu_ky() -> int:
    """Ngày neo cách hôm nay ~15 ngày ⇒ điểm nối luôn rơi GIỮA chu kỳ, và không chạm
    ngưỡng ép thêm tháng (mặc định từ ngày thứ 23 của chu kỳ)."""
    return ((datetime.now(timezone.utc).day + 15 - 1) % 28) + 1


def _switch_to_cycle_aligned(ws_id: str, anchor_day: int) -> None:
    from app.db import SessionLocal
    from app.models import Workspace

    with SessionLocal() as db:
        ws = db.get(Workspace, uuid.UUID(ws_id))
        ws.billing_mode = "cycle_aligned"
        ws.cycle_anchor_day = anchor_day
        db.commit()


def _invite(client: TestClient, token: str, ws_id: str, email: str) -> str:
    r = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member", "subscription_months": 1},
        headers=bearer(token),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _ky_cuoi(member_id: str) -> dict:
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        m = db.get(Member, uuid.UUID(member_id))
        c = sorted(m.subscription_cycles, key=lambda c: c.cycle_number)[-1]
        return {
            "months": c.months,
            "prorated_half_days": c.prorated_half_days,
            "cycle_days": c.cycle_days,
            "start_at": c.start_at,
            "end_at": c.end_at,
        }


def _tien_ky_cuoi(member_id: str, anchor_day: int) -> int:
    from app.db import SessionLocal
    from app.models import Member
    from app.routers.wallet.report import cycle_amount, cycle_units

    with SessionLocal() as db:
        m = db.get(Member, uuid.UUID(member_id))
        c = sorted(m.subscription_cycles, key=lambda c: c.cycle_number)[-1]
        return cycle_amount(cycle_units(c, anchor_day), FEE, 1_000)


def _rut_ngan(client: TestClient, token: str, ws_id: str, member_id: str, den: datetime):
    return client.patch(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/subscription",
        json={"subscription_end_at": den.isoformat()},
        headers=bearer(token),
    )


def _dung_ky_le(client: TestClient, auth_header: dict, ten: str, user: str):
    """Dựng một email có kỳ "phần lẻ, 0 tháng tròn" ở không gian chốt theo chu kỳ."""
    anchor = _anchor_giua_chu_ky()
    ws = create_ws(client, auth_header, ten)
    sub = make_beta_sub(client, auth_header, username=user, balance=20 * FEE)
    assign(client, auth_header, ws["id"], sub["id"])
    member_id = _invite(client, sub["token"], ws["id"], f"{user}@example.com")
    _switch_to_cycle_aligned(ws["id"], anchor)
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}/renew",
        json={"months": 1},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 200, r.text
    return ws, sub, member_id, anchor


def test_ban_xong_la_ghi_luon_do_dai_chu_ky(
    client: TestClient, auth_header: dict
) -> None:
    """Số duy nhất trong công thức mà không suy lại được phải được CẤT lúc bán."""
    _ws, _sub, member_id, _anchor = _dung_ky_le(
        client, auth_header, "Ghi Chu Ky WS", "ghichuky"
    )
    ky = _ky_cuoi(member_id)
    assert ky["prorated_half_days"], "chưa dựng được kỳ có phần lẻ, bài test vô nghĩa"
    assert ky["cycle_days"] is not None, "bán xong mà không ghi lại độ dài chu kỳ"
    assert 28 <= ky["cycle_days"] <= 31


def test_cat_ky_thi_tien_giam_chu_khong_tang(
    client: TestClient, auth_header: dict
) -> None:
    """Cắt sâu vào phần lẻ: cả số tháng lẫn phần lẻ đều phải co lại."""
    ws, sub, member_id, anchor = _dung_ky_le(
        client, auth_header, "Cat Sau WS", "catsau"
    )
    truoc = _ky_cuoi(member_id)
    tien_truoc = _tien_ky_cuoi(member_id, anchor)

    den = truoc["start_at"].replace(tzinfo=timezone.utc) + timedelta(days=3)
    assert _rut_ngan(client, sub["token"], ws["id"], member_id, den).status_code == 200

    sau = _ky_cuoi(member_id)
    assert (sau["months"] or 0) == 0, "sàn 1 tháng lại nhét thêm một khoản không có thật"
    assert sau["prorated_half_days"] < truoc["prorated_half_days"]
    assert sau["cycle_days"] == truoc["cycle_days"], "mẫu số phải đứng yên"
    assert _tien_ky_cuoi(member_id, anchor) < tien_truoc


def test_cat_vai_tieng_cung_khong_lam_tien_tang(
    client: TestClient, auth_header: dict
) -> None:
    """Ca hiểm nhất: cắt một nhúm giờ, trước đây mẫu số nhảy tháng và tiền TĂNG."""
    ws, sub, member_id, anchor = _dung_ky_le(
        client, auth_header, "Cat Nong WS", "catnong"
    )
    tien_truoc = _tien_ky_cuoi(member_id, anchor)

    den = _ky_cuoi(member_id)["end_at"].replace(tzinfo=timezone.utc) - timedelta(hours=7)
    assert _rut_ngan(client, sub["token"], ws["id"], member_id, den).status_code == 200

    tien_sau = _tien_ky_cuoi(member_id, anchor)
    assert tien_sau <= tien_truoc, (
        f"cắt bớt 7 tiếng mà sổ ghi {tien_sau}đ, trước khi cắt chỉ {tien_truoc}đ"
    )


def test_dong_bang_mau_so_cho_dong_ky_cu(
    client: TestClient, auth_header: dict
) -> None:
    """Dòng bán TRƯỚC khi có cột này (cycle_days NULL) phải được chốt mẫu số lại
    ngay trước lúc `end_at` thôi là mốc chốt — bằng không nó rơi vào đúng cái bẫy cũ."""
    from app.db import SessionLocal
    from app.models import Member

    ws, sub, member_id, anchor = _dung_ky_le(
        client, auth_header, "Dong Bang WS", "dongbang"
    )
    # Giả lập dòng cũ: xoá con số vừa ghi đi.
    with SessionLocal() as db:
        m = db.get(Member, uuid.UUID(member_id))
        c = sorted(m.subscription_cycles, key=lambda c: c.cycle_number)[-1]
        c.cycle_days = None
        db.commit()
    tien_truoc = _tien_ky_cuoi(member_id, anchor)

    den = _ky_cuoi(member_id)["end_at"].replace(tzinfo=timezone.utc) - timedelta(hours=7)
    assert _rut_ngan(client, sub["token"], ws["id"], member_id, den).status_code == 200

    sau = _ky_cuoi(member_id)
    assert sau["cycle_days"] is not None, "dòng cũ không được đóng băng mẫu số"
    assert _tien_ky_cuoi(member_id, anchor) <= tien_truoc


def test_khong_gian_ba_muoi_ngay_giu_nguyen_cach_cu(
    client: TestClient, auth_header: dict
) -> None:
    """Đối chứng: dòng kỳ không có phần lẻ vẫn đi đúng đường cũ, kể cả sàn 1 tháng."""
    ws = create_ws(client, auth_header, "Cat Ky Cu WS")
    sub = make_beta_sub(client, auth_header, username="catkycu", balance=10 * FEE)
    assign(client, auth_header, ws["id"], sub["id"])
    member_id = _invite(client, sub["token"], ws["id"], "ck9@example.com")

    truoc = _ky_cuoi(member_id)
    assert truoc["prorated_half_days"] is None
    assert truoc["cycle_days"] is None

    den = truoc["start_at"].replace(tzinfo=timezone.utc) + timedelta(days=10)
    assert _rut_ngan(client, sub["token"], ws["id"], member_id, den).status_code == 200

    sau = _ky_cuoi(member_id)
    assert sau["prorated_half_days"] is None
    assert sau["cycle_days"] is None
    assert sau["months"] == 1  # sàn tối thiểu 1 tháng của chế độ cũ, giữ nguyên


def test_cat_dung_mot_moc_thi_so_mat_dung_mot_thang(
    client: TestClient, auth_header: dict
) -> None:
    """Cửa sổ trải qua tháng 2: cắt bỏ đúng MỘT chu kỳ thì sổ chỉ được mất một tháng.

    Bản vá trước chia phần trọn cho độ dài chu kỳ ĐẦU (31 ngày) nên chu kỳ tháng 2
    (28 ngày) không đủ 62 nửa ngày để đếm — bỏ một mốc mà sổ mất hai tháng, hụt đúng
    một đơn giá. Dựng dòng kỳ bằng mốc cố định để không phụ thuộc ngày chạy."""
    from app.db import SessionLocal
    from app.models import Member, MemberSubscriptionCycle, Workspace
    from app.routers.members._shared import _trim_cycles_to_end

    ws = create_ws(client, auth_header, "Thang Hai WS")
    sub = make_beta_sub(client, auth_header, username="thanghai", balance=0)
    assign(client, auth_header, ws["id"], sub["id"])
    _switch_to_cycle_aligned(ws["id"], anchor_day=1)

    with SessionLocal() as db:
        w = db.get(Workspace, uuid.UUID(ws["id"]))
        m = Member(
            workspace_id=w.id,
            email="th2@example.com",
            chatgpt_role="member",
            status="active",
            invited_by_user_id=uuid.UUID(sub["id"]),
            joined_at=datetime(2027, 1, 20, 10, tzinfo=timezone.utc),
            subscription_months=2,
            subscription_purchased_at=datetime(2027, 1, 20, 10, tzinfo=timezone.utc),
            subscription_end_at=datetime(2027, 4, 1, 3, tzinfo=timezone.utc),
        )
        db.add(m)
        db.flush()
        # Kỳ bán: nối 20/1 10:00 → chốt 1/2 (phần lẻ 24 nửa ngày, chu kỳ tháng 1 =
        # 31 ngày) + hai chu kỳ trọn (tháng 2 = 28 ngày, tháng 3 = 31 ngày).
        m.subscription_cycles.append(
            MemberSubscriptionCycle(
                cycle_number=1,
                months=2,
                prorated_half_days=24,
                cycle_days=31,
                start_at=m.subscription_purchased_at,
                end_at=m.subscription_end_at,
                payment_status="paid",
            )
        )
        db.flush()
        _ = m.workspace  # nạp quan hệ để _trim_cycles_to_end đọc được ngày neo
        _trim_cycles_to_end(
            m,
            datetime(2027, 3, 1, 3, tzinfo=timezone.utc),
            now=datetime(2027, 2, 10, tzinfo=timezone.utc),
        )
        db.commit()
        c = m.subscription_cycles[0]
        assert c.months == 1, f"bỏ một mốc mà sổ ghi còn {c.months} tháng trọn"
        assert c.prorated_half_days == 24
        assert c.cycle_days == 31
