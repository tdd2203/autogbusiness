"""Ô tìm kiếm nhật ký phải tìm TRONG DB, không phải trong trang UI đang giữ.

User 2026-08-27: "khi tìm kiếm chủ động thì phải hiển thị ra chứ không phải chỉ tìm
trong danh sách hiện tại". Trang chỉ giữ vài lô mới nhất (và mặc định lọc theo ngày
hôm nay) nên gõ email của một việc tuần trước là không ra gì. `?q=` đẩy việc lọc
xuống Postgres: khớp trên hành động / người thực hiện / target / cục `data`, và cả
hai đường email GIÁN TIẾP (log chỉ có member_id, log chỉ có queue_item_id).
"""

from datetime import datetime, timedelta, timezone
from urllib.parse import quote
from uuid import uuid4

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import AuditLog, Member, QueueItem, Workspace

_OLD = datetime(2026, 7, 1, 3, 0, tzinfo=timezone.utc)


def _search(client: TestClient, header: dict, q: str, limit: int = 200) -> list[dict]:
    res = client.get(
        f"/api/v1/audit-logs?limit={limit}&q={quote(q)}", headers=header
    )
    assert res.status_code == 200, res.text
    return res.json()


def _actions(logs: list[dict]) -> set[str]:
    return {x["action"] for x in logs}


def test_tim_thay_dong_cu_ngoai_trang_dau(client: TestClient, auth_header: dict) -> None:
    """Dòng khớp nằm sâu trong quá khứ vẫn phải ra — dù trang đầu không chứa nó."""
    with SessionLocal() as db:
        db.add(
            AuditLog(
                timestamp=_OLD,
                actor_type="SYSTEM",
                action="TEST_SEARCH_KIM_TRONG_DONG_CO",
                result="SUCCESS",
                data={"email": "kimcu@example.com"},
            )
        )
        # 40 dòng mới hơn để dòng cần tìm chắc chắn không nằm ở lô đầu khi limit nhỏ.
        for i in range(40):
            db.add(
                AuditLog(
                    timestamp=_OLD + timedelta(days=1, minutes=i),
                    actor_type="SYSTEM",
                    action=f"TEST_SEARCH_NHIEU_{i:02d}",
                    result="SUCCESS",
                )
            )
        db.commit()

    # Trang đầu (không tìm) KHÔNG chứa dòng cũ đó — đúng cảnh người dùng gặp.
    first = client.get("/api/v1/audit-logs?limit=5", headers=auth_header).json()
    assert "TEST_SEARCH_KIM_TRONG_DONG_CO" not in _actions(first)

    hits = _search(client, auth_header, "kimcu@example.com")
    assert _actions(hits) == {"TEST_SEARCH_KIM_TRONG_DONG_CO"}

    # Khớp theo tên hành động cũng phải ra.
    assert "TEST_SEARCH_KIM_TRONG_DONG_CO" in _actions(
        _search(client, auth_header, "kim_trong_dong")
    )


def test_tim_theo_email_khi_log_chi_co_member_id(
    client: TestClient, auth_header: dict
) -> None:
    """Log chỉ ghi member_id (email suy lúc đọc) — gõ email vẫn phải ra việc của nó."""
    with SessionLocal() as db:
        ws = Workspace(name="WS tìm kiếm", extension_api_key=uuid4().hex)
        db.add(ws)
        db.flush()
        member = Member(workspace_id=ws.id, email="giantiep@example.com")
        db.add(member)
        db.flush()
        db.add(
            AuditLog(
                timestamp=_OLD,
                actor_type="SYSTEM",
                action="TEST_SEARCH_QUA_MEMBER_ID",
                result="SUCCESS",
                target_type="MEMBER",
                target_id=str(member.id),
            )
        )
        db.commit()

    assert "TEST_SEARCH_QUA_MEMBER_ID" in _actions(
        _search(client, auth_header, "giantiep@example.com")
    )


def test_tim_theo_email_khi_log_chi_co_queue_item_id(
    client: TestClient, auth_header: dict
) -> None:
    """Log chỉ ghi queue_item_id — email nằm trong payload task, vẫn phải tìm ra."""
    with SessionLocal() as db:
        item = QueueItem(
            type="INVITE_MEMBER",
            status="COMPLETED",
            payload={"emails": ["quatask@example.com"]},
        )
        db.add(item)
        db.flush()
        db.add(
            AuditLog(
                timestamp=_OLD,
                actor_type="EXTENSION",
                action="TEST_SEARCH_QUA_QUEUE_ID",
                result="SUCCESS",
                data={"queue_item_id": str(item.id)},
            )
        )
        db.commit()

    assert "TEST_SEARCH_QUA_QUEUE_ID" in _actions(
        _search(client, auth_header, "quatask@example.com")
    )


def test_ky_tu_dai_dien_la_ky_tu_thuong(client: TestClient, auth_header: dict) -> None:
    """Gõ "%" phải là ký tự thường. Nếu để nguyên cho LIKE thì "%" khớp MỌI dòng —
    tìm một cái ra cả nhật ký, vô dụng y như không tìm."""
    co_pct = f"TEST_SEARCH_CO_PCT_{uuid4().hex[:8].upper()}"
    khong_pct = f"TEST_SEARCH_KHONG_PCT_{uuid4().hex[:8].upper()}"
    with SessionLocal() as db:
        db.add(
            AuditLog(
                timestamp=_OLD,
                actor_type="SYSTEM",
                action=co_pct,
                result="SUCCESS",
                data={"note": "giam 50% phi"},
            )
        )
        db.add(
            AuditLog(
                timestamp=_OLD,
                actor_type="SYSTEM",
                action=khong_pct,
                result="SUCCESS",
                data={"note": "khong co dau phan tram"},
            )
        )
        db.commit()

    hits = _actions(_search(client, auth_header, "%"))
    assert co_pct in hits
    assert khong_pct not in hits
