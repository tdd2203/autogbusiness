#!/usr/bin/env bash
# Update toàn bộ codebase trên macOS / Linux (bash, zsh).
# Tương đương scripts/update.ps1 trên Windows.
#
# Usage:
#   ./scripts/update.sh                # full
#   ./scripts/update.sh --skip-migrate
#   ./scripts/update.sh --skip-extension
#   ./scripts/update.sh --skip-dashboard
#   ./scripts/update.sh --keep-backend
#
# Nếu bị "Permission denied" khi chạy:
#   chmod +x scripts/update.sh
#
# Nếu bị lỗi shebang ('\r: command not found' hoặc 'bad interpreter'):
#   File đã bị CRLF line endings (Windows). Fix:
#     sed -i '' 's/\r$//' scripts/update.sh   # macOS
#     sed -i    's/\r$//' scripts/update.sh   # Linux
#
# Yêu cầu trước khi chạy:
#   - Docker Desktop / Docker Engine đang chạy
#   - apps/api/.venv đã tồn tại:
#       python3 -m venv apps/api/.venv
#       apps/api/.venv/bin/pip install -r apps/api/requirements.txt
#   - apps/extension/node_modules + apps/web/node_modules đã install

set -eo pipefail

# ----- Parse flags -----
SKIP_MIGRATE=0
SKIP_EXTENSION=0
SKIP_DASHBOARD=0
KEEP_BACKEND=0
for arg in "$@"; do
  case "$arg" in
    --skip-migrate) SKIP_MIGRATE=1 ;;
    --skip-extension) SKIP_EXTENSION=1 ;;
    --skip-dashboard) SKIP_DASHBOARD=1 ;;
    --keep-backend) KEEP_BACKEND=1 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

# Repo root = parent của scripts/
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT"

# Absolute path tới venv python — tránh phụ thuộc cwd khi `cd apps/api`.
VENV_PY="$ROOT/apps/api/.venv/bin/python"

# Colors (TTY only). Dùng printf thay echo -e cho portability.
if [ -t 1 ]; then
  C_CYAN=$'\033[36m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_RESET=$'\033[0m'
else
  C_CYAN='' C_YELLOW='' C_RED='' C_GREEN='' C_RESET=''
fi

step() {
  printf "\n%s=== %s ===%s\n" "$C_CYAN" "$1" "$C_RESET"
}

err() {
  printf "%s%s%s\n" "$C_RED" "$1" "$C_RESET" >&2
}

warn() {
  printf "%s%s%s\n" "$C_YELLOW" "$1" "$C_RESET"
}

# ----- Sanity check venv -----
if [ ! -x "$VENV_PY" ]; then
  err "Không tìm thấy hoặc không executable: $VENV_PY"
  err "Tạo venv: python3 -m venv apps/api/.venv && apps/api/.venv/bin/pip install -r apps/api/requirements.txt"
  exit 1
fi

# ----- Detect docker compose command (v1 'docker-compose' vs v2 'docker compose') -----
if docker compose version >/dev/null 2>&1; then
  DOCKER_COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DOCKER_COMPOSE="docker-compose"
else
  err "Không tìm thấy 'docker compose' lẫn 'docker-compose'. Cài Docker Desktop hoặc docker-compose-plugin."
  exit 1
fi

# ----- 1. Postgres alive + auto-start nếu chết -----
step "Check Postgres"
if ! docker exec autogpt-postgres pg_isready -U autogpt >/dev/null 2>&1; then
  warn "Postgres chưa chạy, đang khởi động..."
  if ! $DOCKER_COMPOSE up -d; then
    err "$DOCKER_COMPOSE up thất bại — Docker daemon đang chạy chưa?"
    exit 1
  fi
  # Poll tối đa 30s
  ok=0
  for i in $(seq 1 15); do
    sleep 2
    if docker exec autogpt-postgres pg_isready -U autogpt >/dev/null 2>&1; then
      ok=1; break
    fi
  done
  if [ "$ok" -ne 1 ]; then
    err "Postgres không sẵn sàng sau 30s — kiểm tra: docker logs autogpt-postgres"
    exit 1
  fi
fi
echo "OK"

# ----- 2. Alembic migrate -----
if [ "$SKIP_MIGRATE" -ne 1 ]; then
  step "Alembic migrate"
  (cd "$ROOT/apps/api" && "$VENV_PY" -m alembic upgrade head)
fi

# ----- 3. Restart backend (kill port 18000) -----
if [ "$KEEP_BACKEND" -ne 1 ]; then
  step "Restart backend (:18000)"
  if command -v lsof >/dev/null 2>&1; then
    PID="$(lsof -ti tcp:18000 2>/dev/null || true)"
  else
    # Fallback: dùng ss (Linux) hoặc netstat
    PID="$(ss -tlnp 2>/dev/null | awk '/:18000 /{print $NF}' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)"
  fi
  if [ -n "$PID" ]; then
    echo "Killing PID $PID on port 18000..."
    kill -9 $PID 2>/dev/null || true
    sleep 1
  fi
  # Tạo log dir nếu /tmp không tồn tại (rất hiếm)
  LOG_DIR="${TMPDIR:-/tmp}"
  BACKEND_LOG="$LOG_DIR/autogpt-backend.log"
  # nohup + detach hoàn toàn: </dev/null đóng stdin, >>log gộp stdout/stderr.
  # Subshell để cd không leak ra outer scope.
  (
    cd "$ROOT/apps/api"
    nohup "$VENV_PY" -m uvicorn app.main:app --host 127.0.0.1 --port 18000 \
      </dev/null >>"$BACKEND_LOG" 2>&1 &
  )
  sleep 3
  # Health check
  if curl -fsS http://127.0.0.1:18000/health >/dev/null 2>&1; then
    echo "Backend health: ok"
  else
    warn "Backend chưa sẵn sàng, xem log: tail -f $BACKEND_LOG"
  fi
fi

# ----- 4. Build extension -----
if [ "$SKIP_EXTENSION" -ne 1 ]; then
  step "Build extension"
  (cd "$ROOT/apps/extension" && npm run build)
fi

# ----- 5. Dashboard (Vite :17173) — auto-spawn nếu chưa chạy -----
if [ "$SKIP_DASHBOARD" -ne 1 ]; then
  step "Dashboard (Vite :17173)"
  LOG_DIR="${TMPDIR:-/tmp}"
  WEB_LOG="$LOG_DIR/autogpt-web.log"
  if (command -v lsof >/dev/null 2>&1 && lsof -ti tcp:17173 >/dev/null 2>&1) || \
     (command -v ss >/dev/null 2>&1 && ss -tln 2>/dev/null | grep -q ':17173 '); then
    echo "Vite dev đang chạy trên 17173 — HMR auto pick up"
  else
    echo "Vite chưa chạy trên 17173 — spawn npm run dev ở background ($WEB_LOG)"
    (
      cd "$ROOT/apps/web"
      nohup npm run dev </dev/null >>"$WEB_LOG" 2>&1 &
    )
  fi
fi

printf "\n%s=== DONE ===%s\n" "$C_GREEN" "$C_RESET"
