/**
 * Single source of truth cho version + changelog của extension.
 *
 * Quy tắc bump version (semver-like):
 *   - MAJOR (x.0.0): breaking change về protocol/storage hoặc đổi cấu trúc lớn
 *   - MINOR (0.x.0): thêm action mới (SYNC_BILLING, INVITE_MEMBER, ...) hoặc
 *                    thay đổi UI lớn (popup redesign, scraper rewrite)
 *   - PATCH (0.0.x): fix bug, sửa selectors, tune timing/regex
 *
 * Khi bump:
 *   1. Tăng `VERSION` ở dưới
 *   2. Prepend 1 entry mới ở đầu `CHANGELOG` (most recent first)
 *   3. Build lại extension, reload trong chrome://extensions
 *
 * Manifest tự đọc VERSION từ file này — KHÔNG cần sửa manifest.ts.
 * Popup hiển thị VERSION prominent + cho phép expand changelog.
 */

export const VERSION = "0.6.2";

export type ChangelogEntry = {
  version: string;
  date: string; // YYYY-MM-DD
  kind: "feature" | "fix" | "chore";
  summary: string;
  /** Bullet list chi tiết, hiển thị khi user expand. */
  details: string[];
};

export const KIND_COLOR: Record<ChangelogEntry["kind"], string> = {
  feature: "#10b981",
  fix: "#f59e0b",
  chore: "#6b7280",
};

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.6.2",
    date: "2026-05-20",
    kind: "fix",
    summary: "F5 thật trang admin sau khi submit invite — ép ChatGPT load lại pending list từ server (không dùng cache stale)",
    details: [
      "Tách INVITE_MEMBER thành 2 phase: Phase 1 (content) chỉ submit invite + verify toast/dialog đóng → return ok=true với awaiting_reload_verify=true. Phase 2 do background orchestrate: chrome.tabs.reload(tab) hard F5 → wait tab complete → ensureContentInjected re-inject → gửi VERIFY_PENDING_INVITE message mới → content's new instance scrape pending list (đã load fresh từ server) → return verify result.",
      "Trước v0.6.2: dù click 'forceReload' bounce tab nhưng ChatGPT React Query có thể serve cache stale (cache key dựa workspace, không invalidate khi click tab). Sau v0.6.2: chrome.tabs.reload là F5 thật ở level browser → toàn bộ JS context destroy + reload → React Query cache cũng bị xoá → fetch fresh từ /api/.../invites.",
      "Message protocol mới: VERIFY_PENDING_INVITE { taskId, emails, role } — dùng riêng cho Phase 2, không submit lại invite. Content dispatcher [content/index.ts](apps/extension/src/content/index.ts) route → executeVerifyPendingInvite trong invite.ts.",
      "Runner [background/runner.ts](apps/extension/src/background/runner.ts) detect response.data.awaiting_reload_verify=true → vào branch F5+verify. Nếu F5 fail / inject fail / verify message throw → fallback ok=true với verify_scrape_failed=true (user-facing: 'mở tab Lời mời thủ công để check'), KHÔNG fail invite (vì submit đã OK).",
      "Phase 'f5-verify' mới trong reportRunnerProgress → dashboard banner show 'Submit invite OK — F5 trang admin để ChatGPT load lại pending list...' giữa submit và verify.",
      "Retry trong Phase 2 vẫn giữ (3 attempts với delay 0/3/5s) — phòng ChatGPT backend chậm index invite vừa POST. Tổng thời gian Phase 2 tối đa ~25s (F5 ~3-5s + 3 attempts ~10-15s + final navigate ~2s).",
    ],
  },
  {
    version: "0.6.1",
    date: "2026-05-20",
    kind: "fix",
    summary: "Fix humanClick double-fire (2 toast ChatGPT/click toggle 2 lần) + verify pending: delay 2s + retry 3 lần đến ~10s tổng",
    details: [
      "BUG #1 (DOUBLE-CLICK): [humanClick](apps/extension/src/content/human.ts) trước v0.6.1 dispatch synthetic MouseEvent('click') RỒI gọi LUÔN el.click() native → mỗi 'click' thực ra fire 2 lần. Hậu quả: (a) toggle 'Cho phép lời mời từ miền bên ngoài' click 1 lần → ChatGPT nhận 2 toggle event → 2 toast 'Đã cập nhật'; (b) submit invite click 1 lần → ChatGPT submit 2 lần → 2 toast 'Đã gửi lời mời'. Sau v0.6.1: chỉ gọi el.click() native (Radix/React onClick đều catch được); dispatch synthetic chỉ làm FALLBACK khi el.click không tồn tại hoặc throw.",
      "BUG #2 (VERIFY QUÁ NHANH → false-negative VERIFY_FAILED): sau khi submit invite + toast OK, code v0.6.0 click ngay tab 'Lời mời đang chờ xử lý' + chờ 1.5s rồi scrape. ChatGPT backend cần 1-5s để invite mới xuất hiện trong pending list → scrape thấy 0 email vừa mời → strict v0.4.14 trả VERIFY_FAILED → phantom cleanup xoá record dashboard, NHƯNG thực tế ChatGPT đã nhận invite OK.",
      "FIX BUG #2: sau khi xác nhận toast/dialog đóng, đợi thêm 2s rồi mới gọi scrapePendingInvitesAfterInvite. Nếu attempt đầu KHÔNG verify được hết list email vừa mời → retry tới 3 lần (sleep 0s, 2.5s, 4s giữa các attempt), TỔNG ~10s. Mỗi retry > attempt #1 dùng forceReload=true: bounce qua tab 'Người dùng' rồi click lại 'Lời mời' → ép ChatGPT re-mount component + re-fetch pending list (fix luôn cache stale).",
      "scrapePendingInvitesAfterInvite mới có param forceReload: false → click tab 'Lời mời' trực tiếp (như cũ); true → click 'Người dùng' 800ms trước, rồi click 'Lời mời' với postClickWait 2.5s. Dùng riêng cho retry attempts để cache không che mắt.",
      "Progress message mới khi retry: 'Pending list chưa có N email — đợi ChatGPT cập nhật (retry K/3)...' → dashboard banner show ngay user biết extension đang đợi (không phải treo).",
      "BUG #3 (F5 thấy email trong tab Lời mời ChatGPT): trước v0.6.1 sau verify xong extension click lại tab 'Người dùng' để idle ở trang quen thuộc. Hậu quả: user mở tab admin lên + click 'Lời mời' → ChatGPT re-mount component + có thể serve từ React Query cache stale → KHÔNG thấy email vừa mời, phải F5. Fix: extension giờ DỪNG TẠI tab 'Lời mời đang chờ xử lý' sau verify cuối cùng — DOM đã render data tươi (extension vừa scrape) nên user mở browser tab admin lên là thấy ngay. Task sau (REMOVE/CHANGE_ROLE) tự click tab 'Người dùng' qua findControlByKey, không lệ thuộc end-state.",
    ],
  },
  {
    version: "0.6.0",
    date: "2026-05-20",
    kind: "feature",
    summary: "PURCHASE_SEAT full payment chain — mở rộng cross-origin tới Stripe + Link checkout, charge thật qua thẻ Mastercard",
    details: [
      "Phase 1+2 (chatgpt.com modal): giữ nguyên v0.5.1 — Quản lý giấy phép → +qty → Tiếp tục → Thêm người dùng (tạo invoice 'Đến hạn').",
      "Phase 2.5 (NEW): sau khi modal #2 đóng + có chargeAmount, content script navigate /admin/billing?tab=invoices, tìm row 'Đến hạn' (regex vi/en/zh), extract Stripe URL từ anchor 'Xem', gửi background.",
      "Phase 3 (NEW): background orchestrator [payment-chain.ts](apps/extension/src/background/payment-chain.ts) mở Stripe invoice URL ở tab mới, đợi load + content/stripe-invoice.ts ready, gửi STRIPE_CLICK_LINK → click button 'Link' (xanh có last4 thẻ).",
      "Phase 4 (NEW): background đợi popup checkout.link.com mở (window mới do Stripe spawn), inject content/link-checkout.ts, gửi LINK_CONFIRM_PAYMENT với expectedAmountText → content verify số tiền popup match (tolerance ±50đ) → click 'Thanh toán {amount}' (FINAL CHARGE thẻ).",
      "Manifest: thêm 2 content_scripts cho invoice.stripe.com + checkout.link.com, 2 host_permissions tương ứng.",
      "Safety guards: (1) Sanity check số tiền popup vs expected từ ChatGPT modal — mismatch > 50đ → STOP với VERIFY_FAILED; (2) Detect text 'OTP/3DS/xác minh' trong Link popup TRƯỚC click → trả otp_detected=true, KHÔNG click submit; (3) Sau click 'Thanh toán', monitor 15s: dismissed (success) / otp_after (Link mở 3DS step) / timeout (admin verify).",
      "Task.result mở rộng: stripe_invoice_url, payment_chain_started/stage/ok, payment_chain_stripe (Link button info + amount visible), payment_chain_link (popup amount + clicked + outcome). Audit log đầy đủ chain.",
      "Cross-origin orchestration: background SW dùng chrome.tabs.onCreated/onUpdated để theo dõi Stripe tab → Link popup. Mỗi stage có timeout riêng (Stripe 15s tab open + 12s content ready; Link 12s popup open + 12s content ready).",
    ],
  },
  {
    version: "0.5.1",
    date: "2026-05-20",
    kind: "feature",
    summary: "PURCHASE_SEAT step 2: extension click luôn 'Thêm người dùng' (final charge) sau 'Tiếp tục' — kèm sanity check qty + scrape charge amount",
    details: [
      "Update flow PURCHASE_SEAT: sau khi click 'Tiếp tục' ở modal #1 ('Xem xét'), extension đợi modal #2 ('Quản lý chỗ ngồi') xuất hiện rồi click 'Thêm người dùng' để CHARGE TIỀN THẬT qua Stripe payment method đã lưu trên ChatGPT.",
      "Trước v0.5.1 extension DỪNG sau 'Tiếp tục' (admin tự confirm). Sau v0.5.1 tự động click luôn — flow trọn vẹn nhưng RỦI RO TIỀN nếu task tạo nhầm. Mitigation đã có: hard cap qty=20/task, dedup PENDING/IN_PROGRESS, audit log, sanity check.",
      "SANITY CHECK #1 (qty match): modal #2 phải nói đúng '{qty} suất bổ sung' / '{qty} additional seat'. Nếu modal nói số khác (seat đã đổi giữa chừng do task khác chạy) → STOP với VERIFY_FAILED, KHÔNG click charge.",
      "SCRAPE charge amount: extension đọc 'Tổng đến hạn hôm nay' (vd đ2080.24) vào task.result.charge_amount_text để admin trace + audit. Best-effort, không bắt buộc.",
      "After click 'Thêm người dùng': đợi modal đóng (data-state=closed / removed) tới 10s. Nếu modal vẫn mở → có thể ChatGPT mở 3D Secure / OTP popup, task vẫn COMPLETED ok=true nhưng note ghi 'admin hoàn tất xác minh thủ công'.",
      "Task result mở rộng: thêm `confirm_charge_clicked: bool`, `charge_modal_dismissed: bool`, `charge_amount_text: string|null` ngoài 4 field cũ.",
      "i18n: thêm control_key `billingAddUserButton` (Thêm người dùng / Add user / 添加用户) — VI/EN/ZH (12 variants total).",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-05-20",
    kind: "feature",
    summary: "PURCHASE_SEAT — extension tự mua thêm seat (+N) trên /admin/billing, dừng trước nút payment cuối",
    details: [
      "Action PURCHASE_SEAT mới: dashboard POST /api/v1/workspaces/{id}/purchase-seat {quantity:1..20} → backend tạo QueueItem type=PURCHASE_SEAT → SSE → extension execute.",
      "Flow extension (apps/extension/src/content/actions/purchase-seat.ts): (1) navigate /admin/billing?tab=plan; (2) click 'Quản lý giấy phép' để mở modal 'Xem xét'; (3) đọc input 'Người dùng' giá trị hiện tại N; (4) click nút '+' đúng quantity lần với verify sau mỗi click; (5) click 'Tiếp tục'. DỪNG. Admin tự xác nhận thanh toán cuối trên ChatGPT — extension KHÔNG bao giờ tự confirm payment (an toàn về tiền bạc).",
      "Permission BILLING_PAY (super-admin only) gate endpoint backend. Dedup: nếu workspace đã có PURCHASE_SEAT PENDING/IN_PROGRESS → trả task cũ thay vì double-charge.",
      "Hard cap 20 seat/task để chống fat-finger overcharge (mirror schemas.PURCHASE_SEAT_MAX_PER_TASK). Audit log PURCHASE_SEAT_QUEUED cho mọi lần trigger.",
      "i18n: thêm 3 control_key billingManageLicenses / billingContinueButton / billingIncrementButton (vi/en/zh) vào TEXT_FALLBACKS — harvester /admin/billing có thể quét.",
      "Backend: schemas.PurchaseSeatIn + endpoint POST /workspaces/{id}/purchase-seat + queue._TYPE_TO_PERMISSION['PURCHASE_SEAT']=BILLING_PAY.",
    ],
  },
  {
    version: "0.4.20",
    date: "2026-05-19",
    kind: "fix",
    summary: "Bỏ Step 3 NUCLEAR (regression INVITE) + tăng waitFor dialog 20s + DOM diagnostic + DB sync CHANGE_ROLE/REMOVE",
    details: [
      "REGRESSION FIX: bỏ Step 3 NUCLEAR (tabs.remove + tabs.create) trong ensureContentInjected — quá aggressive, đóng tab user khi không cần, gây dialog Invite không mở được sau khi tab vừa recreate. Step 1 (executeScript) + Step 2 (tabs.reload) đã cover 99% case.",
      "Invite waitFor dialog email input: 10s → 20s. Sau v0.4.17 auto-reload, SPA cần thời gian rehydrate + dialog animate open. 10s đôi khi không đủ.",
      "Invite DOM diagnostic: khi waitFor timeout → dump dialog innerHTML + list tất cả input/textarea trong dialog vào console (prefix '[autogpt-invite] DIAGNOSTIC'). Error message kèm input summary để dashboard banner show ngay (vd: 'Inputs: INPUT[type=text,name=email_0,ph=Enter email address]').",
      "Backend update_task: thêm DB sync sau CHANGE_ROLE COMPLETED → Member.chatgpt_role = new_role. Trước v0.4.20 extension đổi role trên ChatGPT thành công nhưng DB không update → dashboard hiển thị role cũ tới khi SYNC_DATA chạy.",
      "Backend update_task: thêm DB sync sau REMOVE_MEMBER COMPLETED → Member.status = 'removed'. Cùng lý do.",
    ],
  },
  {
    version: "0.4.19",
    date: "2026-05-19",
    kind: "fix",
    summary: "Billing scraper: cho phép case 'Đang dùng 14/13' (over-limit) — bỏ rule used<=total",
    details: [
      "BUG: trong parseSeatRatio có check `used <= total` → khi ChatGPT hiển thị 'Đang dùng 14/13 giấy phép' (admin invite vượt quota), pattern match được nhưng bị reject vì 14 > 13 → scraper bỏ qua → loop tới pattern khác → pick nhầm ratio từ vùng khác trên page (vd '11/12' từ invoice/plan info). Dashboard hiển thị 11/12 trong khi thực tế là 14/13.",
      "Fix: BỎ check `used <= total`. Over-limit là state hợp lệ trên ChatGPT (admin được phép invite vượt seat — sẽ tính tiền phụ vào hóa đơn kế tiếp). Chỉ giữ rule total<=999 và used<=999 (sanity check).",
      "Bonus: thêm keyword 'đang dùng' vào pattern đầu (priority cao hơn 'sử dụng' generic) + 'đang sử dụng' + zh 已使用. Match trực tiếp text ChatGPT vi 'Đang dùng 14/13'.",
    ],
  },
  {
    version: "0.4.18",
    date: "2026-05-19",
    kind: "fix",
    summary: "Step 3 NUCLEAR (recreate tab) + ẨN HOÀN TOÀN banner CONTENT_NOT_INJECTED khỏi popup",
    details: [
      "v0.4.17 thêm auto-reload (Step 2) nhưng vẫn fail cho 1 số case (CSP / dirty state / extension hot-swap). Bổ sung Step 3 NUCLEAR: chrome.tabs.remove tab cũ + chrome.tabs.create tab mới hoàn toàn → wait load → retry ping. Tab mới fresh state 100% — fix mọi case còn lại trừ ChatGPT chưa login.",
      "ensureContentInjected giờ trả về `{ok, tabId}` thay vì boolean — sendToContent dùng tabId MỚI (nếu Step 3 đổi) để gửi message, tránh gửi vào tab đã đóng.",
      "Popup ActiveTaskPanel: ẨN HOÀN TOÀN error CONTENT_NOT_INJECTED và NOT_LOGGED_IN_CHATGPT khỏi recent_completed banner. Đây là lỗi infrastructure được background tự recovery — user KHÔNG cần thấy/thao tác.",
      "Cũng bỏ luôn nút manual 'Mở/F5 tab ChatGPT Admin' — tất cả automatic.",
      "Total fallback time vẫn ~30s nhưng 99% case xong dưới 5s (Step 1). Step 2 ~10s. Step 3 ~15s. Sau Step 3 mà vẫn fail = ChatGPT chưa login (NOT_LOGGED_IN_CHATGPT) — case này extension không thể fix tự động.",
    ],
  },
  {
    version: "0.4.17",
    date: "2026-05-19",
    kind: "fix",
    summary: "AUTO-RELOAD tab ChatGPT khi gặp CONTENT_NOT_INJECTED — không cần user F5 thủ công",
    details: [
      "BUG cũ: reload extension trong chrome://extensions/ tạo manifest mới với file hash mới, nhưng tab ChatGPT đang load vẫn giữ content script CŨ → background SW gửi message → tab cũ không nhận → CONTENT_NOT_INJECTED → task FAILED → user thấy 'liên tục lỗi'.",
      "Sau v0.4.17 [ensureContentInjected] (apps/extension/src/background/runner.ts) có 2 step fallback hoàn toàn TỰ ĐỘNG: (1) chrome.scripting.executeScript inject loader rồi retry ping ~3s; (2) NẾU step 1 thất bại → chrome.tabs.reload (auto F5) → wait tab status='complete' (timeout 15s) → retry ping ~5s để content script đã được manifest auto-inject ở document_idle. Tổng cap ~25s nhưng 99% xong trong ~5s.",
      "User KHÔNG cần thao tác F5 thủ công nữa. Popup vẫn show fallback hint + nút 'Mở/F5 tab ChatGPT Admin' phòng case auto-reload cũng thất bại (vd: ChatGPT chưa login → redirect /auth/login).",
      "i18n 2 string mới: popup.contentNotInjectedHint + popup.openOrReloadAdminTab (vi + zh).",
    ],
  },
  {
    version: "0.4.16",
    date: "2026-05-19",
    kind: "feature",
    summary: "Role dropdown chỉ 2 lựa chọn (member + analytics_viewer); popup có nút ↻ refresh seat",
    details: [
      "Dashboard Members.tsx role dropdown CHỈ hiển thị 'Thành viên' + 'Xem dữ liệu' (analytics_viewer). Member đã là admin/owner KHÔNG cho đổi qua dashboard — hiển thị label với icon 🔒 và tooltip 'thao tác trên ChatGPT'.",
      "Schema mở rộng: ChatGPTRole + DASHBOARD_ALLOWED_ROLES. Backend [schemas.py](apps/api/app/schemas.py) thêm 'analytics_viewer' vào Literal. Extension [messages.ts](apps/extension/src/shared/messages.ts) + [i18n-ui.ts](apps/extension/src/content/i18n-ui.ts) thêm ROLE_LABELS + ROLE_KEYWORDS cho analytics_viewer (vi: 'Trình xem dữ liệu phân tích', en: 'Analytics viewer', zh: '分析查看器').",
      "Popup thêm nút ↻ bên cạnh 'Plan: business · Seat: N/M' → click gọi POST /api/v1/queue/sync-billing (extension auth) → backend dedup task → publish SSE → extension fastpoll pick → scrape /admin/billing → DB cập nhật. Popup tự re-fetch whoami sau 6s.",
      "Backend endpoint mới [queue.py /sync-billing](apps/api/app/routers/queue.py) — extension-facing, dùng X-API-KEY thay vì admin session, dedup nếu đã có PENDING/IN_PROGRESS.",
      "i18n 4 string: popup.syncBillingTooltip (vi/zh), member.roleAnalyticsViewer + member.roleEditOnChatGPT (vi/zh). member.roleOwner/Admin/Member đổi từ tiếng Anh sang i18n đúng.",
    ],
  },
  {
    version: "0.4.15",
    date: "2026-05-19",
    kind: "fix",
    summary: "Fix CHANGE_ROLE treo IN_PROGRESS (UI 2026 inline dropdown) + dashboard tự reload member list không cần F5",
    details: [
      "Fix CHANGE_ROLE (extension): UI ChatGPT 2026 đổi role qua dropdown INLINE trên row ('Thành viên ▼' trực tiếp trong cột Vai trò) — KHÔNG còn ẩn trong '...' menu như UI cũ. Code v0.4.14 vẫn dùng flow cũ → click '...' → tìm 'Change role' item → không có → treo IN_PROGRESS vĩnh viễn. Sau v0.4.15: tìm inline dropdown theo text role hiện tại + label match, click → menu mở → click target role option.",
      "Helper mới `findRowRoleDropdown(row, currentRole?)` trong member-row.ts — multi-strategy: (1) match text role label (Thành viên / Member / 成员); (2) fallback aria-haspopup=menu/listbox (loại trừ seat type 'ChatGPT'/'Codex').",
      "Dispatcher index.ts pass `old_role` từ task payload → helper lọc dropdown theo role hiện tại chính xác hơn.",
      "Fix dashboard auto-reload (apps/web/Members.tsx): trước v0.4.15 query `members` chỉ refetch lúc mount + window focus, dẫn tới sau khi extension xong task (CHANGE_ROLE/REMOVE/INVITE) list không update → user phải F5. Sau v0.4.15: useEffect watch `recentTasks` (đã poll 2s); khi phát hiện task `INVITE_MEMBER/REMOVE_MEMBER/CHANGE_ROLE/REVOKE_INVITES/SYNC_DATA` mới chuyển sang COMPLETED/FAILED → invalidateQueries(['members']) → list refresh tự động trong <2s.",
    ],
  },
  {
    version: "0.4.14",
    date: "2026-05-19",
    kind: "fix",
    summary: "Strict invite: 0 email verified trong pending tab → return FAILED (không phải COMPLETED)",
    details: [
      "Trước v0.4.14: extension click submit thành công + toast OK → verify pending tab. Nếu tab pending KHÔNG có email nào trong list invite → vẫn return ok=true với verified_count=0. Task COMPLETED nhưng tất cả records bị xoá. Banner hiển thị 'Đã verify 0/N' dễ gây nhầm lẫn.",
      "Sau v0.4.14: nếu scrape pending OK và verified_count=0 → return `{ok:false, error_code:'VERIFY_FAILED'}` với message giải thích 3 nguyên nhân khả dĩ (email đã active, domain không verify, ChatGPT từ chối silent). Task FAILED visibility. Phantom cleanup vẫn chạy trong backend update_task FAILED handler.",
      "Logic strict này KHÔNG áp dụng khi verify_scrape_failed=true — vẫn return ok=true vì click submit có thể đã thành công ở ChatGPT nhưng extension không scrape được tab Lời mời để verify.",
    ],
  },
  {
    version: "0.4.13",
    date: "2026-05-19",
    kind: "fix",
    summary: "Phantom email: dashboard chỉ hiện email ChatGPT thực sự nhận; content script inject retry tới 3s",
    details: [
      "Fix A — phantom email (backend): bulk_invite vẫn tạo Member+Invite up-front (optimistic UI) nhưng update_task PATCH có handler MỚI xoá phantom: (1) FAILED → xoá toàn bộ records của queue task; (2) COMPLETED với unverified_emails → xoá chỉ những email đó; (3) verify_scrape_failed=true → giữ lại (an toàn). Chỉ xoá Member status='pending' + joined_at IS NULL (không xoá nhầm record đã active).",
      "Fix B — content script inject retry: trước v0.4.13 chỉ wait 300ms rồi ping 1 lần. CRXJS loader pattern cần thời gian dynamic import (500ms-2s) → false-negative thường xuyên. Giờ retry 5 lần với delay [250,500,700,800,800] (~3s tổng), success ngay khi ping được. Error code đổi từ 'UNKNOWN' → 'CONTENT_NOT_INJECTED' rõ ràng hơn.",
      "Kết hợp: nếu Fix B vẫn fail (3s vẫn không inject), Fix A đảm bảo dashboard tự xoá phantom email — không bao giờ thấy email mà ChatGPT chưa nhận trong list.",
    ],
  },
  {
    version: "0.4.12",
    date: "2026-05-19",
    kind: "feature",
    summary: "Popup: panel 'Task đang chạy' + progress bar; auto SYNC_BILLING sau invite để seat đúng",
    details: [
      "Popup overhaul: BỎ nút 'Không có task chờ' + dòng tip 'Khi tạo task ở dashboard...' (gây confusion). Thay bằng `ActiveTaskPanel` — chỉ hiện khi có task đang chạy / chờ / vừa xong.",
      "Component `ActiveTaskPanel` 3 trạng thái: (1) IN_PROGRESS hiển thị badge 'ĐANG CHẠY' + task type + progress message + thanh % + elapsed_sec; (2) PENDING > 0 hiển thị '{n} task chờ pick' gray; (3) recent COMPLETED/FAILED trong 60s gần đây hiển thị ✓/✗ badge + status.",
      "Poll mỗi 1.5s khi popup mở (useEffect cleanup khi đóng) — UI cập nhật real-time. Khi popup ẩn → ngừng poll → không tốn API quota.",
      "Backend endpoint mới `GET /api/v1/queue/active` trả {in_progress, pending_count, recent_completed} — gọn cho 1 lần fetch popup.",
      "Auto chain `SYNC_BILLING` sau INVITE_MEMBER/REMOVE_MEMBER/REVOKE_INVITES COMPLETED → workspace.seat_used cập nhật đúng ngay sau invite, không phải đợi user bấm 'Cập nhật giá & ngày renew'. Dedup: chỉ enqueue nếu chưa có SYNC_BILLING PENDING/IN_PROGRESS.",
      "Fix bug user thấy: popup hiển thị 'Seat: 11/12' trong khi ChatGPT thực tế 14/13 — DB stale vì SYNC_BILLING chưa chạy sau loạt invite. Giờ tự chạy.",
    ],
  },
  {
    version: "0.4.11",
    date: "2026-05-19",
    kind: "fix",
    summary: "UI Labels: dashboard sửa DB → extension refresh bundle ngay (không phải chờ 15 phút)",
    details: [
      "BUG cũ: admin sửa 1 row UI label qua Settings → DB update OK nhưng extension vẫn dùng label cũ tới 15 phút sau (chrome.alarms tick mới refresh bundle). Tạo cảm giác 'sửa DB không hoạt động'.",
      "Fix 1 — push-based: dashboard sau khi save/clear-stale/harvest done → post message {source:'autogpt-dashboard', type:'refresh-labels'} qua dashboard-bridge → background SW gọi refreshLabelBundle() → fetch /ui-labels/bundle mới → chrome.storage.local cập nhật → content script reload cache. Thời gian: <500ms.",
      "Fix 2 — defensive pull: REFRESH_INTERVAL_MIN giảm 15 → 2 phút. Phòng trường hợp extension chạy ở browser KHÁC dashboard (vd MoreLogin chứa extension, Edge chứa dashboard) → bridge không tồn tại → message bị drop, alarm 2 phút fallback.",
      "Helper mới `requestExtensionRefreshLabels()` trong [useExtensionTrigger.ts](apps/web/src/hooks/useExtensionTrigger.ts) — best-effort, không throw, không await. Gọi trong UiLabelsManager onSuccess của 3 mutation (save bulk, clear stale, harvest complete).",
      "Bridge protocol thêm 1 cặp message: dashboard→bridge 'refresh-labels' và bridge→dashboard 'refresh-labels-result' (payload {ok,error}).",
    ],
  },
  {
    version: "0.4.10",
    date: "2026-05-19",
    kind: "feature",
    summary: "Verify invite ở tab Lời mời đang chờ xử lý TRƯỚC khi update dashboard",
    details: [
      "Quy trình mới sau invite verify success: scrape tab 'Lời mời đang chờ xử lý' → tính giao của (email vừa mời) ∩ (email scrape được) = verified_emails. Chỉ verified emails mới được bulk-upsert lên dashboard.",
      "Unverified emails (mời nhưng KHÔNG xuất hiện trong pending — vd ChatGPT từ chối thầm, email đã active sẵn, đã removed bị block) được report tách riêng vào task.result.unverified_emails → admin biết để check thủ công.",
      "Task result mới include: `verified_count`, `unverified_count`, `unverified_emails[]`, `verify_scrape_failed`. TaskCompletionBanner dashboard hiển thị message rõ hơn: 'Đã verify X/Y email' hoặc 'Chỉ verify được X, KHÔNG verified: ...'.",
      "Edge case: scrape pending FAIL toàn bộ (DOM lạ, locale mismatch, timeout 60s) → `verify_scrape_failed=true`, KHÔNG update dashboard records, banner hiển thị 'mở tab Lời mời thủ công để check'. Task vẫn COMPLETED vì ChatGPT đã nhận click invite.",
      "i18n: 3 string mới `sync.completedInviteVerified` / `Partial` / `VerifyFailed` cho vi + zh-CN.",
    ],
  },
  {
    version: "0.4.9",
    date: "2026-05-19",
    kind: "fix",
    summary: "Fix UI_ELEMENT_NOT_FOUND khi click 'Mời thành viên' sau toggle external invites",
    details: [
      "Bug: sau khi wrap external-invites BẬT toggle tại /admin/identity → navigate về /admin/members → gọi findInviteOpenButton() ngay, nhưng SPA render content sau navigation cần thêm vài trăm ms tới vài giây → button chưa tồn tại trong DOM → invite fail 'UI_ELEMENT_NOT_FOUND'.",
      "Fix 1 (invite.ts): findInviteOpenButton giờ chạy trong `waitFor()` poll loop tới 8s thay vì gọi 1 lần. Error message rõ hơn: list 3 điểm cần check.",
      "Fix 2 (external-invites.ts): wrap navigateTo predicate mạnh hơn — không chỉ chờ `location.pathname.includes('/admin/members')` mà còn chờ DOM có `<main>` + ≥2 button elements (= page content đã render xong). Timeout từ 5s → 10s.",
      "Symptom user thấy: extension xoay/hang ở trang /admin/members nhưng KHÔNG mở dialog Invite. Task FAILED với error_code=UI_ELEMENT_NOT_FOUND.",
    ],
  },
  {
    version: "0.4.8",
    date: "2026-05-19",
    kind: "feature",
    summary: "Invite flow trọn vẹn: bật toggle external invites → mời → MAP lời mời về dashboard → tắt toggle",
    details: [
      "Sau khi invite verify thành công, thêm bước MỚI: click tab 'Lời mời đang chờ xử lý' + scroll-and-scrape pending invites + return về background. Sau đó tab 'Người dùng' được click lại để extension idle ở trang quen thuộc.",
      "Background runner (runner.ts) detect INVITE_MEMBER COMPLETED có `data.pending_members` → chunked bulk-upsert với `scrapedStatuses=['pending']` → dashboard reconcile pending tab (NOT đụng tới `status='active'` của member khác).",
      "Mapping là BEST-EFFORT: nếu scrape pending fail (DOM lạ, locale mismatch, timeout 60s) → log warning + invite vẫn COMPLETED. KHÔNG bao giờ rollback invite chỉ vì mapping fail.",
      "External invites toggle wrap (external-invites.ts) không đổi: vẫn bật ON trước invite, restore (thường OFF) trong finally. Mapping chạy giữa 2 bước → toggle off chỉ sau khi mapping xong.",
      "Phase mới 'mapping' trong reportProgress → dashboard banner hiển thị 'Đang map lời mời mới về dashboard...' giữa invite success và task COMPLETED.",
      "Reusable export `scrapePendingInvitesAfterInvite(taskId)` trong sync.ts — caller bắt buộc đã ở /admin/members, hard cap 60s, không bao giờ throw.",
    ],
  },
  {
    version: "0.4.7",
    date: "2026-05-19",
    kind: "fix",
    summary: "Sync scraper lenient hơn (EMAIL_EXTRACT_RE fallback) + giảm 70% delay",
    details: [
      "Scraper sync.ts: thêm fallback EMAIL_EXTRACT_RE_G — extract email từ text node chứa email cùng tên/avatar (vd 'B b yaakovajax0054@outlook.com'). Trước v0.4.7 chỉ dùng EMAIL_FULL_RE (text node phải EXACT email) — miss khi ChatGPT 2026 concat avatar+name+email vào 1 text node.",
      "Diagnostic logging: scrape log tổng text nodes scanned + full-match count + extract-match count + final unique rows → debug dễ hơn khi sync trả 0 row.",
      "Delay -70% toàn bộ (human.ts DELAY_MULTIPLIER = 0.30): randomDelay default 1500-4000ms → 450-1200ms; microDelay 60-140ms → 18-42ms; per-char typing 40-120ms → 12-36ms. Theo yêu cầu user 'extension cứ xoay mãi' = chậm. Tradeoff: anti-detection nhẹ hơn nhưng vẫn realistic.",
      "⚠ Backend pair: sau khi update API code (vd thêm subscription_months column trong v0.4.4-0.4.6), MUST chạy `alembic upgrade head`. Auto-migration giờ chạy on startup (apps/api/app/main.py lifespan) — chỉ cần restart backend, không cần lệnh thủ công.",
    ],
  },
  {
    version: "0.4.6",
    date: "2026-05-19",
    kind: "fix",
    summary: "Sync: locale mismatch detection + anchor-click navigation cho /admin/members",
    details: [
      "SYNC_DATA action giờ nhận `expectedLocale` ('vi'|'en'|'zh') từ payload — dashboard truyền lang hiện tại (mapping: vi→vi, zh-CN→zh) để extension check ChatGPT đang dùng locale gì.",
      "Helper mới: `detectChatGPTLocale()` đọc `document.documentElement.lang` → normalize về 'vi'|'en'|'zh'. `checkLocaleMatch(expected)` compare + tạo hint message cho user nếu mismatch (instructions đổi ChatGPT settings → Locale).",
      "Khi sync trả 0 row VÀ locale mismatch → error_code mới 'LANGUAGE_MISMATCH' với error_message chứa hướng dẫn cụ thể. Dashboard TaskCompletionBanner show full message → user biết chính xác cần làm gì.",
      "sync.ts navigation cải tiến: ưu tiên click <a href> trong sidebar (Next.js router catches reliably) trước khi fallback pushState — khắc phục case admin tab đang ở /admin/billing và pushState không trigger re-render.",
      "Backend `POST /workspaces/{id}/sync` nhận query param `expected_locale` → ghi vào QueueItem payload. Dashboard syncMembers mutation gửi `expected_locale` mapped từ i18n state hiện tại.",
      "Log diagnostic cải tiến: phase 'discover' giờ kèm locale info trong console.",
    ],
  },
  {
    version: "0.4.5",
    date: "2026-05-19",
    kind: "fix",
    summary: "Invite progress chi tiết hơn (phase, current/total) để dashboard banner hiển thị tiến trình",
    details: [
      "Thêm `current` + `total` (= emails.length) vào mọi reportProgress call trong invite — banner Members hiển thị '1/4', '2/4', ... real-time.",
      "Phase 'add-row' mới: trước khi click 'Add more' cho email i, báo phase này → user thấy ngay extension đang ở bước nào.",
      "Phase 'opening-dialog' giờ kèm tổng số email trong message → debug dễ hơn khi banner hiển thị.",
      "Dashboard (apps/web) cập nhật banner invite — hiển thị per-task: email, status badge, phase, current/total, elapsed seconds, stale warning nếu > 90s không có phase. Banner FAILED riêng cho invite vừa fail (60s gần nhất) hiển thị error_code + error_message.",
    ],
  },
  {
    version: "0.4.4",
    date: "2026-05-19",
    kind: "fix",
    summary: "Multi-email invite: row-based UI 2026 (mỗi email 1 input riêng) + bổ sung text mapping",
    details: [
      "ChatGPT đổi dialog Invite sang layout 3-column (Email | Role | Seat type) với mỗi email là 1 ROW riêng có input riêng. UI cũ là 1 input + textarea expand sau khi click 'Add more'.",
      "Multi-email cũ: join các email bằng \\n vào 1 input duy nhất → 1 input không nhận newline → ChatGPT reject toàn bộ.",
      "Multi-email mới: type email[0] vào input đầu → loop 'Add more' → đợi row mới render (input count tăng) → type email[i] vào input rỗng cuối → repeat. Fallback dồn email vào 1 input nếu Add more fail.",
      "Helpers mới: countDialogEmailInputs(dialog) đếm input email-like, findLastEmptyEmailInput(dialog) lấy input rỗng cuối.",
      "Text mapping: thêm 'Send invites' (plural), 'Send invitations', 'Add another member', 'Add a member', 'Add row', 'Add many', 'Thêm thành viên', 'Thêm dòng', '添加成员', '添加一行'.",
      "Text mapping menu: thêm 'Change seat type', 'Edit seat type', 'Đổi loại ghế', '更改席位类型' (UI mới row menu chỉ còn Change seat type + Remove member).",
      "Progress mới: 'Đang nhập email i/N: {email}' — dashboard thấy tiến trình từng email.",
    ],
  },
  {
    version: "0.4.3",
    date: "2026-05-19",
    kind: "fix",
    summary: "Invite flow robust: multi-strategy label, sidebar-link nav, seat-limit error hints",
    details: [
      "findExternalInvitesToggle: thay row-only scope bằng multi-strategy label extraction — aria-labelledby → aria-label → label[for] → closest <label> → previous siblings → single-switch row. Switch nào không có ancestor 1-switch (DOM siblings flat) vẫn được label hoá đúng.",
      "console.table diagnostic mỗi lần scan switch — user mở DevTools thấy ngay label đọc được của từng toggle + pattern nào match/exclude.",
      "navigateTo: ưu tiên click <a href> trong sidebar (Next.js router catches) thay vì pushState. Selector mới quét tất cả <a[href]> match cả tuyệt đối lẫn tương đối. Quan trọng khi extension bị invoke từ tab /admin/billing — pushState từ billing đến identity thường không trigger re-render.",
      "INVITE_ERROR_HINTS thêm: seat limit (insufficient seats, không đủ ghế, 席位不足, …) + external domain (outside your organization, miền bên ngoài, 外部域). Dialog ChatGPT báo lỗi loại này sẽ được surface rõ ràng thay vì 'Dialog text: …'.",
      "Nav timeout log warning rõ ràng (đang ở X, target Y) thay vì im lặng.",
    ],
  },
  {
    version: "0.4.2",
    date: "2026-05-19",
    kind: "fix",
    summary: "Invite flow: chọn đúng toggle 'Allow External Domain Invites' (không nhầm 'Automatic Account Creation')",
    details: [
      "findExternalInvitesToggle() refactor: scope text match về 'row' (ancestor lớn nhất chỉ chứa 1 switch) thay vì walk-up 5 cấp — chặn false-match khi 2 toggle share ancestor.",
      "Thêm EXTERNAL_INVITE_EXCLUDE_PATTERNS — loại các row chứa 'Automatic Account Creation' / 'tự động tạo tài khoản' / '自动创建账户' khỏi candidate list.",
      "Patterns mới: 'Allow External Domain Invites' (English đầy đủ), 'cho phép lời mời từ miền bên ngoài' (VI), '允许外部域邀请' (ZH) — sắp xếp theo độ dài để chọn pattern đặc trưng nhất khi nhiều match.",
      "Best-match scoring: pattern dài nhất thắng → chọn switch có row label đặc trưng nhất.",
      "Áp dụng cùng heuristic cho harvest-labels.ts /admin/identity scraper — tránh ghi nhầm label 'Automatic Account Creation' vào DB.",
    ],
  },
  {
    version: "0.4.1",
    date: "2026-05-18",
    kind: "fix",
    summary: "Invite flow: luôn navigate về /admin/members sau khi tắt toggle",
    details: [
      "withExternalInvitesEnabled() trong finally: sau khi restore toggle external invites về OFF (nếu prev OFF), navigate về /admin/members thay vì kẹt ở /admin/identity.",
      "Áp dụng cho cả invite success và invite fail — UX nhất quán + task sau (SYNC_DATA, REMOVE_MEMBER...) khởi động ở đúng trang.",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-05-18",
    kind: "feature",
    summary: "HARVEST_LABELS: probe-invite mode (auto 100% locale coverage)",
    details: [
      "Khi tab 'Pending Invites' trống, harvest tự tạo invite probe (autogpt-probe-{ts}@example.com) → harvest menu Revoke + confirm Revoke → tự thu hồi probe để workspace sạch.",
      "Bỏ member_row_menu_button khỏi expected list (icon-only, không có text — CSS selector handle).",
      "Coverage giờ 14 control_key/page Members (thay vì 15) → 18 tổng → đạt 100% nếu probe-invite chạy được.",
    ],
  },
  {
    version: "0.3.2",
    date: "2026-05-18",
    kind: "fix",
    summary: "HARVEST_LABELS: progress lifecycle (background) + initial signal",
    details: [
      "Background runner báo progress sớm: 'queued' → 'opening_tab' → 'rate_limit' trước cả khi gửi tới content script. Trước đây dashboard im lặng 5-30s khi extension tự mở tab chatgpt.com/admin.",
      "Content script báo signal 'starting' ngay tại 0/18 trước locale check — dashboard có gì hiện ngay khi inject.",
      "Dashboard hiển thị status badge (PENDING/IN_PROGRESS), elapsed timer cục bộ ticking 1s, watchdog cảnh báo sau 20s nếu không thấy signal nào.",
      "Áp dụng cùng pattern progress lifecycle cho SYNC_DATA.",
    ],
  },
  {
    version: "0.3.1",
    date: "2026-05-18",
    kind: "fix",
    summary: "HARVEST_LABELS: progress real-time + nav verify + 3 phút timeout",
    details: [
      "Per-step progress (current/total/scanned/elapsed_sec) — dashboard hiện progress bar.",
      "navigateSpaVerified: kiểm tra location.pathname đổi thật sự sau pushState; skip page nếu nav fail thay vì hang.",
      "Global 3 phút timeout — harvest tự thoát nếu kẹt.",
      "Trả error 'không lấy được label nào' nếu total=0 sau crawl (thường do user chưa F5 hoặc selector lệch).",
      "JSON.parse hardening — backend 5xx không crash extension cache refresh nữa.",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-05-18",
    kind: "feature",
    summary: "HARVEST_LABELS — auto-crawl ChatGPT UI label",
    details: [
      "Action HARVEST_LABELS: extension tự navigate 4 page (/admin/members, /admin/billing, /admin/billing?tab=invoices, /admin/identity), mở invite dialog + click '...' menu + đọc confirm dialog rồi ESC để hủy → đọc 18 control_key cho 1 locale.",
      "Dashboard Settings → UI Labels: nút 'Harvest VI/EN/ZH' thay thế Console snippet thủ công.",
      "Endpoint mới POST /api/v1/ui-labels/harvest (X-API-KEY) cho extension bulk-upsert đa page.",
      "POST /api/v1/workspaces/{id}/harvest-labels (super-admin) tạo task qua SSE.",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-05-18",
    kind: "feature",
    summary: "UI Label calibration + self-heal stale labels",
    details: [
      "Fetch /api/v1/ui-labels/bundle định kỳ (15 phút) — cache label calibrate vào chrome.storage.",
      "Actions ưu tiên label đã harvest cho (locale × page) hiện tại; fallback hardcoded text patterns nếu DB rỗng.",
      "Tự động POST /report-mismatch khi tìm element fail dù DB có label → dashboard banner stale.",
      "Wire DB lookup: invite open/submit/add-more, tabs (active/pending/requests/billing-plan/billing-invoices), role options, menu remove/change-role, confirm remove/revoke, toggle external invites.",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-05-18",
    kind: "feature",
    summary: "Initial release",
    details: [
      "Cầu nối Dashboard nội bộ ↔ ChatGPT Business admin.",
      "Action: INVITE_MEMBER, REMOVE_MEMBER, CHANGE_ROLE, SYNC_DATA, SYNC_BILLING, REVOKE_INVITES.",
      "Auto-execute task qua SSE (real-time, không poll ChatGPT).",
      "Multi-language scraper (VI/EN/ZH).",
      "Port riêng: backend 18000, dashboard 17173, ext dev 17174.",
    ],
  },
];
