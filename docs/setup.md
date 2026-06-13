# Setup AutoGPT (Windows + PowerShell)

## Yêu cầu

- Docker Desktop (Postgres chạy trong container)
- Python 3.11+ (đã test với 3.14)
- Node.js 20+
- PowerShell 5.1+ hoặc PowerShell 7

## 1. Khởi động Postgres

```powershell
docker compose up -d
```

Kiểm tra:

```powershell
docker exec autogpt-postgres pg_isready -U autogpt
```

Đợi tới khi `accepting connections`.

## 2. Cấu hình `apps/api/.env`

```powershell
Copy-Item apps\api\.env.example apps\api\.env
```

Mở file `apps/api/.env` và thay 3 placeholder:

| Biến | Cách generate |
|------|---------------|
| `JWT_SECRET` | `-join ((48..57)+(97..102) \| Get-Random -Count 64 \| ForEach-Object {[char]$_})` |
| `SUPER_ADMIN_PASSWORD` | Tự đặt ≥ 12 ký tự, có hoa/thường/số/đặc biệt. Đổi ngay sau login đầu tiên. |
| `EXTENSION_API_KEY` | `-join ((48..57)+(97..102) \| Get-Random -Count 48 \| ForEach-Object {[char]$_})` |

Có thể giữ `SUPER_ADMIN_EMAIL` và `SUPER_ADMIN_USERNAME` mặc định nếu chỉ dùng local.

## 3. Backend

```powershell
cd apps\api
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .[dev]
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

Backend chạy tại http://localhost:8000. Swagger: http://localhost:8000/docs.

Lần đầu khởi động, super-admin được seed tự động từ `.env`. Lần sau bỏ qua nếu đã tồn tại.

### Khắc phục lỗi bcrypt

Nếu thấy lỗi `password cannot be longer than 72 bytes`, bcrypt 5.x không tương thích passlib 1.7.4. Cài lại đúng version:

```powershell
pip install "bcrypt<4.0"
```

`pyproject.toml` đã pin sẵn, nhưng nếu môi trường cũ vẫn dính, chạy lệnh trên.

## 4. Frontend

```powershell
cd apps\web
npm install
Copy-Item .env.example .env
npm run dev
```

Frontend chạy tại http://localhost:5173.

## 5. Login

Mở http://localhost:5173, nhập:

- **Tài khoản**: `admin` (hoặc email `admin@example.com`)
- **Password**: giá trị bạn đặt cho `SUPER_ADMIN_PASSWORD`

Vào trang **Cài đặt** → Đổi mật khẩu.

## Tests

```powershell
cd apps\api

# Lần đầu, tạo test DB:
docker exec autogpt-postgres psql -U autogpt -d postgres -c "CREATE DATABASE autogpt_test OWNER autogpt;"

# Chạy tests:
.\.venv\Scripts\python.exe -m pytest tests\ -v
```

Tests dùng DB riêng `autogpt_test`, không đụng `autogpt_dashboard` đang dev.

## Kiến trúc tóm tắt

```
Browser  ──http──▶  Vite :5173  ──http──▶  FastAPI :8000  ──TCP──▶  Postgres :5432
                                              ▲
                                              │ X-API-KEY (polling)
                                              │
                                          Chrome Extension (chưa có — Tuần 4)
                                              │
                                              ▼
                                      chatgpt.com/admin/*
```

Chi tiết: xem [PLAN.md](../PLAN.md).
