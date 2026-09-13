"""Email đã chuyển hạn sang email khác thì không mời lại được (user chốt 14/9/2026).

Ngoại lệ duy nhất là ca `cmsgpshp` (13/9/2026): super-admin mời lại email đã chuyển
hạn đi. Từ lúc được mời lại, email đó trở về bình thường — và lịch sử của nó phải
khớp ở cả hai đầu:
  * tab "Đã xoá" vẫn còn dòng "đã chuyển hạn sang …" dù bản ghi đã sống lại;
  * email nhận chỉ kế thừa tiền và nhật ký của email cũ TỚI mốc chuyển, không gom
    luôn lượt mời mới của email cũ.
"""

import uuid as _uuid
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import AuditLog, Member, QueueItem, User, Wallet, WalletTransaction

OLD = "email.cu@example.org"
NEW = "email.moi@example.org"


def _sub_admin(client: TestClient, auth_header: dict, n: str = "agent1") -> dict:
    resp = client.post(
        "/api/v1/users",
        json={
            "email": f"{n}@example.com",
            "username": n,
            "password": "SubPassword123!",
            "permissions": ["MEMBER_VIEW", "MEMBER_INVITE"],
        },
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    login = client.post(
        "/api/v1/auth/login", json={"identifier": n, "password": "SubPassword123!"}
    )
    return {
        "id": resp.json()["id"],
        "header": {"Authorization": f"Bearer {login.json()['access_token']}"},
    }


def _ws(client: TestClient, auth_header: dict, name: str = "CHATGPT PRO") -> str:
    resp = client.post("/api/v1/workspaces", json={"name": name}, headers=auth_header)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _assign(client: TestClient, auth_header: dict, user_id: str, ws_id: str) -> None:
    resp = client.put(
        f"/api/v1/invite-config/users/{user_id}",
        json={"all_workspaces": False, "workspace_ids": [ws_id]},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text


def _agent_with_ws(client: TestClient, auth_header: dict) -> tuple[str, dict]:
    ws = _ws(client, auth_header)
    sub = _sub_admin(client, auth_header)
    _assign(client, auth_header, sub["id"], ws)
    return ws, sub


def _seed_pair(
    ws_id: str, owner_id: str, *, came_back: str | None = None
) -> tuple[str, str, datetime]:
    """Một lần chuyển hạn OLD → NEW cách đây 2 tiếng.

    `came_back`: None = OLD đã rời đội như mọi lần chuyển; "pending" = super-admin
    mời lại OLD 8 phút sau (ca cmsgpshp); "expired" = mời lại xong, dùng hết hạn rồi
    rời đội bình thường."""
    now = datetime.now(timezone.utc)
    hop = now - timedelta(hours=2)
    source_fields = dict(
        status="removed",
        removed_at=hop + timedelta(minutes=1),
        removed_reason="subscription_transferred",
        last_invited_at=now - timedelta(days=30),
        subscription_end_at=hop,
    )
    if came_back == "pending":
        source_fields.update(
            status="pending",
            removed_at=None,
            removed_reason=None,
            last_invited_at=hop + timedelta(minutes=8),
            subscription_end_at=now + timedelta(days=10),
        )
    elif came_back == "expired":
        source_fields.update(
            status="removed",
            removed_at=now - timedelta(minutes=10),
            removed_reason="expired",
            last_invited_at=hop + timedelta(minutes=8),
            subscription_end_at=now - timedelta(hours=1),
        )
    ws = _uuid.UUID(ws_id)
    owner = _uuid.UUID(owner_id)
    with SessionLocal() as db:
        target = Member(
            workspace_id=ws,
            email=NEW,
            status="active",
            invited_by_user_id=owner,
            joined_at=now - timedelta(days=1),
            subscription_months=1,
            subscription_end_at=now + timedelta(days=5),
            payment_status="paid",
            transferred_from_email=OLD,
            transferred_in_at=hop,
            origin_email=OLD,
        )
        source = Member(
            workspace_id=ws,
            email=OLD,
            invited_by_user_id=owner,
            joined_at=now - timedelta(days=30),
            subscription_months=1,
            payment_status="paid",
            transferred_to_email=NEW,
            transferred_out_at=hop,
            transfer_kind="takeover",
            **source_fields,
        )
        db.add_all([target, source])
        db.flush()
        source.transferred_to_member_id = target.id
        target.transferred_from_member_id = source.id
        db.commit()
        return str(source.id), str(target.id), hop


def _bulk(client: TestClient, ws_id: str, header: dict, email: str = OLD):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-invite",
        json={"invites": [{"email": email, "subscription_months": 1}], "role": "member"},
        headers=header,
    )


def _fee(user_id: str, *, email: str, amount: int, at: datetime) -> None:
    uid = _uuid.UUID(user_id)
    with SessionLocal() as db:
        wallet = db.query(Wallet).filter(Wallet.user_id == uid).one_or_none()
        if wallet is None:
            wallet = Wallet(user_id=uid, balance=0, held=0)
            db.add(wallet)
            db.flush()
        db.add(
            WalletTransaction(
                wallet_id=wallet.id,
                user_id=uid,
                kind="invite_fee",
                amount=-amount,
                balance_after=0,
                held_after=0,
                ref_type="invite",
                ref_id=str(_uuid.uuid4()),
                meta={"email": email, "fee": amount},
                created_at=at,
            )
        )
        db.commit()


def _log(action: str, target_id: str, data: dict, at: datetime) -> None:
    with SessionLocal() as db:
        db.add(
            AuditLog(
                timestamp=at,
                actor_type="ADMIN",
                action=action,
                result="SUCCESS",
                target_type="MEMBER",
                target_id=target_id,
                data=data,
            )
        )
        db.commit()


# ── Chặn mời lại ─────────────────────────────────────────────────────────────


def test_dai_ly_moi_lai_email_da_chuyen_han_bi_chan(
    client: TestClient, auth_header: dict
) -> None:
    ws, sub = _agent_with_ws(client, auth_header)
    source_id, _target_id, _hop = _seed_pair(ws, sub["id"])

    resp = _bulk(client, ws, sub["header"])
    assert resp.status_code == 409, resp.text
    assert "đã chuyển hạn sang" in resp.text

    single = client.post(
        f"/api/v1/workspaces/{ws}/members/invite",
        json={"email": OLD, "role": "member", "subscription_months": 1},
        headers=sub["header"],
    )
    assert single.status_code == 409, single.text

    again = client.post(
        f"/api/v1/workspaces/{ws}/members/{source_id}/re-invite", headers=sub["header"]
    )
    assert again.status_code == 409, again.text

    with SessionLocal() as db:
        assert db.get(Member, _uuid.UUID(source_id)).status == "removed"
        assert (
            db.query(QueueItem).filter(QueueItem.workspace_id == _uuid.UUID(ws)).count()
            == 0
        )


def test_super_admin_van_moi_lai_duoc(client: TestClient, auth_header: dict) -> None:
    ws = _ws(client, auth_header)
    with SessionLocal() as db:
        admin_id = str(db.query(User).filter(User.is_super_admin.is_(True)).first().id)
    _seed_pair(ws, admin_id)

    resp = _bulk(client, ws, auth_header)
    assert resp.status_code == 202, resp.text


def test_da_duoc_moi_lai_sau_chuyen_han_thi_tro_ve_binh_thuong(
    client: TestClient, auth_header: dict
) -> None:
    """Ca cmsgpshp về sau: mời lại xong, hết hạn, đại lý gia hạn tiếp như mọi email."""
    ws, sub = _agent_with_ws(client, auth_header)
    _seed_pair(ws, sub["id"], came_back="expired")

    resp = _bulk(client, ws, sub["header"])
    assert resp.status_code == 202, resp.text


def test_email_moi_toanh_khong_bi_anh_huong(client: TestClient, auth_header: dict) -> None:
    ws, sub = _agent_with_ws(client, auth_header)
    _seed_pair(ws, sub["id"])

    resp = _bulk(client, ws, sub["header"], email="khac.han@example.org")
    assert resp.status_code == 202, resp.text


# ── Lịch sử của ca được mời lại phải khớp ────────────────────────────────────


def test_tab_da_xoa_giu_dong_chuyen_han_cua_email_duoc_moi_lai(
    client: TestClient, auth_header: dict
) -> None:
    ws, sub = _agent_with_ws(client, auth_header)
    source_id, target_id, hop = _seed_pair(ws, sub["id"], came_back="pending")

    removed = client.get(
        "/api/v1/added-members?removed=true&platform=gpt", headers=sub["header"]
    )
    assert removed.status_code == 200, removed.text
    rows = [r for r in removed.json() if r["email"] == OLD]
    assert len(rows) == 1, rows
    row = rows[0]
    assert row["id"] == source_id
    assert row["status"] == "removed"
    assert row["removed_reason"] == "subscription_transferred"
    assert row["email_changed_to"] == [NEW]
    assert row["email_changed_to_ids"] == [target_id]
    removed_at = datetime.fromisoformat(row["removed_at"].replace("Z", "+00:00"))
    assert abs((removed_at - hop).total_seconds()) < 1

    live = client.get("/api/v1/added-members?platform=gpt", headers=sub["header"])
    assert live.status_code == 200, live.text
    assert [r["status"] for r in live.json() if r["email"] == OLD] == ["pending"]


def test_tab_da_xoa_khong_nhan_doi_email_chua_moi_lai(
    client: TestClient, auth_header: dict
) -> None:
    ws, sub = _agent_with_ws(client, auth_header)
    _seed_pair(ws, sub["id"])

    removed = client.get(
        "/api/v1/added-members?removed=true&platform=gpt", headers=sub["header"]
    )
    assert removed.status_code == 200, removed.text
    rows = [r for r in removed.json() if r["email"] == OLD]
    assert [r["removed_reason"] for r in rows] == ["subscription_transferred"]


def test_email_nhan_khong_gom_tien_luot_moi_moi_cua_email_cu(
    client: TestClient, auth_header: dict
) -> None:
    ws, sub = _agent_with_ws(client, auth_header)
    source_id, target_id, hop = _seed_pair(ws, sub["id"], came_back="pending")
    _fee(sub["id"], email=OLD, amount=100_000, at=hop - timedelta(days=5))
    _fee(sub["id"], email=OLD, amount=50_000, at=hop + timedelta(minutes=9))

    target = client.get(
        f"/api/v1/workspaces/{ws}/members/{target_id}/payments", headers=sub["header"]
    ).json()
    assert target["charged_total"] == 100_000, target
    assert {e["from_email"] for e in target["entries"]} == {OLD}

    source = client.get(
        f"/api/v1/workspaces/{ws}/members/{source_id}/payments", headers=sub["header"]
    ).json()
    assert source["charged_total"] == 150_000, source


def test_chuoi_binh_thuong_van_gom_tien_nhu_cu(
    client: TestClient, auth_header: dict
) -> None:
    ws, sub = _agent_with_ws(client, auth_header)
    _source_id, target_id, hop = _seed_pair(ws, sub["id"])
    _fee(sub["id"], email=OLD, amount=100_000, at=hop - timedelta(days=5))
    _fee(sub["id"], email=OLD, amount=50_000, at=hop + timedelta(minutes=9))

    target = client.get(
        f"/api/v1/workspaces/{ws}/members/{target_id}/payments", headers=sub["header"]
    ).json()
    assert target["charged_total"] == 150_000, target


def _seed_logs(ws: str, source_id: str, target_id: str, hop: datetime) -> None:
    _log(
        "MEMBER_INVITE_QUEUED",
        source_id,
        {"workspace_id": ws, "email": OLD},
        hop - timedelta(days=30),
    )
    _log(
        "MEMBER_SUBSCRIPTION_TRANSFERRED",
        target_id,
        {
            "workspace_id": ws,
            "source_member_id": source_id,
            "source_email": OLD,
            "target_email": NEW,
        },
        hop,
    )
    _log(
        "MEMBER_MANUAL_FIX",
        source_id,
        {"workspace_id": ws, "email": OLD},
        hop + timedelta(hours=1),
    )


def test_email_nhan_khong_ke_thua_nhat_ky_sau_moc_chuyen(
    client: TestClient, auth_header: dict
) -> None:
    ws, sub = _agent_with_ws(client, auth_header)
    source_id, target_id, hop = _seed_pair(ws, sub["id"], came_back="pending")
    _seed_logs(ws, source_id, target_id, hop)

    target = client.get(
        f"/api/v1/workspaces/{ws}/members/{target_id}/logs", headers=sub["header"]
    )
    assert target.status_code == 200, target.text
    actions = {r["action"] for r in target.json()}
    assert "MEMBER_SUBSCRIPTION_TRANSFERRED" in actions
    assert "MEMBER_INVITE_QUEUED" in actions
    assert "MEMBER_MANUAL_FIX" not in actions

    source = client.get(
        f"/api/v1/workspaces/{ws}/members/{source_id}/logs", headers=sub["header"]
    )
    assert "MEMBER_MANUAL_FIX" in {r["action"] for r in source.json()}


def test_chuoi_binh_thuong_van_ke_thua_nhat_ky_nhu_cu(
    client: TestClient, auth_header: dict
) -> None:
    ws, sub = _agent_with_ws(client, auth_header)
    source_id, target_id, hop = _seed_pair(ws, sub["id"])
    _seed_logs(ws, source_id, target_id, hop)

    target = client.get(
        f"/api/v1/workspaces/{ws}/members/{target_id}/logs", headers=sub["header"]
    )
    assert target.status_code == 200, target.text
    assert "MEMBER_MANUAL_FIX" in {r["action"] for r in target.json()}
