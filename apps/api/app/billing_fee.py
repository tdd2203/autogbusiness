"""Phí ngân hàng của hoá đơn ChatGPT — quy về MỘT công thức dùng chung.

Bối cảnh (chốt user 2026-08-27): phí ngân hàng luôn là một TỈ LỆ % cố định trên số
tiền chuyển (ca thật GPT1: 475.960 / 43.269.050 và 578.045 / 52.549.578 đều đúng
1,1%). Trước đây super-admin phải gõ SỐ TIỀN phí cho TỪNG hoá đơn — gõ sót một
hoá đơn là "tổng thực trả" và báo cáo CHI hụt đúng bằng phần phí đó, mà không có
gì báo. Giờ chỉ cần nhập % MỘT LẦN cho workspace (`Workspace.bank_fee_percent`),
mọi hoá đơn tự tính.

Quy tắc:
  - workspace CÓ % → phí mọi hoá đơn = làm tròn(số tiền thực trả × %). Số tiền
    phí nhập tay cũ trong JSONB KHÔNG còn được dùng (giữ nguyên trong dữ liệu, để
    xoá % là quay lại như trước).
  - workspace CHƯA có % → giữ nguyên hành vi cũ: dùng `service_fee_vnd` nhập tay.

Web (`billing-math.ts`, `WorkspaceBillingPanel.tsx`) lặp lại đúng công thức này —
sửa ở đây thì sửa cả bên đó.
"""

from __future__ import annotations


def invoice_base_vnd(inv: dict) -> int:
    """Số tiền THỰC CHUYỂN của 1 hoá đơn (gồm VAT) — gốc để tính phí ngân hàng."""
    base = inv.get("total_vnd")
    if base is None:
        base = inv.get("amount_vnd")
    return int(base or 0)


def invoice_fee_vnd(inv: dict, bank_fee_percent: float | None) -> int:
    """Phí ngân hàng hiệu lực của 1 hoá đơn: theo % workspace, fallback nhập tay."""
    if bank_fee_percent:
        return round(invoice_base_vnd(inv) * float(bank_fee_percent) / 100)
    return int(inv.get("service_fee_vnd") or 0)
