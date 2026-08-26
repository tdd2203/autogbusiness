"""Package `wallet` — endpoint Ví & thanh toán.

Import các submodule để decorator @router.<method> chạy và đăng ký route lên
`router` (định nghĩa ở _shared). main.py chỉ include `wallet.router`.
"""

from ._shared import router  # noqa: F401

# Submodule đăng ký route khi import (thứ tự không quan trọng).
from . import balance  # noqa: F401,E402
from . import topup  # noqa: F401,E402
from . import orders  # noqa: F401,E402
from . import withdraw  # noqa: F401,E402
from . import admin  # noqa: F401,E402
from . import report  # noqa: F401,E402
from . import daily  # noqa: F401,E402
from . import sepay_events  # noqa: F401,E402
