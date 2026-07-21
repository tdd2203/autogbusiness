"""US2 — An toàn đồng thời khi trừ phí. Phủ SC-004 (số dư không âm/không sai).

Hai thao tác trừ phí song song trên cùng ví chỉ đủ 1 lần → đúng 1 thành công, 1
thất bại; số dư không bao giờ âm. Dựa trên khoá dòng ví (SELECT ... FOR UPDATE) +
Postgres thật (test DB).
"""

import concurrent.futures
import threading
from uuid import UUID, uuid4

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import User
from app.services import wallet_service
from app.services.wallet_service import InsufficientBalance
from tests.wallet_helpers import make_beta_sub, wallet_of

FEE = 100_000


def test_concurrent_charge_no_double_spend(client: TestClient, auth_header: dict) -> None:
    # Ví có ĐÚNG 1 suất phí.
    sub = make_beta_sub(client, auth_header, username="racer", balance=FEE)
    user_id = UUID(sub["id"])

    barrier = threading.Barrier(2)
    results: list[str] = []
    lock = threading.Lock()

    def worker() -> None:
        barrier.wait()  # đồng loạt xuất phát để tạo tranh chấp
        db = SessionLocal()
        try:
            user = db.get(User, user_id)
            wallet_service.charge_invite(db, user, uuid4(), [("x@example.com", FEE)])
            db.commit()
            outcome = "ok"
        except InsufficientBalance:
            db.rollback()
            outcome = "insufficient"
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            outcome = f"error:{exc}"
        finally:
            db.close()
        with lock:
            results.append(outcome)

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        for fut in [ex.submit(worker) for _ in range(2)]:
            fut.result()

    # Đúng 1 thành công, 1 bị chặn thiếu số dư — không có lỗi khác.
    assert sorted(results) == ["insufficient", "ok"], results
    # Số dư cuối = 0, không âm.
    assert wallet_of(client, sub["token"])["balance"] == 0
