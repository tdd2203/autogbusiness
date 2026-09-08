"""chế độ tính hạn theo CHU KỲ HOÁ ĐƠN của workspace (cycle_aligned)

Revision ID: 0067_workspace_cycle_billing
Revises: 0066_member_transfer_link
Create Date: 2026-09-07

Hoá đơn ChatGPT tính `quantity × đơn_giá_tháng` — đủ MỘT THÁNG cho mọi ghế trong
`seat_total`, bất kể ghế đó trống vào ngày thứ mấy của kỳ. Mô hình cũ cho mỗi email một
đồng hồ riêng (neo + số tháng × 30 ngày) nên khách nào cũng hết hạn GIỮA kỳ ⇒ mỗi mốc
chốt ta trả đủ tháng cho một loạt ghế đã biết trước là sẽ bỏ không.

Chế độ `cycle_aligned` neo hạn của mọi email vào MỐC CHỐT chu kỳ để gỡ hết người chưa
gia hạn TRƯỚC khi hoá đơn chạy, rồi mới mua đúng số ghế đã bán. Luật đầy đủ ở
`app/routers/members/EXPIRY_RULES.md` §3.6 — đọc file đó trước khi sửa bất cứ gì.

Migration này CHỈ thêm cột, không đổi hành vi: `billing_mode` mặc định `legacy_30d` là
cầu dao, deploy xong mọi workspace vẫn chạy y như cũ cho tới khi super-admin gạt từng
cái một.

⚠️ `cycle_anchor_day` mồi ở cuối file là GIÁ TRỊ KHỞI ĐẦU, không phải con số bất di
bất dịch. Từ 8/9/2026 HOÁ ĐƠN QUYẾT ĐỊNH MỐC: hoá đơn của kỳ đang chạy/sắp tới — dán
tay hay extension tự quét — dời `cycle_anchor_day` ngay, chỉ ghi nhật ký. Hoá đơn CŨ
(kết thúc trước mốc mở của kỳ đang chạy) thì vẫn lưu nhưng KHÔNG đụng tới mốc, vì dán
bù cả xấp hoá đơn cũ là chuyện thường và nó sẽ kéo mốc của cả workspace về quá khứ.
Chưa có hoá đơn nào thì mốc tự cuộn theo tháng từ con số mồi này (EXPIRY_RULES §3.6.3).

Con số mặc định (sửa được ở DB, không hard-code trong code — EXPIRY_RULES §3.6.6):

  cycle_cutoff_utc            03:00 UTC = 10h giờ VN. Phải sớm hơn giờ ChatGPT chốt hoá
                              đơn (quan sát: ~09:00–10:00 UTC) đủ để gỡ xong người chưa
                              gia hạn RỒI hạ seat_total.
  cycle_force_extra_from_day  23. Mua từ ngày thứ 23 của chu kỳ trở đi thì bắt buộc cộng
                              thêm 1 tháng — kỳ đầu quá ngắn thì vừa mua đã hết hạn.
  price_round_to_vnd          1000. Tiền lẻ hàng trăm đồng chỉ tổ lệch khi đối soát
                              chuyển khoản.
  cycle_invoice_utc           09:00 UTC = 16h giờ VN, giờ ChatGPT chốt hoá đơn. KHÔNG
                              dùng tính tiền — chỉ để cảnh báo khi đợt gỡ chưa xong
                              trước lúc hoá đơn tính đủ ghế cũ.

Cột trên `workspaces` để NULL nghĩa là "theo mặc định hệ thống"; điền vào là ghi đè cho
riêng workspace đó.

Thêm `members.invite_credit_vnd` / `invite_credit_at`: từ 7/9/2026 mời hỏng không hoàn
phí về ví nữa mà giữ khoản đã trả gắn với email (lượt mời lại miễn phí). Hoàn phí vốn là
cách "đóng sổ"; bỏ nó đi mà không ghi lại thì tiền đã thu chưa giao dịch vụ nằm lẫn vào
doanh thu, không ai đếm được.

Thêm `member_subscription_cycles.prorated_half_days`: kỳ đầu của chế độ mới thường lẻ
ngày (vd 20,5 ngày) nên không nhét vào `months` nguyên được. Đơn vị NỬA NGÀY, số nguyên
— tiền không được dính số thực.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0067_workspace_cycle_billing"
down_revision: Union[str, None] = "0066_member_transfer_link"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspaces",
        sa.Column(
            "billing_mode",
            sa.String(length=16),
            nullable=False,
            server_default="legacy_30d",
        ),
    )
    op.add_column(
        "workspaces", sa.Column("cycle_anchor_day", sa.Integer(), nullable=True)
    )
    op.add_column(
        "workspaces", sa.Column("cycle_cutoff_utc", sa.Time(), nullable=True)
    )
    op.add_column(
        "workspaces",
        sa.Column("cycle_force_extra_from_day", sa.Integer(), nullable=True),
    )
    op.create_check_constraint(
        "ck_workspaces_billing_mode",
        "workspaces",
        "billing_mode IN ('legacy_30d', 'cycle_aligned')",
    )
    op.create_check_constraint(
        "ck_workspaces_cycle_anchor_day",
        "workspaces",
        "cycle_anchor_day IS NULL OR cycle_anchor_day BETWEEN 1 AND 31",
    )
    op.create_check_constraint(
        "ck_workspaces_cycle_force_day",
        "workspaces",
        "cycle_force_extra_from_day IS NULL "
        "OR cycle_force_extra_from_day BETWEEN 1 AND 31",
    )
    # Chỉ nhánh 'gpt' được gạt sang `cycle_aligned`: chế độ này neo hạn vào chu kỳ hoá
    # đơn ChatGPT Business, mà team Canva không có hoá đơn nào để neo. Nguy hiểm hơn:
    # `payment_flow.fee_for_window` luôn tính theo ĐƠN GIÁ THÁNG của GPT, không hề đi
    # qua bảng bậc thang của Canva (`services/canva_price.py`) — gạt nhầm một team
    # Canva là nó ÂM THẦM bán sai giá, không có lỗi nào bật lên. Chặn ngay ở tầng dữ
    # liệu để dù sửa thẳng bằng SQL cũng không lọt.
    #
    # Mọi dòng đang có đều thoả: `billing_mode` vừa thêm ở trên với server_default
    # 'legacy_30d' NOT NULL, nên vế trái luôn đúng và câu CHECK không chặn ai.
    op.create_check_constraint(
        "ck_workspaces_cycle_aligned_gpt_only",
        "workspaces",
        "billing_mode <> 'cycle_aligned' OR platform = 'gpt'",
    )

    op.add_column(
        "payment_settings",
        sa.Column(
            "cycle_cutoff_utc",
            sa.Time(),
            nullable=False,
            server_default=sa.text("'03:00:00'"),
        ),
    )
    op.add_column(
        "payment_settings",
        sa.Column(
            "cycle_force_extra_from_day",
            sa.Integer(),
            nullable=False,
            server_default="23",
        ),
    )
    op.add_column(
        "payment_settings",
        sa.Column(
            "price_round_to_vnd",
            sa.Integer(),
            nullable=False,
            server_default="1000",
        ),
    )
    op.add_column(
        "payment_settings",
        sa.Column(
            "cycle_invoice_utc",
            sa.Time(),
            nullable=False,
            server_default=sa.text("'09:00:00'"),
        ),
    )
    op.create_check_constraint(
        "ck_payment_settings_cycle_force_day",
        "payment_settings",
        "cycle_force_extra_from_day BETWEEN 1 AND 31",
    )
    op.create_check_constraint(
        "ck_payment_settings_round_positive",
        "payment_settings",
        "price_round_to_vnd >= 1",
    )

    op.add_column(
        "member_subscription_cycles",
        sa.Column("prorated_half_days", sa.Integer(), nullable=True),
    )
    op.add_column(
        "members", sa.Column("invite_credit_vnd", sa.BigInteger(), nullable=True)
    )
    op.add_column(
        "members",
        sa.Column("invite_credit_at", sa.DateTime(timezone=True), nullable=True),
    )

    # Mồi `cycle_anchor_day` từ chu kỳ hoá đơn ĐANG biết, để workspace nào được gạt sang
    # chế độ mới cũng có sẵn mốc đúng thay vì phải gõ tay. Chỉ MỒI — mốc cuộn theo tháng
    # từ con số này, không đọc lại `renewal_date` ở mỗi lần tính; đổi được nó là hoá đơn
    # của kỳ đang chạy/sắp tới về sau (EXPIRY_RULES §3.6.3).
    #
    # `AT TIME ZONE 'UTC'` là BẮT BUỘC, không được để `EXTRACT` trần: `renewal_date`
    # là `timestamptz`, mà `EXTRACT` trên timestamptz đọc theo TimeZone của PHIÊN
    # Postgres đang chạy migration. Code lúc chạy lại đọc UTC
    # (`_shared.py::cycle_params` → `_as_utc(ws.renewal_date).day`), nên phiên nào
    # không phải UTC (vd Asia/Ho_Chi_Minh, lệch 7 tiếng) là mồi ra ngày LỆCH MỘT so
    # với ngày code tính. Lệch ngày neo thì lệch mốc chốt của CẢ workspace ⇒ mọi email
    # trong đó vừa sai hạn vừa sai tiền, mà không có gì báo. EXPIRY_RULES §3.6.4:
    # "Mọi mốc đều là UTC".
    op.execute(
        """
        UPDATE workspaces
           SET cycle_anchor_day = EXTRACT(DAY FROM (renewal_date AT TIME ZONE 'UTC'))::int
         WHERE renewal_date IS NOT NULL
           AND cycle_anchor_day IS NULL
        """
    )


def downgrade() -> None:
    op.drop_column("members", "invite_credit_at")
    op.drop_column("members", "invite_credit_vnd")
    op.drop_column("member_subscription_cycles", "prorated_half_days")
    op.drop_constraint(
        "ck_payment_settings_round_positive", "payment_settings", type_="check"
    )
    op.drop_constraint(
        "ck_payment_settings_cycle_force_day", "payment_settings", type_="check"
    )
    op.drop_column("payment_settings", "cycle_invoice_utc")
    op.drop_column("payment_settings", "price_round_to_vnd")
    op.drop_column("payment_settings", "cycle_force_extra_from_day")
    op.drop_column("payment_settings", "cycle_cutoff_utc")

    op.drop_constraint(
        "ck_workspaces_cycle_aligned_gpt_only", "workspaces", type_="check"
    )
    op.drop_constraint("ck_workspaces_cycle_force_day", "workspaces", type_="check")
    op.drop_constraint("ck_workspaces_cycle_anchor_day", "workspaces", type_="check")
    op.drop_constraint("ck_workspaces_billing_mode", "workspaces", type_="check")
    op.drop_column("workspaces", "cycle_force_extra_from_day")
    op.drop_column("workspaces", "cycle_cutoff_utc")
    op.drop_column("workspaces", "cycle_anchor_day")
    op.drop_column("workspaces", "billing_mode")
