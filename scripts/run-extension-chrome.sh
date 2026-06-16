#!/bin/bash
# ============================================================================
# run-extension-chrome.sh
# Khởi chạy Google Chrome (GUI) với AutoGPT Admin Extension đã nạp sẵn, dùng
# một profile RIÊNG, để extension tự poll queue và automation 24/7.
#
# Được gọi bởi launchd agent `com.autogpt.extension-runner` (xem
# install-extension-runner.sh). KeepAlive=true → nếu Chrome thoát/chết,
# launchd sẽ chạy lại script này.
#
# Bọc bằng `caffeinate -dimsu` → giữ máy không ngủ suốt thời gian Chrome chạy.
# Khi Chrome thoát, caffeinate thoát theo → launchd relaunch.
# ============================================================================
set -uo pipefail

# --- Cấu hình (có thể override qua biến môi trường trong plist) ---------------
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXT_DIR="${EXT_DIR:-$REPO_ROOT/apps/extension/dist}"
PROFILE_DIR="${PROFILE_DIR:-$HOME/Library/Application Support/AutoGPTRunner/chrome-profile}"
ADMIN_URL="${ADMIN_URL:-https://chatgpt.com/admin}"

# --- Kiểm tra điều kiện -------------------------------------------------------
if [ ! -x "$CHROME" ]; then
  echo "[run-extension-chrome] LỖI: không tìm thấy Chrome tại: $CHROME" >&2
  echo "  Cài Google Chrome, hoặc set CHROME_BIN trỏ đúng đường dẫn." >&2
  exit 78  # EX_CONFIG — không retry vô ích, sửa cấu hình đã
fi
if [ ! -f "$EXT_DIR/manifest.json" ]; then
  echo "[run-extension-chrome] LỖI: chưa build extension (thiếu $EXT_DIR/manifest.json)" >&2
  echo "  Chạy: cd $REPO_ROOT/apps/extension && npm install && npm run build" >&2
  exit 78
fi

mkdir -p "$PROFILE_DIR"

# --- Xóa cờ thoát bất thường để Chrome KHÔNG hiện bong bóng "Restore pages?" ---
# (mỗi lần launchd relaunch, lần trước có thể bị coi là crash)
PREFS="$PROFILE_DIR/Default/Preferences"
if [ -f "$PREFS" ]; then
  /usr/bin/sed -i '' \
    -e 's/"exit_type":"Crashed"/"exit_type":"Normal"/g' \
    -e 's/"exited_cleanly":false/"exited_cleanly":true/g' \
    "$PREFS" 2>/dev/null || true
fi

echo "[run-extension-chrome] $(date '+%Y-%m-%d %H:%M:%S') khởi chạy Chrome"
echo "  profile : $PROFILE_DIR"
echo "  ext     : $EXT_DIR"

# --- Khởi chạy -----------------------------------------------------------------
# caffeinate -dimsu <cmd>: giữ display(d)/idle(i)/system(s)/disk(m) thức + ngăn
# sleep do user(u), kéo dài đúng bằng vòng đời tiến trình Chrome.
# Các cờ --disable-*-backgrounding/throttling giúp service worker + tab nền của
# extension không bị Chrome bóp throttle khi cửa sổ không focus.
exec /usr/bin/caffeinate -dimsu "$CHROME" \
  --user-data-dir="$PROFILE_DIR" \
  --load-extension="$EXT_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --hide-crash-restore-bubble \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --password-store=basic \
  "$ADMIN_URL"
