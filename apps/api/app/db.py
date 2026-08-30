from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


_settings = get_settings()


def _timeout_options() -> dict[str, str]:
    """Trần thời gian đặt NGAY LÚC MỞ KẾT NỐI, áp cho mọi câu SQL của API.

    Postgres mặc định chờ VÔ HẠN: một câu chạy loạn, hay một transaction bị bỏ quên
    đang giữ khoá, sẽ ghim luôn mọi request đụng cùng hàng — pool 15 kết nối cạn
    trong tích tắc và dashboard chỉ thấy màn hình quay mãi không hiện gì
    (đúng lớp sự cố `idle in transaction` 21/8/2026). Có hạn giờ thì câu hỏng chết
    một mình và client nhận được lỗi để báo ra màn hình.

    Đặt qua `connect_args` chứ KHÔNG đặt trên role trong Postgres: alembic dựng
    engine riêng (`alembic/env.py`) nên migration — thứ có quyền chạy lâu và có
    quyền ôm khoá nặng — không dính hạn này.
    """
    parts = []
    if _settings.db_statement_timeout_ms > 0:
        parts.append(f"-c statement_timeout={_settings.db_statement_timeout_ms}")
    if _settings.db_lock_timeout_ms > 0:
        parts.append(f"-c lock_timeout={_settings.db_lock_timeout_ms}")
    return {"options": " ".join(parts)} if parts else {}


# Pool khai báo TƯỜNG MINH (tối ưu RAM 2026-08-04). Trước đây dùng mặc định của
# SQLAlchemy (5 + 10) — con số giống hệt, nhưng viết ra để (a) chỉnh được qua
# .env mà không sửa code, (b) buộc phải đối chiếu với `max_connections` của
# Postgres trong docker-compose.yml, (c) thêm pool_recycle (mặc định là -1 =
# không bao giờ tái tạo → kết nối chết sau khi tunnel/DB restart vẫn nằm trong
# pool cho tới lần pre_ping kế tiếp).
engine = create_engine(
    _settings.database_url,
    pool_pre_ping=True,
    future=True,
    pool_size=_settings.db_pool_size,
    max_overflow=_settings.db_max_overflow,
    pool_recycle=_settings.db_pool_recycle_sec,
    connect_args=_timeout_options(),
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
