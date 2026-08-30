"""Sổ thời gian của một lệnh — `queue/timing.py`.

Đây là dữ liệu để đi tối ưu tốc độ chạy về sau, nên phép trừ mốc phải khoá bằng
test: sai một nhịp là mọi kết luận "khâu nào chậm" đều lệch.
"""

from datetime import datetime, timedelta, timezone

from app.routers.queue.timing import summarize_timing


def _at(sec: int) -> datetime:
    return datetime(2026, 8, 30, 11, 28, 11, tzinfo=timezone.utc) + timedelta(seconds=sec)


def _iso(sec: int) -> str:
    return _at(sec).isoformat()


def test_phases_tinh_toi_moc_ke_va_moc_cuoi_toi_completed_at():
    progress = {
        "history": [
            {"phase": "seat-check", "at": _iso(1)},
            {"phase": "verifying", "at": _iso(37)},
            {"phase": "submit-done", "at": _iso(120)},
        ]
    }
    out = summarize_timing(progress, _at(0), _at(0), _at(603))
    assert out is not None
    assert out["phases"] == [
        {"phase": "seat-check", "ms": 36_000},
        {"phase": "verifying", "ms": 83_000},
        {"phase": "submit-done", "ms": 483_000},
    ]
    # Giai đoạn cuối dài bất thường chính là chỗ cần sửa — phải nổi lên `slowest`.
    assert out["slowest"] == "submit-done"
    assert out["total_ms"] == 603_000


def test_cho_hang_doi_va_chay_that_tach_bach():
    out = summarize_timing({}, _at(0), _at(12), _at(100))
    assert out == {
        "wait_ms": 12_000,
        "run_ms": 88_000,
        "total_ms": 100_000,
        "phases": [],
        "slowest": None,
    }


def test_chua_ket_thuc_thi_khong_chot_so():
    assert summarize_timing({"history": []}, _at(0), _at(1), None) is None


def test_moc_hong_khong_lam_vo_ca_so():
    progress = {"history": [{"phase": "x", "at": "khong-phai-ngay"}, "rac", {"at": _iso(5)}]}
    out = summarize_timing(progress, None, None, _at(10))
    assert out is not None
    assert out["phases"] == []
    assert out["wait_ms"] is None and out["run_ms"] is None and out["total_ms"] is None
