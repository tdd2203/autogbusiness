# AutoGPT Admin Extension — Changelog

Mọi thay đổi đáng kể của extension được ghi tại đây. File này là **mirror text-only** của [`src/version.ts`](src/version.ts) — version.ts là single source of truth (manifest + popup UI đọc từ đó).

## Quy tắc bump version (semver-like)

- **MAJOR (`x.0.0`)** — breaking change: đổi protocol message với backend, đổi cấu trúc storage, refactor lớn buộc reload toàn bộ workspace.
- **MINOR (`0.x.0`)** — thêm action/scraper mới (SYNC_BILLING, INVITE_MEMBER…) hoặc redesign UI lớn.
- **PATCH (`0.0.x`)** — bug fix, sửa selectors khi ChatGPT đổi UI, tune regex/timing.

## Quy trình mỗi lần bump

1. Cập nhật `VERSION` trong [`src/version.ts`](src/version.ts).
2. Prepend entry mới vào đầu mảng `CHANGELOG` cùng file (most recent first).
3. Mirror entry đó vào file này (cũng most recent first).
4. Rebuild extension, reload trong `chrome://extensions/`.
5. Popup sẽ tự hiển thị version + changelog từ `version.ts` — không cần sửa manifest hay popup.

---

## v0.4.1 — 2026-05-18 — fix

**Invite flow: luôn navigate về /admin/members sau khi tắt toggle**

- `withExternalInvitesEnabled()` trong `finally`: sau khi restore toggle external invites về OFF (nếu trước đó OFF), navigate về `/admin/members` thay vì kẹt ở `/admin/identity`.
- Áp dụng cho cả invite success và invite fail — UX nhất quán + task sau (SYNC_DATA, REMOVE_MEMBER…) khởi động ở đúng trang.

---

## v0.4.0 — 2026-05-18 — feature

**HARVEST_LABELS: probe-invite mode (auto 100% locale coverage)**

- Khi tab "Pending Invites" trống, harvest tự tạo invite probe (`autogpt-probe-{ts}@example.com`) → harvest menu Revoke + confirm Revoke → tự thu hồi probe để workspace sạch.
- Bỏ `member_row_menu_button` khỏi expected list (icon-only, không có text — CSS selector handle).
- Coverage giờ 14 control_key/page Members (thay vì 15) → 18 tổng → đạt 100% nếu probe-invite chạy được.

---

## v0.3.2 — 2026-05-18 — fix

**HARVEST_LABELS: progress lifecycle (background) + initial signal**

- Background runner báo progress sớm: `queued` → `opening_tab` → `rate_limit` **trước** cả khi gửi tới content script. Trước đây dashboard im lặng 5–30s khi extension tự mở tab `chatgpt.com/admin` + inject content script.
- Content script báo signal `starting` ngay tại `0/18` trước locale check — dashboard có gì hiện ngay khi inject.
- Dashboard hiển thị status badge (`PENDING`/`IN_PROGRESS`), elapsed timer cục bộ ticking 1s, watchdog cảnh báo sau 20s nếu không thấy signal nào.
- Áp dụng cùng pattern progress lifecycle cho `SYNC_DATA`.

---

## v0.3.1 — 2026-05-18 — fix

**HARVEST_LABELS: progress real-time + nav verify + 3 phút timeout**

- Per-step progress (`current/total/scanned/elapsed_sec`) — dashboard hiện progress bar + step counter.
- `navigateSpaVerified`: kiểm tra `location.pathname` đổi thật sự sau pushState; skip page nếu nav fail thay vì hang.
- Global 3 phút timeout — harvest tự thoát nếu kẹt.
- Trả error "không lấy được label nào" nếu `total=0` sau crawl (thường do user chưa F5 hoặc selector lệch).
- JSON.parse hardening — backend 5xx không crash extension cache refresh nữa.

---

## v0.3.0 — 2026-05-18 — feature

**HARVEST_LABELS — auto-crawl ChatGPT UI label**

- Action `HARVEST_LABELS`: extension tự navigate 4 page (`/admin/members`, `/admin/billing`, `/admin/billing?tab=invoices`, `/admin/identity`), mở invite dialog + click `...` menu + đọc confirm dialog rồi ESC để hủy → đọc 18 control_key cho 1 locale.
- Dashboard Settings → UI Labels: nút "Harvest VI/EN/ZH" thay thế Console snippet thủ công.
- Endpoint mới `POST /api/v1/ui-labels/harvest` (X-API-KEY) cho extension bulk-upsert đa page.
- `POST /api/v1/workspaces/{id}/harvest-labels` (super-admin) tạo task qua SSE.

---

## v0.2.0 — 2026-05-18 — feature

**UI Label calibration + self-heal stale labels**

- Fetch `/api/v1/ui-labels/bundle` định kỳ (15 phút) — cache label calibrate vào chrome.storage.
- Actions ưu tiên label đã harvest cho (locale × page) hiện tại; fallback hardcoded text patterns nếu DB rỗng.
- Tự động POST `/report-mismatch` khi tìm element fail dù DB có label → dashboard banner stale.
- Wire DB lookup: invite open/submit/add-more, tabs (active/pending/requests/billing-plan/billing-invoices), role options, menu remove/change-role, confirm remove/revoke, toggle external invites.

---

## v0.1.0 — 2026-05-18 — feature

**Initial release**

- Cầu nối Dashboard nội bộ ↔ ChatGPT Business admin.
- Action: INVITE_MEMBER, REMOVE_MEMBER, CHANGE_ROLE, SYNC_DATA, SYNC_BILLING, REVOKE_INVITES.
- Auto-execute task qua SSE (real-time, không poll ChatGPT).
- Multi-language scraper (VI/EN/ZH).
- Port riêng: backend 18000, dashboard 17173, ext dev 17174.
