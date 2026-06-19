"""Test timeline phase trong progress (update_progress → _merge_progress_history).

Đảm bảo dashboard có dữ liệu THỜI LƯỢNG từng giai đoạn (admin tối ưu tốc độ):
chỉ append mốc khi `phase` ĐỔI, giữ snapshot mới, và cap history.
"""

from app.routers.queue.execution import _MAX_PHASE_HISTORY, _merge_progress_history


def test_first_tick_seeds_history():
    out = _merge_progress_history(None, {"phase": "queued", "message": "x"})
    assert out["message"] == "x"  # snapshot giữ nguyên
    assert len(out["history"]) == 1
    assert out["history"][0]["phase"] == "queued"
    assert "at" in out["history"][0]


def test_same_phase_does_not_duplicate():
    p1 = _merge_progress_history(None, {"phase": "scraping", "current": 1})
    p2 = _merge_progress_history(p1, {"phase": "scraping", "current": 50})
    # Cùng phase → KHÔNG thêm mốc, nhưng snapshot (current) cập nhật.
    assert len(p2["history"]) == 1
    assert p2["current"] == 50


def test_phase_change_appends_mark():
    p1 = _merge_progress_history(None, {"phase": "queued"})
    p2 = _merge_progress_history(p1, {"phase": "typing-email"})
    p3 = _merge_progress_history(p2, {"phase": "verifying"})
    assert [h["phase"] for h in p3["history"]] == [
        "queued",
        "typing-email",
        "verifying",
    ]


def test_missing_phase_keeps_history_untouched():
    p1 = _merge_progress_history(None, {"phase": "queued"})
    p2 = _merge_progress_history(p1, {"message": "no phase here"})
    assert len(p2["history"]) == 1
    assert p2["message"] == "no phase here"


def test_history_capped():
    prog = None
    for i in range(_MAX_PHASE_HISTORY + 20):
        prog = _merge_progress_history(prog, {"phase": f"phase-{i}"})
    assert len(prog["history"]) == _MAX_PHASE_HISTORY
    # Giữ các mốc MỚI nhất (cắt đầu).
    assert prog["history"][-1]["phase"] == f"phase-{_MAX_PHASE_HISTORY + 19}"
