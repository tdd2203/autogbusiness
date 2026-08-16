"""Canh id revision alembic — dài quá là DB MỚI không dựng nổi.

Vì sao có test này (sự cố 2026-08-16): revision "0025_member_subscription_purchased_at"
dài 37 ký tự, trong khi alembic tự tạo bảng `alembic_version` với cột
`version_num VARCHAR(32)`. DB đang chạy không hề hấn gì (bảng của nó dựng từ đời
alembic cũ nên rộng 128) → lỗi ẩn hoàn toàn cho tới lúc dựng DB mới: `alembic
upgrade head` chết giữa chừng, postgres rollback cả transaction DDL, để lại DB
RỖNG và API sập lúc seed với thông báo lạc đề "relation users does not exist".

Bộ test còn lại KHÔNG bắt được lỗi này vì conftest dựng schema bằng
`Base.metadata.create_all`, không đi qua alembic.
"""

import re
from pathlib import Path

import pytest

# Độ dài cột `alembic_version.version_num` do alembic tạo ra (ddl/impl.py:
# Column("version_num", String(32))). Không sửa được qua alembic.ini.
VERSION_NUM_MAX_LEN = 32

VERSIONS_DIR = Path(__file__).resolve().parent.parent / "alembic" / "versions"
_REVISION_RE = re.compile(r"^revision(?::\s*str)?\s*=\s*[\"']([^\"']+)[\"']", re.M)
_DOWN_REVISION_RE = re.compile(
    r"^down_revision(?::\s*[^=]+)?=\s*[\"']([^\"']+)[\"']", re.M
)


def _migration_files() -> list[Path]:
    files = sorted(p for p in VERSIONS_DIR.glob("*.py") if p.name != "__init__.py")
    assert files, f"Không thấy file migration nào trong {VERSIONS_DIR}"
    return files


@pytest.mark.parametrize("path", _migration_files(), ids=lambda p: p.name)
def test_revision_id_khong_qua_32_ky_tu(path: Path) -> None:
    m = _REVISION_RE.search(path.read_text(encoding="utf-8"))
    assert m, f"{path.name}: không tìm thấy dòng `revision = ...`"
    rev = m.group(1)
    assert len(rev) <= VERSION_NUM_MAX_LEN, (
        f"{path.name}: id revision {rev!r} dài {len(rev)} ký tự > "
        f"{VERSION_NUM_MAX_LEN} → DB mới sẽ chết ở `alembic upgrade head`. Đặt tên ngắn lại."
    )


def test_chuoi_revision_lien_mach() -> None:
    """Mọi `down_revision` phải trỏ tới một revision CÓ THẬT (đổi tên hụt là gãy chuỗi)."""
    revisions: set[str] = set()
    downs: dict[str, str] = {}
    for path in _migration_files():
        text = path.read_text(encoding="utf-8")
        m = _REVISION_RE.search(text)
        assert m, f"{path.name}: không tìm thấy dòng `revision = ...`"
        revisions.add(m.group(1))
        d = _DOWN_REVISION_RE.search(text)
        if d:
            downs[path.name] = d.group(1)

    for name, down in downs.items():
        assert down in revisions, (
            f"{name}: down_revision {down!r} không khớp revision nào — chuỗi migration gãy."
        )
