#!/usr/bin/env bash
# Deploy backend (api + web + tunnel) lên VPS production — một lệnh duy nhất.
#
# Khác với scripts/deploy-all.sh (chạy Docker TRÊN MÁY NÀY): script này rsync
# source từ máy local lên VPS rồi build + khởi động container TRÊN VPS.
# Truy cập production: https://gpt.lovevn.org (Cloudflare tunnel, profile "remote").
#
# Quy trình: KHÔNG qua git — rsync thẳng working tree hiện tại lên VPS
# (kể cả thay đổi chưa commit). Git chỉ dùng để quản lý lịch sử code như thường.
#
# NHỮNG GÌ KHÔNG BAO GIỜ BỊ COPY ĐÈ (đã migrate 1 lần ngày 2026-08-01, giờ
# "sống" trên server):
#   - .env         → server có secret riêng (JWT/Postgres mạnh hơn bản dev local)
#   - database     → nằm trong docker volume trên VPS; muốn đụng tới phải dump
#                    thủ công, đừng bao giờ restore đè khi server đã có data mới.
#
# Extension KHÔNG deploy lên server (nó chạy trong Chrome trên máy người dùng):
# build extension bằng  ./scripts/deploy-all.sh --skip-stack  rồi Reload ở
# chrome://extensions nếu bản cũ chưa có self-heal.
#
# Usage:
#   ./scripts/deploy-server.sh              # rsync + build + up + health check
#   ./scripts/deploy-server.sh --sync-only  # chỉ rsync, không build/restart
#
# Permission denied? chmod +x scripts/deploy-server.sh

set -euo pipefail

SERVER="root@103.74.100.4"
REMOTE_DIR="/opt/autogbusiness"
PUBLIC_URL="https://gpt.lovevn.org"

SYNC_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --sync-only) SYNC_ONLY=1 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT"

if [ -t 1 ]; then
  C_CYAN=$'\033[36m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_RESET=$'\033[0m'
else
  C_CYAN='' C_YELLOW='' C_RED='' C_GREEN='' C_RESET=''
fi
step() { printf "\n%s=== %s ===%s\n" "$C_CYAN" "$1" "$C_RESET"; }
err()  { printf "%s%s%s\n" "$C_RED" "$1" "$C_RESET" >&2; }
warn() { printf "%s%s%s\n" "$C_YELLOW" "$1" "$C_RESET"; }

# ----- 0. SSH phải vào được bằng key (không hỏi password) -----
if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$SERVER" true 2>/dev/null; then
  err "Không SSH được $SERVER bằng key. Kiểm tra mạng / key trong ~/.ssh."
  exit 1
fi

# ----- 1. Rsync source lên VPS -----
step "Rsync source → $SERVER:$REMOTE_DIR"
# --delete: xoá file server-side đã bị xoá ở local. File nằm trong --exclude
# (như .env) KHÔNG bị xoá (rsync chỉ xoá excluded khi có --delete-excluded).
# (rsync macOS bản cũ: không dùng --info=..., chỉ dùng option cổ điển)
rsync -az --delete \
  --exclude node_modules \
  --exclude .venv \
  --exclude .git \
  --exclude .env \
  --exclude .DS_Store \
  --exclude '*.bak' \
  --exclude '*.dump' \
  --exclude logs/ \
  "$ROOT/" "$SERVER:$REMOTE_DIR/"

if [ "$SYNC_ONLY" -eq 1 ]; then
  warn "--sync-only: đã rsync xong, không build/restart."
  exit 0
fi

# ----- 2. Build + up trên VPS -----
step "Build + up trên VPS (api, web, cloudflared)"
# api lifespan tự alembic upgrade head lúc startup → migration DB tự áp dụng.
ssh "$SERVER" "cd $REMOTE_DIR \
  && docker compose build api web \
  && docker compose --profile remote up -d"

# ----- 3. Health check -----
step "Health check"
ok=0
for i in $(seq 1 20); do
  if ssh "$SERVER" "curl -fsS http://127.0.0.1:18000/health" >/dev/null 2>&1; then
    ok=1; break
  fi
  sleep 2
done
if [ "$ok" -ne 1 ]; then
  err "API trên VPS chưa health sau 40s — xem log:"
  err "  ssh $SERVER 'cd $REMOTE_DIR && docker compose logs --tail=50 api'"
  exit 1
fi
echo "API (VPS nội bộ): ok"

# Public qua tunnel (check từ máy local — xác nhận cả cloudflared).
if curl -fsS --max-time 15 "$PUBLIC_URL/health" >/dev/null 2>&1; then
  echo "Public $PUBLIC_URL/health: ok"
else
  warn "API nội bộ ok nhưng $PUBLIC_URL chưa trả lời — kiểm tra cloudflared:"
  warn "  ssh $SERVER 'docker logs --tail=30 autogpt-cloudflared'"
  exit 1
fi

printf "\n%s=== DONE — production: %s ===%s\n" "$C_GREEN" "$PUBLIC_URL" "$C_RESET"
