#!/usr/bin/env bash
# Deploy toàn bộ stack qua Docker + build extension — một lệnh duy nhất.
#
# Khác với scripts/update.sh (chế độ DEV: venv uvicorn + vite dev), script này
# chạy backend + dashboard qua DOCKER (production-like):
#   docker compose up -d --build api web   (api tự alembic upgrade head + seed)
# rồi build extension (apps/extension). Extension v0.7.4+ tự self-heal nên KHÔNG
# cần reload tay ở chrome://extensions sau khi build (trừ lần đầu lên 0.7.4).
#
# Usage:
#   ./scripts/deploy-all.sh                # build extension + docker up api web
#   ./scripts/deploy-all.sh --skip-extension   # chỉ deploy stack docker
#   ./scripts/deploy-all.sh --skip-stack       # chỉ build extension
#
# Permission denied? chmod +x scripts/deploy-all.sh
# Lỗi shebang ('\r: command not found')? File bị CRLF:
#   sed -i '' 's/\r$//' scripts/deploy-all.sh   # macOS

set -eo pipefail

# ----- Parse flags -----
SKIP_EXTENSION=0
SKIP_STACK=0
for arg in "$@"; do
  case "$arg" in
    --skip-extension) SKIP_EXTENSION=1 ;;
    --skip-stack) SKIP_STACK=1 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

# Repo root = parent của scripts/
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT"

# Colors (TTY only).
if [ -t 1 ]; then
  C_CYAN=$'\033[36m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_RESET=$'\033[0m'
else
  C_CYAN='' C_YELLOW='' C_RED='' C_GREEN='' C_RESET=''
fi
step() { printf "\n%s=== %s ===%s\n" "$C_CYAN" "$1" "$C_RESET"; }
err()  { printf "%s%s%s\n" "$C_RED" "$1" "$C_RESET" >&2; }
warn() { printf "%s%s%s\n" "$C_YELLOW" "$1" "$C_RESET"; }

# ----- Detect docker compose (v2 'docker compose' vs v1 'docker-compose') -----
if [ "$SKIP_STACK" -ne 1 ]; then
  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker-compose"
  else
    err "Không tìm thấy 'docker compose' lẫn 'docker-compose'. Cài Docker Desktop."
    exit 1
  fi
fi

# ----- 1. Build extension (apps/extension) -----
if [ "$SKIP_EXTENSION" -ne 1 ]; then
  step "Build extension (apps/extension)"
  if ! command -v npm >/dev/null 2>&1; then
    err "Không tìm thấy npm trên PATH — cài Node.js trước."
    exit 1
  fi
  EXT="$ROOT/apps/extension"
  if [ ! -d "$EXT/node_modules" ]; then
    warn "node_modules chưa có — npm install..."
    (cd "$EXT" && npm install)
  fi
  # Build; nếu dính lỗi rollup optional-dep (node_modules cài ở arch khác) thì
  # clean reinstall + build lại 1 lần.
  if ! (cd "$EXT" && npm run build); then
    warn "Build fail — thử clean reinstall (lỗi @rollup/rollup-*-* thường gặp khi đổi arch)..."
    (cd "$EXT" && rm -rf node_modules package-lock.json && npm install && npm run build)
  fi
fi

# ----- 2. Deploy stack qua Docker (api + web) -----
if [ "$SKIP_STACK" -ne 1 ]; then
  step "Docker up --build api web"
  if ! docker info >/dev/null 2>&1; then
    err "Docker daemon chưa chạy — mở Docker Desktop rồi chạy lại."
    exit 1
  fi
  # api lifespan tự alembic upgrade head + seed super-admin lúc startup.
  $DOCKER_COMPOSE up -d --build api web

  step "Health check API (:18000)"
  ok=0
  for i in $(seq 1 20); do
    if curl -fsS http://127.0.0.1:18000/health >/dev/null 2>&1; then
      ok=1; break
    fi
    sleep 2
  done
  if [ "$ok" -eq 1 ]; then
    echo "Backend health: ok"
  else
    warn "API chưa health sau 40s — xem log: $DOCKER_COMPOSE logs --tail=50 api"
  fi
  echo "Dashboard: http://127.0.0.1:17173"
fi

printf "\n%s=== DONE ===%s\n" "$C_GREEN" "$C_RESET"
if [ "$SKIP_EXTENSION" -ne 1 ]; then
  warn "Extension đã build. Self-heal (v0.7.4+) tự reload khi có build mới + task chờ → KHÔNG cần reload tay."
  warn "LƯU Ý: nếu SW đang chạy là bản TRƯỚC self-heal, reload 1 lần ở chrome://extensions để nạp code self-heal (chỉ 1 lần duy nhất)."
fi
