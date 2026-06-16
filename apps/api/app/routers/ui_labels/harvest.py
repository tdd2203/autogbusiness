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

from fastapi import Depends, status
from sqlalchemy import select
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


@router.get("/bundle", response_model=UiLabelBundleOut)
def extension_bundle(
    workspace: Workspace = Depends(require_extension_workspace),
    db: Session = Depends(get_session),
) -> UiLabelBundleOut:
    """Extension fetch endpoint — trả toàn bộ label (3 locale × 4 page) đã có."""
    rows = list(db.execute(select(UiLabel)).scalars())
    nested: dict[str, dict[str, dict[str, dict]]] = defaultdict(lambda: defaultdict(dict))
    max_version = 0
    latest_at = datetime.fromtimestamp(0, tz=timezone.utc)
    for r in rows:
        nested[r.locale][r.page][r.control_key] = {
            "label_text": r.label_text,
            "aria_label": r.aria_label,
            "notes": r.notes,
            "version": r.version,
            "stale": r.stale,
        }
        if r.version > max_version:
            max_version = r.version
        if r.updated_at and r.updated_at > latest_at:
            latest_at = r.updated_at
    bundle_version = max_version * 1000 + len(rows)
    _ = workspace
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
