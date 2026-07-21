"""Chức năng: HARVEST / BUNDLE / MISMATCH — API cho EXTENSION.

⚠️ ĐỌC `harvest.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
Docs ghi lịch sử lỗi, business rule và ý tưởng cải tiến — code chỉ là "how".

Auth qua `require_extension_workspace` (X-API-KEY của extension) thay vì
super-admin Bearer — vì extension không có Bearer token của dashboard.

Endpoints (đăng ký lên router dùng chung từ `_shared`):
  - GET  /bundle           → extension_bundle (extension fetch toàn bộ label)
  - POST /harvest          → auto_harvest (extension bulk upsert nhiều page)
  - POST /report-mismatch  → report_mismatch (extension báo label stale)
"""

from collections import defaultdict
from datetime import datetime, timezone

from fastapi import Depends, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_session, require_extension_workspace
from app.models import UiLabel, Workspace
from app.schemas import (
    UiLabelBundleOut,
    UiLabelHarvestIn,
    UiLabelHarvestOut,
    UiLabelReportIn,
)

from ._shared import router, _push_history


def _bundle_version(max_version: int, row_count: int) -> int:
    """Công thức version của bundle — CHỈ ĐỊNH NGHĨA MỘT NƠI.

    `max(version)` bắt đổi nội dung (mỗi upsert bump version), `count` bắt
    thêm/bớt row. Dùng chung cho cả probe rẻ (MAX+COUNT) lẫn khi build đầy đủ,
    để ETag khớp CHÍNH XÁC giá trị `version` trả trong body.
    """
    return int(max_version) * 1000 + int(row_count)


def _match_etag(if_none_match: str | None, etag: str) -> bool:
    """So If-None-Match với ETag hiện tại theo weak comparison (RFC 7232).

    Xử lý: `*` (khớp mọi resource đang tồn tại), danh sách nhiều tag ngăn cách
    dấu phẩy, và tiền tố `W/` của weak ETag.
    """
    if not if_none_match:
        return False
    if if_none_match.strip() == "*":
        return True
    wanted = etag.removeprefix("W/")
    for tag in if_none_match.split(","):
        if tag.strip().removeprefix("W/") == wanted:
            return True
    return False


@router.get("/bundle", response_model=UiLabelBundleOut)
def extension_bundle(
    request: Request,
    response: Response,
    workspace: Workspace = Depends(require_extension_workspace),
    db: Session = Depends(get_session),
) -> UiLabelBundleOut | Response:
    """Extension fetch endpoint — trả toàn bộ label (3 locale × 4 page) đã có.

    Hỗ trợ ETag / conditional GET: extension poll bundle định kỳ nhưng label gần
    như tĩnh (chỉ đổi khi admin harvest/calibrate). Trước tiên chạy 1 probe RẺ
    (MAX(version) + COUNT) tái tạo CHÍNH XÁC `version` mà KHÔNG nạp toàn bảng; nếu
    khớp `If-None-Match` của client → trả 304 (không body, không nạp bảng). Chỉ khi
    version đổi mới nạp full + build dict. HTTP cache của browser/SW tự gửi
    `If-None-Match` nên không cần đổi code extension.
    """
    _ = workspace

    # Probe rẻ: aggregate 1 dòng thay vì nạp toàn bảng.
    max_version, row_count = db.execute(
        select(
            func.coalesce(func.max(UiLabel.version), 0),
            func.count(UiLabel.id),
        )
    ).one()
    bundle_version = _bundle_version(max_version, row_count)
    etag = f'"ui-labels-v{bundle_version}"'
    # no-cache = client PHẢI revalidate qua ETag mỗi lần (không tự phục vụ cache mù),
    # nhưng khi 304 thì server không nạp bảng — vừa tươi vừa rẻ.
    response.headers["Cache-Control"] = "no-cache"
    response.headers["ETag"] = etag

    if _match_etag(request.headers.get("if-none-match"), etag):
        return Response(
            status_code=status.HTTP_304_NOT_MODIFIED,
            headers={"ETag": etag, "Cache-Control": "no-cache"},
        )

    rows = list(db.execute(select(UiLabel)).scalars())
    nested: dict[str, dict[str, dict[str, dict]]] = defaultdict(lambda: defaultdict(dict))
    latest_at = datetime.fromtimestamp(0, tz=timezone.utc)
    for r in rows:
        nested[r.locale][r.page][r.control_key] = {
            "label_text": r.label_text,
            "aria_label": r.aria_label,
            "notes": r.notes,
            "version": r.version,
            "stale": r.stale,
        }
        if r.updated_at and r.updated_at > latest_at:
            latest_at = r.updated_at
    return UiLabelBundleOut(
        version=bundle_version,
        generated_at=latest_at if rows else datetime.now(timezone.utc),
        labels={k: dict(v) for k, v in nested.items()},
    )


@router.post("/harvest", response_model=UiLabelHarvestOut)
def auto_harvest(
    body: UiLabelHarvestIn,
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> UiLabelHarvestOut:
    """Extension đã auto-crawl DOM trên chatgpt.com → bulk upsert nhiều page.

    Auth qua X-API-KEY (extension) thay vì super-admin Bearer, vì extension
    không có Bearer token của dashboard.
    """
    counts: dict[str, int] = {}
    total = 0
    for page_block in body.pages:
        changed = 0
        for item in page_block.labels:
            if not (item.label_text or "").strip() and not (item.aria_label or "").strip():
                continue
            existing = db.execute(
                select(UiLabel).where(
                    UiLabel.locale == body.locale,
                    UiLabel.page == page_block.page,
                    UiLabel.control_key == item.control_key,
                )
            ).scalar_one_or_none()
            new_text = (item.label_text or "").strip() or None
            new_aria = (item.aria_label or "").strip() or None
            new_notes = item.notes or None
            if existing is None:
                row = UiLabel(
                    locale=body.locale,
                    page=page_block.page,
                    control_key=item.control_key,
                    label_text=new_text,
                    aria_label=new_aria,
                    notes=new_notes,
                    stale=False,
                    stale_count=0,
                    version=1,
                )
                db.add(row)
                db.flush()
                changed += 1
                continue
            if (
                existing.label_text == new_text
                and existing.aria_label == new_aria
                and not existing.stale
            ):
                continue
            _push_history(db, existing, None)
            existing.label_text = new_text
            existing.aria_label = new_aria
            if new_notes is not None:
                existing.notes = new_notes
            existing.stale = False
            existing.stale_reason = None
            existing.version = existing.version + 1
            db.add(existing)
            changed += 1
        counts[page_block.page] = changed
        total += changed
    if total > 0:
        log_event(
            db,
            actor_type="EXTENSION",
            actor_label=f"workspace:{workspace.name}",
            action="UI_LABELS_AUTO_HARVESTED",
            result="SUCCESS",
            target_type="UI_LABEL",
            data={"locale": body.locale, "counts": counts, "total": total},
            commit=False,
        )
    db.commit()
    return UiLabelHarvestOut(locale=body.locale, pages=counts, total=total)


@router.post("/report-mismatch", status_code=status.HTTP_202_ACCEPTED)
def report_mismatch(
    body: UiLabelReportIn,
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> dict:
    """Extension báo: chạy action mà label DB không match DOM thực tế."""
    row = db.execute(
        select(UiLabel).where(
            UiLabel.locale == body.locale,
            UiLabel.page == body.page,
            UiLabel.control_key == body.control_key,
        )
    ).scalar_one_or_none()
    if row is None:
        row = UiLabel(
            locale=body.locale,
            page=body.page,
            control_key=body.control_key,
            label_text=None,
            stale=True,
            stale_reason=(body.dom_sample or "")[:1000],
            stale_count=1,
            version=1,
        )
        db.add(row)
        db.flush()
    else:
        row.stale = True
        row.stale_reason = (body.dom_sample or body.expected or "")[:1000]
        row.stale_count = (row.stale_count or 0) + 1
        db.add(row)

    log_event(
        db,
        actor_type="EXTENSION",
        actor_label=f"workspace:{workspace.name}",
        action="UI_LABEL_MISMATCH_REPORTED",
        result="FAILED",
        target_type="UI_LABEL",
        target_id=str(row.id),
        data={
            "locale": body.locale,
            "page": body.page,
            "control_key": body.control_key,
            "expected": body.expected,
        },
        commit=False,
    )
    db.commit()
    return {"label_id": str(row.id), "stale_count": row.stale_count}
