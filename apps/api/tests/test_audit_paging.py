"""Trang nhật ký tải theo lô, mới→cũ — con trỏ (timestamp, id) không được sót dòng.

Vì sao con trỏ phải kèm `id`: `AuditLog.timestamp` mặc định `func.now()`, mà trong
Postgres `now()` là HẰNG suốt một transaction ⇒ mọi log ghi trong CÙNG một request
(mời hàng loạt, một lệnh hàng đợi sinh 5-6 dòng…) mang y hệt timestamp. Cắt trang
bằng mỗi `timestamp < before` sẽ nuốt luôn các dòng anh em cùng mốc.
"""

from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import AuditLog


def _seed(rows: list[tuple[str, datetime]]) -> None:
    """Ghi thẳng audit log với timestamp CHỈ ĐỊNH (không qua now() của transaction)."""
    with SessionLocal() as db:
        for action, ts in rows:
            db.add(
                AuditLog(
                    timestamp=ts,
                    actor_type="SYSTEM",
                    action=action,
                    result="SUCCESS",
                )
            )
        db.commit()


def _page(client: TestClient, header: dict, limit: int, cursor: dict | None) -> list[dict]:
    q = f"/api/v1/audit-logs?limit={limit}"
    if cursor:
        # Mốc ISO có "+00:00" — phải encode, không thì "+" thành dấu cách và API trả 422
        # (UI dùng encodeURIComponent đúng chỗ này).
        q += f"&before={quote(cursor['timestamp'])}&before_id={cursor['id']}"
    res = client.get(q, headers=header)
    assert res.status_code == 200, res.text
    return res.json()


def _drain(client: TestClient, header: dict, limit: int) -> list[dict]:
    """Lật hết mọi trang đúng như UI làm: dừng khi lô ngắn hơn một trang."""
    out: list[dict] = []
    cursor: dict | None = None
    for _ in range(50):
        page = _page(client, header, limit, cursor)
        out.extend(page)
        if len(page) < limit:
            return out
        cursor = page[-1]
    raise AssertionError("lật trang không dừng — con trỏ không tiến")


def test_paging_khong_sot_khong_trung(client: TestClient, auth_header: dict) -> None:
    base = datetime(2026, 8, 20, 3, 0, tzinfo=timezone.utc)
    _seed([(f"TEST_PAGE_{i:02d}", base + timedelta(minutes=i)) for i in range(12)])

    everything = _drain(client, auth_header, limit=500)
    seeded = [lg for lg in everything if lg["action"].startswith("TEST_PAGE_")]
    assert [lg["action"] for lg in seeded] == [
        f"TEST_PAGE_{i:02d}" for i in range(11, -1, -1)
    ]

    # Lật từng lô 3 dòng phải ra ĐÚNG cùng danh sách, không trùng không sót.
    paged = _drain(client, auth_header, limit=3)
    assert [lg["id"] for lg in paged] == [lg["id"] for lg in everything]
    assert len({lg["id"] for lg in paged}) == len(paged)


def test_paging_khong_nuot_log_cung_mot_moc(
    client: TestClient, auth_header: dict
) -> None:
    """5 dòng CÙNG timestamp (một request ghi nhiều log) — lật lô 2 vẫn ra đủ 5."""
    same = datetime(2026, 8, 21, 4, 0, tzinfo=timezone.utc)
    _seed([(f"TEST_TIE_{i}", same) for i in range(5)])

    paged = _drain(client, auth_header, limit=2)
    ties = [lg for lg in paged if lg["action"].startswith("TEST_TIE_")]
    assert len(ties) == 5, [lg["action"] for lg in ties]
    assert len({lg["id"] for lg in ties}) == 5


def test_before_khong_kem_id_van_chay(client: TestClient, auth_header: dict) -> None:
    """`before` đứng một mình (không `before_id`) vẫn hợp lệ: cắt theo mốc thời gian."""
    base = datetime(2026, 8, 22, 5, 0, tzinfo=timezone.utc)
    _seed([(f"TEST_TS_{i}", base + timedelta(minutes=i)) for i in range(3)])

    older = client.get(
        "/api/v1/audit-logs?limit=100&before="
        + quote((base + timedelta(minutes=1)).isoformat()),
        headers=auth_header,
    )
    assert older.status_code == 200, older.text
    actions = [lg["action"] for lg in older.json() if lg["action"].startswith("TEST_TS_")]
    assert actions == ["TEST_TS_0"]
