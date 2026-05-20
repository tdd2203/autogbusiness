#!/usr/bin/env bash
# Dev mode: 1 lệnh khởi chạy toàn bộ stack trên macOS / Linux.
# Tương đương scripts/dev.ps1 (Windows).
#
# Backend / Web / Extension chạy NỀN, log → logs/*.log. Dùng `tail -f` để xem.
#
# Usage:
#   ./scripts/dev.sh                  # full stack background
#   ./scripts/dev.sh --skip-migrate   # bỏ alembic upgrade
#   ./scripts/dev.sh --skip-backend   # không start uvicorn
#   ./scripts/dev.sh --skip-web       # không start Vite web
#   ./scripts/dev.sh --skip-extension # không start Vite extension watch
#   ./scripts/dev.sh --foreground     # backend foreground (web+ext vẫn nền)
#   ./scripts/dev.sh --stop           # dừng tất cả service đã start
#   ./scripts/dev.sh --status         # xem service nào đang chạy
#
# Nếu bị "Permission denied" khi chạy:
#   chmod +x scripts/dev.sh
#
# Nếu shebang lỗi ('\r: command not found' hoặc 'bad interpreter'):
#   File đã bị CRLF. Fix:
#     sed -i '' 's/\r$//' scripts/dev.sh   # macOS
#     sed -i    's/\r$//' scripts/dev.sh   # Linux
#
# Setup lần đầu (yêu cầu):
#   - Docker Desktop (mac) / Docker Engine (Linux) đang chạy
#   - python3 -m venv apps/api/.venv
#     apps/api/.venv/bin/pip install -e "apps/api[dev]"
#   - (cd apps/web && npm install)
#   - (cd apps/extension && npm install)
#
# Xem logs runtime:
#   tail -f logs/backend.log
#   tail -f logs/web.log
#   tail -f logs/extension.log

set -eo pipefail

# ----- Parse flags -----
SKIP_MIGRATE=0
SKIP_BACKEND=0
SKIP_WEB=0
SKIP_EXTENSION=0
FOREGROUND=0
STOP_ONLY=0
STATUS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --skip-migrate) SKIP_MIGRATE=1 ;;
    --skip-backend) SKIP_BACKEND=1 ;;
    --skip-web) SKIP_WEB=1 ;;
    --skip-extension) SKIP_EXTENSION=1 ;;
    --foreground) FOREGROUND=1 ;;
    --stop) STOP_ONLY=1 ;;
    --status) STATUS_ONLY=1 ;;
    -h|--help)
      sed -n '2,28p' "$0"
      exit 0
      ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

# ----- Colors (chỉ in nếu stdout là tty) -----
if [ -t 1 ]; then
  C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'; C_GRAY=$'\033[90m'; C_RESET=$'\033[0m'
else
  C_CYAN=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_GRAY=""; C_RESET=""
fi

step() { printf '\n%s=== %s ===%s\n' "$C_CYAN" "$1" "$C_RESET"; }
info() { printf '%s%s%s\n' "$C_GRAY" "$1" "$C_RESET"; }
warn() { printf '%s%s%s\n' "$C_YELLOW" "$1" "$C_RESET"; }
ok()   { printf '%s%s%s\n' "$C_GREEN" "$1" "$C_RESET"; }
err()  { printf '%s%s%s\n' "$C_RED" "$1" "$C_RESET" >&2; }

# Repo root = parent của scripts/
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT"
LOGS_DIR="$ROOT/logs"
mkdir -p "$LOGS_DIR"

# ----- Port helpers (macOS + Linux đều có lsof) -----
port_pid() {
  # In tất cả PID đang listen port $1 (1 dòng / PID), rỗng nếu không có
  lsof -ti tcp:"$1" -sTCP:LISTEN 2>/dev/null || true
}

kill_port() {
  local port="$1"
  local pids
  pids=$(port_pid "$port")
  if [ -n "$pids" ]; then
    info "Killing PID(s) $(echo "$pids" | tr '\n' ' ')on port $port..."
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
    sleep 1
  fi
}

# ----- Service control: store PID vào logs/<name>.pid -----
service_pidfile() { echo "$LOGS_DIR/$1.pid"; }
service_logfile() { echo "$LOGS_DIR/$1.log"; }

start_service_bg() {
  # start_service_bg <name> <workdir> <command...>
  local name="$1"; shift
  local workdir="$1"; shift
  local logfile pidfile
  logfile=$(service_logfile "$name")
  pidfile=$(service_pidfile "$name")
  (
    cd "$workdir"
    # Tách log session bằng marker để dễ scroll back
    echo "===== $(date '+%Y-%m-%d %H:%M:%S') START $name =====" >> "$logfile"
    # nohup tách process khỏi terminal — Ctrl+C không kill nó
    nohup "$@" >> "$logfile" 2>&1 &
    echo $! > "$pidfile"
  )
  ok "  $name started (PID $(cat "$pidfile"), log: logs/$name.log)"
}

stop_service() {
  local name="$1"
  local pidfile
  pidfile=$(service_pidfile "$name")
  if [ -f "$pidfile" ]; then
    local pid
    pid=$(cat "$pidfile" 2>/dev/null || echo "")
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      info "Stopping $name (PID $pid)..."
      # Gửi TERM cho nhóm process (uvicorn/vite fork worker)
      kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      sleep 1
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi
}

service_status() {
  local name="$1" port="$2"
  local pidfile
  pidfile=$(service_pidfile "$name")
  local pid="" alive="no"
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile" 2>/dev/null || echo "")
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive="yes"; fi
  fi
  local lsof_pid
  lsof_pid=$(port_pid "$port" | head -1)
  printf '  %-10s pidfile=%-8s alive=%-3s port:%s=%s\n' \
    "$name" "${pid:-—}" "$alive" "$port" "${lsof_pid:-free}"
}

# ----- Mode: --stop -----
if [ "$STOP_ONLY" = "1" ]; then
  step "Stop all dev services"
  stop_service backend
  stop_service web
  stop_service extension
  # Belt-and-suspenders kill theo port
  kill_port 18000
  kill_port 17173
  kill_port 17174
  ok "Done."
  exit 0
fi

# ----- Mode: --status -----
if [ "$STATUS_ONLY" = "1" ]; then
  step "Dev services status"
  service_status backend 18000
  service_status web 17173
  service_status extension 17174
  exit 0
fi

# ===== Normal startup =====

# 1. Postgres (docker)
step "Postgres"
if ! command -v docker >/dev/null 2>&1; then
  err "docker không có trong PATH. Cài Docker Desktop (mac) / Docker Engine (Linux) trước."
  exit 1
fi
if docker exec autogpt-postgres pg_isready -U autogpt >/dev/null 2>&1; then
  ok "  Postgres OK (container autogpt-postgres)"
else
  warn "  Container chưa lên — docker compose up -d..."
  if ! docker compose up -d 2>&1 | sed 's/^/    /'; then
    err "docker compose failed. Docker daemon đang chạy chưa?"
    exit 1
  fi
  POSTGRES_READY=0
  for _ in $(seq 1 15); do
    sleep 2
    if docker exec autogpt-postgres pg_isready -U autogpt >/dev/null 2>&1; then
      POSTGRES_READY=1; break
    fi
  done
  if [ "$POSTGRES_READY" = "1" ]; then
    ok "  Postgres ready"
  else
    err "Postgres chưa ready sau 30s — kiểm tra: docker logs autogpt-postgres"
    exit 1
  fi
fi

# 2. Alembic migrate
if [ "$SKIP_MIGRATE" != "1" ]; then
  step "Alembic migrate"
  VENV_PY="$ROOT/apps/api/.venv/bin/python"
  if [ ! -x "$VENV_PY" ]; then
    err "Không tìm thấy $VENV_PY"
    err "Setup venv: python3 -m venv apps/api/.venv && apps/api/.venv/bin/pip install -e 'apps/api[dev]'"
    exit 1
  fi
  ( cd "$ROOT/apps/api" && "$VENV_PY" -m alembic upgrade head ) | sed 's/^/  /'
  ok "  Migrations OK"
fi

# 3. Backend (uvicorn --reload)
if [ "$SKIP_BACKEND" != "1" ]; then
  step "Free port 18000"
  kill_port 18000
  stop_service backend
  ok "  Port 18000 free"

  step "Start backend (uvicorn --reload, port 18000)"
  VENV_PY="$ROOT/apps/api/.venv/bin/python"
  if [ ! -x "$VENV_PY" ]; then
    err "Không tìm thấy $VENV_PY (xem hướng dẫn setup ở đầu file)"
    exit 1
  fi
  if [ "$FOREGROUND" = "1" ]; then
    info "  --foreground: backend chạy trực tiếp (Ctrl+C để dừng)"
    info "  Web + Extension sẽ start nền TRƯỚC, sau đó backend foreground."
  fi
  if [ "$FOREGROUND" != "1" ]; then
    start_service_bg backend "$ROOT/apps/api" \
      "$VENV_PY" -m uvicorn app.main:app --host 127.0.0.1 --port 18000 --reload
    # Health check
    BACKEND_OK=0
    for _ in $(seq 1 10); do
      sleep 1
      if curl -fs http://127.0.0.1:18000/health >/dev/null 2>&1; then
        BACKEND_OK=1; break
      fi
    done
    if [ "$BACKEND_OK" = "1" ]; then
      ok "  Backend health OK"
    else
      warn "  Backend chưa ready sau 10s — xem: tail -f logs/backend.log"
    fi
  fi
fi

# 4. Web (Vite dev, port 17173)
if [ "$SKIP_WEB" != "1" ]; then
  step "Start web dev (Vite :17173)"
  if [ -n "$(port_pid 17173)" ]; then
    warn "  Port 17173 đã có process — skip"
  else
    stop_service web
    start_service_bg web "$ROOT/apps/web" npm run dev
  fi
fi

# 5. Extension (Vite watch, port 17174)
if [ "$SKIP_EXTENSION" != "1" ]; then
  step "Start extension watch (Vite :17174)"
  if [ -n "$(port_pid 17174)" ]; then
    warn "  Port 17174 đã có process — skip"
  else
    stop_service extension
    start_service_bg extension "$ROOT/apps/extension" npm run dev
    info "  Sau khi extension build xong: reload trong chrome://extensions"
  fi
fi

# 6. Foreground backend (nếu user yêu cầu) — chạy CUỐI để web/ext đã up
if [ "$SKIP_BACKEND" != "1" ] && [ "$FOREGROUND" = "1" ]; then
  step "Backend foreground"
  VENV_PY="$ROOT/apps/api/.venv/bin/python"
  printf '\n%s=== ALL UP (backend foreground) ===%s\n' "$C_GREEN" "$C_RESET"
  echo "  Backend : http://127.0.0.1:18000  (docs: /docs)"
  echo "  Web     : http://127.0.0.1:17173"
  echo "  Postgres: localhost:5432 (docker)"
  echo "  Stop    : Ctrl+C (sẽ chỉ dừng backend) → ./scripts/dev.sh --stop để dừng hết"
  echo
  exec "$VENV_PY" -m uvicorn app.main:app --host 127.0.0.1 --port 18000 --reload --app-dir "$ROOT/apps/api"
fi

# 7. Summary
printf '\n%s=== ALL UP ===%s\n' "$C_GREEN" "$C_RESET"
echo "  Backend  : http://127.0.0.1:18000  (docs: /docs)"
echo "  Web      : http://127.0.0.1:17173"
echo "  Postgres : localhost:5432 (docker)"
echo
printf '%sCommands:%s\n' "$C_GRAY" "$C_RESET"
echo "  tail -f logs/backend.log"
echo "  tail -f logs/web.log"
echo "  tail -f logs/extension.log"
echo "  ./scripts/dev.sh --status"
echo "  ./scripts/dev.sh --stop"
