"""phí mời 2 tầng (users.invite_fee_vnd) + payment_orders + bật luồng ORDER + default 380k

Revision ID: 0033_invite_fee_and_orders
Revises: 0032_preserve_wallet_history
Create Date: 2026-07-13

Feature 003 (bổ sung — user 2026-07-13):
- Phí mời/gia hạn 2 tầng: mặc định theo user (đại lý) `users.invite_fee_vnd`, override
  theo member `members.fee_vnd`, fallback global `payment_settings.invite_fee_vnd`.
- Đổi phí mặc định toàn hệ thống 100k → 380k (chỉ đụng row còn để nguyên 100k cũ).
- `payment_orders`: hoá đơn QR cho mời/gia hạn khi ví không đủ (mã ORDER). Bật luồng
  'order' trong payment_codes (nhận diện + có consumer thực thi mời/gia hạn khi trả tiền).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0033_invite_fee_and_orders"
down_revision: Union[str, None] = "0032_preserve_wallet_history"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    # ── 1) Phí mặc định của riêng user (đại lý) ──────────────────────────────
    op.add_column("users", sa.Column("invite_fee_vnd", sa.BigInteger(), nullable=True))
    op.create_check_constraint(
        "ck_users_fee_nonneg", "users", "invite_fee_vnd IS NULL OR invite_fee_vnd >= 0"
    )

    # ── 2) Đổi phí mặc định toàn hệ thống 100k → 380k ────────────────────────
    op.alter_column(
        "payment_settings",
        "invite_fee_vnd",
        existing_type=sa.BigInteger(),
        server_default="380000",
    )
    # Chỉ nâng row còn để nguyên default cũ 100k; KHÔNG đụng nếu admin đã tuỳ chỉnh.
    op.execute(
        sa.text("UPDATE payment_settings SET invite_fee_vnd = 380000 WHERE id = 1 AND invite_fee_vnd = 100000")
    )

    # ── 3) Bật luồng 'order' trong payment_codes ─────────────────────────────
    # (a) flip enabled=true + cập nhật nhãn cho phần tử order đã có.
    op.execute(
        sa.text(
            "UPDATE payment_settings SET payment_codes = ("
            "  SELECT jsonb_agg("
            "    CASE WHEN e->>'key' = 'order' "
            "         THEN e || '{\"enabled\": true, \"label\": \"Thanh toán hoá đơn (mời/gia hạn)\"}'::jsonb "
            "         ELSE e END"
            "  ) FROM jsonb_array_elements(payment_codes) e"
            ") WHERE payment_codes IS NOT NULL AND payment_codes @> '[{\"key\": \"order\"}]'"
        )
    )
    # (b) thêm luồng order nếu chưa có (row cũ chỉ có topup).
    op.execute(
        sa.text(
            "UPDATE payment_settings SET payment_codes = payment_codes || "
            "'[{\"key\": \"order\", \"label\": \"Thanh toán hoá đơn (mời/gia hạn)\", \"prefix\": \"ORDER\", "
            "\"suffix_min\": 6, \"suffix_max\": 30, \"suffix_type\": \"alphanumeric\", \"enabled\": true}]'::jsonb "
            "WHERE payment_codes IS NOT NULL AND NOT (payment_codes @> '[{\"key\": \"order\"}]')"
        )
    )

    # ── 4) Bảng payment_orders ───────────────────────────────────────────────
    op.create_table(
        "payment_orders",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column(
            "user_id", _UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column(
            "workspace_id", _UUID, sa.ForeignKey("workspaces.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("ref_code", sa.String(32), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("amount_vnd", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("payload", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("paid_amount_vnd", sa.BigInteger(), nullable=True),
        sa.Column("provider_txn_id", sa.String(64), nullable=True),
        sa.Column(
            "transaction_id", _UUID,
            sa.ForeignKey("wallet_transactions.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column(
            "queue_item_id", _UUID,
            sa.ForeignKey("queue_items.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column(
            "member_id", _UUID,
            sa.ForeignKey("members.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("fulfilled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("fulfillment_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("ref_code", name="uq_payment_orders_ref_code"),
        sa.CheckConstraint("amount_vnd > 0", name="ck_payment_orders_amount_pos"),
    )
    op.create_index("ix_payment_orders_user_id", "payment_orders", ["user_id"])
    op.create_index("ix_payment_orders_ref_code", "payment_orders", ["ref_code"])
    op.create_index("ix_payment_orders_kind", "payment_orders", ["kind"])
    op.create_index("ix_payment_orders_status", "payment_orders", ["status"])
    op.create_index("ix_payment_orders_created_at", "payment_orders", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_payment_orders_created_at", table_name="payment_orders")
    op.drop_index("ix_payment_orders_status", table_name="payment_orders")
    op.drop_index("ix_payment_orders_kind", table_name="payment_orders")
    op.drop_index("ix_payment_orders_ref_code", table_name="payment_orders")
    op.drop_index("ix_payment_orders_user_id", table_name="payment_orders")
    op.drop_table("payment_orders")

    # Tắt lại luồng order (giữ nhãn cũ).
    op.execute(
        sa.text(
            "UPDATE payment_settings SET payment_codes = ("
            "  SELECT jsonb_agg("
            "    CASE WHEN e->>'key' = 'order' THEN e || '{\"enabled\": false}'::jsonb ELSE e END"
            "  ) FROM jsonb_array_elements(payment_codes) e"
            ") WHERE payment_codes IS NOT NULL AND payment_codes @> '[{\"key\": \"order\"}]'"
        )
    )
    op.alter_column(
        "payment_settings",
        "invite_fee_vnd",
        existing_type=sa.BigInteger(),
        server_default="100000",
    )
    op.drop_constraint("ck_users_fee_nonneg", "users", type_="check")
    op.drop_column("users", "invite_fee_vnd")
