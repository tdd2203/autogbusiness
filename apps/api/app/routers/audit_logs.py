from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import Select, Text, and_, cast, func, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.deps import get_session, require_permission
from app.models import (
    PLATFORM_CANVA,
    PLATFORMS,
    AuditLog,
    Member,
    PaymentOrder,
    QueueItem,
    User,
    Workspace,
)
from app.permissions import Permission
from app.schemas import AuditLogOut

router = APIRouter(prefix="/api/v1/audit-logs", tags=["audit"])


class AuditLogHeadOut(BaseModel):
    """Mốc nhật ký mới nhất — beacon cho trang Nhật ký tự làm mới.

    Trang mở lâu thì các sự kiện chạy nền (extension, hệ thống, admin khác) không
    tự hiện ra. Poll thẳng danh sách thì tốn: mỗi lô 200 dòng, và với sub-admin
    còn phải quét 3000 dòng để lọc quyền nhìn. Endpoint này chỉ trả id + timestamp
    của dòng MỚI NHẤT (không lọc quyền — chỉ là mã đổi/không đổi, không kèm nội
    dung), web so với dòng đầu đang hiện, khác mới tải lại thật.
    """

    id: UUID | None = None
    timestamp: datetime | None = None


@router.get("/head", response_model=AuditLogHeadOut)
def audit_log_head(
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.AUDIT_LOG_VIEW)),
    platform: str | None = Query(default=None),
) -> AuditLogHeadOut:
    """Dòng nhật ký mới nhất (chỉ id + thời điểm) để web biết có gì mới hay chưa.

    `platform` nhận cho khớp lời gọi của trang nhưng CỐ TÌNH không lọc: đây chỉ là
    mã đổi/không đổi để web biết có nên tải lại danh sách hay không, mà quy nhánh
    thì phải tra bảng khác — trả giá đó cho mỗi nhịp poll 15s là không đáng.
    """
    del platform
    row = db.execute(
        select(AuditLog.id, AuditLog.timestamp)
        .order_by(AuditLog.timestamp.desc(), AuditLog.id.desc())
        .limit(1)
    ).first()
    if row is None:
        return AuditLogHeadOut()
    return AuditLogHeadOut(id=row[0], timestamp=row[1])


def _workspace_id_of(log: AuditLog) -> str | None:
    """workspace_id gắn với 1 audit log: ưu tiên data.workspace_id, fallback target
    khi target_type=WORKSPACE."""
    wid = (log.data or {}).get("workspace_id")
    if isinstance(wid, str) and wid:
        return wid
    if log.target_type == "WORKSPACE" and log.target_id:
        return log.target_id
    return None


def _owned_member_sets(db: Session, user_id: UUID) -> tuple[set[str], set[str]]:
    """member.id (str) + email (lowercase) do user mời — dùng lọc nhật ký sub-admin."""
    rows = db.execute(
        select(Member.id, func.lower(Member.email).label("email")).where(
            Member.invited_by_user_id == user_id
        )
    ).all()
    return {str(r.id) for r in rows}, {r.email for r in rows if r.email}


def _emails_in_log_data(data: dict | None) -> set[str]:
    if not data:
        return set()
    out: set[str] = set()
    email = data.get("email")
    if isinstance(email, str) and email.strip():
        out.add(email.strip().lower())
    for item in data.get("emails") or []:
        if isinstance(item, str) and item.strip():
            out.add(item.strip().lower())
    for entry in data.get("entries") or []:
        if isinstance(entry, dict):
            em = entry.get("email")
            if isinstance(em, str) and em.strip():
                out.add(em.strip().lower())
    return out


def _member_ids_in_log_data(data: dict | None) -> set[str]:
    if not data:
        return set()
    return {str(m) for m in data.get("member_ids") or []}


def _queue_payload_emails(payload: dict | None) -> list[str]:
    """Email trong payload task hàng đợi (REVOKE_INVITES.emails, REMOVE_MEMBER.email…)."""
    if not payload:
        return []
    out: list[str] = []
    raw = payload.get("emails")
    if isinstance(raw, list):
        for e in raw:
            if isinstance(e, str) and "@" in e:
                em = e.strip().lower()
                if em and em not in out:
                    out.append(em)
    email = payload.get("email")
    if isinstance(email, str) and "@" in email:
        em = email.strip().lower()
        if em and em not in out:
            out.append(em)
    return out


def _queue_item_id_of(log: AuditLog) -> str | None:
    d = log.data or {}
    qid = d.get("queue_item_id")
    if isinstance(qid, str) and qid:
        return qid
    if log.target_type == "QUEUE_ITEM" and log.target_id:
        return log.target_id
    return None


def _order_id_of(log: AuditLog) -> str | None:
    """id hoá đơn QR (`payment_orders.id`) mà dòng log này nói tới.

    Hai dòng tiền của một hoá đơn neo theo hai kiểu khác nhau:
      • `PAYMENT_ORDER_CREATED` → target_type=PAYMENT_ORDER, target_id = id hoá đơn
      • `WALLET_ORDER_CREDITED` → data.ref_type='order', data.ref_id = id hoá đơn
    """
    if log.target_type == "PAYMENT_ORDER" and log.target_id:
        return log.target_id
    d = log.data or {}
    if d.get("ref_type") == "order":
        ref = d.get("ref_id")
        if isinstance(ref, str) and ref:
            return ref
    return None


def _own_queue_item_ids(db: Session, user_id: UUID, logs: list[AuditLog]) -> set[str]:
    """queue_item.id (str) mà CHÍNH user này tạo, trong số task được nhắc ở `logs`."""
    ids: set[UUID] = set()
    for log in logs:
        qid = _queue_item_id_of(log)
        if not qid:
            continue
        try:
            ids.add(UUID(qid))
        except ValueError:
            continue
    if not ids:
        return set()
    rows = db.execute(
        select(QueueItem.id).where(
            QueueItem.id.in_(ids), QueueItem.created_by_id == user_id
        )
    ).all()
    return {str(r[0]) for r in rows}


def _audit_log_visible(
    log: AuditLog,
    user: User,
    owned_ids: set[str],
    owned_emails: set[str],
    own_queue_ids: set[str],
) -> bool:
    """Sub-admin chỉ thấy nhật ký về email họ sở hữu + thao tác/thông tin của họ."""
    uid = user.id
    uid_s = str(uid)
    data = log.data or {}
    emails_in_log = _emails_in_log_data(data)
    member_ids = _member_ids_in_log_data(data)

    # Sự kiện CẤP HÀNG ĐỢI của task do CHÍNH họ tạo (`QUEUE_PICKED`, `QUEUE_TIMEOUT`,
    # `QUEUE_UPDATED`…): `actor_id` NULL (extension/hệ thống ghi) và data không mang
    # email nào, nên MỌI luật bên dưới đều trượt → trước đây sub-admin không bao giờ
    # thấy chúng.
    #
    # ⚠️ CA THẬT 26/8/2026 (task 3bc11c7b): cùng một lệnh mời, super-admin đọc ra
    # "Thất bại" (thấy `QUEUE_TIMEOUT`) còn sub-admin đọc ra "Thành công" (không
    # thấy) — hai người nhìn hai sự thật khác nhau về việc của chính sub-admin.
    #
    # CHỈ mở cho log KHÔNG mang email/member: log có email vẫn phải qua luật sở hữu
    # bên dưới, vì email của một task có thể đã đổi chủ sang sub-admin khác.
    if not emails_in_log and not member_ids:
        qid = _queue_item_id_of(log)
        if qid is not None and qid in own_queue_ids:
            return True

    if log.actor_id == uid:
        if emails_in_log and not emails_in_log.issubset(owned_emails):
            return False
        if member_ids and not member_ids.issubset(owned_ids):
            return False
        return True

    if log.target_type == "USER" and log.target_id == uid_s:
        return True

    if log.target_type == "MEMBER" and log.target_id in owned_ids:
        return True

    if data.get("user_id") == uid_s:
        return True

    # Gán/chuyển chủ hàng loạt (MEMBER_BULK_OWNER_ASSIGN, MEMBER_OWNER_TRANSFERRED…).
    if data.get("target_user_id") == uid_s:
        return True

    # Đổi chủ đơn lẻ: user là chủ mới.
    if data.get("after") == uid_s:
        return True

    if emails_in_log and emails_in_log.issubset(owned_emails):
        return True

    if member_ids and member_ids.issubset(owned_ids):
        return True

    return False


def _log_platforms(db: Session, logs: list[AuditLog]) -> dict[UUID, set[str]]:
    """Nhánh sản phẩm mà TỪNG dòng nhật ký nói tới. Rỗng = không quy được nhánh nào.

    audit_logs KHÔNG có cột nhánh (và cố tình không thêm: nguồn thật là workspace của
    member — xem models.PLATFORM_*), nên quy nhánh lúc đọc, theo thứ tự rẻ→đắt:
      1. workspace_id trong `data` / target WORKSPACE  → nhánh của workspace đó.
      2. member_ids / target MEMBER                     → nhánh workspace của member.
      3. email trong `data`                             → nhánh của member mang email.

    Dòng không quy được (đăng nhập, nạp ví, đổi cấu hình…) là việc CỦA TÀI KHOẢN chứ
    không của nhánh nào: hàm trả tập rỗng và người gọi cho nó hiện ở CẢ HAI nhánh —
    giấu đi thì nhật ký kể thiếu chuyện đã thật sự xảy ra.
    """
    out: dict[UUID, set[str]] = {log.id: set() for log in logs}

    # 1. workspace
    ws_ids: set[UUID] = set()
    for log in logs:
        wid = _workspace_id_of(log)
        if wid:
            try:
                ws_ids.add(UUID(wid))
            except ValueError:
                pass
    ws_platform: dict[str, str] = {}
    if ws_ids:
        for wid, plat in db.execute(
            select(Workspace.id, Workspace.platform).where(Workspace.id.in_(ws_ids))
        ).all():
            ws_platform[str(wid)] = plat
    for log in logs:
        wid = _workspace_id_of(log)
        if wid and wid in ws_platform:
            out[log.id].add(ws_platform[wid])

    # 2. member id
    mem_ids: set[UUID] = set()
    for log in logs:
        if out[log.id]:
            continue
        raw = set(_member_ids_in_log_data(log.data))
        if log.target_type == "MEMBER" and log.target_id:
            raw.add(log.target_id)
        for mid in raw:
            try:
                mem_ids.add(UUID(mid))
            except (ValueError, TypeError):
                pass
    mem_platform: dict[str, str] = {}
    if mem_ids:
        for mid, plat in db.execute(
            select(Member.id, Workspace.platform)
            .join(Workspace, Member.workspace_id == Workspace.id)
            .where(Member.id.in_(mem_ids))
        ).all():
            mem_platform[str(mid)] = plat
    for log in logs:
        if out[log.id]:
            continue
        raw = set(_member_ids_in_log_data(log.data))
        if log.target_type == "MEMBER" and log.target_id:
            raw.add(log.target_id)
        for mid in raw:
            plat = mem_platform.get(mid)
            if plat:
                out[log.id].add(plat)

    # 3. task hàng đợi — dòng cấp hàng đợi (QUEUE_PICKED/QUEUE_UPDATED) chỉ mang
    # `queue_item_id`, không mang workspace lẫn email. Thiếu bước này thì mỗi lệnh
    # mời/đồng bộ của ChatGPT đẻ ra một cặp dòng "vô chủ" nằm chình ình trong nhật ký
    # Canva (đo trên dữ liệu thật 2026-09-01: 140/200 dòng gần nhất).
    q_ids: set[UUID] = set()
    for log in logs:
        if out[log.id]:
            continue
        qid = _queue_item_id_of(log)
        if qid:
            try:
                q_ids.add(UUID(qid))
            except ValueError:
                pass
    q_platform: dict[str, str] = {}
    if q_ids:
        for qid, plat in db.execute(
            select(QueueItem.id, Workspace.platform)
            .join(Workspace, QueueItem.workspace_id == Workspace.id)
            .where(QueueItem.id.in_(q_ids))
        ).all():
            q_platform[str(qid)] = plat
    for log in logs:
        if out[log.id]:
            continue
        qid = _queue_item_id_of(log)
        plat = q_platform.get(qid) if qid else None
        if plat:
            out[log.id].add(plat)

    # 4. hoá đơn — dòng tiền của một lệnh (`PAYMENT_ORDER_CREATED`,
    # `WALLET_ORDER_CREDITED`) chỉ mang id hoá đơn. `payment_orders` CÓ cột nhánh
    # nên quy được, khỏi để tiền của ChatGPT nằm trong nhật ký Canva.
    order_ids: set[UUID] = set()
    for log in logs:
        if out[log.id]:
            continue
        oid = _order_id_of(log)
        if oid:
            try:
                order_ids.add(UUID(oid))
            except ValueError:
                pass
    order_platform: dict[str, str] = {}
    if order_ids:
        for oid, plat in db.execute(
            select(PaymentOrder.id, PaymentOrder.platform).where(
                PaymentOrder.id.in_(order_ids)
            )
        ).all():
            order_platform[str(oid)] = plat
    for log in logs:
        if out[log.id]:
            continue
        oid = _order_id_of(log)
        plat = order_platform.get(oid) if oid else None
        if plat:
            out[log.id].add(plat)

    # 5. email — một email có thể nằm ở CẢ HAI nhánh (khách mua cả ChatGPT lẫn
    # Canva); khi đó dòng log hiện ở cả hai, vì không có gì trong log nói nó thuộc
    # bên nào.
    emails: set[str] = set()
    for log in logs:
        if out[log.id]:
            continue
        emails |= _emails_in_log_data(log.data)
    email_platform: dict[str, set[str]] = {}
    if emails:
        for em, plat in db.execute(
            select(func.lower(Member.email), Workspace.platform)
            .join(Workspace, Member.workspace_id == Workspace.id)
            .where(func.lower(Member.email).in_(emails))
        ).all():
            email_platform.setdefault(em, set()).add(plat)
    for log in logs:
        if out[log.id]:
            continue
        for em in _emails_in_log_data(log.data):
            out[log.id] |= email_platform.get(em, set())

    # 6. hành động mang tên nhánh (CANVA_PRICE_TIERS_UPDATED…): không gắn workspace
    # nào nhưng rõ ràng là việc của nhánh đó, đừng để nó hiện bên ChatGPT.
    for log in logs:
        if not out[log.id] and log.action.startswith("CANVA_"):
            out[log.id].add(PLATFORM_CANVA)

    return out


# Quét tối đa N dòng gần nhất rồi post-filter — tránh SQL prefilter bỏ sót log
# hàng loạt (member_ids JSONB), extension (actor_id NULL), gán chủ cũ, v.v.
_SUB_ADMIN_AUDIT_SCAN = 3000
# Trang nhật ký tải theo NGÀY (cần đến đâu tải đến đó) nên một trang của sub-admin
# có thể phải quét lùi nhiều lô mới gom đủ `limit` dòng THẤY ĐƯỢC. Quét lùi tối đa
# ngần này lô để trang không bao giờ dừng sớm chỉ vì lô đầu toàn log của người khác.
_SUB_ADMIN_MAX_CHUNKS = 8


def _before_cursor(
    stmt: "Select[tuple[AuditLog]]",
    ts: datetime | None,
    log_id: UUID | None,
) -> "Select[tuple[AuditLog]]":
    """Chỉ lấy log CŨ HƠN mốc (ts, id) — con trỏ phân trang.

    Phải kèm `id` vì `server_default=func.now()` là HẰNG trong một transaction:
    mọi log ghi cùng một request mang y hệt timestamp. Cắt trang bằng mỗi
    `timestamp <` sẽ nuốt luôn các log anh em cùng mốc.
    """
    if ts is None:
        return stmt
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    if log_id is None:
        return stmt.where(AuditLog.timestamp < ts)
    return stmt.where(
        or_(
            AuditLog.timestamp < ts,
            and_(AuditLog.timestamp == ts, AuditLog.id < log_id),
        )
    )


# TÌM KIẾM — số id gián tiếp (member / queue item khớp từ khoá) tối đa nhét vào một
# truy vấn. Mỗi id đẻ thêm một điều kiện OR nên phải chặn, kẻo gõ "@" là kéo cả bảng
# members vào câu WHERE.
_SEARCH_MAX_IDS = 60


def _like_escape(q: str) -> str:
    """Thoát ký tự đại diện của LIKE — gõ "%" hay "_" phải là ký tự thường."""
    return q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _search_clause(db: Session, q: str) -> "ColumnElement[bool]":
    """Điều kiện cho ô tìm kiếm — quét TOÀN BỘ nhật ký trong DB, không phải chỉ phần
    UI đang giữ (user 2026-08-27: "tìm kiếm chủ động thì phải hiển thị ra chứ không
    phải chỉ tìm trong danh sách hiện tại").

    Bốn cột text bắt được phần lớn: hành động, người thực hiện, target_id và cả cục
    `data` (email, mã hoá đơn, số tiền…). Nhưng có hai chỗ email KHÔNG hề nằm trong
    dòng log: dòng chỉ ghi `member_id` (email suy lúc đọc từ bảng members) và dòng
    chỉ ghi `queue_item_id` (email nằm trong payload task). Tra ngược hai bảng đó ra
    id rồi tìm id trong log — không làm thì gõ email sẽ KHÔNG thấy chính việc mời /
    gỡ của email ấy, đúng cái làm người dùng tưởng nhật ký trống.
    """
    like = f"%{_like_escape(q.lower())}%"
    data_text = cast(AuditLog.data, Text)
    conds = [
        func.lower(AuditLog.action).like(like, escape="\\"),
        func.lower(AuditLog.actor_label).like(like, escape="\\"),
        func.lower(AuditLog.target_id).like(like, escape="\\"),
        func.lower(data_text).like(like, escape="\\"),
    ]
    ids: list[str] = []
    for mid in db.execute(
        select(Member.id)
        .where(func.lower(Member.email).like(like, escape="\\"))
        .limit(_SEARCH_MAX_IDS)
    ).scalars():
        ids.append(str(mid))
    for qid in db.execute(
        select(QueueItem.id)
        .where(func.lower(cast(QueueItem.payload, Text)).like(like, escape="\\"))
        .limit(_SEARCH_MAX_IDS)
    ).scalars():
        ids.append(str(qid))
    if ids:
        conds.append(AuditLog.target_id.in_(ids))
        conds.extend(data_text.like(f"%{i}%") for i in ids)
    return or_(*conds)


@router.get("", response_model=list[AuditLogOut])
def list_audit_logs(
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.AUDIT_LOG_VIEW)),
    limit: int = Query(default=100, le=500),
    action: str | None = Query(default=None),
    actor_type: str | None = Query(default=None),
    before: datetime | None = Query(default=None),
    before_id: UUID | None = Query(default=None),
    q: str | None = Query(default=None, max_length=200),
    platform: str | None = Query(default=None),
) -> list[AuditLogOut]:
    """Một TRANG nhật ký, mới→cũ. `before`/`before_id` = con trỏ (dòng cuối của
    trang trước) để trang sau tải tiếp phần cũ hơn. Trả về ÍT HƠN `limit` dòng
    nghĩa là đã hết nhật ký — UI dựa vào đó để ẩn nút "xem thêm".

    `platform=gpt|canva` → chỉ dòng của MỘT nhánh (xem `_log_platforms`). Lọc nhánh
    phải làm sau khi đọc dòng ra (nhánh nằm trong JSONB / phải tra bảng khác), nên
    khi có tham số này thì cả super-admin cũng đi đường QUÉT THEO LÔ như sub-admin:
    quét lùi tới khi gom đủ `limit` dòng, giữ nguyên quy ước "ít hơn limit = hết"."""
    base = select(AuditLog).order_by(AuditLog.timestamp.desc(), AuditLog.id.desc())
    if action:
        base = base.where(AuditLog.action == action)
    if actor_type:
        base = base.where(AuditLog.actor_type == actor_type)
    # Ô tìm kiếm của UI: lọc ngay ở DB rồi mới phân trang, nên kết quả đến từ MỌI
    # ngày / mọi lô — không phụ thuộc người dùng đã bấm "xem thêm" bao nhiêu lần.
    if q and q.strip():
        base = base.where(_search_clause(db, q.strip()))

    if platform is not None and platform not in PLATFORMS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="platform không hợp lệ"
        )

    if user.is_super_admin and platform is None:
        rows = list(
            db.execute(_before_cursor(base, before, before_id).limit(limit)).scalars()
        )
    else:
        owned_ids, owned_emails = (
            (set(), set())
            if user.is_super_admin
            else _owned_member_sets(db, user.id)
        )
        rows = []
        ts, log_id = before, before_id
        for _ in range(_SUB_ADMIN_MAX_CHUNKS):
            raw = list(
                db.execute(
                    _before_cursor(base, ts, log_id).limit(_SUB_ADMIN_AUDIT_SCAN)
                ).scalars()
            )
            if not raw:
                break
            own_queue_ids = (
                set() if user.is_super_admin else _own_queue_item_ids(db, user.id, raw)
            )
            of_platform = _log_platforms(db, raw) if platform is not None else {}
            for r in raw:
                if not user.is_super_admin and not _audit_log_visible(
                    r, user, owned_ids, owned_emails, own_queue_ids
                ):
                    continue
                if platform is not None:
                    plats = of_platform.get(r.id) or set()
                    # Tập rỗng = việc của tài khoản, không của nhánh nào → hiện ở cả hai.
                    if plats and platform not in plats:
                        continue
                rows.append(r)
                if len(rows) >= limit:
                    break
            if len(rows) >= limit or len(raw) < _SUB_ADMIN_AUDIT_SCAN:
                break
            ts, log_id = raw[-1].timestamp, raw[-1].id

    # Suy tên workspace cho các log gắn workspace (mời/xoá thành viên, workspace…).
    ids: set[UUID] = set()
    for r in rows:
        wid = _workspace_id_of(r)
        if wid:
            try:
                ids.add(UUID(wid))
            except ValueError:
                pass
    names: dict[str, str] = {}
    if ids:
        for wid, wname in db.execute(
            select(Workspace.id, Workspace.name).where(Workspace.id.in_(ids))
        ).all():
            names[str(wid)] = wname

    # Suy email thành viên cho các sự kiện HÀNG LOẠT chỉ lưu `member_ids` (đánh dấu
    # thanh toán / đặt hạn hàng loạt…) — để cột Đối tượng hiện RÕ AI bị ảnh hưởng
    # thay vì chỉ "N thành viên". Cũng suy từ target_id khi target_type=MEMBER mà
    # payload chưa có email (QUEUE_PICKED, MEMBER_REMOVED_SYNCED cũ…). Phân giải lúc
    # đọc → áp cho cả log cũ, không cần migration.
    member_ids: set[UUID] = set()
    for r in rows:
        d = r.data or {}
        if d.get("member_ids") and not d.get("emails"):
            for mid in d["member_ids"]:
                try:
                    member_ids.add(UUID(str(mid)))
                except (ValueError, TypeError):
                    pass
        if r.target_type == "MEMBER" and r.target_id and not _emails_in_log_data(d):
            try:
                member_ids.add(UUID(r.target_id))
            except (ValueError, TypeError):
                pass
    member_emails: dict[str, str] = {}
    if member_ids:
        mem_stmt = select(Member.id, Member.email).where(Member.id.in_(member_ids))
        if not user.is_super_admin:
            mem_stmt = mem_stmt.where(Member.invited_by_user_id == user.id)
        for mid, memail in db.execute(mem_stmt).all():
            member_emails[str(mid)] = memail

    # HOÁ ĐƠN QR → TASK ĐÃ THỰC THI. Một lượt "ví thiếu → quét QR → mời" đẻ ra 3 chỗ
    # ghi: `PAYMENT_ORDER_CREATED` (tạo lệnh), `WALLET_ORDER_CREDITED` (tiền vào ví)
    # và cụm sự kiện của task mời. Hai dòng đầu KHÔNG mang `queue_item_id` nên UI gom
    # nhóm theo task không nhặt được → cùng MỘT việc hiện thành 3 dòng rời (user
    # 2026-08-26). `payment_orders.queue_item_id` mới là liên kết thật (đặt lúc thực
    # thi). Phân giải lúc ĐỌC → gộp được cả nhật ký CŨ, không cần migration và không
    # phải sửa dòng đã ghi.
    order_ids: set[UUID] = set()
    for r in rows:
        oid = _order_id_of(r)
        if oid:
            try:
                order_ids.add(UUID(oid))
            except ValueError:
                pass
    order_queue: dict[str, str] = {}
    order_ref: dict[str, str] = {}
    # Hoá đơn GIA HẠN/ĐỔI HẠN không đi qua hàng đợi: kết quả của nó là một member
    # (`payment_orders.member_id`, đặt lúc thực thi). Giữ lại để nối khoản trừ phí.
    order_member: dict[str, list[tuple[str, datetime]]] = {}
    if order_ids:
        for oid, qid, ref_code, mid, fulfilled in db.execute(
            select(
                PaymentOrder.id,
                PaymentOrder.queue_item_id,
                PaymentOrder.ref_code,
                PaymentOrder.member_id,
                PaymentOrder.fulfilled_at,
            ).where(PaymentOrder.id.in_(order_ids))
        ).all():
            if qid:
                order_queue[str(oid)] = str(qid)
            order_ref[str(oid)] = ref_code
            if mid and fulfilled:
                order_member.setdefault(str(mid), []).append((str(oid), fulfilled))

    def _fee_order_id(log: AuditLog) -> str | None:
        """Hoá đơn QR mà khoản TRỪ PHÍ này thuộc về.

        Ví thiếu → quét QR gia hạn/đổi hạn đẻ ra 3 dòng cùng một giây: tiền QR vào
        ví (`WALLET_ORDER_CREDITED`, neo theo id hoá đơn) và phí trừ ra
        (`WALLET_RENEW_CHARGED`, neo theo `member_id`). Hai khoá khác nhau nên UI
        gom nhóm coi là hai việc rời (user 2026-08-30). Nối lại qua
        `payment_orders.member_id` + `fulfilled_at` — liên kết THẬT, không đoán
        theo thời gian, và gộp được cả nhật ký cũ.
        """
        if log.action.split(":")[0] != "WALLET_RENEW_CHARGED":
            return None
        mid = (log.data or {}).get("member_id")
        if not isinstance(mid, str):
            return None
        ts = log.timestamp
        if ts is not None and ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        for oid, fulfilled in order_member.get(mid, []):
            if fulfilled.tzinfo is None:
                fulfilled = fulfilled.replace(tzinfo=timezone.utc)
            # Trừ phí chạy TRONG cùng transaction với lúc thực thi hoá đơn; nới 5
            # phút cho lệch đồng hồ, đủ chặt để hai lần gia hạn cách nhau không lẫn.
            if ts is not None and abs((ts - fulfilled).total_seconds()) <= 300:
                return oid
        return None

    def _resolved_queue_id(log: AuditLog) -> str | None:
        """queue_item_id của dòng log — kể cả khi chỉ suy ra được qua hoá đơn."""
        qid = _queue_item_id_of(log)
        if qid:
            return qid
        oid = _order_id_of(log)
        return order_queue.get(oid) if oid else None

    # MÃ HOÁ ĐƠN cho cả cụm sự kiện của lệnh. Trang nhật ký hiện mã này cạnh tên
    # workspace thay cho mã hàng đợi — người đối soát tra được thẳng sang khối "Hoá
    # đơn QR" ở panel thành viên và sao kê ngân hàng, còn mã hàng đợi chỉ là id nội
    # bộ (user 2026-08-29). Nối ngược `payment_orders.queue_item_id` → `ref_code`.
    queue_ref: dict[str, str] = {}
    ref_queue_ids: set[UUID] = set()
    for r in rows:
        qid = _resolved_queue_id(r)
        if qid:
            try:
                ref_queue_ids.add(UUID(qid))
            except ValueError:
                pass
    if ref_queue_ids:
        for qid, ref_code in db.execute(
            select(PaymentOrder.queue_item_id, PaymentOrder.ref_code)
            .where(PaymentOrder.queue_item_id.in_(ref_queue_ids))
            .order_by(PaymentOrder.created_at)
        ).all():
            queue_ref[str(qid)] = ref_code  # nhiều hoá đơn/lượt → giữ mã mới nhất

    def _order_ref_code(log: AuditLog, qid: str | None) -> str | None:
        oid = _order_id_of(log)
        if oid and oid in order_ref:
            return order_ref[oid]
        return queue_ref.get(qid) if qid else None

    # Suy email từ payload QueueItem khi audit chỉ có queue_item_id / QUEUE_ITEM
    # (REVOKE_INVITES_QUEUED cũ chỉ lưu count; QUEUE_PICKED không mang email).
    queue_ids: set[UUID] = set()
    for r in rows:
        d = r.data or {}
        if _emails_in_log_data(d):
            continue
        qid = _resolved_queue_id(r)
        if qid:
            try:
                queue_ids.add(UUID(qid))
            except (ValueError, TypeError):
                pass
        elif isinstance(d.get("payload"), dict):
            if _queue_payload_emails(d["payload"]):
                continue
    queue_emails: dict[str, list[str]] = {}
    if queue_ids:
        for qid, payload in db.execute(
            select(QueueItem.id, QueueItem.payload).where(QueueItem.id.in_(queue_ids))
        ).all():
            resolved = _queue_payload_emails(payload)
            if resolved:
                queue_emails[str(qid)] = resolved

    out: list[AuditLogOut] = []
    for r in rows:
        o = AuditLogOut.model_validate(r)
        wid = _workspace_id_of(r)
        o.workspace_name = names.get(wid) if wid else None
        d = dict(r.data or {})
        mutated = False
        row_qid = _resolved_queue_id(r)
        if row_qid and not _queue_item_id_of(r):
            d["queue_item_id"] = row_qid
            mutated = True
        row_order = _fee_order_id(r)
        if row_order and not d.get("order_id"):
            d["order_id"] = row_order
            mutated = True
        row_ref = _order_ref_code(r, row_qid) or (
            order_ref.get(row_order) if row_order else None
        )
        if row_ref and not d.get("order_ref_code"):
            d["order_ref_code"] = row_ref
            mutated = True
        if d.get("member_ids") and not d.get("emails"):
            resolved = [
                member_emails[str(m)]
                for m in d["member_ids"]
                if str(m) in member_emails
            ]
            if resolved:
                d["emails"] = resolved
                mutated = True
        if (
            r.target_type == "MEMBER"
            and r.target_id
            and r.target_id in member_emails
            and not _emails_in_log_data(d)
        ):
            d["email"] = member_emails[r.target_id]
            mutated = True
        if not _emails_in_log_data(d):
            qid = row_qid
            if qid and qid in queue_emails:
                d["emails"] = queue_emails[qid]
                if len(queue_emails[qid]) == 1:
                    d["email"] = queue_emails[qid][0]
                mutated = True
            elif isinstance(d.get("payload"), dict):
                from_payload = _queue_payload_emails(d["payload"])
                if from_payload:
                    d["emails"] = from_payload
                    if len(from_payload) == 1:
                        d["email"] = from_payload[0]
                    mutated = True
        if mutated:
            o.data = d
        out.append(o)
    return out
