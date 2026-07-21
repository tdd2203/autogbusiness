"""wallet & sepay payment — ví, giao dịch, nạp, rút, chống trùng webhook, cấu hình

Revision ID: 0028_wallet
Revises: 0027_member_subscription_cycle
Create Date: 2026-07-12

Feature 003-wallet-invite-payment: thêm Ví cho user + tích hợp nạp SePay + bắt
buộc trừ phí khi mời. Xem specs/003-wallet-invite-payment/data-model.md.

Bất biến enforce bằng CHECK: balance/held ≥ 0, amount nạp/rút > 0, payment_settings
là singleton (id=1). Seed 1 dòng payment_settings mặc định (phí từ env, default 100k).
"""

import os
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0028_wallet"
down_revision: Union[str, None] = "0027_member_subscription_cycle"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # users.wallet_beta
    op.add_column(
        "users",
        sa.Column(
            "wallet_beta", sa.Boolean(), nullable=False, server_default="false"
        ),
    )

    # members.fee_vnd — phí mời riêng theo member (NULL = dùng phí mặc định)
    op.add_column("members", sa.Column("fee_vnd", sa.BigInteger(), nullable=True))
    op.create_check_constraint(
        "ck_members_fee_nonneg", "members", "fee_vnd IS NULL OR fee_vnd >= 0"
    )

    # wallets
    op.create_table(
        "wallets",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("balance", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("held", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", name="uq_wallets_user"),
        sa.CheckConstraint("balance >= 0", name="ck_wallets_balance_nonneg"),
        sa.CheckConstraint("held >= 0", name="ck_wallets_held_nonneg"),
    )
    op.create_index("ix_wallets_user_id", "wallets", ["user_id"])

    # wallet_transactions
    op.create_table(
        "wallet_transactions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "wallet_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("wallets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column("balance_after", sa.BigInteger(), nullable=False),
        sa.Column("held_after", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("ref_type", sa.String(24), nullable=True),
        sa.Column("ref_id", sa.String(64), nullable=True),
        sa.Column("meta", postgresql.JSONB(), nullable=True),
        sa.Column("reversed", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column(
            "actor_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_wallet_transactions_wallet_id", "wallet_transactions", ["wallet_id"])
    op.create_index("ix_wallet_transactions_user_id", "wallet_transactions", ["user_id"])
    op.create_index("ix_wallet_transactions_kind", "wallet_transactions", ["kind"])
    op.create_index("ix_wallet_transactions_ref_id", "wallet_transactions", ["ref_id"])
    op.create_index("ix_wallet_transactions_reversed", "wallet_transactions", ["reversed"])
    op.create_index("ix_wallet_transactions_created_at", "wallet_transactions", ["created_at"])

    # topup_orders
    op.create_table(
        "topup_orders",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("ref_code", sa.String(24), nullable=False),
        sa.Column("amount_vnd", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("paid_amount_vnd", sa.BigInteger(), nullable=True),
        sa.Column("provider_txn_id", sa.String(64), nullable=True),
        sa.Column(
            "transaction_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("wallet_transactions.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("ref_code", name="uq_topup_orders_ref_code"),
        sa.CheckConstraint("amount_vnd > 0", name="ck_topup_amount_pos"),
    )
    op.create_index("ix_topup_orders_user_id", "topup_orders", ["user_id"])
    op.create_index("ix_topup_orders_ref_code", "topup_orders", ["ref_code"])
    op.create_index("ix_topup_orders_status", "topup_orders", ["status"])
    op.create_index("ix_topup_orders_created_at", "topup_orders", ["created_at"])

    # withdrawal_requests
    op.create_table(
        "withdrawal_requests",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("amount_vnd", sa.BigInteger(), nullable=False),
        sa.Column("bank_account", sa.String(255), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("reject_reason", sa.Text(), nullable=True),
        sa.Column(
            "hold_txn_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("wallet_transactions.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "settle_txn_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("wallet_transactions.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "reviewed_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("amount_vnd > 0", name="ck_withdrawal_amount_pos"),
    )
    op.create_index("ix_withdrawal_requests_user_id", "withdrawal_requests", ["user_id"])
    op.create_index("ix_withdrawal_requests_status", "withdrawal_requests", ["status"])
    op.create_index("ix_withdrawal_requests_created_at", "withdrawal_requests", ["created_at"])

    # sepay_idem
    op.create_table(
        "sepay_idem",
        sa.Column("key", sa.String(128), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    # payment_settings (singleton)
    op.create_table(
        "payment_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("invite_fee_vnd", sa.BigInteger(), nullable=False, server_default="100000"),
        sa.Column("bank_name", sa.String(64), nullable=True),
        sa.Column("account_number", sa.String(64), nullable=True),
        sa.Column("account_name", sa.String(255), nullable=True),
        sa.Column("code_prefix", sa.String(8), nullable=False, server_default="NAP"),
        sa.Column("amount_tolerance_vnd", sa.BigInteger(), nullable=False, server_default="1000"),
        sa.Column(
            "updated_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("id = 1", name="ck_payment_settings_singleton"),
        sa.CheckConstraint("invite_fee_vnd >= 0", name="ck_payment_settings_fee_nonneg"),
    )
    default_fee = int(os.getenv("WALLET_INVITE_FEE_DEFAULT", "100000") or "100000")
    op.execute(
        sa.text(
            "INSERT INTO payment_settings (id, invite_fee_vnd, code_prefix, amount_tolerance_vnd) "
            "VALUES (1, :fee, 'NAP', 1000) ON CONFLICT (id) DO NOTHING"
        ).bindparams(fee=default_fee)
    )


def downgrade() -> None:
    op.drop_table("payment_settings")
    op.drop_table("sepay_idem")
    op.drop_index("ix_withdrawal_requests_created_at", table_name="withdrawal_requests")
    op.drop_index("ix_withdrawal_requests_status", table_name="withdrawal_requests")
    op.drop_index("ix_withdrawal_requests_user_id", table_name="withdrawal_requests")
    op.drop_table("withdrawal_requests")
    op.drop_index("ix_topup_orders_created_at", table_name="topup_orders")
    op.drop_index("ix_topup_orders_status", table_name="topup_orders")
    op.drop_index("ix_topup_orders_ref_code", table_name="topup_orders")
    op.drop_index("ix_topup_orders_user_id", table_name="topup_orders")
    op.drop_table("topup_orders")
    op.drop_index("ix_wallet_transactions_created_at", table_name="wallet_transactions")
    op.drop_index("ix_wallet_transactions_reversed", table_name="wallet_transactions")
    op.drop_index("ix_wallet_transactions_ref_id", table_name="wallet_transactions")
    op.drop_index("ix_wallet_transactions_kind", table_name="wallet_transactions")
    op.drop_index("ix_wallet_transactions_user_id", table_name="wallet_transactions")
    op.drop_index("ix_wallet_transactions_wallet_id", table_name="wallet_transactions")
    op.drop_table("wallet_transactions")
    op.drop_index("ix_wallets_user_id", table_name="wallets")
    op.drop_table("wallets")
    op.drop_constraint("ck_members_fee_nonneg", "members", type_="check")
    op.drop_column("members", "fee_vnd")
    op.drop_column("users", "wallet_beta")
