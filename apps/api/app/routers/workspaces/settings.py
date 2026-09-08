"""Chức năng: WORKSPACE SETTINGS + EXTENSION STATUS (cấu hình rate-limit + poll online).

⚠️ ĐỌC `settings.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
Docs ghi lịch sử lỗi, business rule và ý tưởng cải tiến — code chỉ là "how".

Endpoints (đăng ký lên router dùng chung từ `_shared`):
  - GET   /{workspace_id}/settings          → get_workspace_settings
  - PATCH /{workspace_id}/settings          → update_workspace_settings
  - GET   /{workspace_id}/extension-status  → get_extension_status
  - POST  /{workspace_id}/invite-block/clear → clear_invite_block (super-admin)
  - POST  /{workspace_id}/billing-mode      → set_billing_mode (super-admin)

Lưu ý: `get_extension_status` không thuộc nhóm "settings" thuần tuý nhưng là 1
endpoint read-only nhỏ (poll trạng thái SSE) nên đặt chung ở đây thay vì tạo
module riêng.
"""

from datetime import datetime, time as dtime
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    assert_workspace_access,
    get_current_user,
    get_session,
    require_super_admin,
)
from app.models import (
    BILLING_MODE_CYCLE_ALIGNED,
    PLATFORM_GPT,
    User,
    Workspace,
    WorkspaceSettings,
)
from app.routers.members._shared import _as_utc
from app.services import invite_block
from app.sse import subscriber_count
from app.schemas import (
    WorkspaceBillingModeIn,
    WorkspaceOut,
    WorkspaceSettingsOut,
    WorkspaceSettingsUpdate,
)

from ._shared import router, _get_workspace_or_404


@router.get("/{workspace_id}/extension-status", response_model=dict)
def get_extension_status(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Dashboard poll endpoint này để biết extension nào có đang subscribe SSE
    cho workspace tương ứng. Cross-browser detection — KHÔNG cần postMessage
    bridge cùng trình duyệt.

    Trả:
      - online: bool — có ít nhất 1 extension SSE subscriber đang kết nối
      - subscribers: int — số extension đang subscribe (thường 0 hoặc 1)
    """
    ws = _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)
    count = subscriber_count(ws.id)
    return {"online": count > 0, "subscribers": count}


@router.get("/{workspace_id}/settings", response_model=WorkspaceSettingsOut)
def get_workspace_settings(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
) -> WorkspaceSettings:
    _get_workspace_or_404(db, workspace_id)
    settings_row = db.get(WorkspaceSettings, workspace_id)
    if not settings_row:
        settings_row = WorkspaceSettings(workspace_id=workspace_id)
        db.add(settings_row)
        db.commit()
        db.refresh(settings_row)
    return settings_row


@router.patch("/{workspace_id}/settings", response_model=WorkspaceSettingsOut)
def update_workspace_settings(
    workspace_id: UUID,
    body: WorkspaceSettingsUpdate,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> WorkspaceSettings:
    _get_workspace_or_404(db, workspace_id)
    settings_row = db.get(WorkspaceSettings, workspace_id)
    if not settings_row:
        settings_row = WorkspaceSettings(workspace_id=workspace_id)
        db.add(settings_row)
        db.flush()

    changes: dict = {}
    for field in ("rate_limit_invite_ms", "rate_limit_role_ms", "rate_limit_remove_ms", "dry_run_mode"):
        new_val = getattr(body, field)
        if new_val is not None and new_val != getattr(settings_row, field):
            changes[field] = {"before": getattr(settings_row, field), "after": new_val}
            setattr(settings_row, field, new_val)

    if not changes:
        return settings_row

    db.add(settings_row)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="WORKSPACE_SETTINGS_UPDATED",
        result="SUCCESS",
        target_type="WORKSPACE",
        target_id=str(workspace_id),
        data=changes,
        commit=False,
    )
    db.commit()
    db.refresh(settings_row)
    return settings_row


@router.post("/{workspace_id}/invite-block/clear", response_model=dict)
def clear_invite_block(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_super_admin),
) -> dict:
    """CHO PHÉP MỜI LẠI NGAY một workspace đang bị ngưng (chốt user 3/9/2026).

    Mốc ngưng do hệ thống tự đặt khi ChatGPT hỏng cú bấm công tắc "mời ngoài
    miền" (xem `services/invite_block.py`) và tự hết sau một tiếng. Nút này là
    đường tắt cho ca ChatGPT hồi sớm — CHỈ super-admin, vì mở lại lúc ChatGPT vẫn
    hỏng là mua thêm một loạt lệnh hỏng cho cả workspace.

    Không bị ngưng thì trả về `blocked: false` chứ không báo lỗi: nút có thể được
    bấm lại sau khi mốc vừa tự hết.
    """
    ws = _get_workspace_or_404(db, workspace_id)
    was = invite_block.blocked_until(ws)
    invite_block.clear_block(db, ws, user, commit=True)
    return {
        "blocked": False,
        "was_blocked_until": was.isoformat() if was else None,
    }


# ═════════════════════════════════════════════════════════════════════════════
# CẦU DAO CHẾ ĐỘ TÍNH HẠN (EXPIRY_RULES §3.6.6)
# ═════════════════════════════════════════════════════════════════════════════

# Khoảng hợp lệ của ngày-trong-tháng. Phải KHỚP hai ràng buộc đang có trong
# `models.py` (`ck_workspaces_cycle_anchor_day`, `ck_workspaces_cycle_force_day`):
# kiểm ở đây chỉ để người dùng nhận được câu tiếng Việt thay vì lỗi ràng buộc DB,
# chứ không phải để nới rộng hơn DB — lệch khoảng là lỗi lại rơi xuống tầng dưới.
CYCLE_DAY_MIN = 1
CYCLE_DAY_MAX = 31


def plan_billing_mode_switch(
    *,
    platform: str,
    mode: str,
    current_anchor_day: int | None,
    requested_anchor_day: int | None,
    requested_force_from_day: int | None,
    renewal_date: datetime | None,
) -> tuple[int | None, str | None]:
    """Suy ra NGÀY NEO sau khi gạt, hoặc câu TỪ CHỐI. Hàm THUẦN — không đụng DB.

    Trả `(ngày_neo, câu_lỗi)`. Có câu lỗi thì ngày neo vô nghĩa, người gọi phải từ
    chối thẳng chứ đừng ghi gì.

    Tách thuần khỏi endpoint để bốn chốt chặn dưới đây test được mà không cần
    Postgres: chúng là thứ DUY NHẤT đứng giữa một cú bấm nhầm và cả một workspace
    bán sai giá suốt một chu kỳ, nên phải chạy được test ở mọi máy, mọi lúc.

    Bốn chốt:
      1. Ngày neo / ngưỡng ép tháng ngoài 1..31 → từ chối (khớp ràng buộc DB).
      2. Nhánh Canva KHÔNG được gạt sang `cycle_aligned`.
      3. Sang `cycle_aligned` mà không có mốc nào để neo → từ chối, bắt nhập.
      4. Chưa có ngày neo thì MỒI từ `renewal_date`, ép UTC trước khi đọc `.day`.
    """
    for label, value in (
        ("Ngày chốt chu kỳ", requested_anchor_day),
        ("Ngày ép thêm tháng", requested_force_from_day),
    ):
        if value is not None and not (CYCLE_DAY_MIN <= value <= CYCLE_DAY_MAX):
            return None, (
                f"{label} phải là một ngày trong tháng, từ {CYCLE_DAY_MIN} tới "
                f"{CYCLE_DAY_MAX}. Đang nhận: {value}."
            )

    if mode != BILLING_MODE_CYCLE_ALIGNED:
        # Về `legacy_30d` thì không cần mốc nào: hạn = neo + số tháng × 30 ngày,
        # mỗi email một đồng hồ riêng. Giữ nguyên ngày neo đã có (không xoá) để
        # gạt đi gạt lại không mất cấu hình cũ.
        if requested_anchor_day is not None:
            return requested_anchor_day, None
        return current_anchor_day, None

    if platform != PLATFORM_GPT:
        # Canva không có hoá đơn business để neo vào, và giá một lượt bán ở chế độ
        # này luôn đi qua đơn giá THÁNG của GPT (`payment_flow.fee_for_window`), bỏ
        # qua hẳn bảng bậc thang Canva ⇒ gạt nhầm là âm thầm bán sai giá. DB cũng
        # chặn (`ck_workspaces_cycle_aligned_gpt_only`) nhưng lỗi ràng buộc DB thì
        # người gạt không đọc được gì.
        return None, (
            "Chỉ không gian ChatGPT mới bật được chế độ neo theo chu kỳ hoá đơn. "
            "Không gian Canva tính tiền theo gói bậc thang, không có hoá đơn chu "
            "kỳ để neo vào."
        )

    anchor_day = current_anchor_day
    if requested_anchor_day is not None:
        anchor_day = requested_anchor_day
    if anchor_day is None and renewal_date is not None:
        # ⚠️ PHẢI ép UTC trước khi đọc `.day`. `renewal_date` là `timestamptz`, đọc
        # `.day` trần là lệch một ngày so với `_shared.cycle_params` (dùng
        # `_as_utc(...).day`) — mà lệch một ngày ở đây là lệch mốc chốt của CẢ
        # workspace: lệch hạn và lệch giá cho mọi email trong đó. Lỗi này đã xảy ra
        # hai lần trong tính năng này rồi.
        anchor_day = _as_utc(renewal_date).day
    if anchor_day is None:
        # Không có neo thì mọi lượt bán sẽ ném 409 giữa chừng
        # (`members/_shared._require_anchor_day`) — gạt xong là hỏng cả workspace.
        return None, (
            "Không gian này chưa biết ngày chốt chu kỳ: chưa có ngày chốt lưu sẵn "
            "và cũng chưa có ngày gia hạn nào để suy ra. Nhập 'ngày chốt chu kỳ' "
            "(1–31) rồi gạt lại, hoặc dán một hoá đơn trước."
        )
    return anchor_day, None


def _time_str(value: dtime | None) -> str | None:
    """Giờ chốt → chuỗi cho nhật ký.

    `datetime.time` KHÔNG đi qua `json.dumps` được, ghi thô vào JSONB `data` là 500
    ngay lúc gạt cầu dao — đúng vết xe của `renewal_date` thô ở `push_billing_sync`
    (xem chú thích trong `billing.py`).
    """
    return value.isoformat() if value is not None else None


@router.post("/{workspace_id}/billing-mode", response_model=WorkspaceOut)
def set_billing_mode(
    workspace_id: UUID,
    body: WorkspaceBillingModeIn,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> Workspace:
    """GẠT CẦU DAO chế độ tính hạn/tính tiền cho MỘT workspace (EXPIRY_RULES §3.6).

    VÌ SAO LÀ ENDPOINT RIÊNG, KHÔNG NHÉT VÀO `PATCH /{workspace_id}`: đổi
    `billing_mode` là đổi CÁCH TÍNH TIỀN của cả workspace — hạn của mọi email
    chuyển từ "neo + số tháng × 30 ngày" sang "rơi đúng mốc chốt chu kỳ hoá đơn",
    và giá một lượt bán chuyển từ trọn tháng sang tính theo ngày. Đó không phải một
    trường cấu hình bình thường như tên hay tên miền. Trộn vào PATCH chung thì một
    ngày nào đó sẽ có người gạt nhầm trong lúc đang sửa tên workspace, và không có
    gì bật lên cả — chỉ có tiền thu sai từ lượt bán kế tiếp.

    ⚠️ ENDPOINT NÀY KHÔNG ĐỤNG `subscription_end_at` CỦA BẤT KỲ AI (§3.6.8). Gạt
    sang `cycle_aligned` là chuyện của những lượt bán TỪ ĐÂY VỀ SAU: khách đang
    chạy giữ nguyên hạn, không migration, không thu thêm, không cắt bớt. Lần gia
    hạn kế tiếp của họ tự rơi vào luật §3.6.2 và nhờ ĐIỂM NỐI mà họ trả đúng số
    ngày từ hạn cũ tới mốc — hội tụ xong sau đúng MỘT vòng gia hạn. Ai đọc tới đây
    và thấy "tiện tay migrate luôn cho đẹp" thì DỪNG: kéo hạn về mốc chung là cắt
    mất thời gian khách đã trả tiền, hoặc cho không một quãng — cả hai đều im lặng.

    Bốn chốt chặn nằm ở `plan_billing_mode_switch` (hàm thuần, test không cần DB).
    """
    ws = _get_workspace_or_404(db, workspace_id)

    anchor_day, error = plan_billing_mode_switch(
        platform=ws.platform,
        mode=body.mode,
        current_anchor_day=ws.cycle_anchor_day,
        requested_anchor_day=body.cycle_anchor_day,
        requested_force_from_day=body.cycle_force_extra_from_day,
        renewal_date=ws.renewal_date,
    )
    if error is not None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=error)

    changes: dict = {
        "billing_mode": {"before": ws.billing_mode, "after": body.mode},
        "cycle_anchor_day": {"before": ws.cycle_anchor_day, "after": anchor_day},
    }
    ws.billing_mode = body.mode
    ws.cycle_anchor_day = anchor_day

    # Giờ chốt + ngưỡng ép tháng: chỉ đụng khi client THỰC SỰ gửi trường đó. Gửi
    # null tường minh = XOÁ ghi đè (quay về giá trị chung của `payment_settings`),
    # không gửi = giữ nguyên. Đọc theo `model_fields_set` giống
    # `crud.update_workspace`: xét "khác None" thì không còn đường nào xoá ghi đè.
    for field in ("cycle_cutoff_utc", "cycle_force_extra_from_day"):
        before = getattr(ws, field)
        after = getattr(body, field) if field in body.model_fields_set else before
        if field == "cycle_cutoff_utc":
            changes[field] = {"before": _time_str(before), "after": _time_str(after)}
        else:
            changes[field] = {"before": before, "after": after}
        setattr(ws, field, after)

    db.add(ws)
    # Gạt chế độ tính tiền mà không có dấu vết là không đối soát được: sau này nhìn
    # một hoá đơn lệch giá, phải tra ra được ai gạt, lúc nào, và bốn trường trước/
    # sau ra sao. Ghi CẢ BỐN trường kể cả trường không đổi — nhật ký ở đây là ảnh
    # chụp cấu hình chu kỳ tại thời điểm gạt, không phải danh sách khác biệt.
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="WORKSPACE_BILLING_MODE_SET",
        result="SUCCESS",
        target_type="WORKSPACE",
        target_id=str(ws.id),
        data=changes,
        commit=False,
    )
    db.commit()
    db.refresh(ws)
    return ws
