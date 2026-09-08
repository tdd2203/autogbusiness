"""Canh chuỗi migration chỉ có ĐÚNG MỘT head — hai head là deploy chết.

Vì sao có test này: số hiệu file trong `alembic/versions/` KHÔNG phải thứ tự chạy, thứ
tự thật nằm ở `down_revision`. Hiện chuỗi chạy là 0062 → 0064 → 0065 → 0066 → 0067 →
0063 (0063 thuộc một nhánh lên sau nên nó nối vào head lúc đó, đúng quy ước ghi trong
`0064_workspace_invite_member_cap.py`). Ai chỉ nhìn tên file rồi thêm 0068 nối vào
`0067` — lựa chọn hiển nhiên nhất — là tạo ra HAI head: `alembic upgrade head` báo
"Multiple head revisions are present" và dừng, deploy gãy giữa chừng.

Hỏng kiểu này không lộ ra ở bộ test còn lại: conftest dựng schema bằng
`Base.metadata.create_all`, không đi qua alembic bao giờ. Chỉ tới lúc chạy trên máy
thật mới biết. Test này thuần đọc file, không cần DB.

`test_alembic_revisions.py` canh việc khác (độ dài id, `down_revision` trỏ vào chỗ có
thật) — nó vẫn xanh khi có hai head, nên hai file phải cùng tồn tại.
"""

import re
from collections import defaultdict
from pathlib import Path

VERSIONS_DIR = Path(__file__).resolve().parent.parent / "alembic" / "versions"
_REVISION_RE = re.compile(r"^revision(?::\s*str)?\s*=\s*[\"']([^\"']+)[\"']", re.M)
_DOWN_REVISION_RE = re.compile(
    r"^down_revision(?::\s*[^=]+)?=\s*[\"']([^\"']+)[\"']", re.M
)


def _chain() -> tuple[dict[str, str], dict[str, str | None]]:
    """`({revision: tên file}, {revision: down_revision})` của mọi migration.

    `down_revision = None` (file gốc) không khớp regex nên vào map với giá trị None —
    phân biệt được với "trỏ vào một revision khác".
    """
    owner: dict[str, str] = {}
    downs: dict[str, str | None] = {}
    trung: dict[str, list[str]] = defaultdict(list)

    files = sorted(p for p in VERSIONS_DIR.glob("*.py") if p.name != "__init__.py")
    assert files, f"Không thấy file migration nào trong {VERSIONS_DIR}"

    for path in files:
        text = path.read_text(encoding="utf-8")
        m = _REVISION_RE.search(text)
        assert m, f"{path.name}: không tìm thấy dòng `revision = ...`"
        rev = m.group(1)
        trung[rev].append(path.name)
        owner[rev] = path.name
        d = _DOWN_REVISION_RE.search(text)
        downs[rev] = d.group(1) if d else None

    lap = {rev: names for rev, names in trung.items() if len(names) > 1}
    assert not lap, (
        "Có id revision bị TRÙNG giữa các file: "
        + "; ".join(f"{rev!r} ở {', '.join(names)}" for rev, names in lap.items())
        + ". Alembic ghi một dòng duy nhất vào `alembic_version` nên bản chạy sau ghi "
        "đè bản trước, chuỗi mất một mắt xích mà không báo gì."
    )
    return owner, downs


def test_chi_co_mot_head() -> None:
    """Không revision nào được có HAI file cùng nối vào, và cả chuỗi chỉ một ngọn."""
    owner, downs = _chain()

    # Hai file cùng `down_revision` = chỗ chuỗi tách đôi. Bắt ở đây để thông báo chỉ
    # đúng hai thủ phạm, thay vì liệt kê cả rừng head ở cuối mỗi nhánh.
    con: dict[str, list[str]] = defaultdict(list)
    for rev, down in downs.items():
        if down is not None:
            con[down].append(owner[rev])
    tach = {down: names for down, names in con.items() if len(names) > 1}
    assert not tach, (
        "Chuỗi migration TÁCH ĐÔI: "
        + "; ".join(
            f"{', '.join(sorted(names))} cùng nối vào {down!r}"
            for down, names in tach.items()
        )
        + ". Sửa bằng cách trỏ `down_revision` của bản lên SAU vào bản lên TRƯỚC "
        "(nối tiếp), đừng để cả hai cùng nối vào một mắt xích."
    )

    duoc_noi = {down for down in downs.values() if down is not None}
    heads = sorted(rev for rev in owner if rev not in duoc_noi)
    assert len(heads) == 1, (
        "Phải có ĐÚNG MỘT head, đang thấy "
        f"{len(heads)}: {', '.join(f'{r} ({owner[r]})' for r in heads)}. "
        "`alembic upgrade head` sẽ báo 'Multiple head revisions are present' và "
        "dừng, deploy gãy. Bản mới nhất phải nối vào head hiện tại — head là bản "
        "KHÔNG có ai trỏ vào, không phải bản có số hiệu file lớn nhất."
    )


def test_chi_co_mot_goc_va_khong_vong_lap() -> None:
    """Đi ngược từ head phải chạm được MỌI migration rồi dừng ở gốc."""
    owner, downs = _chain()

    goc = sorted(rev for rev, down in downs.items() if down is None)
    assert len(goc) == 1, (
        "Phải có ĐÚNG MỘT migration gốc (`down_revision = None`), đang thấy "
        f"{len(goc)}: {', '.join(f'{r} ({owner[r]})' for r in goc)}. Nhiều gốc là "
        "nhiều nhánh rời, `alembic upgrade head` không biết chạy nhánh nào trước."
    )

    duoc_noi = {down for down in downs.values() if down is not None}
    # `None` thay vì để `next()` ném StopIteration: chuỗi bị nối thành vòng kín thì
    # KHÔNG có revision nào là head, và người đọc phải thấy câu báo vòng lặp đã soạn
    # sẵn ngay bên dưới chứ không phải một StopIteration trần.
    head = next((rev for rev in owner if rev not in duoc_noi), None)
    assert head is not None, (
        "Không tìm được head: mọi revision đều có người trỏ vào, tức chuỗi migration "
        "đã bị nối thành VÒNG KÍN."
    )

    tham: list[str] = []
    da_qua: set[str] = set()
    cur: str | None = head
    while cur is not None:
        assert cur not in da_qua, (
            f"Chuỗi migration có VÒNG LẶP tại {cur!r} ({owner.get(cur, '?')}) — "
            "alembic sẽ quay mãi không tới gốc."
        )
        da_qua.add(cur)
        tham.append(cur)
        cur = downs.get(cur)

    sot = sorted(set(owner) - da_qua)
    assert not sot, (
        "Có migration KHÔNG nằm trên chuỗi từ head về gốc, tức sẽ không bao giờ "
        "được chạy: " + ", ".join(f"{r} ({owner[r]})" for r in sot)
    )
    assert len(tham) == len(owner)
