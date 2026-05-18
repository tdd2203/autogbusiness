# Project: gpt
**Description:** Hệ thống quản trị Workspace ChatGPT Business gồm Dashboard nội bộ + Chrome Extension + Backend API.

## Modules Index (use case docs)
- [Authentication_and_Authorization](./Authentication_and_Authorization) — Login + Manage Sub-Accounts
- [Workspace_Management](./Workspace_Management) — Invite / Remove / Change Role / Sync Data / Sync Billing
- [Queue_and_Audit](./Queue_and_Audit) — Record Action Log / Send Alert
- [chatgpt-admin-label-harvest](./docs/chatgpt-admin-label-harvest.md) — Kịch bản thu thập label UI (vi/en/zh) từ 4 trang ChatGPT admin

## Implementation
- [apps/api](./apps/api) — Backend FastAPI + PostgreSQL
- [apps/web](./apps/web) — Frontend React + Vite

## Quickstart (dev)

```bash
# 1. khởi động Postgres
docker compose up -d

# 2. backend
cd apps/api
python -m venv .venv
.venv\Scripts\activate
pip install -e .[dev]
copy .env.example .env
alembic upgrade head
uvicorn app.main:app --reload --port 8000

# 3. frontend (terminal khác)
cd apps/web
npm install
copy .env.example .env
npm run dev
```

Super-admin được seed tự động từ `SUPER_ADMIN_EMAIL/USERNAME/PASSWORD` trong `apps/api/.env` lần đầu khởi động.

Mở http://localhost:17173, đăng nhập bằng email hoặc username của super-admin.

## Architecture

```
       Admin
         │
         ▼
[Dashboard Web (React)]  ──REST──►  [Backend API (FastAPI)]
                                              │
                                              ├── Postgres (users, queue, audit_logs)
                                              │
                                              ▼
                              [Chrome Extension (X-API-KEY)]
                                              │
                                              ▼
                              ChatGPT Business UI (chatgpt.com)
```

- Admin (super-admin / sub-admin) đăng nhập Dashboard bằng email/username + password.
- Dashboard tạo task (`QueueItem`) → Extension polling lấy task → thao tác trên ChatGPT UI → cập nhật kết quả về Backend.
- Mọi sự kiện ghi vào `audit_logs` (bất biến).
