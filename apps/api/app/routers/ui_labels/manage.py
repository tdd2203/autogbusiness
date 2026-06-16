"""Chức năng: QUẢN LÝ UI LABEL (admin calibration + versioning + view).

⚠️ ĐỌC `manage.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
Docs ghi lịch sử lỗi, business rule và ý tưởng cải tiến — code chỉ là "how".

Endpoints (đăng ký lên router dùng chung từ `_shared`) — tất cả yêu cầu
`Permission.UI_LABEL_MANAGE` (super-admin dashboard, không phải extension):
  - GET   ""                       → list_labels
  - GET   /coverage                → coverage
  - POST  /bulk                    → bulk_upsert
  - PATCH /{label_id}              → update_label
  - POST  /{label_id}/clear-stale  → clear_stale
  - GET   /{label_id}/history      → label_history
  - POST  /{label_id}/rollback/{version} → rollback_label
"""

from uuid import UUID

from fastapi import Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_session, require_permission
from app.models import UiLabel, UiLabelHistory, User
from app.permissions import Permission
from app.schemas import (
    UiLabelBulkIn,
    UiLabelCoverageCell,
    UiLabelCoverageOut,
    UiLabelHistoryOut,
    UiLabelOut,
    UiLabelUpdate,
)

from ._shared import (
    router,
    CONTROL_KEYS_BY_PAGE,
    LOCALES,
    PAGES,
    _push_history,
)


@router.get("", response_model=list[UiLabelOut])
def list_labels(
    locale: str | None = Query(default=None),
    page: str | None = Query(default=None),
    stale: bool | None = Query(default=None),
    db: Session = Depends(get_session),
    _: User = Depends(require_permission(Permission.UI_LABEL_MANAGE)),
) -> list[UiLabel]:
    stmt = select(UiLabel)
    if locale:
        stmt = stmt.where(UiLabel.locale == locale)
    if page:
        stmt = stmt.where(UiLabel.page == page)
    if stale is not None:
        stmt = stmt.where(UiLabel.stale.is_(stale))
    stmt = stmt.order_by(UiLabel.page, UiLabel.locale, UiLabel.control_key)
    return list(db.execute(stmt).scalars())


@router.get("/coverage", response_model=UiLabelCoverageOut)
def coverage(
    db: Session = Depends(get_session),
    _: User = Depends(require_permission(Permission.UI_LABEL_MANAGE)),
) -> UiLabelCoverageOut:
    rows = list(db.execute(select(UiLabel)).scalars())
    matrix: dict[str, dict[str, UiLabelCoverageCell]] = {}
    for page in PAGES:
        matrix[page] = {}
        expected_keys = CONTROL_KEYS_BY_PAGE.get(page, ())
        for locale in LOCALES:
            matching = [r for r in rows if r.page == page and r.locale == locale]
            filled = sum(1 for r in matching if (r.label_text or "").strip())
            stale = sum(1 for r in matching if r.stale)
            matrix[page][locale] = UiLabelCoverageCell(
                total=len(expected_keys),
                filled=min(filled, len(expected_keys)) if expected_keys else filled,
                stale=stale,
            )
    return UiLabelCoverageOut(
        pages=list(PAGES), locales=list(LOCALES), matrix=matrix
    )


@router.post("/bulk", response_model=list[UiLabelOut])
def bulk_upsert(
    body: UiLabelBulkIn,
    db: Session = Depends(get_session),
    actor: User = Depends(require_permission(Permission.UI_LABEL_MANAGE)),
) -> list[UiLabel]:
    out: list[UiLabel] = []
    changed_count = 0
    for item in body.labels:
        existing = db.execute(
            select(UiLabel).where(
                UiLabel.locale == body.locale,
                UiLabel.page == body.page,
                UiLabel.control_key == item.control_key,
            )
        ).scalar_one_or_none()

        if existing is None:
            row = UiLabel(
                locale=body.locale,
                page=body.page,
                control_key=item.control_key,
                label_text=(item.label_text or "").strip() or None,
                aria_label=(item.aria_label or "").strip() or None,
                notes={**(body.scrape_notes or {}), **(item.notes or {})} or None,
                stale=False,
                stale_count=0,
                version=1,
                updated_by_id=actor.id,
            )
            db.add(row)
            db.flush()
            out.append(row)
            changed_count += 1
            continue

        new_text = (item.label_text or "").strip() or None
        new_aria = (item.aria_label or "").strip() or None
        new_notes = (
            {**(existing.notes or {}), **(body.scrape_notes or {}), **(item.notes or {})}
            or None
        )
        if (
            new_text == existing.label_text
            and new_aria == existing.aria_label
            and new_notes == existing.notes
            and not existing.stale
        ):
            out.append(existing)
            continue

        _push_history(db, existing, actor.id)
        existing.label_text = new_text
        existing.aria_label = new_aria
        existing.notes = new_notes
        existing.stale = False
        existing.stale_reason = None
        existing.version = existing.version + 1
        existing.updated_by_id = actor.id
        db.add(existing)
        out.append(existing)
        changed_count += 1

    if changed_count:
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=actor.id,
            actor_label=actor.email,
            action="UI_LABELS_CALIBRATED",
            result="SUCCESS",
            target_type="UI_LABEL",
            data={
                "locale": body.locale,
                "page": body.page,
                "count": changed_count,
            },
            commit=False,
        )
    db.commit()
    for row in out:
        db.refresh(row)
    return out


@router.patch("/{label_id}", response_model=UiLabelOut)
def update_label(
    label_id: UUID,
    body: UiLabelUpdate,
    db: Session = Depends(get_session),
    actor: User = Depends(require_permission(Permission.UI_LABEL_MANAGE)),
) -> UiLabel:
    row = db.get(UiLabel, label_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Label không tồn tại")

    new_text = body.label_text if body.label_text is None else (body.label_text or "").strip() or None
    new_aria = body.aria_label if body.aria_label is None else (body.aria_label or "").strip() or None
    new_notes = body.notes if body.notes is not None else row.notes

    if new_text == row.label_text and new_aria == row.aria_label and new_notes == row.notes:
        return row

    _push_history(db, row, actor.id)
    if body.label_text is not None:
        row.label_text = new_text
    if body.aria_label is not None:
        row.aria_label = new_aria
    if body.notes is not None:
        row.notes = new_notes
    row.stale = False
    row.stale_reason = None
    row.version = row.version + 1
    row.updated_by_id = actor.id
    db.add(row)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="UI_LABEL_UPDATED",
        result="SUCCESS",
        target_type="UI_LABEL",
        target_id=str(row.id),
        data={"locale": row.locale, "page": row.page, "control_key": row.control_key},
        commit=False,
    )
    db.commit()
    db.refresh(row)
    return row


@router.post("/{label_id}/clear-stale", response_model=UiLabelOut)
def clear_stale(
    label_id: UUID,
    db: Session = Depends(get_session),
    actor: User = Depends(require_permission(Permission.UI_LABEL_MANAGE)),
) -> UiLabel:
    row = db.get(UiLabel, label_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Label không tồn tại")
    if not row.stale:
        return row
    row.stale = False
    row.stale_reason = None
    row.updated_by_id = actor.id
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.get("/{label_id}/history", response_model=list[UiLabelHistoryOut])
def label_history(
    label_id: UUID,
    db: Session = Depends(get_session),
    _: User = Depends(require_permission(Permission.UI_LABEL_MANAGE)),
) -> list[UiLabelHistory]:
    return list(
        db.execute(
            select(UiLabelHistory)
            .where(UiLabelHistory.label_id == label_id)
            .order_by(UiLabelHistory.version.desc())
        ).scalars()
    )


@router.post("/{label_id}/rollback/{version}", response_model=UiLabelOut)
def rollback_label(
    label_id: UUID,
    version: int,
    db: Session = Depends(get_session),
    actor: User = Depends(require_permission(Permission.UI_LABEL_MANAGE)),
) -> UiLabel:
    row = db.get(UiLabel, label_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Label không tồn tại")
    snap = db.execute(
        select(UiLabelHistory).where(
            UiLabelHistory.label_id == label_id, UiLabelHistory.version == version
        )
    ).scalar_one_or_none()
    if not snap:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"Version {version} không tồn tại"
        )
    _push_history(db, row, actor.id)
    row.label_text = snap.label_text
    row.aria_label = snap.aria_label
    row.notes = snap.notes
    row.stale = False
    row.stale_reason = None
    row.version = row.version + 1
    row.updated_by_id = actor.id
    db.add(row)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="UI_LABEL_ROLLED_BACK",
        result="SUCCESS",
        target_type="UI_LABEL",
        target_id=str(row.id),
        data={"to_version": version},
        commit=False,
    )
    db.commit()
    db.refresh(row)
    return row
