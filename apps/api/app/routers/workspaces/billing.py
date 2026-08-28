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
from app.schemas import (
    BillingInvoiceFeeIn,
    BillingPasteIn,
    BillingSyncIn,
    WorkspaceOut,
)

from ._shared import _get_workspace_or_404, router


# HOÁ ĐƠN = HÀNG NHẬP TAY (chốt user 2026-08-13). Trước đây extension scrape trang
# /admin/billing rồi GHI ĐÈ nguyên list `billing_invoices` — hệ quả:
#   1. Dòng scrape chỉ có ngày + số tiền + link Stripe (không seat, không giá/seat,
#      không chu kỳ) nên bảng Thanh toán đầy dòng "—", và
#   2. Mỗi hoá đơn super-admin dán tay (số ghế, giá/seat, chu kỳ) BỊ XOÁ ở lần sync
#      kế tiếp — công nhập tay mất trắng, im lặng. Dán tay còn đẻ dòng TRÙNG vì khoá
#      của bản dán có `invoice_number` còn bản scrape thì không.
# Nên: `billing_invoices` giờ CHỈ chứa hoá đơn nhập tay. Sync vẫn cập nhật
# plan/seat/renewal/billing_status như cũ, nhưng KHÔNG đụng vào danh sách hoá đơn —
# chỉ đếm số hoá đơn scrape được rồi ghi vào audit để còn đối chiếu.
# Muốn quay lại nhận hoá đơn scrape: đổi hằng số này về True (và đọc §5 billing.md).
BILLING_SYNC_ACCEPTS_SCRAPED_INVOICES = False


def _is_manual_invoice(row: dict) -> bool:
    """Hoá đơn này do người dán tay (`billing-paste`) hay do extension scrape?

    `source='manual'` là dấu CHÍNH THỨC, bản dán từ 2026-08-13 trở đi luôn có. Dữ
    liệu cũ hơn không có cờ → suy theo hình dạng: bản dán tay có chi tiết đầy đủ
    (`detail_scraped`) và KHÔNG có `detail_url` (link Stripe chỉ sinh ra ở đường
    scrape). Đối chiếu trên production 13/8/2026: quy tắc này khớp CHÍNH XÁC 6/6
    lần dán trong audit `WORKSPACE_BILLING_PASTED`.
    """
    if row.get("source") == "manual":
        return True
    return bool(row.get("detail_scraped")) and not row.get("detail_url")


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

    # HOÁ ĐƠN NHẬP TAY LÀ NGUỒN CHÂN LÝ (chốt user 2026-08-13 — xem hằng số đầu file):
    # sync KHÔNG được đụng vào `billing_invoices` nữa, chỉ đếm để ghi audit. Các field
    # billing khác (plan/seat/renewal/status) ở trên vẫn cập nhật bình thường.
    if body.invoices and not BILLING_SYNC_ACCEPTS_SCRAPED_INVOICES:
        kept = sum(1 for r in (workspace.billing_invoices or []) if _is_manual_invoice(r))
        changes["invoices_scraped_ignored"] = {
            "before": None,
            "after": len(body.invoices),
        }
        changes["invoices_manual_kept"] = {"before": None, "after": kept}
    # An toàn dữ liệu (Hiến pháp II): CHỈ ghi đè khi có list không rỗng. None/[]
    # (scrape lỗi/thiếu) KHÔNG được xoá lịch sử hoá đơn cũ.
    elif body.invoices:
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


@router.post("/{workspace_id}/billing-paste", response_model=WorkspaceOut)
def paste_billing_invoice(
    workspace_id: UUID,
    body: BillingPasteIn,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> Workspace:
    """Super-admin DÁN chi tiết 1 hoá đơn (web đã parse) → lưu vào workspace.

    Thay cho việc extension scrape trang chi tiết Stripe. Lưu hoá đơn vào JSONB
    `billing_invoices` (merge theo invoice_number / date+amount, bảo toàn phí NHẬP
    TAY) + set `renewal_date` = period_end.

    KHÔNG set `seat_total`/`seat_used` — số ghế trên hoá đơn là số của KỲ đó, dán
    hoá đơn cũ sẽ kéo tổng suất về quá khứ (xem chú thích trong thân hàm).
    """
    if body.quantity is None or body.total_vnd is None or body.period_end is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Không đọc được đủ dữ liệu từ text dán: cần số ghế (dòng 'per "
                "seat'), tổng tiền và chu kỳ (period). Kiểm tra lại text hoá đơn."
            ),
        )
    ws = _get_workspace_or_404(db, workspace_id)

    date = body.date or body.period_start or body.period_end
    amount = body.amount_vnd if body.amount_vnd is not None else body.total_vnd
    row: dict = {
        "date": date.isoformat(),
        "amount_vnd": amount,
        "status": body.status or "paid",
        "detail_scraped": True,
        # Dấu CHÍNH THỨC "hàng nhập tay" (2026-08-13) — trước đây chỉ suy được theo
        # hình dạng row. Xem `_is_manual_invoice`.
        "source": "manual",
        "quantity": body.quantity,
    }
    for field in ("unit_price_vnd", "subtotal_vnd", "vat_vnd", "total_vnd", "invoice_number"):
        val = getattr(body, field)
        if val is not None:
            row[field] = val
    if body.period_start is not None:
        row["period_start"] = body.period_start.isoformat()
    row["period_end"] = body.period_end.isoformat()

    invoices = list(ws.billing_invoices or [])
    new_key = _invoice_key(body.invoice_number, row["date"], amount)
    # Bảo toàn phí NHẬP TAY của hoá đơn cũ cùng khoá; thay thế nếu đã tồn tại.
    merged: list[dict] = []
    replaced = False
    for old in invoices:
        old_key = _invoice_key(
            old.get("invoice_number"), old.get("date"), old.get("amount_vnd")
        )
        # Dòng SCRAPE trùng (cùng ngày + số tiền) phải bị bản dán tay THAY THẾ, không
        # được nằm song song: khoá của bản dán có `invoice_number` còn bản scrape thì
        # không nên `_invoice_key` không khớp → trước đây bảng Thanh toán hiện 2 dòng
        # cho cùng 1 hoá đơn, một dòng đủ chi tiết một dòng toàn "—" (ca thật GPT1
        # 11/6, 12/6, 22/6 — user 2026-08-13).
        dup_scraped = (
            old_key != new_key
            and not _is_manual_invoice(old)
            and old.get("date") == row["date"]
            and old.get("amount_vnd") == amount
        )
        if old_key == new_key or dup_scraped:
            if old.get("service_fee_vnd") is not None and "service_fee_vnd" not in row:
                row["service_fee_vnd"] = old["service_fee_vnd"]
            if not replaced:
                merged.append(row)
            replaced = True
        else:
            merged.append(old)
    if not replaced:
        merged.append(row)
    ws.billing_invoices = merged
    flag_modified(ws, "billing_invoices")

    changes: dict = {"invoice": {"number": body.invoice_number, "replaced": replaced}}
    # renewal_date = period_end (ngày kết thúc chu kỳ dịch vụ dòng "(per seat)").
    if ws.renewal_date != body.period_end:
        changes["renewal_date"] = {
            "before": ws.renewal_date.isoformat() if ws.renewal_date else None,
            "after": body.period_end.isoformat(),
        }
        ws.renewal_date = body.period_end
    # KHÔNG đụng vào `seat_total`/`seat_used` (user 2026-08-24).
    #
    # `body.quantity` là số ghế GHI TRÊN HOÁ ĐƠN — số ghế tại thời điểm CHỐT hoá
    # đơn đó, không phải số suất workspace đang có. Dán hoá đơn CŨ (admin dán lại
    # cả lịch sử để đủ báo cáo tài chính) sẽ kéo tổng suất về quá khứ: ca thật
    # GPT1 13/8/2026 dán 3 hoá đơn liên tiếp → seat_total nhảy 151 → 2 → 102 →
    # 148 và đứng ở 148 suốt 11 ngày, trong khi ChatGPT đang có 151.
    #
    # Tổng suất chỉ nhận từ chỗ ĐỌC TẬN NƠI trên ChatGPT: hộp "Quản lý suất"
    # (`_absorb_seat_reading` — queue/completion.py) hoặc dòng tỉ lệ trang thanh
    # toán (SYNC_BILLING). Số ghế của hoá đơn vẫn được lưu trong chính dòng hoá
    # đơn (`quantity`) để tính tiền — không mất gì.
    changes["invoice_quantity"] = {
        "seats_on_invoice": body.quantity,
        "workspace_seat_total_kept": ws.seat_total,
    }
    if ws.billing_status != "PAID":
        changes["billing_status"] = {"before": ws.billing_status, "after": "PAID"}
        ws.billing_status = "PAID"
    # Neo mốc tính CHI nếu workspace chưa có (giống push_billing_sync).
    if ws.finance_start_at is None and body.period_start is not None:
        ws.finance_start_at = body.period_start
        changes["finance_start_at"] = {"before": None, "after": body.period_start.isoformat()}

    ws.last_billing_synced_at = datetime.now(timezone.utc)
    db.add(ws)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="WORKSPACE_BILLING_PASTED",
        result="SUCCESS",
        target_type="WORKSPACE",
        target_id=str(ws.id),
        data={"changes": changes},
        commit=False,
    )
    db.commit()
    db.refresh(ws)
    return ws


@router.patch("/{workspace_id}/billing-invoices/fee", response_model=WorkspaceOut)
def set_invoice_fee(
    workspace_id: UUID,
    body: BillingInvoiceFeeIn,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> Workspace:
    """Super-admin nhập/xoá phí dịch vụ ngân hàng cho 1 hoá đơn trong chu kỳ.

    ĐƯỜNG LÙI từ 2026-08-27: phí ngân hàng giờ nhập MỘT LẦN theo % cho cả workspace
    (`Workspace.bank_fee_percent`) — workspace đã đặt % thì giá trị gán ở đây không
    còn được dùng để tính tiền (xem `app/billing_fee.py`), web cũng khoá ô nhập.
    Endpoint vẫn giữ cho workspace chưa đặt % và cho dữ liệu cũ.

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
