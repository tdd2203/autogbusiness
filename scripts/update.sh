#!/usr/bin/env bash
# Update toàn bộ codebase trên macOS / Linux (zsh, bash).
# Tương đương scripts/update.ps1 trên Windows.
#
# Usage:
#   ./scripts/update.sh                # full
#   ./scripts/update.sh --skip-migrate
#   ./scripts/update.sh --skip-extension
#   ./scripts/update.sh --skip-dashboard
#   ./scripts/update.sh --keep-backend
#
# Yêu cầu trước khi chạy:
#   - Docker Desktop đang chạy
#   - apps/api/.venv đã tồn tại (chạy `python -m venv apps/api/.venv` + pip install nếu chưa)
#   - apps/extension/node_modules + apps/web/node_modules đã install

set -eo pipefail

# ----- Parse flags -----
SKIP_MIGRATE=0
SKIP_EXTENSION=0
SKIP_DASHBOARD=0
KEEP_BACKEND=0
for arg in "$@"; do
  case $arg in
    --skip-migrate) SKIP_MIGRATE=1 ;;
    --skip-extension) SKIP_EXTENSION=1 ;;
    --skip-dashboard) SKIP_DASHBOARD=1 ;;
    --keep-backend) KEEP_BACKEND=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

# Repo root = parent của scripts/
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT"

# Colors (TTY only)
if [ -t 1 ]; then
  C_CYAN='\033[36m'
  C_YELLOW='\033[33m'
  C_RED='\033[31m'
  C_GREEN='\033[32m'
  C_RESET='\033[0m'
else
  C_CYAN='' C_YELLOW='' C_RED='' C_GREEN='' C_RESET=''
fi

step() {
  printf "\n${C_CYAN}=== %s ===${C_RESET}\n" "$1"
}

# Detect venv python path — macOS/Linux dùng bin/python, KHÔNG phải Scripts/python.exe
VENV_PY="apps/api/.venv/bin/python"
if [ ! -x "$VENV_PY" ]; then
  echo -e "${C_RED}Không tìm thấy $VENV_PY — chạy: python3 -m venv apps/api/.venv && apps/api/.venv/bin/pip install -r apps/api/requirements.txt${C_RESET}" >&2
  exit 1
fi

# ----- 1. Postgres alive + auto-start nếu chết -----
step "Check Postgres"
if ! docker exec autogpt-postgres pg_isready -U autogpt >/dev/null 2>&1; then
  printf "${C_YELLOW}Postgres chưa chạy, đang khởi động...${C_RESET}\n"
  if ! docker compose up -d; then
    printf "${C_RED}docker compose up thất bại — Docker Desktop đang chạy chưa?${C_RESET}\n"
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
    printf "${C_RED}Postgres không sẵn sàng sau 30s — kiểm tra: docker logs autogpt-postgres${C_RESET}\n"
    exit 1
  fi
fi
echo "OK"

# ----- 2. Alembic migrate -----
if [ "$SKIP_MIGRATE" -ne 1 ]; then
  step "Alembic migrate"
  (cd apps/api && "../../$VENV_PY" -m alembic upgrade head)
fi

# ----- 3. Restart backend (kill port 18000) -----
if [ "$KEEP_BACKEND" -ne 1 ]; then
  step "Restart backend (:18000)"
  PID=$(lsof -ti tcp:18000 || true)
  if [ -n "$PID" ]; then
    echo "Killing PID $PID on port 18000..."
    kill -9 $PID || true
    sleep 1
  fi
  # Run uvicorn in background, log to /tmp
  (cd apps/api && nohup "../../$VENV_PY" -m uvicorn app.main:app --host 127.0.0.1 --port 18000 \
    >/tmp/autogpt-backend.log 2>&1 &)
  sleep 3
  # Health check
  if curl -fsS http://127.0.0.1:18000/health >/dev/null 2>&1; then
    echo "Backend health: ok"
  else
    printf "${C_YELLOW}Backend chưa sẵn sàng, xem log: tail -f /tmp/autogpt-backend.log${C_RESET}\n"
  fi
fi

# ----- 4. Build extension -----
if [ "$SKIP_EXTENSION" -ne 1 ]; then
  step "Build extension"
  (cd apps/extension && npm run build)
fi

# ----- 5. Dashboard (Vite :17173) — auto-spawn nếu chưa chạy -----
if [ "$SKIP_DASHBOARD" -ne 1 ]; then
  step "Dashboard (Vite :17173)"
  if lsof -ti tcp:17173 >/dev/null 2>&1; then
    echo "Vite dev đang chạy trên 17173 — HMR auto pick up"
  else
    echo "Vite chưa chạy trên 17173 — spawn npm run dev ở background"
    (cd apps/web && nohup npm run dev >/tmp/autogpt-web.log 2>&1 &)
  fi
fi

printf "\n${C_GREEN}=== DONE ===${C_RESET}\n"

