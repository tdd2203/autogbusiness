"""
sepay/qr.py — Sinh QR thanh toán ngân hàng VN (chuẩn EMV QRCPS / VietQR).

Local-first: build chuỗi EMV + render PNG bằng lib `qrcode` (~20ms), banking app
quét được và tự điền bank + số TK + số tiền + nội dung.
Hoặc dùng URL: `qr_image_url()` trả link ảnh từ vietqr.app (template `qronly` — CHỈ
ma trận QR, KHÔNG logo VietQR/napas), khỏi render local; hợp mọi bank có BIN/tên.

Không phụ thuộc DB — nhận thẳng thông tin bank qua tham số.

Cài đặt: pip install "qrcode[pil]"   # chỉ cần cho qr_png_bytes (render local)
"""

import re
from io import BytesIO
from urllib.parse import quote

# vietqr.app template `qronly` — CHỈ ma trận QR, KHÔNG logo VietQR/napas giữa mã
# (img.vietqr.io/qr_only vẫn nhúng logo chữ V). Payload EMV mã hoá y hệt nên app
# ngân hàng đọc như cũ.
_VIETQR_APP_IMG = "https://vietqr.app/img"

# NAPAS BIN codes — chuẩn VietQR. Key đã normalize (lowercase, bỏ space/dấu).
_VN_BANK_BIN = {
    "vietcombank": "970436", "vcb": "970436",
    "vietinbank": "970415", "ctg": "970415", "vietin": "970415",
    "bidv": "970418",
    "agribank": "970405", "agri": "970405",
    "techcombank": "970407", "tcb": "970407",
    "mbbank": "970422", "mb": "970422", "militarybank": "970422",
    "acb": "970416",
    "vpbank": "970432", "vp": "970432",
    "tpbank": "970423", "tp": "970423",
    "sacombank": "970403", "stb": "970403",
    "hdbank": "970437", "hd": "970437",
    "vib": "970441",
    "scb": "970429",
    "msb": "970426", "maritimebank": "970426",
    "ocb": "970448",
    "shb": "970443",
    "eximbank": "970431", "eib": "970431",
    "lpbank": "970449", "lienvietpostbank": "970449",
    "seabank": "970440",
    "abbank": "970425",
    "namabank": "970428",
    "baoviet": "970438", "baovietbank": "970438",
    "vietabank": "970427", "vab": "970427",
    "vietbank": "970433",
    "ncb": "970419",
    "oceanbank": "970414",
    "pgbank": "970430",
    "publicbank": "970439",
    "saigonbank": "970400", "sgb": "970400",
    "kienlongbank": "970452", "klb": "970452",
    "bacabank": "970409", "baca": "970409",
    "pvcombank": "970412",
    "dongabank": "970406", "donga": "970406", "dab": "970406",
    "gpbank": "970408",
    "cake": "546034", "cakebyvpbank": "546034",
    "ubank": "546035", "ubankbyvpbank": "546035",
    "timo": "963388",
    "viettelmoney": "971005",
    "vnptmoney": "971011",
}


def _normalize_bank_name(name: str) -> str:
    """'ACB Bank' → 'acb', 'Vietcombank' → 'vietcombank'."""
    if not name:
        return ""
    return re.sub(r"[^a-z0-9]", "", name.strip().lower())


def _get_bank_bin(bank_name: str) -> str | None:
    key = _normalize_bank_name(bank_name)
    if not key:
        return None
    if key in _VN_BANK_BIN:
        return _VN_BANK_BIN[key]
    if key.endswith("bank") and len(key) > 4 and key[:-4] in _VN_BANK_BIN:
        return _VN_BANK_BIN[key[:-4]]
    return None


def vietqr_bank_id(bank_name: str) -> str:
    """Map tên bank → id cho ảnh QR VietQR (vietqr.app / vietqr.io) — ưu tiên BIN code."""
    return _get_bank_bin(bank_name) or _normalize_bank_name(bank_name) or bank_name


# ── EMV QRCPS builder ────────────────────────────────────────────────────────

def _tlv(tag: str, value: str) -> str:
    """TLV encode: tag (2 ký tự) + length (2 chữ số) + value."""
    return f"{tag}{len(value):02d}{value}"


def _crc16_ccitt(data: str) -> str:
    """CRC16-CCITT-FALSE (poly=0x1021, init=0xFFFF) — chuẩn EMV QRCPS."""
    crc = 0xFFFF
    for ch in data.encode("utf-8"):
        crc ^= ch << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if (crc & 0x8000) else (crc << 1)
            crc &= 0xFFFF
    return f"{crc:04X}"


def build_emv_qr_string(bin_code: str, account_number: str, amount: int, note: str) -> str:
    """Chuỗi EMV VietQR (QRIBFTTA — chuyển khoản theo số tài khoản)."""
    consumer = _tlv("00", bin_code) + _tlv("01", account_number)
    mai = _tlv("00", "A000000727") + _tlv("01", consumer) + _tlv("02", "QRIBFTTA")
    payload = (
        _tlv("00", "01")                # Payload Format Indicator
        + _tlv("01", "12")              # Point of Initiation = dynamic
        + _tlv("38", mai)               # Merchant Account Info
        + _tlv("53", "704")             # Currency = VND
        + _tlv("54", str(int(amount)))  # Transaction Amount
        + _tlv("58", "VN")              # Country
        + _tlv("62", _tlv("08", note))  # Additional Data: nội dung CK
        + "6304"                        # CRC tag + length
    )
    return payload + _crc16_ccitt(payload)


def qr_png_bytes(bank_name: str, account_number: str, amount: int, note: str) -> bytes:
    """
    Sinh PNG QR (local). Trả về bytes.
    Dùng khi bank có trong _VN_BANK_BIN. Nếu không → gọi qr_image_url() thay thế.
    """
    try:
        import qrcode  # type: ignore  # dep TÙY CHỌN — chỉ hàm này cần, import lazy
    except ModuleNotFoundError as e:
        raise RuntimeError(
            'qr_png_bytes cần lib "qrcode" (chưa cài) — chạy: pip install "qrcode[pil]". '
            "Không muốn cài thì dùng qr_image_url() (URL vietqr.app, không cần lib)."
        ) from e

    bin_code = _get_bank_bin(bank_name)
    if not bin_code:
        raise ValueError(f"Bank '{bank_name}' không có BIN — dùng qr_image_url() (URL vietqr.app) thay thế")

    emv = build_emv_qr_string(bin_code, str(account_number), int(amount), note)
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=2)
    qr.add_data(emv)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def qr_image_url(bank_name: str, account_number: str, account_name: str, amount: int, note: str) -> str:
    """URL ảnh QR từ vietqr.app template `qronly` — nhét thẳng vào <img src>.

    `qronly` = CHỈ ma trận QR, KHÔNG logo chữ V/napas nhúng giữa mã (khác
    img.vietqr.io/qr_only vẫn baked logo VietQR). Payload EMV mã hoá GIỐNG HỆT:
    bank BIN + số TK + amount + nội dung (des) → app ngân hàng đọc y như cũ, tự điền
    số tiền & nội dung. UI modal tự vẽ thương hiệu VietQR/napas + STK/nội dung có nút
    Chép nên dùng showinfo=false để mã QR to & sạch nhất (không baked text).
    `account_name` chỉ dùng cho showinfo (đang tắt) — không nằm trong payload EMV.
    """
    bank_id = vietqr_bank_id(bank_name)
    return (
        f"{_VIETQR_APP_IMG}?bank={quote(str(bank_id))}&acc={quote(str(account_number))}"
        f"&template=qronly&showinfo=false"
        f"&amount={int(amount)}&des={quote(note)}"
    )
