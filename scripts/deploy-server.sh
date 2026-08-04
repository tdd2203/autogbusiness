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
# Server đang chạy bản nào?  ssh root@103.74.100.4 'cat /opt/autogbusiness/VERSION'
# (mỗi lần deploy ghi lại commit + branch + có sửa chưa commit hay không + giờ).
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
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
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

# ----- 1. Build dashboard TẠI ĐÂY (không build trên VPS) -----
# Từ 2026-08-04 image web là serve-only: `npm install` + `vite build` ngốn 1–2GB,
# chạy trên VPS là đỉnh RAM lớn nhất của cả hệ thống. Build ở máy dev rồi rsync
# `dist/` (chưa tới 1MB) lên — VPS chỉ còn copy file vào nginx.
step "Build dashboard (apps/web) tại máy này"
if ! command -v npm >/dev/null 2>&1; then
  err "Không tìm thấy npm trên PATH — cài Node.js trước (web build ở máy dev, không build trên VPS)."
  exit 1
fi
WEB="$ROOT/apps/web"
if [ ! -d "$WEB/node_modules" ]; then
  warn "node_modules chưa có — npm install..."
  (cd "$WEB" && npm install)
fi
(cd "$WEB" && npm run build)
if [ ! -f "$WEB/dist/index.html" ]; then
  err "Build xong nhưng không thấy apps/web/dist/index.html — dừng, không deploy bản hỏng."
  exit 1
fi

# ----- 2. Rsync source lên VPS -----
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

# ----- 2b. Dấu phiên bản trên server (VERSION) -----
# Deploy đi thẳng từ working tree nên KHÔNG tự suy ra được "server đang chạy commit
# nào". Ghi hẳn 1 file dấu vết lên VPS. Xem bất cứ lúc nào:
#   ssh root@103.74.100.4 'cat /opt/autogbusiness/VERSION'
# Sinh SAU rsync vì `--delete` sẽ xoá file lạ ở đầu mỗi lần deploy rồi ghi lại đây.
# `dirty=yes` = bản đang chạy có thay đổi CHƯA commit ⇒ commit ghi kèm KHÔNG dựng
# lại được nguyên trạng bằng git, chỉ để định vị mốc gần nhất.
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then DIRTY="yes"; else DIRTY="no"; fi
ssh "$SERVER" "cat > '$REMOTE_DIR/VERSION'" <<EOF
commit=$COMMIT
branch=$BRANCH
dirty=$DIRTY
deployed_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
deployed_by=$(whoami)@$(hostname -s)
EOF
if [ "$DIRTY" = "yes" ]; then
  warn "Đang deploy commit $COMMIT + thay đổi CHƯA commit (dirty)."
else
  echo "Phiên bản: commit $COMMIT ($BRANCH)"
fi

if [ "$SYNC_ONLY" -eq 1 ]; then
  warn "--sync-only: đã rsync xong, không build/restart."
  exit 0
fi

# ----- 3. Build + up trên VPS -----
step "Build + up trên VPS (api, web, cloudflared)"
# `build web` giờ chỉ COPY dist/ đã rsync ở bước 2 → gần như không tốn RAM.
# api lifespan tự alembic upgrade head lúc startup → migration DB tự áp dụng.
ssh "$SERVER" "cd $REMOTE_DIR \
  && docker compose build api web \
  && docker compose --profile remote up -d"

# ----- 4. Health check -----
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

DIRTY_NOTE=""
if [ "$DIRTY" = "yes" ]; then DIRTY_NOTE=" + sửa chưa commit"; fi
printf "\n%s=== DONE — production: %s (commit %s%s) ===%s\n" \
  "$C_GREEN" "$PUBLIC_URL" "$COMMIT" "$DIRTY_NOTE" "$C_RESET"
