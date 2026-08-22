#!/usr/bin/env bash
# Đích deploy/backup (SERVER, REMOTE_DIR, PUBLIC_URL) — KHÔNG hardcode trong repo.
#
# VÌ SAO: repo này PUBLIC trên GitHub. Trước đây `deploy-server.sh` và `db-pull.sh`
# ghi thẳng `root@<ip>` nên ai mở repo cũng đọc được IP máy chủ production, biết
# đăng nhập bằng root, biết mã nguồn ở /opt/... và bản dump DB ở /root/backups/...
# SSH đã khoá mật khẩu (chỉ vào bằng key) nên đây không phải lỗ hổng, nhưng không
# có lý do gì để tự quảng cáo mục tiêu cho bot quét cổng.
#
# Giá trị lấy theo thứ tự ưu tiên:
#   1. biến môi trường đang có (vd  DEPLOY_SERVER=root@1.2.3.4 ./scripts/deploy-server.sh)
#   2. file `.env` ở gốc dự án (đã gitignore, không bao giờ lên GitHub)
#   3. mặc định truyền vào (chỉ dùng cho giá trị KHÔNG nhạy cảm như đường dẫn)
#
# Cách dùng:
#   . "$(dirname "${BASH_SOURCE[0]:-$0}")/_target.sh"
#   require_deploy_server                                   # set $SERVER, thiếu thì thoát
#   REMOTE_DIR="$(target_get DEPLOY_REMOTE_DIR /opt/autogbusiness)"
#
# ⚠️ CỐ Ý KHÔNG `source .env`: file đó chứa JWT_SECRET / POSTGRES_PASSWORD /
# SEPAY_APIKEY…, source vào sẽ đẩy TOÀN BỘ secret thành biến môi trường của mọi
# lệnh con (ssh, rsync, docker) — thừa và dễ rò. `source` còn vỡ khi giá trị có
# khoảng trắng hoặc dấu `#`. Ở đây chỉ bới đúng key cần.

_TARGET_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"

# env_get <KEY> — in giá trị KEY trong .env (rỗng nếu không có). Dòng comment
# (`# KEY=...`) không khớp vì có `#` đứng trước. Lấy dòng CUỐI nếu key lặp, gỡ
# nháy bao ngoài và ký tự CR của file CRLF.
env_get() {
  local key="$1" file="$_TARGET_ROOT/.env" val
  [ -f "$file" ] || return 0
  val="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$file" | tail -1 | tr -d '\r')"
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  printf '%s' "$val"
}

# target_get <KEY> [mặc định] — môi trường > .env > mặc định.
target_get() {
  local key="$1" fallback="${2-}" val="${!1-}"
  [ -n "$val" ] || val="$(env_get "$key")"
  [ -n "$val" ] || val="$fallback"
  printf '%s' "$val"
}

# require_deploy_server — set $SERVER; thiếu thì in hướng dẫn rồi thoát 1.
require_deploy_server() {
  SERVER="$(target_get DEPLOY_SERVER)"
  if [ -z "$SERVER" ]; then
    cat >&2 <<'MSG'
Chưa biết kết nối tới đâu: thiếu DEPLOY_SERVER.

Địa chỉ VPS KHÔNG nằm trong repo (repo này public trên GitHub). Thêm vào `.env`
ở gốc dự án — file đó đã gitignore nên không bao giờ bị đẩy lên:

  DEPLOY_SERVER=root@<ip-hoac-hostname-vps>
  DEPLOY_REMOTE_DIR=/opt/autogbusiness
  DEPLOY_BACKUP_DIR=/root/backups/autogpt

Hoặc truyền thẳng cho một lần chạy:

  DEPLOY_SERVER=root@1.2.3.4 ./scripts/deploy-server.sh
MSG
    exit 1
  fi
}
