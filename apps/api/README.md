# AutoGPT Dashboard API

Backend FastAPI + PostgreSQL cho Dashboard quản trị Workspace ChatGPT Business.

## Yêu cầu
- Python 3.11+
- PostgreSQL 14+ (xem [docker-compose.yml](../../docker-compose.yml))

## Setup

```bash
cd apps/api
python -m venv .venv
.venv\Scripts\activate     # Windows
pip install -e .[dev]

# config
copy .env.example .env
# sửa SUPER_ADMIN_*, JWT_SECRET, EXTENSION_API_KEY trong .env

# migrate
alembic upgrade head

# chạy
uvicorn app.main:app --reload --port 8000
```

Lần đầu khởi động, super-admin được seed tự động từ env. Lần sau bỏ qua nếu đã tồn tại.

## Endpoints

| Method | Path | Auth | Mô tả |
|---|---|---|---|
| POST | `/api/v1/auth/login` | – | `{ identifier, password }` → JWT |
| GET | `/api/v1/auth/me` | Bearer | Thông tin user hiện tại |
| POST | `/api/v1/auth/change-password` | Bearer | Đổi password (cho mọi user) |
| GET | `/api/v1/users` | Super-admin | List users |
| POST | `/api/v1/users` | Super-admin | Tạo sub-admin |
| PATCH | `/api/v1/users/{id}` | Super-admin | Đổi permissions / enable / disable |
| POST | `/api/v1/users/{id}/reset-password` | Super-admin | Reset password sub-admin |
| POST | `/api/v1/queue` | Bearer + perm theo loại task | Tạo task cho Extension |
| GET | `/api/v1/queue` | `QUEUE_VIEW` | List task |
| GET | `/api/v1/queue/next` | X-API-KEY | Extension lấy task PENDING |
| PATCH | `/api/v1/queue/{id}` | X-API-KEY | Extension cập nhật kết quả |
| GET | `/api/v1/audit-logs` | `AUDIT_LOG_VIEW` | List audit logs |
| GET | `/health` | – | Liveness |

Swagger UI: http://localhost:8000/docs
