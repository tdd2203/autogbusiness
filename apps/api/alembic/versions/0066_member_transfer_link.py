"""gói lịch sử CHUYỂN HẠN vào cột thật (email gốc + chuyển từ/đến)

Revision ID: 0066_member_transfer_link
Revises: 0065_invite_cap_message
Create Date: 2026-09-04

Trước đây "email này thay cho email nào" CHỈ nằm trong nhật ký `MEMBER_EMAIL_CHANGED`
(`data.old_member_id` → `target_id`). Mọi thứ cần biết chuỗi cũ→mới — mũi tên ở tab
"Đã xoá", ô gộp tiền của email cũ, kế thừa trạng thái thanh toán, timeline hai chiều —
đều phải dò lại nhật ký, mỗi nơi dò một kiểu, và `MEMBER_SUBSCRIPTION_TRANSFERRED`
(chuyển hạn) thì KHÔNG nơi nào đọc. Gộp hai chức năng về một ("Chuyển hạn sử dụng
đến") mà giữ nguyên cách đó là mất trắng chuỗi lẫn tiền.

Nay danh tính người dùng nằm THẲNG trên bản ghi:

  - origin_email: email GỐC của người dùng — đầu chuỗi A→B→C. NULL = chính nó là gốc.
    Đây cũng là chốt chặn "một người dùng chỉ được chuyển hạn 1 lần": dòng nào đã có
    origin_email nghĩa là nó vốn sinh ra từ một lần chuyển ⇒ không được chuyển tiếp.
  - transferred_from_member_id / _email / transferred_in_at: dòng đã trao hạn CHO nó
    (chỉ ghi khi email nhận TIẾP QUẢN danh tính, tức có mời email nhận vào).
  - transferred_to_member_id / _email / transferred_out_at: dòng đã NHẬN hạn từ nó.
    Ghi cho CẢ hai kiểu chuyển, nên ca "cộng dồn vào một email đang dùng" tra ngược
    được bằng transferred_to_member_id (index) — email nhận cộng dồn giữ nguyên danh
    tính của chính mình nên KHÔNG bị ghi origin_email.
  - transfer_kind: 'takeover' (email nhận tiếp quản, có mời) | 'accumulate' (cộng dồn
    vào email đang dùng). Ghi trên dòng CHO.

Backfill từ nhật ký cũ (`MEMBER_EMAIL_CHANGED` + `MEMBER_SUBSCRIPTION_TRANSFERRED`)
theo thứ tự thời gian để chuỗi nhiều chặng ra đúng email gốc, không thì lịch sử của
52 lần đổi email đã có bị đứt ngay khi giao diện chuyển sang đọc cột.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0066_member_transfer_link"
down_revision: Union[str, None] = "0065_invite_cap_message"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Backfill: đi theo THỨ TỰ THỜI GIAN của nhật ký. Mỗi lần chuyển ghi 2 đầu; email gốc
# của dòng nhận = email gốc của dòng cho (nếu dòng cho đã là kết quả của lần chuyển
# trước) hoặc chính email dòng cho. `will_invite = false` (cộng dồn) chỉ ghi đầu CHO.
_BACKFILL = """
DO $$
DECLARE
    r RECORD;
    src_origin TEXT;
    src_id UUID;
    dst_id UUID;
BEGIN
    FOR r IN
        SELECT a.timestamp AS ts,
               COALESCE(a.data->>'old_member_id', a.data->>'source_member_id') AS src_id,
               a.target_id AS dst_id,
               COALESCE(a.data->>'old_email', a.data->>'source_email') AS src_email,
               COALESCE(a.data->>'new_email', a.data->>'target_email') AS dst_email,
               CASE
                   WHEN a.action = 'MEMBER_EMAIL_CHANGED' THEN TRUE
                   ELSE COALESCE((a.data->>'will_invite')::boolean, TRUE)
               END AS takeover
        FROM audit_logs a
        WHERE a.action IN ('MEMBER_EMAIL_CHANGED', 'MEMBER_SUBSCRIPTION_TRANSFERRED')
          AND COALESCE(a.data->>'old_member_id', a.data->>'source_member_id') IS NOT NULL
          AND a.target_id IS NOT NULL
        ORDER BY a.timestamp
    LOOP
        BEGIN
            src_id := r.src_id::uuid;
            dst_id := r.dst_id::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
            -- target_id của log cũ không phải uuid (log cấp workspace) → bỏ qua.
            CONTINUE;
        END;

        -- Bản ghi đã bị XOÁ CỨNG sau 30 ngày (retention) thì không còn chỗ nào để
        -- ghi/để trỏ tới: bỏ id đi chứ đừng để khoá ngoại nổ giữa lượt backfill.
        IF NOT EXISTS (SELECT 1 FROM members WHERE id = src_id) THEN
            CONTINUE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM members WHERE id = dst_id) THEN
            -- Vẫn giữ EMAIL nhận để mũi tên "đã chuyển sang ai" còn đọc được.
            UPDATE members
               SET transferred_to_email = r.dst_email,
                   transferred_out_at = r.ts,
                   transfer_kind = CASE WHEN r.takeover THEN 'takeover' ELSE 'accumulate' END
             WHERE id = src_id;
            CONTINUE;
        END IF;

        UPDATE members
           SET transferred_to_member_id = dst_id,
               transferred_to_email = r.dst_email,
               transferred_out_at = r.ts,
               transfer_kind = CASE WHEN r.takeover THEN 'takeover' ELSE 'accumulate' END
         WHERE id = src_id;

        IF r.takeover THEN
            SELECT COALESCE(origin_email, email) INTO src_origin
              FROM members WHERE id = src_id;
            UPDATE members
               SET transferred_from_member_id = src_id,
                   transferred_from_email = r.src_email,
                   transferred_in_at = r.ts,
                   origin_email = COALESCE(src_origin, r.src_email)
             WHERE id = dst_id;
        END IF;
    END LOOP;
END $$;
"""


def upgrade() -> None:
    op.add_column("members", sa.Column("origin_email", sa.String(length=255), nullable=True))
    op.add_column(
        "members",
        sa.Column("transferred_from_member_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "members", sa.Column("transferred_from_email", sa.String(length=255), nullable=True)
    )
    op.add_column(
        "members", sa.Column("transferred_in_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "members",
        sa.Column("transferred_to_member_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "members", sa.Column("transferred_to_email", sa.String(length=255), nullable=True)
    )
    op.add_column(
        "members", sa.Column("transferred_out_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("members", sa.Column("transfer_kind", sa.String(length=16), nullable=True))
    # Tra ngược "ai đã cộng hạn vào email này" (ca cộng dồn không ghi gì lên dòng nhận).
    op.create_index(
        "ix_members_transferred_to_member_id", "members", ["transferred_to_member_id"]
    )
    # Bảng thống kê gom theo NGƯỜI DÙNG (email gốc) chứ không theo từng email.
    op.create_index("ix_members_origin_email", "members", ["origin_email"])
    # Bản ghi cũ bị hard-delete sau 30 ngày → chỉ mất id, email vẫn còn để hiện chuỗi.
    op.create_foreign_key(
        "fk_members_transferred_from_member",
        "members",
        "members",
        ["transferred_from_member_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_members_transferred_to_member",
        "members",
        "members",
        ["transferred_to_member_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.execute(_BACKFILL)


def downgrade() -> None:
    op.drop_constraint("fk_members_transferred_to_member", "members", type_="foreignkey")
    op.drop_constraint("fk_members_transferred_from_member", "members", type_="foreignkey")
    op.drop_index("ix_members_origin_email", table_name="members")
    op.drop_index("ix_members_transferred_to_member_id", table_name="members")
    op.drop_column("members", "transfer_kind")
    op.drop_column("members", "transferred_out_at")
    op.drop_column("members", "transferred_to_email")
    op.drop_column("members", "transferred_to_member_id")
    op.drop_column("members", "transferred_in_at")
    op.drop_column("members", "transferred_from_email")
    op.drop_column("members", "transferred_from_member_id")
    op.drop_column("members", "origin_email")
