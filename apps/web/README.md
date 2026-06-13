# AutoGPT Dashboard Web

Frontend React + Vite + TypeScript cho Dashboard quản trị Workspace ChatGPT Business.

## Setup

```bash
cd apps/web
npm install     # hoặc pnpm install
copy .env.example .env

npm run dev     # http://localhost:17173
```

Port riêng 17173 (không dùng default 5173 của Vite) để tránh đụng project khác.
Vite proxy `/api/*` → `http://127.0.0.1:18000` (backend FastAPI), nên FE và BE chạy song song được.

## Routes

| Route | Permission yêu cầu |
|---|---|
| `/login` | – |
| `/queue` | `QUEUE_VIEW` |
| `/audit-logs` | `AUDIT_LOG_VIEW` |
| `/users` | `USER_MANAGE` (super-admin only) |
| `/billing` | `BILLING_VIEW` (super-admin only) |
| `/settings` | (mọi user đã đăng nhập) |

Sidebar tự ẩn các mục thiếu permission.
