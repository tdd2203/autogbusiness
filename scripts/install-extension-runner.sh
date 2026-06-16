#!/bin/bash
# ============================================================================
# install-extension-runner.sh
# Cài đặt launchd agent để Chrome + AutoGPT extension TỰ CHẠY 24/7 trên Mac:
#   - Tự mở khi bạn đăng nhập máy (RunAtLoad)
#   - Tự khởi chạy lại nếu Chrome bị thoát/chết (KeepAlive)
#   - Giữ máy không ngủ khi đang chạy (caffeinate trong run-extension-chrome.sh)
#
# Dùng: ./scripts/install-extension-runner.sh [--no-build]
# Gỡ:   ./scripts/uninstall-extension-runner.sh
# ============================================================================
set -euo pipefail

LABEL="com.autogpt.extension-runner"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_SCRIPT="$REPO_ROOT/scripts/run-extension-chrome.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
OUT_LOG="$LOG_DIR/autogpt-extension-runner.out.log"
ERR_LOG="$LOG_DIR/autogpt-extension-runner.err.log"
EXT_DIR="$REPO_ROOT/apps/extension/dist"

DO_BUILD=1
[ "${1:-}" = "--no-build" ] && DO_BUILD=0

echo "==> AutoGPT extension runner — cài đặt launchd agent"
echo "    repo: $REPO_ROOT"

# --- 1. Build extension (trừ khi --no-build) ---------------------------------
if [ "$DO_BUILD" = "1" ]; then
  if command -v npm >/dev/null 2>&1; then
    echo "==> Build extension (npm run build)"
    ( cd "$REPO_ROOT/apps/extension" && npm install --silent && npm run build )
  else
    echo "!!  Không tìm thấy npm — bỏ qua build. Đảm bảo $EXT_DIR đã build sẵn." >&2
  fi
fi
if [ ! -f "$EXT_DIR/manifest.json" ]; then
  echo "!!  LỖI: chưa có $EXT_DIR/manifest.json. Build extension trước rồi chạy lại." >&2
  exit 1
fi

chmod +x "$RUN_SCRIPT"
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

# --- 2. Sinh file plist với đường dẫn tuyệt đối ------------------------------
echo "==> Ghi $PLIST"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$RUN_SCRIPT</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>REPO_ROOT</key>
    <string>$REPO_ROOT</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>$OUT_LOG</string>
  <key>StandardErrorPath</key>
  <string>$ERR_LOG</string>
</dict>
</plist>
PLIST_EOF

# --- 3. Nạp agent vào launchd (gui domain của user hiện tại) ------------------
GUI="gui/$(id -u)"
echo "==> Nạp agent vào $GUI"
launchctl bootout "$GUI/$LABEL" 2>/dev/null || true
launchctl bootstrap "$GUI" "$PLIST"
launchctl enable "$GUI/$LABEL"
launchctl kickstart -k "$GUI/$LABEL"

echo ""
echo "✓ Đã cài. Chrome sẽ tự mở (profile riêng) và chạy lại nếu bị tắt."
echo ""
echo "LẦN ĐẦU cần làm tay 2 việc trong cửa sổ Chrome vừa mở:"
echo "  1) Đăng nhập https://chatgpt.com/admin bằng tài khoản admin workspace."
echo "  2) Bấm icon extension → nhập Backend URL = http://localhost:18000 + Extension API Key."
echo "     (Profile riêng nên không dính tới Chrome cá nhân của bạn.)"
echo ""
echo "Log:    $OUT_LOG"
echo "        $ERR_LOG"
echo "Trạng thái: launchctl print $GUI/$LABEL | grep state"
echo "Khởi chạy lại thủ công: launchctl kickstart -k $GUI/$LABEL"
echo "Gỡ:     ./scripts/uninstall-extension-runner.sh"
echo ""
echo "Lưu ý: để sống sót sau mất điện/reboot, bật thêm (1 lần):"
echo "  - System Settings → Users & Groups → Automatic login (vào thẳng desktop)"
echo "  - System Settings → Energy → Start up automatically after a power failure"
echo "  - sudo pmset -c sleep 0   (không ngủ khi cắm điện)"
