"""Chức năng: BILLING SYNC PUSH (extension đẩy billing scrape từ /admin/billing).

⚠️ ĐỌC `billing.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
Docs ghi lịch sử lỗi, business rule và ý tưởng cải tiến — code chỉ là "how".

Endpoints (đăng ký lên router dùng chung từ `_shared`):
  - POST /billing-sync  → push_billing_sync (auth bằng X-API-KEY của extension)
"""

from dataclasses import dataclass
from datetime import datetime, time as dtime, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.audit import log_event
from app.deps import get_session, require_extension_workspace, require_super_admin
from app.models import PaymentSettings, User, Workspace
from app.routers.members._shared import (
    _as_utc,
    _boundary_on,
    cycle_params,
    cycle_settings,
    is_cycle_aligned,
    next_boundary,
    workspace_cycle,
)
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


def cycle_mismatch_day(
    period_end: datetime, anchor_day: int, cutoff: dtime
) -> int | None:
    """Bản dán này có LỆCH MỐC chu kỳ đang chạy không? (EXPIRY_RULES §3.6.3)

    Trả NGÀY của mốc đang chạy trong tháng của `period_end` nếu lệch, `None` nếu
    khớp. Hàm THUẦN — không đụng DB, để định nghĩa "lệch mốc" test được ở mọi máy.

    ĐỊNH NGHĨA CHÍNH XÁC, đừng đoán lại:
      - So NGÀY TRONG THÁNG của `period_end` (ép UTC) với mốc mà workspace sẽ chốt
        trong CHÍNH tháng đó — tức `_boundary_on`, nên luật "ngày neo 29/30/31 rơi
        vào tháng ngắn thì lùi về ngày cuối tháng" được tính CÙNG một cách. Neo 31
        mà hoá đơn chốt 28/2 là KHỚP, không phải lệch: tự viết `anchor_day !=
        period_end.day` là báo động giả cho mọi tháng ngắn.
      - CHỈ so ngày, KHÔNG so giờ. Giờ trong `period_end` là giờ của Stripe, còn
        `cycle_cutoff_utc` là giờ chốt do ta tự đặt (mặc định 03:00 UTC) — so cả
        giờ thì hoá đơn nào cũng "lệch", cảnh báo mất hết ý nghĩa.
      - Phải ép UTC: `period_end` là `timestamptz`, đọc `.day` trần lệch tới một
        ngày so với mốc mà `members/_shared` đang dùng.
    """
    at = _as_utc(period_end)
    expected = _boundary_on(anchor_day, cutoff, at.year, at.month)
    if expected.day == at.day:
        return None
    return expected.day


# ── MỐC CHU KỲ ĐI THEO HOÁ ĐƠN (chốt user 2026-09-08) ────────────────────────
# Luật CŨ: mốc tự cuộn theo tháng từ `cycle_anchor_day`, hoá đơn về mà lệch mốc thì
# CHẶN (409) bắt tích ô xác nhận rồi dán lại lần hai.
# Luật MỚI: HOÁ ĐƠN QUYẾT ĐỊNH MỐC. Hoá đơn của kỳ ĐANG chạy hoặc SẮP tới — dán tay
# hay extension tự quét đều vậy — thì dời mốc NGAY, không hỏi gì, chỉ ghi nhật ký.
# Hoá đơn là chứng từ của chính ChatGPT, còn con số ta tự cuộn chỉ là phỏng đoán;
# bắt xác nhận mỗi kỳ chỉ dạy người ta tích ô cho xong rồi bấm tiếp.
#
# NGOẠI LỆ KHÔNG ĐƯỢC BỎ — HOÁ ĐƠN CŨ: `period_end` nằm trước cả mốc mở của kỳ đang
# chạy thì VẪN LƯU vào danh sách (báo cáo tài chính cần nó) nhưng KHÔNG đụng tới mốc.
# Ca thật hay gặp: super-admin dán bù cả xấp hoá đơn cũ để tính chi phí — cho chúng
# dời mốc là kéo mốc chốt của CẢ workspace về quá khứ, tức đổi hạn và đổi giá của mọi
# email trong đó, im lặng.
#
# Chưa có mốc nào (`cycle_anchor_day` NULL và `renewal_date` NULL) thì không có gì để
# lệch: chính hoá đơn này là thứ mồi ra mốc.
CYCLE_ANCHOR_LEGACY = "legacy_30d"
CYCLE_ANCHOR_NO_PERIOD_END = "no_period_end"
CYCLE_ANCHOR_NO_ANCHOR = "no_anchor"
CYCLE_ANCHOR_MATCHED = "matched"
CYCLE_ANCHOR_AUTO_APPLIED = "auto_applied"
CYCLE_ANCHOR_STALE_KEPT = "stale_invoice_kept"
# Ngày chốt vượt quá mốc kế tiếp ⇒ không phải hoá đơn của kỳ đang chạy hay sắp
# tới, mà là một con số rác (parse nhầm năm, quét lỗi). Không dời mốc theo nó.
CYCLE_ANCHOR_OUT_OF_RANGE = "out_of_range"


@dataclass(frozen=True)
class CycleAnchorDecision:
    """Một hoá đơn nói gì về mốc chu kỳ của workspace.

    `anchor_day_after` None = KHÔNG dời mốc. `write_renewal_date` False = cả cột
    `renewal_date` cũng không được ghi (hoá đơn cũ), vì `cycle_params` MỒI mốc từ
    chính cột đó khi `cycle_anchor_day` còn trống — ghi vào là dời mốc bằng đường
    vòng. `log_result` None = ca bình thường, không cần để lại dấu vết.
    """

    outcome: str
    write_renewal_date: bool
    anchor_day_after: int | None
    log_result: str | None
    log_data: dict | None


def _cycle_anchor_untouched(outcome: str) -> CycleAnchorDecision:
    """Ca không có gì để xét: ghi `renewal_date` như trước, không đụng mốc, không log."""
    return CycleAnchorDecision(
        outcome=outcome,
        write_renewal_date=True,
        anchor_day_after=None,
        log_result=None,
        log_data=None,
    )


def decide_cycle_anchor(
    *,
    period_end: datetime,
    anchor_day: int | None,
    cutoff: dtime,
    now: datetime,
    max_period_end: datetime | None,
    invoice_number: str | None = None,
    renewal_date_before: datetime | None = None,
) -> CycleAnchorDecision:
    """Luật BA NGẢ ở trên, dạng HÀM THUẦN — nhận giá trị, trả quyết định.

    Đây là chỗ DUY NHẤT định nghĩa luật đó: cả đường dán tay lẫn đường extension tự
    quét đều đi qua đây. Chép khối if/elif ra hai nơi là hai cửa vào cho ra hai mốc
    khác nhau, mà lệch mốc thì lệch hạn và lệch tiền của mọi email trong workspace.

    Không đụng DB nên test được ở mọi máy. `now` = thời điểm xét; `max_period_end`
    = mốc chốt kế tiếp sau kỳ đang chạy (None khi workspace chưa có mốc nào).
    """
    pasted = _as_utc(period_end)
    note: dict = {
        # Giữ nguyên tên `anchor_day` như nhật ký cũ để tra lại lịch sử không gãy.
        "anchor_day": anchor_day,
        "pasted_period_end": pasted.isoformat(),
        "pasted_day": pasted.day,
        "invoice_number": invoice_number,
        "renewal_date_before": (
            renewal_date_before.isoformat() if renewal_date_before else None
        ),
    }

    if anchor_day is None:
        return _cycle_anchor_untouched(CYCLE_ANCHOR_NO_ANCHOR)
    # Khớp mốc đang chạy ⇒ không có gì phải dời, cũng không có gì phải kể lại. Xét
    # TRƯỚC nhánh hoá đơn cũ: hoá đơn cũ mà ngày vẫn khớp thì đường đi phải y hệt
    # trước đây (ghi `renewal_date`, không log) — mốc không suy suyển vì ngày trùng.
    if cycle_mismatch_day(pasted, anchor_day, cutoff) is None:
        return _cycle_anchor_untouched(CYCLE_ANCHOR_MATCHED)

    def _giu_nguyen_moc(ly_do: str) -> CycleAnchorDecision:
        note["outcome"] = ly_do
        note["anchor_day_before"] = anchor_day
        note["anchor_day_after"] = anchor_day
        return CycleAnchorDecision(
            outcome=ly_do,
            write_renewal_date=False,
            anchor_day_after=None,
            log_result="SKIPPED",
            log_data=note,
        )

    # HOÁ ĐƠN CŨ — so với HIỆN TẠI, không phải với mốc mở của kỳ đang chạy.
    #
    # Hoá đơn của kỳ ĐANG chạy hoặc SẮP tới thì kỳ đó CHƯA đóng, nên `period_end`
    # của nó luôn ở tương lai. Ngày chốt đã trôi qua ⇒ đó là hoá đơn của một kỳ đã
    # xong, dù nó rơi vào trong kỳ đang chạy.
    #
    # Lấy mốc mở của kỳ đang chạy làm ranh giới (bản trước) hở một cửa sổ rộng gần
    # một tháng: neo 25, hôm nay 8/9 thì kỳ mở từ 25/8, nên dán bù một hoá đơn cũ
    # có ngày chốt 5/9 vẫn lọt vào nhánh "kỳ hiện tại" và kéo mốc của cả không gian
    # về ngày 5. Đúng cái mà chốt này sinh ra để chặn.
    if pasted < _as_utc(now):
        return _giu_nguyen_moc(CYCLE_ANCHOR_STALE_KEPT)

    # QUÁ XA — không phải hoá đơn của kỳ đang chạy hay kỳ kế tiếp. Bỏ chặn hỏi mà
    # không đặt trần thì một con số rác (parse nhầm năm, quét lỗi) cũng dời được mốc
    # của cả không gian, và đường extension thì không có ai ngồi nhìn.
    if max_period_end is not None and pasted > _as_utc(max_period_end):
        return _giu_nguyen_moc(CYCLE_ANCHOR_OUT_OF_RANGE)

    # Kỳ ĐANG chạy hoặc SẮP tới mà lệch ngày ⇒ ChatGPT đã đổi chu kỳ, mốc đi theo
    # hoá đơn. Neo MỚI là ngày TRÊN HOÁ ĐƠN (đã ép UTC), KHÔNG phải giá trị
    # `cycle_mismatch_day` trả về — hàm đó trả ngày của mốc CŨ, gán vào là đặt neo
    # về đúng chỗ vừa bị hoá đơn bác bỏ.
    note["outcome"] = CYCLE_ANCHOR_AUTO_APPLIED
    note["anchor_day_before"] = anchor_day
    note["anchor_day_after"] = pasted.day
    return CycleAnchorDecision(
        outcome=CYCLE_ANCHOR_AUTO_APPLIED,
        write_renewal_date=True,
        anchor_day_after=pasted.day,
        log_result="SUCCESS",
        log_data=note,
    )


def apply_cycle_anchor_from_invoice(
    db: Session,
    ws: Workspace,
    period_end: datetime | None,
    *,
    actor_type: str,
    actor_id: UUID | None = None,
    actor_label: str | None = None,
    invoice_number: str | None = None,
    now: datetime | None = None,
    settings_row: PaymentSettings | None = None,
) -> CycleAnchorDecision:
    """Áp `decide_cycle_anchor` lên một workspace: dời mốc + ghi nhật ký nếu cần.

    Trả quyết định để nơi gọi biết còn được ghi `renewal_date` nữa không. KHÔNG
    commit — nơi gọi commit chung với phần việc còn lại của nó.

    Workspace `legacy_30d` ra ngay ở dòng đầu: chế độ đó mốc chu kỳ không tham gia
    tính hạn của ai cả nên không có gì để bảo vệ, hành vi phải y hệt trước đây.
    """
    if period_end is None:
        return _cycle_anchor_untouched(CYCLE_ANCHOR_NO_PERIOD_END)
    if not is_cycle_aligned(ws):
        return _cycle_anchor_untouched(CYCLE_ANCHOR_LEGACY)

    if settings_row is None:
        settings_row = cycle_settings(db)
    anchor_day, cutoff, _ = cycle_params(ws, settings_row)
    at = now or datetime.now(timezone.utc)
    max_period_end: datetime | None = None
    if anchor_day is not None:
        # `workspace_cycle` ném 409 khi chưa có mốc, nên chỉ gọi khi đã có.
        # TRẦN = mốc chốt kế tiếp SAU kỳ đang chạy: hoá đơn hợp lệ nhất cũng chỉ mô
        # tả tới kỳ kế tiếp, xa hơn nữa là số rác.
        _cycle_start, cycle_end = workspace_cycle(ws, at, settings_row=settings_row)
        max_period_end = next_boundary(ws, cycle_end, settings_row=settings_row)

    decision = decide_cycle_anchor(
        period_end=period_end,
        anchor_day=anchor_day,
        cutoff=cutoff,
        now=at,
        max_period_end=max_period_end,
        invoice_number=invoice_number,
        renewal_date_before=ws.renewal_date,
    )

    if decision.anchor_day_after is not None:
        # ⚠️ PHẢI GHI `cycle_anchor_day`, KHÔNG chỉ `renewal_date`. `cycle_params`
        # đọc `cycle_anchor_day` TRƯỚC và chỉ mồi từ `renewal_date` khi cột đó còn
        # NULL — mà endpoint gạt chế độ luôn điền sẵn nó. Chỉ ghi `renewal_date` thì
        # màn hình báo "Đã lưu", nhật ký ghi "đã dời mốc", mà mốc thật đứng nguyên.
        ws.cycle_anchor_day = decision.anchor_day_after
        db.add(ws)
    if decision.log_result is not None:
        # Không hỏi thì phải KỂ LẠI: dời mốc là đổi hạn của mọi email trong không
        # gian, sau này nhìn một hoá đơn lệch giá phải tra ra được mốc đổi lúc nào,
        # theo hoá đơn nào, và ai/cái gì mang nó về.
        log_event(
            db,
            actor_type=actor_type,
            actor_id=actor_id,
            actor_label=actor_label,
            action="WORKSPACE_CYCLE_MISMATCH",
            result=decision.log_result,
            target_type="WORKSPACE",
            target_id=str(ws.id),
            data=decision.log_data,
            commit=False,
        )
    return decision


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

    ⚠️ Workspace `cycle_aligned`: đường này CŨNG dời được mốc chu kỳ (chốt user
    2026-09-08) — xem khối `apply_cycle_anchor_from_invoice` trong thân hàm.
    """
    changes: dict = {}
    # MỐC CHU KỲ CŨNG ĐI THEO ĐƯỜNG NÀY (chốt user 2026-09-08). `renewal_date` mà
    # extension quét về là ngày kết thúc "Current cycle" trên tab Kế hoạch — cùng
    # một con số với `period_end` của hoá đơn kỳ đó, nên nó là chứng từ đủ để dời
    # mốc. Trước đây vòng lặp dưới ghi thẳng `renewal_date` không qua chốt nào: hoá
    # đơn CŨ quét về cũng kéo mốc lùi lại, mà workspace đã có `cycle_anchor_day` thì
    # mốc lại đứng im dù ChatGPT đã đổi kỳ. Gọi TRƯỚC vòng lặp vì quyết định cần đọc
    # `renewal_date` lúc chưa bị ghi đè.
    #
    # Nhật ký ở đây do EXTENSION sinh ra (auth bằng X-API-KEY, không có người dùng
    # nào phía sau) nên actor đi theo quy ước của các log extension khác trong repo:
    # `actor_type="EXTENSION"`, nhãn là tên workspace.
    cycle_decision = apply_cycle_anchor_from_invoice(
        db,
        workspace,
        body.renewal_date,
        actor_type="EXTENSION",
        actor_label=f"workspace:{workspace.name}",
    )
    for field in (
        "plan",
        "seat_total",
        "seat_used",
        "billing_status",
        "renewal_date",
    ):
        # Hoá đơn/kỳ CŨ quét về: giữ nguyên mốc, và giữ nguyên cả `renewal_date` vì
        # `cycle_params` mồi mốc từ chính cột đó khi `cycle_anchor_day` còn trống.
        if field == "renewal_date" and not cycle_decision.write_renewal_date:
            continue
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

    if cycle_decision.log_data is not None:
        changes["cycle_anchor"] = cycle_decision.log_data

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

    ⚠️ Workspace `cycle_aligned`: bản dán còn QUYẾT ĐỊNH MỐC CHỐT chu kỳ. Hoá đơn
    của kỳ đang chạy/sắp tới mà lệch ngày thì mốc dời theo nó ngay, không hỏi;
    hoá đơn CŨ thì vẫn lưu nhưng không đụng mốc (EXPIRY_RULES §3.6.3, luật ba ngả ở
    `decide_cycle_anchor`). Workspace `legacy_30d` giữ nguyên hành vi cũ TỪNG DÒNG:
    dán là ghi, không hỏi gì.
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

    # ── MỐC CHU KỲ ĐI THEO HOÁ ĐƠN (EXPIRY_RULES §3.6.3) ─────────────────────
    # Luật ba ngả nằm ở `decide_cycle_anchor` (hàm thuần) và đường dán tay lẫn đường
    # extension tự quét dùng CHUNG nó — xem khối chú thích ở đầu file.
    #
    # Gọi TRƯỚC KHI đụng vào `billing_invoices`/`renewal_date`: quyết định phải đọc
    # mốc và `renewal_date` lúc chưa ai sửa. Workspace `legacy_30d` ra ngay ở dòng
    # đầu của hàm đó, không đổi một dòng hành vi nào.
    cycle_decision = apply_cycle_anchor_from_invoice(
        db,
        ws,
        body.period_end,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        invoice_number=body.invoice_number,
    )

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
    if cycle_decision.log_data is not None:
        changes["cycle_anchor"] = cycle_decision.log_data
    # renewal_date = period_end (ngày kết thúc chu kỳ dịch vụ dòng "(per seat)").
    if not cycle_decision.write_renewal_date:
        # Hoá đơn cũ dán bù cho báo cáo tài chính: hoá đơn đã được lưu ở trên,
        # nhưng mốc chu kỳ thì GIỮ NGUYÊN. Kéo `renewal_date` về quá khứ ở chế độ
        # `cycle_aligned` là kéo mốc chốt của cả workspace lùi lại — hạn và giá của
        # mọi email lệch theo, mà trên màn hình không có gì bật lên.
        pass
    elif ws.renewal_date != body.period_end:
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
