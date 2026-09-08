"""Chạy THẬT `alembic upgrade head` trên một DB trắng, rồi soi lại schema.

VÌ SAO CẦN FILE NÀY: `conftest.py` dựng schema bằng `Base.metadata.create_all`, tức
mọi test còn lại chỉ chứng minh CODE đúng với `models.py`. Không một test nào chạy
qua thư mục `alembic/versions/`. Nghĩa là một cột khai trong `models.py` mà quên
thêm vào migration, hay một câu SQL hỏng trong `upgrade()`, sẽ đi qua toàn bộ suite
màu xanh rồi mới nổ lúc deploy — mà lúc đó API `alembic upgrade head` ngay trong
lifespan, hỏng là cả stack không lên được.

Ba thứ file này khoá:

1. `alembic upgrade head` chạy hết được trên DB trắng (bắt SQL hỏng, chuỗi gãy,
   migration tham chiếu cột chưa tồn tại).
2. Schema do MIGRATION dựng ra khớp schema do `models.py` khai — cùng tập bảng,
   cùng tập cột. Đây là chốt bắt "sửa models mà quên viết migration", loại lỗi
   không có cách nào tự lộ ra.
3. Các ràng buộc CHECK khai trong `models.py` đều có mặt thật sau khi migrate.
   Ràng buộc chỉ nằm trong `__table_args__` mà thiếu ở migration thì trên máy dev
   (dựng bằng `create_all`) nó có, còn trên production thì không — dữ liệu bẩn lọt
   qua đúng ở nơi không ai kiểm.

Chạy alembic bằng TIẾN TRÌNH RIÊNG chứ không gọi API của nó trong process: `env.py`
đọc `get_settings().database_url`, mà `get_settings` có `lru_cache` nên đổi biến môi
trường trong process này không ăn thua. Tiến trình riêng còn đi đúng con đường mà
deploy thật đi.

Test cần Postgres. Không có thì tự bỏ qua (`skip`), không làm đỏ suite trên máy
đang tắt Docker — nhưng nhớ là bỏ qua thì KHÔNG có gì khoá cả ba điều trên.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from app.db import Base

API_ROOT = Path(__file__).resolve().parent.parent

# DB riêng cho migration: KHÔNG dùng chung `autogpt_test` của `conftest`, vì fixture
# ở đó drop/create toàn bộ bảng theo `models.py` — hai bên giẫm lên nhau thì test này
# đo nhầm schema của bên kia.
SCRATCH_SUFFIX = "_alembic_check"


def _base_url():
    """URL của server Postgres đang dùng, hoặc None nếu không nối được."""
    raw = os.environ.get("DATABASE_URL")
    if not raw:
        return None
    try:
        url = make_url(raw)
    except Exception:
        return None
    try:
        eng = create_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
        with eng.connect():
            pass
        eng.dispose()
    except Exception:
        return None
    return url


@pytest.fixture(scope="module")
def scratch_url():
    url = _base_url()
    if url is None:
        pytest.skip("Không nối được Postgres — bỏ qua kiểm tra migration")
    name = (url.database or "autogpt") + SCRATCH_SUFFIX
    admin = create_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    try:
        yield url.set(database=name)
    finally:
        with admin.connect() as conn:
            # Ngắt mọi phiên còn bám vào DB nháp, không thì DROP treo.
            conn.execute(
                text(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = :n AND pid <> pg_backend_pid()"
                ),
                {"n": name},
            )
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
        admin.dispose()


def _alembic(args: list[str], url) -> subprocess.CompletedProcess:
    env = {**os.environ, "DATABASE_URL": url.render_as_string(hide_password=False)}
    return subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=API_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
    )


def test_upgrade_head_chay_duoc_tren_db_trang(scratch_url):
    """Cả chuỗi migration chạy hết từ DB rỗng."""
    r = _alembic(["upgrade", "head"], scratch_url)
    assert r.returncode == 0, f"alembic upgrade head hỏng:\n{r.stdout}\n{r.stderr}"


def test_migration_dung_du_bang_va_cot_nhu_models(scratch_url):
    """Schema do migration dựng phải KHỚP `models.py` — cùng bảng, cùng cột.

    Lệch nghĩa là có người sửa `models.py` mà quên viết migration (hoặc ngược lại).
    Trên máy dev không ai thấy vì `create_all` đọc thẳng `models.py`; chỉ production
    mới thiếu cột, và thiếu cột thì API gãy ngay cú truy vấn đầu tiên.
    """
    assert _alembic(["upgrade", "head"], scratch_url).returncode == 0

    eng = create_engine(scratch_url)
    try:
        insp = inspect(eng)
        thuc_te = set(insp.get_table_names())
        khai_bao = set(Base.metadata.tables)
        thieu = sorted(khai_bao - thuc_te - {"alembic_version"})
        assert not thieu, f"Bảng khai trong models.py mà migration không tạo: {thieu}"

        lech: dict[str, dict[str, list[str]]] = {}
        for ten in sorted(khai_bao & thuc_te):
            cot_db = {c["name"] for c in insp.get_columns(ten)}
            cot_model = set(Base.metadata.tables[ten].columns.keys())
            thieu_o_db = sorted(cot_model - cot_db)
            thua_o_db = sorted(cot_db - cot_model)
            if thieu_o_db or thua_o_db:
                lech[ten] = {"thiếu_ở_DB": thieu_o_db, "thừa_ở_DB": thua_o_db}
        assert not lech, f"Cột lệch giữa migration và models.py: {lech}"
    finally:
        eng.dispose()


def test_rang_buoc_check_khai_trong_models_deu_co_that(scratch_url):
    """Mọi CheckConstraint CÓ TÊN trong `models.py` phải tồn tại sau khi migrate.

    Ràng buộc chỉ khai ở `__table_args__` mà quên thêm vào migration là ca hiểm:
    máy dev có nó (create_all), production không — nên dữ liệu sai chỉ bẩn ở đúng
    nơi không ai soi. Chỉ so ràng buộc CÓ TÊN; loại không tên thì Postgres tự đặt,
    không đối chiếu được.
    """
    from sqlalchemy import CheckConstraint

    assert _alembic(["upgrade", "head"], scratch_url).returncode == 0

    eng = create_engine(scratch_url)
    try:
        insp = inspect(eng)
        thieu: list[str] = []
        for ten_bang, bang in Base.metadata.tables.items():
            if ten_bang not in set(insp.get_table_names()):
                continue
            co_that = {
                c["name"] for c in insp.get_check_constraints(ten_bang) if c.get("name")
            }
            for rb in bang.constraints:
                if isinstance(rb, CheckConstraint) and rb.name:
                    if str(rb.name) not in co_that:
                        thieu.append(f"{ten_bang}.{rb.name}")
        assert not thieu, (
            "CheckConstraint khai trong models.py mà migration không tạo: "
            + ", ".join(sorted(thieu))
        )
    finally:
        eng.dispose()
