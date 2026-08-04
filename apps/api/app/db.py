from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


_settings = get_settings()
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
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
