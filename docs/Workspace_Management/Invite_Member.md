# Use Case: Invite Member

**Description:** Admin m�?i thành viên mới vào workspace qua Dashboard, được thực thi bởi Extension.

**Precondition:** Admin đã đăng nhập vào Dashboard và đã đăng nhập tài khoản ChatGPT Business trên trình duyệt. Backend đã sẵn sàng.

**Postcondition:** Thành viên đã được gửi l�?i m�?i trên ChatGPT, trạng thái yêu cầu được cập nhật trong hệ thống, và hành động được ghi nhật ký.

## Actors
- **Chrome Extension**
- **Backend API**
- **Dashboard UI**
- **Admin**

## Data Entities
- **AuditLog**
- **QueueItem**
- **Member**

## Flows
### EXCEPTION: UI Change Exception
1. Extension không tìm thấy các phần tử UI (có thể ChatGPT thay đổi giao diện).
2. Extension ghi nhận lỗi, ngừng thực thi và gửi trạng thái 'FAILED' với lý do 'UI_ELEMENT_NOT_FOUND' v�? Backend API.
3. Backend API đánh dấu 'QueueItem' là 'FAILED'.
4. Dashboard UI hiển thị thông báo đ�?: 'Extension cần bảo trì: Không thể tương tác với giao diện ChatGPT'.

### MAIN: Main Flow
1. Admin nhập email thành viên và ch�?n role trên Dashboard UI, nhấn 'M�?i'.
2. Dashboard UI gửi request 'Tạo yêu cầu m�?i' tới Backend API.
3. Backend API validate dữ liệu (email hợp lệ, quy�?n của Admin), tạo bản ghi vào bảng 'QueueItem' với trạng thái 'PENDING'.
4. Chrome Extension polling Backend API mỗi 30 giây để lấy các yêu cầu 'PENDING'.
5. Chrome Extension nhận yêu cầu 'INVITE_MEMBER' (chứa email, role).
6. Chrome Extension kiểm tra trạng thái đăng nhập của Admin tại trang ChatGPT Business.
7. Chrome Extension đi�?u hướng tới trang quản lý thành viên (có độ trễ ngẫu nhiên).
8. Chrome Extension thực hiện nhập email (mô ph�?ng gõ phím), ch�?n role, và click 'Invite' (mô ph�?ng chuỗi sự kiện chuột).
9. Chrome Extension đợi thông báo xác nhận từ trang ChatGPT (có timeout).
10. Chrome Extension gửi kết quả 'SUCCESS' kèm message v�? Backend API.
11. Backend API cập nhật trạng thái 'QueueItem' thành 'COMPLETED' và tạo bản ghi AuditLog.
12. Dashboard UI cập nhật trạng thái thành công cho Admin.

## Business Rules
- M�?i hành động phải tạo một bản ghi Audit Log tại Backend.
- Tốc độ thực hiện tối đa là 5 ngư�?i/lần, sau đó nghỉ 30-60 giây.
- Extension phải kiểm tra sự tồn tại của các thành phần UI trước khi tương tác.
- Các thao tác nhập liệu phải mô ph�?ng hành động gõ phím từng ký tự.
- Không được sử dụng trực tiếp .click(), phải mô ph�?ng chuỗi sự kiện mousedown -> mouseup -> click.
- M�?i thao tác của Extension (click, gõ phím) phải có độ trễ ngẫu nhiên từ 1.5s - 4s để mô ph�?ng ngư�?i thật.
- Admin phải đăng nhập vào Dashboard và ChatGPT Business trước khi bắt đầu.

## Changelog

### 2026-05-20 — FORCE tắt toggle external invites + đợi DOM list stable trước F5 (extension v0.6.6)
- **Loại**: bugfix (regression của v0.6.5)
- **User report**: (a) toggle external invites KHÔNG tự tắt nếu user đã bật ON sẵn từ trước; (b) email trong tab "Lời mời đang chờ xử lý" load thiếu so với ChatGPT thật.
- **Fix 1 — Force OFF toggle**: `withExternalInvitesEnabled` finally bỏ điều kiện `if (setResult.changed)`. LUÔN gọi `setExternalInvites(false)` sau invite, kể cả khi prev đã ON. Lý do: "Cho phép lời mời ngoài tên miền" là rủi ro bảo mật — extension phải về OFF sau mỗi invite, user có thể bật lại thủ công nếu cần.
- **Fix 2 — Wait DOM stable trước F5**: Trong `executeInvite`, sau `clickTabAndWait("tab_pending_invites", 3000ms)` thêm `waitForPendingListStable(emails, 8s)`. Hàm này poll text-node email pattern trong main element, return khi: (i) tất cả email vừa mời xuất hiện, HOẶC (ii) row count stable 2 tick liên tiếp. Tránh F5 cắt giữa lúc ChatGPT React Query đang fetch → sau F5 serve cache stale.
- **Fix 3 — Phase 2 verify chờ đủ + retry tăng cường**: `executeVerifyPendingInvite` tăng initial sleep 800 → 2500ms. Retry chain `[0, 2500]` (v0.6.5) → `[0, 3000, 6000]` (v0.6.6). Mỗi retry attempt > 0 dùng `forceReload=true` (bounce tab Người dùng → Lời mời) để ép ChatGPT re-fetch list.
- **Trade-off**: invite chậm hơn v0.6.5 ~3-7s nhưng độ chính xác cao hơn — không còn miss email.
- **File đã đổi**: [external-invites.ts](../../apps/extension/src/content/actions/external-invites.ts) (force OFF), [invite.ts](../../apps/extension/src/content/actions/invite.ts) (waitForPendingListStable + sleep + retry).
- **Version**: [version.ts](../../apps/extension/src/version.ts), [CHANGELOG.md](../../apps/extension/CHANGELOG.md) bump `v0.6.6`.

### 2026-05-20 — Fix thứ tự bước invite: TẮT toggle TRƯỚC, chuyển tab Lời mời SAU (extension v0.6.5)
- **Loại**: bugfix (regression của v0.6.4)
- **User spec (chính xác)**:
  1. Kiểm tra toggle "Cho phép lời mời ngoài tên miền" hiện đang bật hay chưa.
  2. Nếu chưa → bật ON. Nếu đã bật → giữ nguyên.
  3. Chuyển sang dialog mời thành viên → type email → set role → submit.
  4. **Quay lại TẮT toggle "lời mời ngoài"** (nếu trước đó OFF) — bước này PHẢI xong trước bước 5.
  5. Chuyển sang tab "Lời mời đang chờ xử lý". Chờ load xong → F5/reload trang để thu thập danh sách lời mời thật từ server.
  6. Khi xác định email đã ở trong tab Lời mời → ghi vào DB → dashboard hiển thị.
- **Bug v0.6.4**: thêm `clickTabAndWait("tab_pending_invites")` vào cuối `executeInviteInner`. Tức là CLICK TAB TRƯỚC RESTORE TOGGLE → finally của wrapper navigate `/admin/identity` (tắt) rồi `/admin/members` → URL **mất** `?tab=invites` khi background F5 → Phase 2 phải tự click lại tab → tối ưu v0.6.4 vô hiệu.
- **Fix**: Move bước click tab "Lời mời" RA NGOÀI `executeInviteInner`, đặt ở scope của `executeInvite` SAU khi `withExternalInvitesEnabled` đã restore. Trình tự cuối cùng đúng spec: bật → mời → tắt → chuyển tab Lời mời → F5 → verify → DB.
- `executeInviteInner` về lại single responsibility: chỉ submit invite + return `awaiting_reload_verify=true`. Tab management thuộc về scope ngoài.
- **File đã đổi**: [invite.ts](../../apps/extension/src/content/actions/invite.ts) — `executeInvite` thêm step click tab sau wrapper; `executeInviteInner` xoá đoạn click tab v0.6.4.
- **Version**: [version.ts](../../apps/extension/src/version.ts), [CHANGELOG.md](../../apps/extension/CHANGELOG.md) bump `v0.6.5`.

### 2026-05-20 — Fix: a12 "biến mất" khỏi dashboard + verify pending faster (extension v0.6.4)
- **Loại**: bugfix + UX speedup
- **Triệu chứng**: User invite a12 → ChatGPT nhận thật, nhưng dashboard mất a12 sau khi invite g12 ~3 phút sau. Hai email cùng tab "Lời mời" trên ChatGPT nhưng dashboard chỉ còn g12.
- **Root cause**: Sau khi invite g12, extension scrape tab "Lời mời" để verify g12 → scrape tại thời điểm đó chỉ thấy g12 (a12 chưa được ChatGPT index về client) → gửi `bulk-upsert` với `scraped_statuses=["pending"]` → backend reconcile: a12 status='pending' KHÔNG có trong scrape → **mark a12 = removed (oan)**. Phantom cleanup logic của INVITE_MEMBER hoạt động ĐÚNG (verify_scrape_failed=true → giữ). Lỗi nằm ở **bulk-upsert reconcile**: dùng cùng endpoint cho cả 2 case (SYNC_DATA full + verify after invite) mà không phân biệt scope.
- **Fix 1 — Extension (`runner.ts` INVITE_MEMBER reportToBackend)**: bulk-upsert sau verify dùng `isFullSync: false` (mới thêm option) + bỏ `scrapedStatuses`. Backend bây giờ CHỈ upsert email trong payload, KHÔNG reconcile/mark removed cho member khác.
- **Fix 2 — Backend (`members.py:bulk_upsert_members`) defense-in-depth**: reconcile `WHERE NOT (invited_by_user_id IS NOT NULL AND created_at > NOW() - INTERVAL '10 minutes')` → nếu sau này extension lỡ regress hoặc admin SYNC_DATA full khi vừa invite email khác, member mới vẫn được bảo vệ.
- **UX speedup — Approach của user (Phase 1 click tab trước F5)**:
  - **Trước v0.6.4**: submit dialog → return → background F5 → Phase 2 sleep 1500ms → navigate `/admin/members` → click tab "Lời mời" → scrape (retry 0/3/5s).
  - **Từ v0.6.4**: submit dialog → click tab "Lời mời" NGAY (~2s) → return → background F5 ở URL `/admin/members?tab=invites` → Phase 2 sleep 800ms → scrape thẳng (retry 0/2.5s). ChatGPT load pending list trực tiếp vào view sau F5, không qua client navigation cache.
  - Lợi ích kép: nhanh hơn (~3-5s) + né được race của bug a12 (scrape data tươi từ server thay vì DOM stale).
- **File đã đổi**:
  - [invite.ts](../../apps/extension/src/content/actions/invite.ts) — Phase 1 cuối `executeInviteInner`: thêm `clickTabAndWait("tab_pending_invites", ...)` trước khi return. Phase 2 `executeVerifyPendingInvite`: giảm initial sleep 1500→800ms, retry chain `[0, 3000, 5000]` → `[0, 2500]`.
  - [sync.ts](../../apps/extension/src/content/actions/sync.ts) — export `clickTabAndWait` để invite.ts dùng.
  - [api.ts](../../apps/extension/src/shared/api.ts) — `bulkUpsertMembers` thêm option `isFullSync?: boolean` (default true backward-compat).
  - [runner.ts](../../apps/extension/src/background/runner.ts) — INVITE_MEMBER reportToBackend: `bulkUpsertMembers(..., { isFullSync: false })` thay cho `{ scrapedStatuses: ["pending"] }`.
  - [members.py:bulk_upsert_members](../../apps/api/app/routers/members.py) — reconcile filter thêm điều kiện `NOT (invited_by_user_id IS NOT NULL AND created_at > cutoff)`.
  - [version.ts](../../apps/extension/src/version.ts), [CHANGELOG.md](../../apps/extension/CHANGELOG.md) — bump `v0.6.4`.

### 2026-05-19 (v6) — Subscription per-email + auto-remove expired (backend + frontend)
- **Loại**: feature
- **Yêu cầu user**: "khi nhập email hợp lệ vào thì hiển thị bảng tùy chỉnh thời gian sử dụng của email đó. khi hết hạn thì tự động thông báo và xóa".
- **Backend**:
  - `MemberInviteEntry` mới (`apps/api/app/schemas.py`): `{email, subscription_months}`.
  - `MemberBulkInviteIn` mở rộng: thêm field `invites: list[MemberInviteEntry] | None`. `resolved_entries()` method dedup theo email lowercase, ưu tiên `invites` > `emails`+`subscription_months` legacy path → backward-compat client cũ.
  - `bulk_invite_members` dùng `body.resolved_entries()` → mỗi email có `subscription_months` + `subscription_end_at` (= `now + months × 30 days`) riêng.
  - Endpoint mới `POST /workspaces/{id}/members/cleanup-expired` (`apps/api/app/routers/members.py`): tìm member status active/pending có `subscription_end_at <= now`, enqueue `REMOVE_MEMBER` task + audit log `MEMBER_EXPIRED_REMOVE_QUEUED`. Visibility-filtered cho sub-admin.
  - Background scheduler (`apps/api/app/main.py`): `threading.Timer` reschedule mỗi giờ chạy `_cleanup_expired_subscriptions_once` cho MỌI workspace. Lifespan startup tick ngay 1 lần để cleanup tồn đọng. `_cleanup_lock` chặn race condition.
- **Frontend** (`apps/web`):
  - `InviteMemberModal` redesign hoàn toàn: thay textarea 1-email-per-line bằng table rows (Email | Số tháng | Hết hạn | ×). Mỗi row:
    - Email input có validation real-time (border đỏ nếu sai format, xanh nếu hợp lệ).
    - Số tháng input + nút `−`/`+` (clamp 1-60).
    - Quick buttons "Áp cho tất cả: 1th 3th 6th 12th".
    - Preview "Hết hạn: DD/MM/YYYY" auto-compute từ `now + months × 30`.
    - Nút `×` xoá row. Auto-spawn row mới khi paste nhiều email vào 1 ô (split `\n` hoặc `,`).
  - `Members.tsx` thêm:
    - Cột mới "Hạn dùng" — `SubscriptionCell` component: badge ĐỎ "Hết hạn N ngày" nếu expired, VÀNG "Còn N ngày" nếu ≤ 7 ngày, hoặc text gray nếu xa.
    - Banner ĐỎ liệt kê expired members + nút "Remove N expired" trigger `cleanup-expired` endpoint.
    - Banner VÀNG cho expiring soon (≤ 7 days) — chỉ hiển thị khi không có expired.
- **i18n**: thêm `member.colSubscription`, `member.subExpired`, `member.subDaysLeft`, `member.expiredBannerTitle/Body`, `member.cleanupExpiredBtn`, `invite.colEmail/Months/Expires`, `invite.expiresTooltip`, `invite.autoRemoveHint`, … cho cả `vi` + `zh-CN`.
- **File đã đổi**:
  - [schemas.py](../../apps/api/app/schemas.py) — `MemberInviteEntry`, `MemberBulkInviteIn.invites`.
  - [members.py](../../apps/api/app/routers/members.py) — `bulk_invite_members` per-email, `cleanup_expired_members` endpoint mới.
  - [main.py](../../apps/api/app/main.py) — lifespan scheduler với `threading.Timer` + cleanup-tick.
  - [InviteMemberModal.tsx](../../apps/web/src/components/InviteMemberModal.tsx) — redesign row-based.
  - [Members.tsx](../../apps/web/src/pages/Members.tsx) — cột Hạn dùng, banners, `SubscriptionCell`, `cleanupExpired` mutation.
  - [types.ts](../../apps/web/src/types.ts) — `Member.subscription_months`, `subscription_end_at`.
  - [vi.json](../../apps/web/src/i18n/locales/vi.json), [zh-CN.json](../../apps/web/src/i18n/locales/zh-CN.json).

### 2026-05-19 (v5) — Banner invite hiển thị progress real-time (debug "extension xoay mãi") (extension v0.4.5)
- **Loại**: observability / debug UX
- **Triệu chứng**: User báo "luồng mời người dùng đang lỗi, extension không hoạt động, cứ xoay mãi" và yêu cầu "tôi cần nhìn thấy tiến trình đang làm gì ở phía dưới task" để biết extension đang stuck ở đâu.
- **Trước đó**: Banner Members chỉ hiện text "Có N lời mời đang chờ Extension xử lý" + spinner — KHÔNG có chi tiết phase, message, email cụ thể, elapsed time → user không biết extension đang stuck ở DOM nào, có thật sự xoay hay đã chết.
- **Fix dashboard** ([Members.tsx](../../apps/web/src/pages/Members.tsx)):
  - Banner active hiển thị MỖI invite task 1 dòng `InviteProgressRow`: email (hoặc "email_1 +N"), status badge (PENDING/IN_PROGRESS), phase hiện tại (vd `add-row`, `typing-email`, `verifying`), `current/total` (vd "2/4"), elapsed seconds.
  - Stale warning bật khi task IN_PROGRESS > 90s nhưng chưa có phase → gợi ý mở DevTools tab ChatGPT xem console log.
  - Banner FAILED riêng cho invite task vừa fail trong 60s gần nhất → `InviteFailedRow` hiển thị `error_code` (badge đỏ) + `error_message` đầy đủ → user khỏi mở Queue tab để debug.
  - i18n: `member.inviteFailedRecent`, `invite.progressElapsedHint`, `invite.progressStaleHint`, `invite.errorFullTooltip` (vi + zh-CN).
- **Fix extension** ([invite.ts](../../apps/extension/src/content/actions/invite.ts)):
  - Mọi `reportProgress` call giờ kèm `current` + `total = emails.length` → banner show `i/N`.
  - Phase mới `add-row`: trước khi click "Add more" cho email `i`, báo phase này → user thấy ngay extension đang ở bước nào.
  - Phase `opening-dialog` message kèm tổng số email.
- **File đã đổi**:
  - [Members.tsx](../../apps/web/src/pages/Members.tsx) — `InviteProgressRow`, `InviteFailedRow` components; banner mở rộng; `recentFailedInvites` filter.
  - [invite.ts](../../apps/extension/src/content/actions/invite.ts) — `reportProgress` với `current/total/phase`.
  - [vi.json](../../apps/web/src/i18n/locales/vi.json), [zh-CN.json](../../apps/web/src/i18n/locales/zh-CN.json) — i18n mới.
  - [version.ts](../../apps/extension/src/version.ts), [CHANGELOG.md](../../apps/extension/CHANGELOG.md) — bump `v0.4.5`.

### 2026-05-19 (v4) — Multi-email row-based UI + bổ sung text mapping (extension v0.4.4)
- **Loại**: bugfix / UI-change
- **Triệu chứng**: User báo "luồng mời người dùng đang lỗi kiểm tra lại text đã mapping hết chưa". Screenshot dialog Invite mới: layout 3-column `Email | Role | Seat type`, mỗi email 1 ROW riêng có input riêng, click "Add more" thêm row mới (KHÔNG mở textarea).
- **Nguyên nhân chính (UI structure, không phải text)**:
  - Code cũ sau click "Add more" KỲ VỌNG input expand thành textarea cho phép multi-line.
  - Logic: `const inputText = emails.join("\\n"); await humanType(emailInput, inputText);` — join 4 email bằng newline vào 1 single-line input.
  - Single-line input KHÔNG nhận newline → ChatGPT thấy 1 chuỗi `email1\nemail2\nemail3\nemail4` invalid → reject toàn bộ.
- **Fix structure**:
  - Type `email[0]` vào input đầu của row 1.
  - Loop `i = 1..N-1`:
    1. Đếm số input email-like trong dialog trước click (`countDialogEmailInputs`).
    2. Click "Add more" (qua `clickAddMoreIfNeeded`).
    3. `waitFor` đến khi count tăng → tìm `findLastEmptyEmailInput` (input rỗng cuối = row mới).
    4. Type `email[i]` vào input mới.
  - Fallback: nếu Add more fail giữa chừng → dồn các email còn lại vào input cuối với separator `\n` (vẫn không hoạt động trên UI mới nhưng giữ behaviour cũ cho workspace UI khác).
  - Progress report theo từng email: "Đang nhập email i/N: {email}".
- **Bổ sung text mapping (phòng ngừa cho VI/ZH)**:
  - `inviteSubmitButton`: "Send invites" (plural), "Send invitations", "Gửi các lời mời", "发送邀请" — match plural trước singular.
  - `inviteAddMoreButton`: "Add another member", "Add a member", "Add row", "Thêm thành viên", "Thêm dòng", "添加成员", "添加一行".
  - `changeRoleMenuItem`: "Change seat type", "Edit seat type", "Đổi loại ghế", "更改席位类型" — UI mới row menu chỉ còn 2 item (Change seat type + Remove member), KHÔNG có "Change role" độc lập. Đổi role thực hiện qua dropdown `Member ▼` ngay trên row, không qua menu — sẽ cần fix `executeChangeRole` ở tuần sau.
- **Lưu ý seat limit**: user workspace 11/12 → 4 invite cần thêm 3 seat. Sau v0.4.4 nếu vẫn fail toàn bộ → kiểm tra Pending invites tab xem ChatGPT có chấp nhận 1 cái và reject 3 cái với "Not enough seats" không. INVITE_ERROR_HINTS v0.4.3 đã thêm patterns cho lỗi này.
- **File đã đổi**:
  - [invite.ts](../../apps/extension/src/content/actions/invite.ts) — multi-email loop mới, helpers `countDialogEmailInputs` + `findLastEmptyEmailInput`.
  - [i18n-ui.ts](../../apps/extension/src/content/i18n-ui.ts) — `inviteSubmitButton`, `inviteAddMoreButton`, `changeRoleMenuItem` mở rộng.
  - [version.ts](../../apps/extension/src/version.ts), [CHANGELOG.md](../../apps/extension/CHANGELOG.md) — bump `v0.4.4`.

### 2026-05-19 (v3) — Invite robust: multi-strategy label, sidebar-link nav, seat-limit detection (extension v0.4.3)
- **Loại**: bugfix / robustness
- **Triệu chứng**: User báo "lỗi mời rồi kiểm tra lại" sau khi thêm 4 email gmail (external domain). Tab ChatGPT đang ở `/admin/billing`, workspace có 11/12 seat sử dụng (4 email mới sẽ vượt seat limit).
- **Hypothesis về nguyên nhân**:
  1. v0.4.2 row-scope strict — nếu 2 switch (Automatic Account Creation + Allow External Domain Invites) là siblings flat (không có wrapper riêng), `findSingleSwitchRow` return null → KHÔNG tìm được toggle nào → toggle không bật → invite external domain fail.
  2. `navigateTo` dùng `pushState` + `popstate` để chuyển từ `/admin/billing` → `/admin/identity`. Next.js router nhiều khi không catch pushState gốc → page không re-render → extension scan toggle trên DOM cũ → fail.
  3. Lỗi seat-limit (11/12 + 4 = 15 > 12) không có trong `INVITE_ERROR_HINTS` → user thấy "Dialog text: …" thay vì lời báo rõ ràng.
- **Fix**:
  1. `findExternalInvitesToggle` đổi sang multi-strategy label extraction:
     - `aria-labelledby` → text element được tham chiếu
     - `aria-label` trên chính switch
     - `<label for="{switch.id}">`
     - `closest('label')` ancestor
     - 3 previous siblings (label thường đứng trước switch)
     - Single-switch row (fallback rộng nhất)
     - Concat → lowercase → check pattern + exclude. Best-match scoring không đổi.
  2. `findSingleSwitchRow` giờ trả về CHÍNH `el` nếu không có 1-switch ancestor (thay vì null) — đảm bảo luôn có DOM để scan.
  3. `navigateTo` ưu tiên `findNavLinkByPath` quét tất cả `<a[href]>` match `pathname` cả tuyệt đối lẫn tương đối → click → Next.js router catch. Fallback `pushState` nếu không có anchor.
  4. `console.table` diagnostic dump label của TỪNG switch + pattern match/exclude → user mở DevTools thấy ngay vì sao toggle không match.
  5. `INVITE_ERROR_HINTS` thêm patterns: `insufficient seats`, `seat limit`, `out of seats`, `không đủ ghế`, `vượt quá số ghế`, `席位不足`, `已达席位上限`, `external domain`, `outside your organization`, `miền bên ngoài`, `外部域` → dialog ChatGPT báo lỗi loại này được surface rõ ràng.
- **User action recommended**: workspace 11/12 + 4 invite = cần 15 seat. Vào ChatGPT `/admin/billing` → "Manage seats" → tăng seat lên ≥ 15 trước khi invite, hoặc invite từng đợt ≤ 1 email tại một lúc.
- **File đã đổi**:
  - [external-invites.ts](../../apps/extension/src/content/actions/external-invites.ts) — `findExternalInvitesToggle` multi-strategy, `extractSwitchLabel` helper, `findNavLinkByPath` helper, `navigateTo` ưu tiên anchor click, diagnostic logging.
  - [i18n-ui.ts](../../apps/extension/src/content/i18n-ui.ts) — `INVITE_ERROR_HINTS` mở rộng.
  - [version.ts](../../apps/extension/src/version.ts), [CHANGELOG.md](../../apps/extension/CHANGELOG.md) — bump `v0.4.3`.

### 2026-05-19 — Fix: invite chọn đúng toggle "Allow External Domain Invites" (extension v0.4.2)
- **Loại**: bugfix / selector
- **Triệu chứng**: Trên `/admin/identity` extension bật/tắt nhầm toggle **"Automatic Account Creation"** thay vì **"Allow External Domain Invites"**. Hệ quả: workspace bị bật/tắt một setting không liên quan; invite email ngoài domain vẫn fail vì toggle đúng không được mở.
- **Nguyên nhân**: `findExternalInvitesToggle()` walk-up 5 cấp parent từ mỗi `button[role="switch"]` rồi gọi `textContent.includes(pattern)`. Khi 2 toggle share ancestor (case ChatGPT thật), textContent của parent chứa label của CẢ 2 → pattern match nhưng grab nhầm switch xuất hiện trước trong DOM.
- **Fix**:
  1. Scope text-match về "row" = ancestor lớn nhất vẫn chỉ chứa 1 switch (`findSingleSwitchRow`) → không nuốt label hàng xóm.
  2. Thêm `EXTERNAL_INVITE_EXCLUDE_PATTERNS` (`automatic account creation`, `tự động tạo tài khoản`, `自动创建账户`, …) — row chứa pattern này bị loại khỏi candidates.
  3. Best-match scoring: chọn switch có pattern dài nhất thắng (vd "allow external domain invites" 30 ký tự > "external domain" 15 ký tự).
  4. Patterns mới (EN/VI/ZH đầy đủ) sắp xếp theo độ dài giảm dần để pattern đặc trưng được kiểm tra trước.
  5. Áp dụng cùng heuristic cho `harvest-labels.ts` `/admin/identity` scraper — DB không còn ghi nhầm label "Automatic Account Creation" cho `toggle_external_invites`.
- **Quy trình hoạt động đúng (xác nhận lại)**: extension đọc state hiện tại → nếu OFF thì bật ON, đợi update, navigate `/admin/members`, chạy invite, finally restore state cũ (OFF nếu trước OFF) → navigate về `/admin/members`. Restore luôn chạy kể cả khi invite FAIL.
- **File đã đổi**:
  - [external-invites.ts](../../apps/extension/src/content/actions/external-invites.ts) — `findExternalInvitesToggle` rewrite + `findSingleSwitchRow` helper.
  - [i18n-ui.ts](../../apps/extension/src/content/i18n-ui.ts) — `EXTERNAL_INVITE_LABEL_PATTERNS` mở rộng + `EXTERNAL_INVITE_EXCLUDE_PATTERNS` mới.
  - [harvest-labels.ts](../../apps/extension/src/content/actions/harvest-labels.ts) — `harvestIdentity()` dùng row-scope + exclude + best-match.
  - [version.ts](../../apps/extension/src/version.ts), [CHANGELOG.md](../../apps/extension/CHANGELOG.md) — bump `v0.4.2`.

### 2026-05-17 — UI fix: bỏ "+" thừa khỏi label "Mời thành viên"
- **Loại**: UI / bugfix
- **Mô tả**: i18n string `member.inviteButton` còn prefix "+ " trong khi nút mới đã có `PlusIcon` JSX → hiển thị "+ + Mời thành viên". Bỏ prefix khỏi label cho cả `vi.json` và `zh-CN.json`.
- **File đã đổi**: [vi.json](../../apps/web/src/i18n/locales/vi.json), [zh-CN.json](../../apps/web/src/i18n/locales/zh-CN.json).

### 2026-05-17 — UI redesign: form mời thành viên + metrics + badge
- **Loại**: UI / design system
- **Mô tả**: Trang Members redesign — 4 metric card phía trên (tổng / active / pending / queue), invite form gói trong `.surface-card` với input + role select, table dùng `.data-table` + `.role-tag` cho role, `.badge-success/.badge-warning` cho status active/pending. Nút "Mời thành viên" dùng `.btn .btn-primary` với icon + (`PlusIcon`).
- **Search**: thêm `SearchInput` filter theo email/name client-side, không thay đổi API.
- **Active invite notice**: khi có invite đang chạy, hiển thị `.notice .warn` với spinner đếm số task in-flight.
- **Logic không đổi**: mutation `POST /api/v1/workspaces/{id}/members/invite`, `triggerExtensionRun()`, polling `recent-tasks` 2s, ownership rule `invited_by_user_id` giữ nguyên.
- **File đã đổi**: [Members.tsx](../../apps/web/src/pages/Members.tsx).

### 2026-05-16 — Implement: extension DOM action `invite` (Tuần 5) ⚠�? selectors cần verify
- **Loại**: extension + UI
- **Mô tả**: Content script handler trong [apps/extension/src/content/actions/invite.ts](../../apps/extension/src/content/actions/invite.ts): mở dialog Invite → nhập email (humanType: keypress từng ký tự) → set role → click submit (mousedown→mouseup→click) → đợi toast/dialog đóng để verify. Background runner [runner.ts](../../apps/extension/src/background/runner.ts) tìm tab `chatgpt.com/admin/*` rồi gửi message; nếu không có tab → FAILED `NOT_LOGGED_IN_CHATGPT`.
- **Rate limit**: hardcode `betweenTasksMs: 5000`, `batchSize: 5`, batch pause 30-60s random (theo spec). Tuần 7 sẽ đ�?c từ workspace_settings.
- **Anti-detection**: `humanType` keypress 40-120ms/char, `humanClick` mouseover→mousedown→mouseup→click với microDelay 60-140ms, `randomDelay` 1.5-4s giữa các step.
- **⚠�? Selectors trong** [selectors.ts](../../apps/extension/src/content/selectors.ts) **là dự đoán** — chưa test trên ChatGPT admin thật. User cần inspect DOM thật và update khi extension báo `UI_ELEMENT_NOT_FOUND`.
- **File đã thêm**: action handlers + human helpers + background runner + shared messages.

### 2026-05-15 — Implement: backend invite endpoint + visibility model (Tuần 2.3) ✅
- **Loại**: endpoint + schema
- **Mô tả**: Endpoint `POST /api/v1/workspaces/{workspace_id}/members/invite` tạo đồng th�?i: (1) `QueueItem` type `INVITE_MEMBER` với `workspace_id`, (2) `Invite` row tracking, (3) `Member` row status `pending` với `invited_by_user_id = current_user.id`. Permission `MEMBER_INVITE` (super-admin bypass).
- **Ownership rule**: `invited_by_user_id` xác định ai "sở hữu" member. Sub-admin chỉ list/remove được member của chính mình.
- **Tại sao**: User yêu cầu 2026-05-15 — sub-admin chỉ thấy member h�? invite, super-admin thấy tất cả.
- **File đã đổi**: [members.py](../../apps/api/app/routers/members.py), [models.py](../../apps/api/app/models.py) (Member + Invite), [schemas.py](../../apps/api/app/schemas.py), migration [0003_workspace_member_invite.py](../../apps/api/alembic/versions/0003_workspace_member_invite.py).
- **Tests**: [test_workspace_member.py](../../apps/api/tests/test_workspace_member.py) `test_sub_admin_sees_only_own_invites`, `test_invite_creates_queue_item_with_workspace_id` — pass.

