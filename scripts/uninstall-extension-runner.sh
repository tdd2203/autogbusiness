#!/bin/bash
# ============================================================================
# uninstall-extension-runner.sh
# Gỡ launchd agent com.autogpt.extension-runner (dừng auto-run Chrome 24/7).
# KHÔNG xóa profile Chrome (giữ phiên đăng nhập ChatGPT). Thêm --purge để xóa.
# ============================================================================
set -uo pipefail

LABEL="com.autogpt.extension-runner"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PROFILE_DIR="$HOME/Library/Application Support/AutoGPTRunner"
GUI="gui/$(id -u)"

echo "==> Bỏ nạp agent $LABEL"
launchctl bootout "$GUI/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "✓ Đã gỡ agent. (Chrome đang mở sẽ không tự chạy lại nữa; tự đóng nếu muốn.)"

if [ "${1:-}" = "--purge" ]; then
  echo "==> --purge: xóa profile Chrome $PROFILE_DIR"
  rm -rf "$PROFILE_DIR"
  echo "✓ Đã xóa profile (sẽ phải đăng nhập lại ChatGPT + nhập API key nếu cài lại)."
else
  echo "    Giữ nguyên profile tại $PROFILE_DIR (thêm --purge để xóa)."
fi
