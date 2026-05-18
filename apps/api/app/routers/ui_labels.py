"""UI Label calibration — labels ChatGPT đã harvest cho 3 locale × 4 page.

Flow:
  - Super-admin harvest qua trang Settings → POST /bulk lưu label vào DB.
  - Extension fetch /bundle khi khởi động → cache local, dùng khi automation.
  - Khi extension không match được → POST /report-mismatch → label stale=true.
  - Dashboard hiện banner stale + nút "Mở harvest" để re-calibrate đúng cell.
"""

from collections import defaultdict
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    get_session,
    require_extension_workspace,
    require_permission,
)
from app.models import UiLabel, UiLabelHistory, User, Workspace
from app.permissions import Permission
from app.schemas import (
    UiLabelBulkIn,
    UiLabelBundleOut,
    UiLabelCoverageCell,
    UiLabelCoverageOut,
    UiLabelHarvestIn,
    UiLabelHarvestOut,
    UiLabelHistoryOut,
    UiLabelOut,
    UiLabelReportIn,
    UiLabelUpdate,
)

router = APIRouter(prefix="/api/v1/ui-labels", tags=["ui-labels"])


LOCALES: tuple[str, ...] = ("vi", "en", "zh")
PAGES: tuple[str, ...] = (
    "/admin/members",
    "/admin/billing",
    "/admin/billing?tab=invoices",
    "/admin/identity",
)
CONTROL_KEYS_BY_PAGE: dict[str, tuple[str, ...]] = {
    "/admin/members": (
        "tab_active_members",
        "tab_pending_invites",
        "tab_pending_requests",
        "invite_button_open",
        "invite_add_more_button",
        "invite_role_owner",
        "invite_role_admin",
        "invite_role_member",
        "invite_submit_button",
        # member_row_menu_button: icon-only button (chỉ aria-label hoặc rỗng),
        # extension dùng CSS selector tìm — không cần text label trong DB.
        "menu_remove_member",
        "menu_change_role",
        "confirm_remove_button",
        "menu_revoke_invite",
        "confirm_revoke_button",
    ),
    "/admin/billing": ("tab_billing_plan", "tab_billing_invoices"),
    "/admin/billing?tab=invoices": ("tab_billing_invoices",),
    "/admin/identity": ("toggle_external_invites",),
}


def _push_history(db: Session, label: UiLabel, actor_id: UUID | None) -> None:
    db.add(
        UiLabelHistory(
            label_id=label.id,
            version=label.version,
            label_text=label.label_text,
            aria_label=label.aria_label,
            notes=label.notes,
            created_by_id=actor_id,
        )
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


