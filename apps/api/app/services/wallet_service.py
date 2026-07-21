"""wallet_service — ĐIỂM VÀO DUY NHẤT thay đổi số dư Ví.

⚠️ Mọi cộng/trừ số dư PHẢI đi qua module này. KHÔNG sửa `Wallet.balance/held`
trực tiếp ở router. Bảo đảm:
  - Atomic + an toàn đồng thời: khoá dòng ví bằng `SELECT ... FOR UPDATE` trước
    khi đọc-sửa-ghi (Nguyên tắc V — cùng tinh thần SKIP LOCKED của queue).
  - Bất biến: balance ≥ 0 và held ≥ 0 mọi lúc (raise `InsufficientBalance` nếu vi phạm).
  - Sổ cái bất biến: mỗi lần đổi = 1 dòng `WalletTransaction(balance_after, held_after)`.
  - Audit: mỗi thay đổi ghi `audit_logs` (Nguyên tắc I).

Các hàm KHÔNG commit — caller quản transaction (thường commit chung với side-effect
nghiệp vụ như tạo QueueItem/Invite để đảm bảo "trừ phí và enqueue" nguyên tử).
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.audit import log_event
from app.models import User, Wallet, WalletTransaction, WithdrawalRequest


class InsufficientBalance(Exception):
    """Số dư khả dụng không đủ cho thao tác trừ/giữ."""

    def __init__(self, available: int, requested: int) -> None:
        self.available = int(available)
        self.requested = int(requested)
        self.shortfall = max(0, self.requested - self.available)
        super().__init__(
            f"Insufficient balance: available={self.available}, "
            f"requested={self.requested}, shortfall={self.shortfall}"
        )


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def get_or_create_wallet(db: Session, user_id: UUID) -> Wallet:
    """Trả ví của user, tạo lazy (0đ) nếu chưa có. KHÔNG khoá — chỉ đọc/tạo."""
    wallet = db.execute(
        select(Wallet).where(Wallet.user_id == user_id)
    ).scalar_one_or_none()
    if wallet is None:
        wallet = Wallet(user_id=user_id, balance=0, held=0)
        db.add(wallet)
        db.flush()
    return wallet


def _lock_wallet(db: Session, user_id: UUID) -> Wallet:
    """Đảm bảo ví tồn tại rồi KHOÁ dòng (FOR UPDATE) để đọc-sửa-ghi nguyên tử."""
    get_or_create_wallet(db, user_id)
    return db.execute(
        select(Wallet).where(Wallet.user_id == user_id).with_for_update()
    ).scalar_one()


def available_balance(db: Session, user_id: UUID, *, lock: bool = False) -> int:
    """Số dư KHẢ DỤNG của ví. `lock=True` khoá dòng (FOR UPDATE) để giữ nguyên
    tới hết transaction — dùng khi quyết định trừ-ví-hay-tạo-QR phải nguyên tử với
    thao tác trừ phí ngay sau đó (feature 003: ví trước, QR sau)."""
    wallet = _lock_wallet(db, user_id) if lock else get_or_create_wallet(db, user_id)
    return int(wallet.balance)


def _write_txn(
    db: Session,
    wallet: Wallet,
    *,
    kind: str,
    amount: int,
    held_delta: int = 0,
    ref_type: str | None = None,
    ref_id: str | None = None,
    meta: dict | None = None,
    actor_id: UUID | None = None,
    actor_type: str = "SYSTEM",
    actor_label: str | None = None,
    action: str,
    audit_data: dict | None = None,
) -> WalletTransaction:
    """Ghi 1 giao dịch trên ví ĐÃ KHOÁ. Enforce balance/held ≥ 0 + audit.

    `amount` có dấu (cộng/trừ khả dụng). `held_delta` chuyển tiền vào/ra vùng giữ.
    """
    new_balance = wallet.balance + amount
    new_held = wallet.held + held_delta
    if new_balance < 0:
        raise InsufficientBalance(available=wallet.balance, requested=-amount)
    if new_held < 0:
        # Bất biến nội bộ (không nên xảy ra nếu logic đúng) — tránh held âm.
        raise ValueError("held would go negative")
    wallet.balance = new_balance
    wallet.held = new_held
    wallet.updated_at = _utcnow()
    db.add(wallet)
    txn = WalletTransaction(
        wallet_id=wallet.id,
        user_id=wallet.user_id,
        kind=kind,
        amount=amount,
        balance_after=new_balance,
        held_after=new_held,
        ref_type=ref_type,
        ref_id=ref_id,
        meta=meta,
        actor_id=actor_id,
    )
    db.add(txn)
    db.flush()
    data = {
        "wallet_id": str(wallet.id),
        "user_id": str(wallet.user_id),
        "kind": kind,
        "amount": amount,
        "balance_after": new_balance,
        "held_after": new_held,
        "ref_type": ref_type,
        "ref_id": ref_id,
    }
    if audit_data:
        data.update(audit_data)
    log_event(
        db,
        actor_type=actor_type,
        actor_id=actor_id,
        actor_label=actor_label,
        action=action,
        result="SUCCESS",
        target_type="WALLET",
        target_id=str(wallet.id),
        data=data,
        commit=False,
    )
    return txn


# ── Nạp tiền (topup) ─────────────────────────────────────────────────────────

def credit_topup(
    db: Session,
    user_id: UUID,
    amount: int,
    *,
    ref_id: str,
    provider_txn_id: str | None = None,
) -> WalletTransaction:
    """Cộng tiền nạp vào ví (gọi từ webhook SePay `on_paid`). Ví bị khoá dòng."""
    wallet = _lock_wallet(db, user_id)
    return _write_txn(
        db,
        wallet,
        kind="topup",
        amount=int(amount),
        ref_type="topup",
        ref_id=ref_id,
        meta={"provider_txn_id": provider_txn_id} if provider_txn_id else None,
        actor_type="SYSTEM",
        actor_label="sepay-webhook",
        action="WALLET_TOPUP_CREDITED",
    )


def credit_order_payment(
    db: Session,
    user_id: UUID,
    amount: int,
    *,
    ref_id: str,
    provider_txn_id: str | None = None,
) -> WalletTransaction:
    """Cộng tiền QR hoá đơn (mã ORDER) vào ví — bước 1 của luồng "ví trước, QR sau"
    khi ví KHÔNG đủ (feature 003). Sau khi credit, caller trừ phí mời/gia hạn ngay
    (net ví = paid − fee). Nếu action lỗi → phí không trừ/hoàn về ví → tiền QR ở lại
    ví. `ref_id` = payment_orders.id."""
    wallet = _lock_wallet(db, user_id)
    return _write_txn(
        db,
        wallet,
        kind="order_topup",
        amount=int(amount),
        ref_type="order",
        ref_id=ref_id,
        meta={"provider_txn_id": provider_txn_id} if provider_txn_id else None,
        actor_type="SYSTEM",
        actor_label="sepay-webhook",
        action="WALLET_ORDER_CREDITED",
    )


# ── Phí mời + hoàn phí ──────────────────────────────────────────────────────

def charge_invite(
    db: Session,
    user: User,
    queue_item_id: UUID,
    email_fees: list[tuple[str, int]],
) -> list[WalletTransaction]:
    """Trừ phí mời: 1 giao dịch `invite_fee` / email với phí RIÊNG của email đó
    (amount = -fee). Phí per-member (feature 003): caller đã resolve
    COALESCE(member.fee_vnd, default) cho từng email.

    Kiểm TỔNG phí trước (atomic, ví khoá dòng) — thiếu thì raise `InsufficientBalance`
    và KHÔNG ghi giao dịch nào (caller rollback). Mỗi giao dịch gắn ref_id=queue_item
    + meta.email để refund theo email lẻ (refund dùng amount đã lưu → phí biến thiên
    vẫn hoàn đúng).
    """
    norm = [(str(e).lower(), int(f)) for e, f in email_fees]
    total = sum(f for _, f in norm)
    wallet = _lock_wallet(db, user.id)
    if wallet.balance < total:
        raise InsufficientBalance(available=wallet.balance, requested=total)
    txns: list[WalletTransaction] = []
    for email, fee in norm:
        txns.append(
            _write_txn(
                db,
                wallet,
                kind="invite_fee",
                amount=-fee,
                ref_type="invite",
                ref_id=str(queue_item_id),
                meta={"email": email, "fee": fee},
                actor_id=user.id,
                actor_type="ADMIN",
                actor_label=user.email,
                action="WALLET_INVITE_CHARGED",
                audit_data={"email": email, "fee": fee, "queue_item_id": str(queue_item_id)},
            )
        )
    return txns


def charge_renew(
    db: Session,
    user: User,
    member_id: UUID,
    fee: int,
    *,
    email: str | None = None,
) -> WalletTransaction:
    """Trừ phí GIA HẠN (1 giao dịch `renew_fee`, amount = -fee). Phí per-member
    (feature 003 — user 2026-07-13: mã hoá đơn dùng cho cả gia hạn). Ví khoá dòng,
    thiếu → `InsufficientBalance` (không ghi gì). ref_id = member_id."""
    fee = int(fee)
    wallet = _lock_wallet(db, user.id)
    if wallet.balance < fee:
        raise InsufficientBalance(available=wallet.balance, requested=fee)
    return _write_txn(
        db,
        wallet,
        kind="renew_fee",
        amount=-fee,
        ref_type="renew",
        ref_id=str(member_id),
        meta={"member_id": str(member_id), "email": email, "fee": fee},
        actor_id=user.id,
        actor_type="ADMIN",
        actor_label=user.email,
        action="WALLET_RENEW_CHARGED",
        audit_data={"member_id": str(member_id), "email": email, "fee": fee},
    )


def refund_invite(
    db: Session,
    queue_item_id: UUID,
    emails: list[str] | None = None,
) -> int:
    """Hoàn phí các lời mời thất bại — IDEMPOTENT (mỗi invite_fee hoàn ≤ 1 lần).

    `emails=None` → hoàn MỌI invite_fee của queue_item (task FAILED toàn bộ).
    `emails=[...]` → chỉ hoàn các email đó (COMPLETED nhưng 1 số email không verify).

    Dùng `UPDATE ... SET reversed=true WHERE reversed=false RETURNING ...` để chốt
    tập cần hoàn nguyên tử; gọi lại cũng không hoàn 2 lần. Trả tổng số tiền đã hoàn.
    """
    sql = (
        "UPDATE wallet_transactions SET reversed = true "
        "WHERE ref_id = :ref AND kind = 'invite_fee' AND reversed = false"
    )
    params: dict = {"ref": str(queue_item_id)}
    if emails is not None:
        norm = [str(e).lower() for e in emails]
        if not norm:
            return 0
        sql += " AND lower(meta->>'email') = ANY(:emails)"
        params["emails"] = norm
    sql += " RETURNING user_id, amount, meta"
    rows = db.execute(text(sql), params).mappings().all()
    if not rows:
        return 0
    total_refunded = 0
    # Gom theo user để khoá ví 1 lần / user.
    by_user: dict[UUID, list[dict]] = {}
    for r in rows:
        by_user.setdefault(r["user_id"], []).append(dict(r))
    for user_id, items in by_user.items():
        if user_id is None:
            continue
        wallet = _lock_wallet(db, user_id)
        for it in items:
            fee = -int(it["amount"])  # amount là số âm → phí dương
            email = (it["meta"] or {}).get("email")
            _write_txn(
                db,
                wallet,
                kind="invite_refund",
                amount=fee,
                ref_type="invite",
                ref_id=str(queue_item_id),
                meta={"email": email},
                actor_type="SYSTEM",
                actor_label="invite-refund",
                action="WALLET_INVITE_REFUNDED",
                audit_data={"email": email, "fee": fee, "queue_item_id": str(queue_item_id)},
            )
            total_refunded += fee
    return total_refunded


# ── Rút tiền (hold → settle/refund) ─────────────────────────────────────────

def create_withdrawal_hold(
    db: Session,
    user: User,
    request: WithdrawalRequest,
) -> WalletTransaction:
    """Giữ (hold) số tiền rút: balance -= X, held += X. Raise nếu không đủ khả dụng."""
    amount = int(request.amount_vnd)
    wallet = _lock_wallet(db, user.id)
    if wallet.balance < amount:
        raise InsufficientBalance(available=wallet.balance, requested=amount)
    return _write_txn(
        db,
        wallet,
        kind="withdraw_hold",
        amount=-amount,
        held_delta=amount,
        ref_type="withdrawal",
        ref_id=str(request.id),
        actor_id=user.id,
        actor_type="ADMIN",
        actor_label=user.email,
        action="WALLET_WITHDRAW_HOLD",
        audit_data={"amount": amount, "withdrawal_id": str(request.id)},
    )


def settle_withdrawal(
    db: Session,
    request: WithdrawalRequest,
    actor: User,
) -> WalletTransaction:
    """Super-admin xác nhận đã chi: held -= X (tiền rời ví). Khả dụng không đổi."""
    amount = int(request.amount_vnd)
    wallet = _lock_wallet(db, request.user_id)
    return _write_txn(
        db,
        wallet,
        kind="withdraw_settle",
        amount=0,
        held_delta=-amount,
        ref_type="withdrawal",
        ref_id=str(request.id),
        actor_id=actor.id,
        actor_type="ADMIN",
        actor_label=actor.email,
        action="WALLET_WITHDRAW_SETTLED",
        audit_data={"amount": amount, "withdrawal_id": str(request.id)},
    )


def reject_withdrawal(
    db: Session,
    request: WithdrawalRequest,
    actor: User,
) -> WalletTransaction:
    """Super-admin từ chối: held -= X, balance += X (hoàn khả dụng)."""
    amount = int(request.amount_vnd)
    wallet = _lock_wallet(db, request.user_id)
    return _write_txn(
        db,
        wallet,
        kind="withdraw_refund",
        amount=amount,
        held_delta=-amount,
        ref_type="withdrawal",
        ref_id=str(request.id),
        actor_id=actor.id,
        actor_type="ADMIN",
        actor_label=actor.email,
        action="WALLET_WITHDRAW_REFUNDED",
        audit_data={"amount": amount, "withdrawal_id": str(request.id)},
    )


# ── Điều chỉnh thủ công (super-admin nạp demo) ──────────────────────────────

def adjust(
    db: Session,
    user_id: UUID,
    amount: int,
    *,
    actor: User,
    reason: str | None = None,
) -> WalletTransaction:
    """Super-admin cộng/trừ số dư thủ công (vd nạp demo cho tài khoản test)."""
    wallet = _lock_wallet(db, user_id)
    return _write_txn(
        db,
        wallet,
        kind="adjust",
        amount=int(amount),
        actor_id=actor.id,
        actor_type="ADMIN",
        actor_label=actor.email,
        action="WALLET_ADJUSTED",
        meta={"reason": reason} if reason else None,
        audit_data={"amount": int(amount), "reason": reason},
    )
