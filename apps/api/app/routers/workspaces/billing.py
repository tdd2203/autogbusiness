"""Chức năng: BILLING SYNC PUSH (extension đẩy billing scrape từ /admin/billing).

⚠️ ĐỌC `billing.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
Docs ghi lịch sử lỗi, business rule và ý tưởng cải tiến — code chỉ là "how".

Endpoints (đăng ký lên router dùng chung từ `_shared`):
  - POST /billing-sync  → push_billing_sync (auth bằng X-API-KEY của extension)
"""

from datetime import datetime, timezone

from fastapi import Depends
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_session, require_extension_workspace
from app.models import Workspace
from app.schemas import BillingSyncIn, WorkspaceOut

from ._shared import router


@router.post("/billing-sync", response_model=WorkspaceOut)
def push_billing_sync(
    body: BillingSyncIn,
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> Workspace:
    """Extension push billing data scrape được từ /admin/billing.

    Format display dashboard: seat_used / seat_total (vd 6/8).
    """
    changes: dict = {}
    for field in (
        "plan",
        "seat_total",
        "seat_used",
        "billing_status",
        "renewal_date",
    ):
        new_val = getattr(body, field)
        if new_val is not None and new_val != getattr(workspace, field):
            changes[field] = {
                "before": getattr(workspace, field),
                "after": new_val.isoformat() if isinstance(new_val, datetime) else new_val,
            }
            setattr(workspace, field, new_val)

    if body.invoices is not None:
        # Lưu list serialized (date thành ISO string) → JSONB
        workspace.billing_invoices = [
            {
                "date": inv.date.isoformat(),
                "amount_vnd": inv.amount_vnd,
                "status": inv.status,
            }
            for inv in body.invoices
        ]
        changes["invoices_count"] = {
            "before": "?",
            "after": len(body.invoices),
        }

    workspace.last_billing_synced_at = datetime.now(timezone.utc)
    db.add(workspace)
    log_event(
        db,
        actor_type="EXTENSION",
        actor_label=f"workspace:{workspace.name}",
        action="WORKSPACE_BILLING_SYNCED",
        result="SUCCESS",
        target_type="WORKSPACE",
        target_id=str(workspace.id),
        data={"changes": changes} if changes else None,
        commit=False,
    )
    db.commit()
    db.refresh(workspace)
    return workspace
