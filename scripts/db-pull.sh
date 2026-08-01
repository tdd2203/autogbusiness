#!/usr/bin/env bash
# Kéo backup DB production (VPS) về Mac — và tuỳ chọn restore vào Postgres local.
#
# Chiều dữ liệu MỘT CHIỀU: VPS (thật) → Mac (bản sao). KHÔNG BAO GIỜ đẩy ngược.
#
# Trên VPS có sẵn /root/backups/autogpt-backup.sh (dump vào /root/backups/autogpt/,
# giữ 14 bản) — CHẠY TAY khi cần, KHÔNG có cron (chốt user 2026-08-01: chỉ backup
# khi được yêu cầu). Script này lấy bản mới nhất về ~/Backups/autogpt/ (giữ 30 ngày).
#
# Usage:
#   ./scripts/db-pull.sh             # kéo bản backup đêm qua về Mac
#   ./scripts/db-pull.sh --fresh     # dump MỚI ngay bây giờ thay vì bản đêm qua
#   ./scripts/db-pull.sh --restore   # kéo xong restore luôn vào container Mac
#                                    #   (đè DB local — DB local chỉ là bản sao)
#
# Muốn backup đầy đủ 1 phát: ssh root@103.74.100.4 /root/backups/autogpt-backup.sh
# rồi chạy script này để kéo về Mac.

set -euo pipefail

SERVER="root@103.74.100.4"
REMOTE_DIR="/root/backups/autogpt"
LOCAL_DIR="$HOME/Backups/autogpt"
PG_CONTAINER="autogpt-postgres"

FRESH=0; RESTORE=0
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    --restore) RESTORE=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

mkdir -p "$LOCAL_DIR"

if [ "$FRESH" -eq 1 ]; then
  DEST="$LOCAL_DIR/autogpt-fresh-$(date +%Y%m%d-%H%M%S).dump"
  echo "Dump mới trực tiếp từ VPS..."
  ssh "$SERVER" "docker exec $PG_CONTAINER pg_dump -U autogpt -Fc autogpt_dashboard" > "$DEST"
else
  LATEST="$(ssh "$SERVER" "ls -1t $REMOTE_DIR/autogpt-*.dump 2>/dev/null | head -1")"
  if [ -z "$LATEST" ]; then
    echo "Không tìm thấy backup nào trên VPS ($REMOTE_DIR) — chạy với --fresh?" >&2
    exit 1
  fi
  DEST="$LOCAL_DIR/$(basename "$LATEST")"
  if [ -f "$DEST" ]; then
    echo "Đã có sẵn bản mới nhất: $DEST"
  else
    scp -q "$SERVER:$LATEST" "$DEST"
  fi
fi
echo "Backup local: $DEST ($(du -h "$DEST" | cut -f1))"

# Dọn bản local cũ hơn 30 ngày.
find "$LOCAL_DIR" -name 'autogpt-*.dump' -mtime +30 -delete

if [ "$RESTORE" -eq 1 ]; then
  echo "Restore vào container $PG_CONTAINER trên Mac (đè DB local)..."
  docker start "$PG_CONTAINER" >/dev/null
  for i in $(seq 1 15); do
    docker exec "$PG_CONTAINER" pg_isready -U autogpt >/dev/null 2>&1 && break
    sleep 2
  done
  docker cp "$DEST" "$PG_CONTAINER:/tmp/pull.dump"
  docker exec "$PG_CONTAINER" pg_restore --clean --if-exists --no-owner \
    -U autogpt -d autogpt_dashboard /tmp/pull.dump
  echo "Restore xong. Container $PG_CONTAINER đang chạy — muốn tắt: docker stop $PG_CONTAINER"
fi
