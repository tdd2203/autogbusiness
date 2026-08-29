"""Chức năng: GỘP LỆNH CÙNG LOẠI trong hàng đợi để chạy MỘT LƯỢT trên ChatGPT.

Vì sao có file này (user chốt 2026-08-28): hàng đợi chạy tuần tự, mỗi lệnh mời
tốn nguyên một vòng mở tab → F5 → mở hộp mời → gửi → F5 xác minh. Ba lời mời rời
rạc trong cùng workspace phải trả cái giá đó BA lần, dù hộp mời của ChatGPT nhận
được nhiều email trong một lần bấm. Gộp lại thì phần chi phí cố định chỉ trả một
lần.

Luật gộp (nguyên văn yêu cầu):

  - CHỈ gộp lệnh CÙNG LOẠI, CÙNG WORKSPACE, và đều đang CHỜ (`PENDING`).
  - Không cần nằm liền nhau: hàng đợi `mời · gỡ · mời · mời · gỡ · mời` thì ba
    lệnh mời ở vị trí 3, 4, 6 vẫn được gộp với nhau (lệnh 1 đang chạy nên không
    tính), còn hai lệnh gỡ gộp riêng với nhau.
  - RIÊNG lệnh MỜI: tổng số suất của cả mẻ KHÔNG được vượt số suất workspace
    đang còn trống. Vượt thì lệnh đó ở lại hàng đợi chạy sau — mẻ gộp TUYỆT ĐỐI
    không được kéo theo việc mua suất, vì mua suất là tiêu tiền thật và cả mẻ
    sẽ cùng sống chết theo một cú bấm.

Điều KHÔNG đổi khi gộp — và đây là lý do thiết kế đi theo hướng "mỗi lệnh vẫn tự
báo kết quả của chính nó":

  Tiền đi theo TASK (`wallet_transactions.ref_id` = id lệnh mời), bản ghi `Invite`
  cũng gắn `queue_item_id`. Nếu gộp bằng cách bê email của lệnh này sang payload
  lệnh kia thì mọi đường hoàn phí / dọn phantom / void kỳ đã trả đều trỏ sai chỗ.
  Nên ở đây KHÔNG có chuyện đó: payload trong DB của từng lệnh giữ NGUYÊN email
  của nó; chỉ có PHẢN HỒI `/queue/next` mang thêm danh sách gộp để extension chạy
  một lượt, rồi extension PATCH kết quả về CHO TỪNG LỆNH như thể chúng chạy rời.
  Toàn bộ máy móc reconcile ở `queue/completion.py` không phải sửa một dòng nào.

Xem thêm: `queue/execution.py` (nơi gọi), `queue/execution.md` §4.
"""

from dataclasses import dataclass, field
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models import QueueItem, Workspace
from app.services import seats

# Loại lệnh được gộp. Tiêu chí: thao tác trên ChatGPT nhận được NHIỀU email trong
# một lượt (hộp mời), hoặc lặp cùng một thao tác trên cùng một danh sách (gỡ, thu
# hồi) nên gộp chỉ tiết kiệm phần mở tab/điều hướng chứ không đổi ngữ nghĩa.
#
# CỐ Ý KHÔNG gộp: SYNC_* (đã có batch riêng), PURCHASE_SEAT (tiền thật, mỗi lệnh
# một giao dịch), CHANGE_ROLE/CHANGE_LICENSE_TYPE/SET_USAGE_LIMIT (mỗi lệnh một
# giá trị đích khác nhau — gộp không tiết kiệm gì mà rối kết quả).
MERGEABLE_TYPES: frozenset[str] = frozenset(
    {"INVITE_MEMBER", "REMOVE_MEMBER", "REVOKE_INVITES"}
)

# Trần số LỆNH trong một mẻ (kể cả lệnh dẫn đầu). Gộp càng to càng tiết kiệm,
# nhưng cả mẻ chạy trong MỘT lượt gọi content: mẻ hỏng giữa chừng là ngần ấy lệnh
# cùng hỏng, và lượt gọi dài quá thì chạm trần treo của backend. 10 là mức vẫn
# gọn dưới ngưỡng thời gian của cả ba loại (xem hệ số nhân ngưỡng ở execution.py).
MAX_MERGED_TASKS = 10

# Trần riêng cho loại lệnh làm việc TUẦN TỰ từng email (gỡ, thu hồi): cả mẻ chạy
# trong MỘT lượt gọi content, mà một lệnh gỡ tốn 30-60s (lọc → menu → xác nhận →
# chờ biến mất). Mười lệnh là một lượt gọi cả chục phút — dài hơn cả tuổi thọ
# service worker MV3, đúng cái bẫy đã làm ba lệnh mời chết im ngày 26/8/2026.
# Lời mời không dính: cả mẻ chỉ là MỘT lần mở hộp mời.
MAX_MERGED_TASKS_BY_TYPE: dict[str, int] = {
    "REMOVE_MEMBER": 5,
    "REVOKE_INVITES": 5,
}


def max_tasks_for(task_type: str) -> int:
    """Trần số lệnh của một mẻ, theo loại lệnh."""
    return MAX_MERGED_TASKS_BY_TYPE.get(task_type, MAX_MERGED_TASKS)


# Trần số EMAIL trong một mẻ. Hộp mời của ChatGPT dán được nhiều email nhưng danh
# sách quá dài thì bước xác minh (quét tab "Lời mời") tốn thêm nhiều vòng F5.
MAX_MERGED_EMAILS = 25


def payload_emails(payload: dict | None) -> list[str]:
    """Email của một lệnh, theo THỨ TỰ trong payload, đã hạ chữ thường + bỏ trùng.

    Chấp cả hai dạng payload đang tồn tại: `emails` (danh sách) và `email` (một
    email — luồng mời đơn, gỡ, đổi email).
    """
    p = payload or {}
    raw: list = []
    if isinstance(p.get("emails"), list):
        raw = p["emails"]
    elif isinstance(p.get("email"), str):
        raw = [p["email"]]
    out: list[str] = []
    seen: set[str] = set()
    for e in raw:
        if not isinstance(e, str) or "@" not in e:
            continue
        low = e.strip().lower()
        if low and low not in seen:
            seen.add(low)
            out.append(low)
    return out


def merge_signature(item: QueueItem) -> tuple:
    """Hai lệnh chỉ gộp được khi CHỮ KÝ trùng nhau.

    Lệnh mời: hộp mời của ChatGPT đặt MỘT vai trò cho cả lượt gửi ⇒ khác `role` là
    khác lượt. Cờ `reinvite` cũng phải trùng: nó bật thêm bước tiền tố (thu hồi
    lời mời cũ) chạy cho MỌI email trong lượt.

    Các loại còn lại không có tham số nào ngoài email ⇒ chữ ký rỗng.
    """
    p = item.payload or {}
    if item.type == "INVITE_MEMBER":
        return ("INVITE_MEMBER", str(p.get("role") or "member"), p.get("reinvite") is True)
    return (item.type,)


def invite_seat_need(item: QueueItem, emails: list[str]) -> int:
    """Số suất MỚI lệnh mời này chiếm — `new_seat_count` do backend tính lúc tạo
    lệnh (email đang là member `active` không chiếm thêm suất). Lệnh cũ / lệnh đổi
    email không có trường này → đếm đủ số email (thừa còn hơn thiếu: thiếu là gộp
    quá tay rồi phải mua suất giữa mẻ)."""
    raw = (item.payload or {}).get("new_seat_count")
    if isinstance(raw, int) and not isinstance(raw, bool) and raw >= 0:
        return raw
    return len(emails)


@dataclass
class MergePlan:
    """Mẻ gộp đã chốt. `tasks` LUÔN có lệnh dẫn đầu ở vị trí đầu tiên."""

    tasks: list[QueueItem]
    emails_by_task: dict[UUID, list[str]] = field(default_factory=dict)
    #: Tổng suất mới cả mẻ chiếm (chỉ có nghĩa với INVITE_MEMBER).
    seat_need: int = 0
    #: Số suất còn trống dùng để chốt mẻ (None = workspace chưa từng đồng bộ).
    seat_free: int | None = None

    @property
    def followers(self) -> list[QueueItem]:
        return self.tasks[1:]

    @property
    def emails(self) -> list[str]:
        out: list[str] = []
        for t in self.tasks:
            out.extend(self.emails_by_task.get(t.id, []))
        return out

    def __bool__(self) -> bool:
        return len(self.tasks) > 1


def _pending_candidates(db: Session, leader: QueueItem) -> list[QueueItem]:
    """Các lệnh CÙNG LOẠI, CÙNG WORKSPACE còn đang CHỜ — khoá hàng luôn.

    `with_for_update(skip_locked=True)`: hai ô tab cùng gọi `/queue/next` một lúc,
    ô kia đang giữ lệnh nào thì mẻ này bỏ qua lệnh đó thay vì tranh nhau.

    Lệnh chờ super-admin duyệt (`approval_status='pending'`) KHÔNG được gộp —
    cùng một luật với lệnh dẫn đầu ở `pick_next`.
    """
    return list(
        db.execute(
            select(QueueItem)
            .where(
                QueueItem.status == "PENDING",
                QueueItem.workspace_id == leader.workspace_id,
                QueueItem.type == leader.type,
                QueueItem.id != leader.id,
                or_(
                    QueueItem.approval_status.is_(None),
                    QueueItem.approval_status == "approved",
                ),
            )
            .order_by(QueueItem.created_at.asc())
            .limit(MAX_MERGED_TASKS * 3)
            .with_for_update(skip_locked=True)
        )
        .scalars()
        .all()
    )


def plan_merge(db: Session, leader: QueueItem, workspace: Workspace) -> MergePlan:
    """Chốt mẻ gộp cho `leader`. Trả về mẻ chỉ có mình nó nếu không gộp được gì.

    Lệnh dẫn đầu LUÔN chạy — nó là lệnh cũ nhất, đến lượt rồi. Điều kiện suất chỉ
    quyết định có kéo thêm lệnh nào vào cùng hay không.
    """
    leader_emails = payload_emails(leader.payload)
    plan = MergePlan(tasks=[leader], emails_by_task={leader.id: leader_emails})
    if leader.type not in MERGEABLE_TYPES or leader.workspace_id is None:
        return plan
    if not leader_emails:
        # Lệnh không có email nào (payload lạ) — không có gì để gộp cùng.
        return plan

    max_tasks = max_tasks_for(leader.type)
    candidates = [
        c
        for c in _pending_candidates(db, leader)
        if merge_signature(c) == merge_signature(leader)
    ]
    if not candidates:
        return plan

    emails_of: dict[UUID, list[str]] = {c.id: payload_emails(c.payload) for c in candidates}

    seat_free: int | None = None
    seat_need = 0
    if leader.type == "INVITE_MEMBER":
        # Suất còn trống = tổng suất đã đồng bộ − số người đang chiếm chỗ, TRỪ RA
        # email của chính các lệnh đang xét (mỗi lời mời đã có sẵn một bản ghi
        # `pending` trong DB — để nguyên là đếm nó hai lần rồi kết luận thiếu chỗ).
        if workspace.seat_total is None:
            # Chưa từng đồng bộ số suất ⇒ không biết còn trống bao nhiêu ⇒ KHÔNG
            # gộp. Đoán bừa ở đây là đẩy cả mẻ vào cửa mua suất bằng tiền thật.
            return plan
        in_play = list(leader_emails)
        for c in candidates:
            in_play.extend(emails_of[c.id])
        occupied = seats.seat_used(db, leader.workspace_id, exclude_emails=in_play)
        seat_free = max(workspace.seat_total - occupied, 0)
        seat_need = invite_seat_need(leader, leader_emails)
        if seat_need > seat_free:
            # Riêng lệnh dẫn đầu đã phải mua suất → nó chạy MỘT MÌNH. Kéo thêm ai
            # vào đây là bắt cả mẻ đi qua cửa mua suất.
            return plan

    taken_emails = set(leader_emails)
    for c in candidates:
        if len(plan.tasks) >= max_tasks:
            break
        emails = emails_of[c.id]
        if not emails:
            continue
        if taken_emails & set(emails):
            # Cùng một email nằm ở hai lệnh (mời lại chồng lệnh) → KHÔNG gộp: gộp
            # vào là một email hai lần trong cùng lượt gửi, phí và bản ghi của hai
            # lệnh không còn tách bạch được nữa. Lệnh sau chạy riêng như cũ.
            continue
        if len(taken_emails) + len(emails) > MAX_MERGED_EMAILS:
            continue
        if leader.type == "INVITE_MEMBER":
            need = invite_seat_need(c, emails)
            if seat_need + need > (seat_free or 0):
                # Không đủ chỗ cho lệnh này → ĐỂ LẠI chạy sau (đúng yêu cầu user),
                # vẫn xét tiếp các lệnh nhỏ hơn phía sau.
                continue
            seat_need += need
        plan.tasks.append(c)
        plan.emails_by_task[c.id] = emails
        taken_emails.update(emails)

    plan.seat_need = seat_need
    plan.seat_free = seat_free
    return plan


def merged_response_payload(
    db: Session, leader: QueueItem, plan: MergePlan, workspace: Workspace
) -> dict:
    """Payload gửi CHO EXTENSION của mẻ gộp (KHÔNG ghi vào DB — xem docstring đầu file).

    Giữ nguyên mọi trường của lệnh dẫn đầu, thay phần email bằng danh sách gộp và
    đính `merged_tasks` để extension biết phải báo kết quả về cho những lệnh nào,
    email nào thuộc lệnh nào.
    """
    emails = plan.emails
    # Bỏ mọi trường chỉ đúng cho MỘT email của lệnh dẫn đầu (`email`, `member_id`):
    # để lại trong payload của cả mẻ là mời người đọc hiểu nhầm nó áp cho cả mẻ.
    payload = {
        k: v
        for k, v in (leader.payload or {}).items()
        if k not in ("email", "member_id")
    }
    payload["emails"] = emails
    payload["merged_tasks"] = [
        {"id": str(t.id), "emails": plan.emails_by_task.get(t.id, [])} for t in plan.tasks
    ]
    if leader.type == "INVITE_MEMBER":
        payload["new_seat_count"] = plan.seat_need
        # Gợi ý suất phải tính lại cho ĐÚNG tập email của cả mẻ (loại email của
        # chính mẻ ra khỏi phần "đang chiếm chỗ") — cùng ngữ nghĩa với
        # `members/invite._seat_hint`, nếu để hint của riêng lệnh dẫn đầu thì
        # extension đếm thiếu chỗ trống rồi mở hộp "Quản lý suất" vô ích.
        payload["seat_hint"] = {
            "total": workspace.seat_total,
            "occupied": seats.seat_used(db, workspace.id, exclude_emails=emails),
            "pending": seats.pending_count(db, workspace.id, exclude_emails=emails),
        }
    return payload
