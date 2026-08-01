#!/usr/bin/env bash
# Chạy test suite backend (apps/api) trong container trên docker network.
#
# Lý do: Postgres KHÔNG expose port ra host (xem docker-compose.yml) nên chạy pytest
# trực tiếp từ máy Mac sẽ bị "Connection refused". Script này chạy pytest trong một
# container dùng lại image autogbusiness-api (đã có sẵn runtime deps), nối vào cùng
# docker network với Postgres và trỏ tới database test riêng.
#
# Dùng:
#   scripts/test-api.sh                 # chạy toàn bộ
#   scripts/test-api.sh -k wallet -q    # truyền thẳng tham số cho pytest
#
set -euo pipefail
cd "$(dirname "$0")/.."

PG_CONTAINER="autogpt-postgres"
API_IMAGE="autogbusiness-api"
DB_NAME="autogpt_test"

# 1) Postgres phải đang chạy.
if ! docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
  echo "❌ Container '$PG_CONTAINER' chưa chạy. Khởi động: docker compose up -d postgres" >&2
  exit 1
fi

# Lấy password thật từ chính container Postgres (khớp .env), không hardcode.
PG_PASS="$(docker exec "$PG_CONTAINER" printenv POSTGRES_PASSWORD)"
PG_PASS="${PG_PASS:-autogpt}"

# 2) Lấy tên docker network mà Postgres đang gắn (không hardcode).
NETWORK="$(docker inspect "$PG_CONTAINER" \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')"
if [ -z "$NETWORK" ]; then
  echo "❌ Không xác định được docker network của '$PG_CONTAINER'." >&2
  exit 1
fi

# 3) Đảm bảo database test tồn tại (idempotent).
if ! docker exec "$PG_CONTAINER" psql -U autogpt -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -qx 1; then
  echo "ℹ️  Tạo database test '${DB_NAME}'..."
  docker exec "$PG_CONTAINER" createdb -U autogpt "$DB_NAME"
fi

# 4) Chạy pytest trong container: mount source hiện tại vào /app (ghi đè code baked
#    trong image để test đúng bản đang sửa), cài thêm dev deps, trỏ DATABASE_URL tới
#    service "postgres" trong network.
echo "▶️  Chạy pytest trên network '$NETWORK' → ${DB_NAME}"
exec docker run --rm \
  --network "$NETWORK" \
  -e DATABASE_URL="postgresql+psycopg://autogpt:${PG_PASS}@postgres:5432/${DB_NAME}" \
  -e PIP_DISABLE_PIP_VERSION_CHECK=1 \
  -v "$PWD/apps/api:/app" \
  -w /app \
  "$API_IMAGE" \
  sh -c 'pip install -q pytest httpx >/dev/null && exec python -m pytest "$@"' -- "$@"
