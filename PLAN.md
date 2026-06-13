# AutoGPT — Hệ thống quản lý ChatGPT Business nội bộ

**Phiên bản:** 2.0 (rewrite sau audit code có sẵn)
**Ngày:** 2026-05-15
**Trạng thái:** Code đã đi được ~50% (auth + queue + audit). Plan dưới đây cho phần còn lại.

---

## 0. Stack & quyết định kiến trúc (CHỐT cuối cùng)

| Hạng mục | Lựa chọn |
|----------|----------|
| Hướng triển khai | **Option C — Hybrid**: giữ code có sẵn, fix red flags, code tiếp |
| Backend | **Python 3.11+ / FastAPI / SQLAlchemy 2.0 sync / Alembic** (đã có) |
| Database | **PostgreSQL 16** qua Docker (đã có `docker-compose.yml`) |
| Frontend | **React 18 + Vite + TypeScript + TailwindCSS + TanStack Query** (đã có) |
| Extension | **TypeScript + Vite + @crxjs/vite-plugin + Manifest V3** (CHƯA có — tuần 4-5) |
| Auth | **JWT username/password + bcrypt** (đã có) — KHÔNG Google OAuth |
| Admin model | **Super-admin (seed env) + Sub-admin với permission matrix 11 perms** (đã có) |
| Extension protocol | **Polling `X-API-KEY` + `SELECT![alt text](image.png) FOR UPDATE SKIP LOCKED`** (đã có) — KHÔNG WebSocket |
| Folder layout | `apps/api/`, `apps/web/`, `apps/extension/` (sẽ thêm) |

---

## 1. Hiện trạng code

### Backend (`apps/api/`) — ~700 LOC, chất lượng tốt
**DONE:**
- Auth: `POST /api/v1/auth/login` (email hoặc username), `GET /auth/me`, `POST /auth/change-password`
- Users: CRUD sub-admin, reset password, disable, permission validate
- Queue: `POST /queue` (dashboard create), `GET /queue/next` (extension poll), `PATCH /queue/{id}` (extension update result), `GET /queue` (dashboard list)
- Audit log: helper `log_event()` gọi tại mọi mutation, bảng `audit_logs` bất biến
- Migration `0001_init.py` với 3 bảng: `users`, `queue_items`, `audit_logs`
- Seed super-admin từ env, idempotent

**CHƯA CÓ:**
- Bảng/endpoint `workspaces`, `members`, `invites`, `workspace_settings`
- Endpoint sync workspace
- Notification/alert system
- Tests (zero coverage)

### Frontend (`apps/web/`) — ~700 LOC, chất lượng tốt
**DONE:**
- Login page, Layout với sidebar, ProtectedRoute với permission check
- Queue, AuditLogs, Users, Settings pages
- API wrapper, useAuth hook, permissions catalog
- TypeScript strict, no `any`

**CHƯA CÓ:**
- Workspaces, Members, Invites pages
- Workspace switcher
- Billing page (stub rỗng)

### Extension — **chưa có folder**

---

## 2. Red flags cần fix (Tuần 1)

| # | Vấn đề | File | Cách fix |
|---|--------|------|----------|
| 1 | JWT 12h không revoke được khi disable sub-admin | [security.py](apps/api/app/security.py) | Thêm `token_version INTEGER` vào `users`, JWT carry claim `tv`, bump tv khi disable/reset-password; deps check tv khớp |
| 2 | JWT trong localStorage (XSS) | [api.ts:5-12](apps/web/src/lib/api.ts#L5-L12) | (Optional, tuần 1 cuối) chuyển sang HttpOnly cookie + CSRF token |
| 3 | Default `JWT_SECRET` yếu trong `.env.example` | [.env.example:6](apps/api/.env.example#L6) | Thay bằng placeholder `__REPLACE_WITH_RANDOM_64__`, viết doc generate `openssl rand -hex 32` |
| 4 | Default `SUPER_ADMIN_PASSWORD=ChangeMe123!` | [.env.example:15](apps/api/.env.example#L15) | Để rỗng, seed.py báo lỗi nếu password ngắn < 12 ký tự |
| 5 | `EXTENSION_API_KEY` mặc định yếu | [.env.example:18](apps/api/.env.example#L18) | Tương tự — placeholder + doc generate ngẫu nhiên |
| 6 | Task IN_PROGRESS stuck nếu extension crash | [models.py](apps/api/app/models.py) (`QueueItem`) | Thêm `picked_at`, job định kỳ reset task IN_PROGRESS > 5 phút → PENDING với `attempts++` |
| 7 | Không có tests | toàn project | Tuần 1 thêm pytest cho auth + permission; tuần 8 phủ rộng |

---

## 3. Schema thiếu (Tuần 2)

### `workspaces`
```sql
id              UUID PK
chatgpt_id      TEXT UNIQUE        -- ID workspace bên ChatGPT (scrape từ URL)
name            TEXT NOT NULL
plan            TEXT               -- 'business' | 'enterprise'
seat_total      INTEGER
seat_used       INTEGER
last_synced_at  TIMESTAMP
created_at      TIMESTAMP DEFAULT NOW()
```

### `members`
```sql
id              UUID PK
workspace_id    UUID FK → workspaces.id
email           TEXT NOT NULL
name            TEXT
chatgpt_role    TEXT               -- 'owner' | 'admin' | 'member'
status          TEXT               -- 'active' | 'pending' | 'removed'
joined_at       TIMESTAMP
last_synced_at  TIMESTAMP
UNIQUE(workspace_id, email)
```

### `invites`
```sql
id              UUID PK
workspace_id    UUID FK
email           TEXT NOT NULL
role            TEXT
status          TEXT               -- 'pending' | 'accepted' | 'expired' | 'revoked'
queue_item_id   UUID FK → queue_items.id   -- link tới task tạo invite
created_at      TIMESTAMP
expires_at      TIMESTAMP
```

### `workspace_settings`
```sql
workspace_id    UUID PK FK
rate_limit_invite_ms     INTEGER DEFAULT 5000
rate_limit_role_ms       INTEGER DEFAULT 3000
rate_limit_remove_ms     INTEGER DEFAULT 5000
dry_run_mode             BOOLEAN DEFAULT FALSE
```

### Cập nhật bảng cũ
- `queue_items`: thêm `workspace_id UUID NULL FK` (nullable cho task không gắn workspace)
- `audit_logs`: đã có `target_type`/`target_id`, dùng `target_type='workspace'` để link

---

## 4. Endpoints thiếu (Tuần 2-3)

### Workspaces
- `GET    /api/v1/workspaces` — list (require `MEMBER_VIEW`)
- `POST   /api/v1/workspaces` — register workspace mới (require super-admin) `{chatgpt_id, name}`
- `GET    /api/v1/workspaces/{id}` — detail
- `POST   /api/v1/workspaces/{id}/sync` — tạo QueueItem `SYNC_DATA` (require `WORKSPACE_SYNC_TRIGGER`)
- `PATCH  /api/v1/workspaces/{id}/settings` — update rate limit (require super-admin)

### Members
- `GET    /api/v1/workspaces/{id}/members?role=&status=&q=` — require `MEMBER_VIEW`
- `POST   /api/v1/workspaces/{id}/members/bulk-upsert` — chỉ X-API-KEY (extension gọi sau khi scrape)
- `POST   /api/v1/workspaces/{id}/members/invite` — tạo QueueItem(s) `INVITE_MEMBER` (require `MEMBER_INVITE`)
- `PATCH  /api/v1/workspaces/{id}/members/{email}/role` — tạo QueueItem `CHANGE_ROLE` (require `MEMBER_CHANGE_ROLE`, chỉ super-admin)
- `DELETE /api/v1/workspaces/{id}/members/{email}` — tạo QueueItem `REMOVE_MEMBER` (require `MEMBER_REMOVE`)

### Invites
- `GET    /api/v1/workspaces/{id}/invites?status=` — list
- `POST   /api/v1/workspaces/{id}/invites/{id}/revoke` — tạo QueueItem revoke

---

## 5. Folder structure (final)

```
AutoGPT/
├── PLAN.md                              ← file này
├── README.md
├── docker-compose.yml                   ← Postgres
├── AutoGPT.code-workspace
├── .gitignore
│
├── apps/
│   ├── api/                             ← Backend (đã có ~70%)
│   │   ├── pyproject.toml
│   │   ├── alembic.ini
│   │   ├── .env.example
│   │   ├── alembic/
│   │   │   └── versions/
│   │   │       ├── 0001_init.py         ← có rồi
│   │   │       └── 0002_workspace.py    ← sẽ thêm
│   │   └── app/
│   │       ├── main.py
│   │       ├── config.py
│   │       ├── db.py
│   │       ├── models.py                ← bổ sung Workspace/Member/Invite
│   │       ├── schemas.py               ← bổ sung
│   │       ├── security.py              ← thêm token_version
│   │       ├── permissions.py
│   │       ├── deps.py
│   │       ├── audit.py
│   │       ├── seed.py
│   │       └── routers/
│   │           ├── auth.py
│   │           ├── users.py
│   │           ├── queue.py
│   │           ├── audit_logs.py
│   │           ├── workspaces.py        ← THÊM
│   │           ├── members.py           ← THÊM
│   │           └── invites.py           ← THÊM
│   │
│   ├── web/                             ← Dashboard (đã có ~60%)
│   │   ├── package.json
│   │   ├── vite.config.ts
│   │   └── src/
│   │       ├── App.tsx                  ← thêm routes
│   │       ├── hooks/
│   │       │   ├── useAuth.tsx
│   │       │   └── useWorkspace.tsx     ← THÊM
│   │       ├── pages/
│   │       │   ├── Login.tsx
│   │       │   ├── Queue.tsx
│   │       │   ├── AuditLogs.tsx
│   │       │   ├── Users.tsx
│   │       │   ├── Settings.tsx
│   │       │   ├── Billing.tsx
│   │       │   ├── Workspaces.tsx       ← THÊM
│   │       │   ├── WorkspaceDetail.tsx  ← THÊM
│   │       │   └── Members.tsx          ← THÊM
│   │       └── components/
│   │           ├── Layout.tsx           ← thêm WorkspaceSwitcher
│   │           └── WorkspaceSwitcher.tsx ← THÊM
│   │
│   └── extension/                       ← Extension (CHƯA có — tuần 4-5)
│       ├── package.json
│       ├── vite.config.ts
│       ├── manifest.json
│       └── src/
│           ├── background/
│           │   ├── index.ts             ← service worker, polling
│           │   ├── job-runner.ts
│           │   └── keepalive.ts         ← chrome.alarms
│           ├── content/
│           │   ├── index.ts
│           │   ├── scrapers/
│           │   │   ├── members.ts
│           │   │   └── workspace.ts
│           │   └── actions/
│           │       ├── invite.ts
│           │       ├── change-role.ts
│           │       └── remove.ts
│           ├── popup/
│           │   └── index.tsx            ← status + API key config
│           └── shared/
│               └── messages.ts
│
├── docs/
│   ├── setup.md
│   ├── extension-install.md
│   └── architecture.md
│
├── Authentication_and_Authorization/    ← specs (đã có)
├── Workspace_Management/                ← specs (đã có)
└── Queue_and_Audit/                     ← specs (đã có)
```

---

## 6. Roadmap chi tiết

### Tuần 1 — Fix red flags + tests baseline
- [ ] Add `token_version` cột vào `users`, migration `0002_token_version` hoặc gộp vào `0002`
- [ ] JWT carry `tv` claim, `get_current_user` check tv khớp
- [ ] Bump tv khi `disable`/`reset-password`/`change-password`
- [ ] Rewrite `.env.example` với placeholder thay vì default yếu, thêm `setup.md` hướng dẫn generate
- [ ] Pytest baseline: `tests/test_auth.py`, `tests/test_users_permissions.py`, `tests/test_queue_skip_locked.py`
- [ ] (Optional) Reset password UX: hiển thị 1 lần qua modal có copy-to-clipboard, KHÔNG dùng `window.prompt`
- **Deliverable:** disable sub-admin → token cũ invalid ngay; CI có 1 run pytest pass

### Tuần 2 — Workspace/Member/Invite tables + endpoints
- [ ] Migration `0003_workspace_member_invite.py`
- [ ] Models + schemas
- [ ] Routers: `workspaces.py`, `members.py`, `invites.py`
- [ ] Cập nhật `queue.py` để payload chứa `workspace_id`
- [ ] Cập nhật `permissions.py` mapping với queue types mới (đã có nhưng chưa link workspace)
- [ ] Tests
- **Deliverable:** curl tạo workspace, list workspace, tạo invite QueueItem có workspace_id

### Tuần 3 — Frontend Workspace/Member UI
- [ ] Pages: `Workspaces.tsx` (list + create), `WorkspaceDetail.tsx`, `Members.tsx`
- [ ] `useWorkspace` hook + `WorkspaceSwitcher` component
- [ ] Invite form (single + bulk CSV)
- [ ] Cập nhật ProtectedRoute để inject current workspace context
- **Deliverable:** Admin tạo workspace, mời 1 email → QueueItem PENDING với workspace_id; UI hiển thị queue

### Tuần 4 — Extension MV3 skeleton + sync member
- [ ] `apps/extension/` init: Vite + @crxjs + TS
- [ ] Background worker: kết nối backend, polling `/queue/next` với X-API-KEY
- [ ] Keepalive `chrome.alarms` 25s/lần
- [ ] Popup: hiển thị connection status + cấu hình base URL + API key
- [ ] Content script: detect `chatgpt.com/admin/people`, scrape danh sách member
- [ ] Action `sync_data`: scrape full → POST `/workspaces/{id}/members/bulk-upsert`
- **Deliverable:** click "Sync" trên dashboard → extension scrape → DB có member

### Tuần 5 — Action `invite` end-to-end + rate limit
- [ ] Content script action `invite`: điền email, click button, verify alert/UI
- [ ] Rate limiter trong job-runner: max 5 actions / batch, sleep 30-60s giữa batch
- [ ] Delay random 1.5-4s giữa các micro-step (mousedown→mouseup→click)
- [ ] Detect UI changed → `FAILED_UI_CHANGED` (xem spec [Invite_Member.md](Workspace_Management/Invite_Member.md))
- **Deliverable:** mời 5 email từ dashboard → 5 invite chạy tuần tự với delay đúng

### Tuần 6 — Actions `change_role` + `remove`
- [ ] Content script action `change_role`, `remove`
- [ ] UI confirm dialog "Type email to confirm" cho remove
- [ ] Sau mỗi action, refresh member list để verify
- [ ] Test thủ công 3 flow trên workspace test
- **Deliverable:** đổi role + remove an toàn có verify

### Tuần 7 — Sync workspace billing + alerts
- [ ] Bảng `workspace_billing` (next_due, status UNPAID/PAID, last_synced)
- [ ] Content scraper billing page
- [ ] Action `sync_billing` (rate limit 1/5 phút)
- [ ] Bảng `notifications` + endpoint
- [ ] UI: trang Billing thật (không stub), banner UNPAID
- [ ] (Optional) Telegram bot channel cho admin
- **Deliverable:** dashboard cảnh báo UNPAID, có nút "Thanh toán ngay" → redirect OpenAI

### Tuần 8 — Polish + tests + docs
- [ ] Retry task stuck IN_PROGRESS (cron `app/jobs/reset_stuck_tasks.py`)
- [ ] Tests: phủ rộng backend (≥60% coverage), vitest frontend basic
- [ ] Export CSV (members, audit logs)
- [ ] Setup script + docs: `setup.md`, `extension-install.md`, `architecture.md`
- [ ] Cleanup TODOs, run ruff + lint
- **Deliverable:** sẵn sàng dùng nội bộ, có docs

---

## 7. Rủi ro & cách giảm thiểu

| Rủi ro | Mức độ | Mitigation |
|--------|--------|------------|
| OpenAI đổi DOM `chatgpt.com/admin` | **Cao** | Tách scraper module riêng, multi-selector (data-testid → aria-label → text), spec yêu cầu Fail-Fast `FAILED_UI_CHANGED` |
| Vi phạm TOS OpenAI khi automation | **TB** | Rate limit nghiêm (5/đợt + 30-60s nghỉ), delay random 1.5-4s, có `dry_run_mode`, log đầy đủ. Spec đã design anti-detection |
| Service worker MV3 ngắt | **TB** | `chrome.alarms` keepalive 25s, polling thay vì WS giảm độ phụ thuộc connection |
| JWT cũ vẫn dùng được sau disable | **TB→Thấp** | Tuần 1 fix bằng `token_version` |
| Task IN_PROGRESS stuck | **TB→Thấp** | Tuần 8 cron reset task quá hạn |
| Postgres race condition khi nhiều extension cùng poll | **Thấp** | Đã có `SELECT FOR UPDATE SKIP LOCKED` |
| Default secrets `.env.example` | **TB→Thấp** | Tuần 1 thay placeholder + doc generate |
| Reset password UX kém (window.prompt plaintext) | **Thấp** | Tuần 1 chuyển sang modal copy-to-clipboard |

---

## 8. Định nghĩa "Done" cho MVP

MVP (sau Tuần 6) hoàn thành khi:

1. Super-admin login dashboard với username/password, tạo được sub-admin với permissions tùy chọn
2. Disable sub-admin → token cũ invalid ngay lập tức (fix red flag #1)
3. Tạo 1 workspace, sync 1 lần → DB có đủ member, role, status
4. Mời 1 email từ dashboard → email nhận lời mời trong ≤60s (queue + rate limit hoạt động)
5. Đổi role 1 member → cập nhật trên ChatGPT + DB + audit log
6. Remove 1 member với confirm → biến mất khỏi ChatGPT + DB cập nhật + audit log
7. Tất cả action có entry trong `audit_logs` với actor + target + result
8. Extension popup hiển thị connection status đúng, có thể cấu hình API key

MVP+ (Tuần 7-8): billing sync + alerts + tests + docs.

---

## 9. Câu hỏi cần xác nhận trước khi code Tuần 1

1. **Postgres đã chạy chưa?** `docker compose up -d` đã chạy được? Đã `alembic upgrade head` thành công?
2. **Có workspace ChatGPT Business để test không?** Cần ≥1 workspace có ≥2 member để verify sync/invite/remove.
3. **Tuần 1 fix red flags theo thứ tự nào?** Tôi đề xuất: token_version → secrets → reset password modal → tests. (HttpOnly cookie để optional, vì single-admin local-only rủi ro XSS thấp).
4. **Có muốn drop DB cũ + chạy lại migration không?** Vì sẽ thêm `token_version`, có thể merge vào migration `0001` thay vì tạo `0002` (nhưng chỉ làm được nếu chưa có data quan trọng).

---

## 10. Bước tiếp theo ngay

Tuần 1 sẽ bắt đầu với:

1. Đọc thật kỹ `apps/api/app/security.py`, `deps.py`, `models.py` để biết chỗ patch
2. Tạo migration thêm `token_version` (hoặc merge vào `0001_init.py` nếu drop DB)
3. Patch `security.create_access_token()` + `deps.get_current_user()` check `tv`
4. Patch `routers/users.py` để bump tv khi disable/reset-password
5. Patch `routers/auth.py` để bump tv khi change-password
6. Viết `tests/test_token_version.py`
7. Cập nhật `.env.example` placeholder + docs
