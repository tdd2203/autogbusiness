"""Chốt SỔ THỜI GIAN của một lệnh ngay lúc nó về trạng thái cuối.

VÌ SAO CÓ FILE NÀY (user 30/8/2026): *"lưu lại timeline thời gian chạy này để sau
này dựa vào đó cải tiến thời gian chạy và sửa quy trình mời cho chuẩn xác"*.

Dữ liệu thô đã có sẵn: `queue_items.progress.history` là danh sách mốc
`{phase, at}` mà extension bơm về mỗi khi đổi giai đoạn (xem
`execution._merge_progress_history`). Nhưng đó là dữ liệu THÔ — muốn trả lời
"lệnh mời tháng này chậm ở khâu nào" thì phải tự trừ từng cặp mốc trong mọi hàng,
mỗi lần muốn xem lại. Ở đây chốt sẵn MỘT lần, ngay lúc lệnh kết thúc, vào
`progress.timing`:

    {"wait_ms":  chờ trong hàng đợi (created_at → picked_at),
     "run_ms":   chạy thật (picked_at → completed_at),
     "total_ms": tổng (created_at → completed_at),
     "phases":   [{"phase": "seat-check", "ms": 36000}, ...] theo đúng thứ tự chạy,
     "slowest":  tên giai đoạn tốn nhiều thời gian nhất}

Không thêm cột DB (nằm trong JSONB `progress`) nên không cần migration, và truy
vấn về sau chỉ là một phép đọc:

    select type, (progress->'timing'->>'run_ms')::bigint as run_ms,
           progress->'timing'->>'slowest' as slowest
    from queue_items where progress ? 'timing' order by run_ms desc;

Mốc cuối của `history` KHÔNG có mốc kế để trừ, nên nó tính tới `completed_at` —
đúng cách dashboard đang vẽ (xem `TaskTimingCell`). Lệnh chết im (TIMEOUT) vì thế
để lại một giai đoạn cuối dài bất thường: đó chính là chỗ cần sửa, không phải
nhiễu — ca `0d191682` ngày 30/8/2026 để lại `submit-done` 483s.
"""

from __future__ import annotations

from datetime import datetime, timezone


def _parse(raw: object) -> datetime | None:
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)
    if not isinstance(raw, str) or not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _ms(start: datetime | None, end: datetime | None) -> int | None:
    if start is None or end is None:
        return None
    delta = int((end - start).total_seconds() * 1000)
    return delta if delta >= 0 else None


def summarize_timing(
    progress: dict | None,
    created_at: datetime | None,
    picked_at: datetime | None,
    completed_at: datetime | None,
) -> dict | None:
    """Sổ thời gian của lệnh, hoặc None khi không đủ mốc để nói gì.

    Thuần dữ liệu (không chạm DB/ORM) để test được bằng dict.
    """
    created = _parse(created_at)
    picked = _parse(picked_at)
    done = _parse(completed_at)
    if done is None:
        return None

    phases: list[dict] = []
    history = list((progress or {}).get("history") or [])
    marks: list[tuple[str, datetime]] = []
    for entry in history:
        if not isinstance(entry, dict):
            continue
        name = entry.get("phase")
        at = _parse(entry.get("at"))
        if name and at is not None:
            marks.append((str(name), at))
    for idx, (name, at) in enumerate(marks):
        end = marks[idx + 1][1] if idx + 1 < len(marks) else done
        ms = _ms(at, end)
        if ms is not None:
            phases.append({"phase": name, "ms": ms})

    slowest = max(phases, key=lambda p: p["ms"])["phase"] if phases else None
    return {
        "wait_ms": _ms(created, picked),
        "run_ms": _ms(picked, done),
        "total_ms": _ms(created, done),
        "phases": phases,
        "slowest": slowest,
    }


def stamp_task_timing(item) -> None:
    """Ghi `progress.timing` cho một `QueueItem` vừa về trạng thái cuối.

    Gọi SAU khi đã đặt `completed_at`. Im lặng bỏ qua khi chưa đủ mốc — sổ thời
    gian là dữ liệu để cải tiến, không phải thứ được phép làm hỏng một lệnh.
    """
    try:
        summary = summarize_timing(
            item.progress, item.created_at, item.picked_at, item.completed_at
        )
    except Exception:  # pragma: no cover - phòng dữ liệu progress lạ
        return
    if summary is None:
        return
    item.progress = {**(item.progress or {}), "timing": summary}
