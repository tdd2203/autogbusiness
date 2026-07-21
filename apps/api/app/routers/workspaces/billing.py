"""Chức năng: BILLING SYNC PUSH (extension đẩy billing scrape từ /admin/billing).

⚠️ ĐỌC `billing.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
Docs ghi lịch sử lỗi, business rule và ý tưởng cải tiến — code chỉ là "how".

Endpoints (đăng ký lên router dùng chung từ `_shared`):
  - POST /billing-sync  → push_billing_sync (auth bằng X-API-KEY của extension)
"""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.audit import log_event
from app.deps import get_session, require_extension_workspace, require_super_admin
from app.models import User, Workspace
from app.schemas import BillingInvoiceFeeIn, BillingSyncIn, WorkspaceOut

from ._shared import _get_workspace_or_404, router


def _invoice_key(
    invoice_number: str | None, date_iso: str | None, amount_vnd: int | None
) -> tuple:
    """Khoá định danh 1 hoá đơn để khớp giữa các lần sync / khi gán phí.

    Ưu tiên `invoice_number` (mã Stripe ổn định). Hoá đơn cũ chưa có mã → fallback
    (date, amount). Đây là mấu chốt để phí NHẬP TAY không bị extension ghi đè mất.
    """
    if invoice_number:
        return ("num", invoice_number)
    return ("da", date_iso, amount_vnd)


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
        old_val = getattr(workspace, field)
        if new_val is not None and new_val != old_val:
            # QUAN TRỌNG: cả before LẪN after phải serialize datetime → ISO. Trước
            # đây chỉ after được đổi; before (vd renewal_date cũ) là datetime thô →
            # log_event ghi vào JSONB `data` fail json.dumps → 500 "Internal Server
            # Error" mỗi khi renewal_date ĐỔI (extension sync chu kỳ mới) → task
            # BILLING_SYNC_FAILED "Unexpected token 'I'…".
            changes[field] = {
                "before": old_val.isoformat() if isinstance(old_val, datetime) else old_val,
                "after": new_val.isoformat() if isinstance(new_val, datetime) else new_val,
            }
            setattr(workspace, field, new_val)

    # An toàn dữ liệu (Hiến pháp II): CHỈ ghi đè khi có list không rỗng. None/[]
    # (scrape lỗi/thiếu) KHÔNG được xoá lịch sử hoá đơn cũ.
    if body.invoices:
        # Bảo toàn phí NHẬP TAY: extension ghi đè TOÀN BỘ list nên phải map lại
        # service_fee_vnd của hoá đơn cũ (theo invoice_number, fallback date+amount)
        # vào hoá đơn mới cùng khoá — nếu không phí sẽ bị xoá mỗi lần sync.
        existing_fees: dict[tuple, int] = {}
        for old in workspace.billing_invoices or []:
            fee = old.get("service_fee_vnd")
            if fee is None:
                continue
            existing_fees[
                _invoice_key(
                    old.get("invoice_number"), old.get("date"), old.get("amount_vnd")
                )
            ] = fee

        serialized: list[dict] = []
        detailed = 0
        failed = 0
        for inv in body.invoices:
            date_iso = inv.date.isoformat()
            row: dict = {
                "date": date_iso,
                "amount_vnd": inv.amount_vnd,
                "status": inv.status,
                "detail_scraped": inv.detail_scraped,
            }
            if inv.detail_url is not None:
                row["detail_url"] = inv.detail_url
            for field in (
                "quantity",
                "unit_price_vnd",
                "subtotal_vnd",
                "vat_vnd",
                "total_vnd",
                "invoice_number",
            ):
                val = getattr(inv, field)
                if val is not None:
                    row[field] = val
            if inv.period_start is not None:
                row["period_start"] = inv.period_start.isoformat()
            if inv.period_end is not None:
                row["period_end"] = inv.period_end.isoformat()
            # Phí: ưu tiên giá trị extension gửi kèm (hiện chưa dùng), nếu không thì
            # giữ lại phí cũ đã map theo khoá.
            fee = inv.service_fee_vnd
            if fee is None:
                fee = existing_fees.get(
                    _invoice_key(inv.invoice_number, date_iso, inv.amount_vnd)
                )
            if fee is not None:
                row["service_fee_vnd"] = fee
            serialized.append(row)
            if inv.detail_scraped:
                detailed += 1
            elif inv.detail_url is not None:
                failed += 1
        workspace.billing_invoices = serialized
        changes["invoices_count"] = {"before": "?", "after": len(serialized)}
        changes["invoices_detailed_count"] = {"before": "?", "after": detailed}
        changes["invoices_failed_count"] = {"before": "?", "after": failed}

        # Mốc bắt đầu tính CHI (báo cáo tài chính): workspace MỚI chưa có mốc → tự
        # neo về ĐẦU CHU KỲ HIỆN TẠI = period_start mới nhất trong các hoá đơn vừa
        # sync (chỉ hoá đơn chu kỳ hiện tại có period_start). Hoá đơn trước mốc coi
        # là hệ thống cũ/thanh toán ngoài → không tính vào CHI. Chỉ set 1 lần; đã có
        # mốc thì giữ nguyên (backfill migration / super-admin không bị ghi đè).
        if workspace.finance_start_at is None:
            starts = [
                p
                for inv in body.invoices
                if (p := getattr(inv, "period_start", None)) is not None
            ]
            if starts:
                workspace.finance_start_at = max(starts)
                changes["finance_start_at"] = {
                    "before": None,
                    "after": workspace.finance_start_at.isoformat(),
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


@router.patch("/{workspace_id}/billing-invoices/fee", response_model=WorkspaceOut)
def set_invoice_fee(
    workspace_id: UUID,
    body: BillingInvoiceFeeIn,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> Workspace:
    """Super-admin nhập/xoá phí dịch vụ ngân hàng cho 1 hoá đơn trong chu kỳ.

    Phí này KHÔNG scrape được (bank charge ngoài Stripe) nên nhập tay; web cộng vào
    "tổng thực trả chu kỳ". Ghi thẳng vào JSONB `billing_invoices` (không migration);
    được bảo toàn khi extension sync đè (xem merge ở push_billing_sync).
    """
    ws = _get_workspace_or_404(db, workspace_id)
    invoices = list(ws.billing_invoices or [])

    target_key = _invoice_key(
        body.invoice_number, body.date.isoformat(), body.amount_vnd
    )
    matched: dict | None = None
    for row in invoices:
        if (
            _invoice_key(
                row.get("invoice_number"), row.get("date"), row.get("amount_vnd")
            )
            == target_key
        ):
            matched = row
            break
    # Fallback: gửi kèm invoice_number nhưng hoá đơn lưu chưa có mã → khớp date+amount.
    if matched is None and body.invoice_number:
        alt_key = _invoice_key(None, body.date.isoformat(), body.amount_vnd)
        for row in invoices:
            if _invoice_key(None, row.get("date"), row.get("amount_vnd")) == alt_key:
                matched = row
                break
    if matched is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Không tìm thấy hoá đơn khớp để gán phí",
        )

    before = matched.get("service_fee_vnd")
    # 0 hoặc None → xoá phí (không lưu field rỗng).
    fee = body.service_fee_vnd or None
    if fee == before:
        return ws
    if fee is None:
        matched.pop("service_fee_vnd", None)
    else:
        matched["service_fee_vnd"] = fee

    ws.billing_invoices = invoices
    flag_modified(ws, "billing_invoices")
    db.add(ws)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="WORKSPACE_INVOICE_FEE_SET",
        result="SUCCESS",
        target_type="WORKSPACE",
        target_id=str(ws.id),
        data={
            "invoice_number": body.invoice_number,
            "date": body.date.isoformat(),
            "amount_vnd": body.amount_vnd,
            "service_fee_vnd": {"before": before, "after": fee},
        },
        commit=False,
    )
    db.commit()
    db.refresh(ws)
    return ws
