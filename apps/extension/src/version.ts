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

export const VERSION = "0.8.11";

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
    version: "0.8.11",
    date: "2026-06-19",
    kind: "fix",
    summary:
      "Đổi loại giấy phép / đổi vai trò / xoá thành viên hết lỗi 'Không tìm thấy <email> sau khi lọc + lật mọi trang' dù member đang active: ép tab về /admin/members trước khi tìm. Regression của v0.8.9 (tái dùng tab admin mới nhất) — tab có thể đang ở /admin/billing nên không có list Người dùng để tìm.",
    details: [
      "USER REPORT 2026-06-19: 'khi ấn vào button đổi seat type bị lỗi không chuyển sang thành viên để tìm thành viên đó và đổi'. Queue: CHANGE_LICENSE_TYPE (tamnm@ibcgroup.vn, c1khaithai-px@hanoiedu.vn) FAILED UI_ELEMENT_NOT_FOUND 'Không tìm thấy ... sau khi lọc + lật mọi trang' — dù 2 member này đang active trong DB. Cùng action COMPLETED bình thường lúc 04:56 rồi bắt đầu fail từ 08:00+.",
      "ROOT CAUSE: v0.8.9 (cùng ngày) đổi ensureAdminTab sang TÁI SỬ DỤNG tab /admin/* mới nhất thay vì luôn mở /admin/members. executeChangeLicenseType chỉ check pathname.includes('/admin') (qua với MỌI sub-page) rồi dựa vào clickTabAndWait('Người dùng') để vào list. Nhưng 3 sub-tab Người dùng/Lời mời/Yêu cầu CHỈ tồn tại TRÊN /admin/members. Khi tab bị 1 task khác (billing/purchase/identity) kéo sang /admin/billing..., nút 'Người dùng' không có → clickTabAndWait no-op (action bỏ qua return value) → locateMemberRow quét nhầm trang → null → UI_ELEMENT_NOT_FOUND. Vì thế lúc tab tình cờ ở /admin/members thì chạy được (04:56), lúc tab drift sang billing thì fail (08:00+).",
      "FIX (runner.ts runOnce): trước khi gửi action cho các task thao tác trên list Người dùng (REMOVE_MEMBER, CHANGE_ROLE, CHANGE_LICENSE_TYPE), nếu tab.url KHÔNG chứa '/admin/members' thì chrome.tabs.update navigate về CHATGPT_ADMIN_URL + waitForTabComplete + sleep 1.5s cho list render. Đảm bảo action luôn bắt đầu đúng trên trang members bất kể tab đang ở sub-page nào.",
      "File đổi: apps/extension/src/background/runner.ts, version.ts. Docs: apps/extension/src/content/actions/change-license-type/README.md (lịch sử + đóng góc tồn đọng tab-drift), runner.md.",
    ],
  },
  {
    version: "0.8.10",
    date: "2026-06-19",
    kind: "fix",
    summary:
      "Bật toggle 'Cho phép lời mời ngoài tên miền' đáng tin hơn khi mời email ngoài domain: poll chờ ChatGPT lưu thay vì sleep cứng, double-check khi tưởng đã ON, retry click, không đoán bừa state. Mục tiêu user: toggle LUÔN OFF, chỉ bật khi mời email ngoài rồi tắt lại — và lúc bật phải chắc ăn (không mời khi toggle thật vẫn OFF).",
    details: [
      "USER REPORT 2026-06-19: 'nhiều khi bật chế độ cho phép mời ngoài bị lỗi ... nhiều khi tôi thấy nó vẫn bị tắt mà vẫn đi mời thành viên ngoài vào' (vd avkpoint@outlook.com bị mời theo lệnh lỗi).",
      "LÀM RÕ: việc toggle LUÔN hiện OFF sau khi mời là CỐ Ý (spec bảo mật v0.6.6 — force OFF sau mỗi invite). Email ngoài domain được mời vì extension tự bật ON tích tắc rồi tắt. Hệ thống KHÔNG có policy cấm mời ngoài; mọi email ngoài verified_domain đều được auto-bật-toggle. User xác nhận hành vi đúng = 'luôn tắt, khi mời ngoài thì bật lên' → giữ thiết kế, chỉ làm khâu BẬT đáng tin.",
      "ROOT CAUSE khâu bật không ổn định (set-toggle.ts): (a) click 1 lần + sleep(800) cứng + đọc state 1 lần → mạng/PATCH chậm thì verify đọc state cũ → confirmed=false oan → EXTERNAL_TOGGLE_FAILED (mời ngoài fail vô cớ). (b) getToggleState fallback trả false thầm lặng khi không đọc được aria → quyết định sai. (c) early-return khi prev===target tin tưởng 1 lần đọc DOM (có thể bắt nhầm switch / transient) → bỏ qua click → mời khi toggle thật OFF.",
      "FIX (set-toggle.ts): getToggleState trả boolean|null (không đoán bừa); khi prev===target thì đọc lại lần 2 (double-check) mới SKIP; khi click thì POLL state tới khi == target (tối đa 4s) thay vì sleep cứng; retry click tối đa 2 lần. Confirmed chỉ true khi state CUỐI thực sự == target → execute-invite.ts vẫn chặn submit nếu !confirmed (không phantom).",
      "File đổi: apps/extension/src/content/actions/external-invites/set-toggle.ts, version.ts. Docs: external-invites/README.md (đóng tồn đọng #4 sleep cứng, #5 fallback false), Invite_Member.md changelog.",
    ],
  },
  {
    version: "0.8.9",
    date: "2026-06-19",
    kind: "feature",
    summary:
      "Quản lý tab chatgpt.com/admin theo quy tắc user: CHỈ mở tab mới khi action không chạy được trên tab cũ; bình thường tái sử dụng tab mới nhất; khi >5 tab trùng thì tự đóng bớt tab cũ, giữ 5 tab mới nhất.",
    details: [
      "USER REQUEST 2026-06-19: ban đầu 'luôn mở tab mới mỗi action; >3 tab dùng tab mới nhất; >5 tab tự đóng' → sau đó chỉnh lại: 'chỉ mở tab khi các action không hoạt động trên tab cũ'.",
      "ensureAdminTab (apps/extension/src/background/runner.ts) viết lại: (1) queryAdminTabs() lấy tất cả tab /admin/* sắp xếp cũ→mới theo tab.id; (2) >ADMIN_TAB_MAX(5) → pruneStaleAdminTabs đóng các tab cũ nhất, giữ 5 tab mới nhất; (3) còn ≥1 tab → TÁI SỬ DỤNG tab MỚI NHẤT, không mở thêm; (4) 0 tab → chrome.tabs.create tab mới (background, active:false) tới /admin/members rồi verify còn ở /admin.",
      "'Mở tab mới khi action fail' đã do ensureContentInjected Step 3 NUCLEAR đảm nhiệm: content script không inject được trên tab cũ → tabs.remove tab hỏng + tabs.create tab mới hoàn toàn. ensureAdminTab không cần tự đẻ tab mỗi action nữa.",
      "Dùng tab.id làm proxy 'mới nhất' (Chrome cấp id tăng dần theo thời điểm tạo).",
      "Bỏ findAdminTab() cũ (trả tab[0]) và hằng ADMIN_TAB_REUSE_THRESHOLD (không còn dùng). File đổi: background/runner.ts, runner.md, version.ts.",
    ],
  },
  {
    version: "0.8.8",
    date: "2026-06-18",
    kind: "fix",
    summary:
      "Thu hồi lời mời (REVOKE) tìm email bằng ô 'Search for invites' trên tab Lời mời thay vì cuộn list (dễ miss). Trước đây revoke miss row → kết luận nhầm 'không có trên tab Lời mời' → fallback nhầm sang tab Người dùng (REMOVE) → fail dù email đang là pending invite.",
    details: [
      "USER REPORT + bằng chứng queue (2026-06-17): INVITE_MEMBER oewi@gmail.com COMPLETED lúc 18:07:38; REVOKE_INVITES cùng email 27s sau (18:08:05) trả 'Không có trên tab Lời mời; xoá khỏi tab Người dùng cũng thất bại: Không tìm thấy ... sau khi duyệt hết mọi trang'. Email rõ ràng đang là pending invite nhưng revoke không thấy.",
      "ROOT CAUSE: revokeInvite dùng scrollScanForRow (cuộn list virtualized) để định vị row trên tab Lời mời. List virtualized / phân trang → row ngoài viewport chưa render → miss → trả notInPending=true → executeRevokeInvites fallback sang executeRemove (tab Người dùng) → không có ở đó (vì đang pending) → fail.",
      "FIX: thêm locatePendingRow(email) — gõ email vào ô 'Search for invites' (SELECTORS.pendingSearchInput, thêm ở v0.8.7) → list rút còn 0-1 row → findMemberRow đọc ngay. Đây mới là cách đúng & chính xác. Chỉ fallback scroll-scan khi UI KHÔNG có ô search.",
      "Giữ nguyên fallback REMOVE sang tab Người dùng cho case THẬT (người đã chấp nhận lời mời → thành active member) — chỉ kích hoạt khi ô search xác nhận email không còn trong pending.",
      "File mới: apps/extension/src/content/actions/revoke/locate-pending-row.ts. File đổi: revoke-invite.ts, version.ts. Docs: apps/extension/src/content/actions/revoke/README.md.",
    ],
  },
  {
    version: "0.8.7",
    date: "2026-06-18",
    kind: "fix",
    summary:
      "Vá fast-path verify (0.8.6) KHÔNG hoạt động: tab 'Lời mời đang chờ xử lý' có ô 'Search for invites' RIÊNG (placeholder khác + thường là input[type=text]) nên selector cũ trượt → vẫn rơi về scrape cả trang + lật trang. Thêm SELECTORS.pendingSearchInput match đúng ô search lời mời.",
    details: [
      "USER REPORT (2026-06-18): sau khi mời thành công + F5 render xong, extension VẪN không gõ vào ô tìm kiếm ('Search for invites') mà quét cả trang rồi lật sang trang khác.",
      "ROOT CAUSE: v0.8.6 dùng SELECTORS.memberFilterInput (ô 'Lọc theo tên'/'Filter by name' của tab Người dùng). Tab Lời mời có ô search KHÁC: placeholder 'Search for invites', và là input[type=text] chứ không phải type=search → cả 8 selector trượt → findPendingFilterInput()=null → verifyPendingViaFilter trả null → fallback scrapePendingInvitesAfterInvite (scrape full + lật trang) đúng như user thấy.",
      "FIX: thêm SELECTORS.pendingSearchInput match placeholder/aria-label đa ngôn ngữ ('Search for invites'/'Tìm kiếm lời mời'/'搜索邀请' + bắt rộng Search/Tìm/搜索). findPendingFilterInput() thử pendingSearchInput TRƯỚC rồi mới fallback memberFilterInput.",
      "File đổi: apps/extension/src/content/selectors.ts (+pendingSearchInput), apps/extension/src/content/actions/invite/verify-pending-via-filter.ts, version.ts.",
    ],
  },
  {
    version: "0.8.6",
    date: "2026-06-18",
    kind: "fix",
    summary:
      "Verify sau khi mời (bước F5 tab 'Lời mời đang chờ xử lý') nhanh hơn NHIỀU lần: dùng ô 'Lọc theo tên' gõ thẳng từng email vừa mời thay vì scrape TOÀN BỘ list (scroll hết + lật hết trang). Không đọc email khác, không chuyển trang — y như fast-path đã dùng cho REMOVE/CHANGE_ROLE.",
    details: [
      "USER REPORT (2026-06-18): 'khi mời thành viên thành công đến bước F5 load tại trang lời mời đang chờ xử lý không cần đọc toàn bộ email hay chuyển trang. Khi render thành công thì search email sẽ nhanh hơn rất nhiều lần. Làm tương tự các chức năng tìm kiếm tương tự.'",
      "TRƯỚC: executeVerifyPendingInvite gọi scrapePendingInvitesAfterInvite → scrapeCurrentTab cuộn hết list + lật hết MỌI trang (hard cap 60s) chỉ để xác nhận vài email. Pending list dài = chậm vô ích.",
      "FIX: thêm verifyPendingViaFilter(emails) — tab 'Lời mời' dùng CHUNG ô search input[type=search] (SELECTORS.memberFilterInput) như tab 'Người dùng'. Gõ từng email (local-part rồi full email) → list rút còn 0-1 row → scrapeAllRows đọc ngay → clear filter. Mirror fast-path filterAndFindRow của REMOVE.",
      "Fallback an toàn: không vào được tab / không thấy ô lọc → trả null → executeVerifyPendingInvite tự dùng lại scrape full như cũ. Email lọc chưa thấy = unverified → giữ nguyên cơ chế F5 retry (needs_reload_retry) sẵn có.",
      "File mới: apps/extension/src/content/actions/invite/verify-pending-via-filter.ts. File đổi: execute-verify-pending.ts, version.ts. Docs: apps/extension/src/content/actions/invite/README.md.",
    ],
  },
  {
    version: "0.8.5",
    date: "2026-06-18",
    kind: "fix",
    summary:
      "Mời thành viên mở dialog NHANH hơn + chẩn đoán rõ bước nào chậm. Bỏ click tab 'Người dùng' thừa khi nút Mời đã hiện sẵn (click thừa làm ChatGPT re-fetch cả danh sách member → trễ), thay sleep 800ms cố định bằng poll dialog (mở sớm đi tiếp ngay), tách phase 'waiting-dialog' để dashboard tách bạch thời gian tìm/click nút mở vs thời gian dialog render.",
    details: [
      "USER REPORT (2026-06-18): 'time mở dialog tốn rất nhiều thời gian' (phase opening-dialog ~11s).",
      "PHÂN TÍCH: phase 'opening-dialog' gộp nhiều bước: (1) click tab 'Người dùng' (kể cả khi đã ở đúng tab) → ChatGPT re-fetch + re-render list vài giây; (2) waitFor nút Mời render (tới 8s sau navigate); (3) sleep 800ms CỐ ĐỊNH + có thể click lần 2; (4) waitFor dialog + ô email render (tới 20s). Không tách phase nên không biết bước nào chậm.",
      "FIX 1 (bỏ click thừa): chỉ click tab 'Người dùng' khi findInviteOpenButton() CHƯA thấy nút Mời. Nếu nút đã hiện = đang đúng tab → bỏ qua click (tránh ChatGPT re-fetch danh sách ngay trước khi mở dialog).",
      "FIX 2 (poll thay sleep): sau click nút Mở, poll dialog xuất hiện mỗi 150ms (tối đa 1000ms) thay vì sleep 800ms cứng → dialog mở ~150-400ms thì đi tiếp ngay (tiết kiệm ~400-650ms). Hết 1s chưa thấy mới retry click.",
      "FIX 3 (telemetry): thêm phase 'waiting-dialog' ngay trước waitFor ô email → PhaseBreakdown tách 'opening-dialog' (tìm+click nút) khỏi 'waiting-dialog' (dialog+ô email render) → lần sau nhìn breakdown biết chính xác bước nào tốn thời gian (ChatGPT render chậm vs extension chờ thừa).",
      "File đổi: apps/extension/src/content/actions/invite/execute-invite-inner.ts, version.ts. Docs: apps/extension/src/content/actions/invite/README.md.",
    ],
  },
  {
    version: "0.8.4",
    date: "2026-06-18",
    kind: "fix",
    summary:
      "Mời thành viên (và mọi task) không còn kẹt IN_PROGRESS tới khi auto-cleanup: thêm hard-timeout cho PHASE 1 (gửi lệnh tới content script). Trước đây chỉ Phase 2 (verify sau F5) có timeout; Phase 1 thì KHÔNG → khi tab ChatGPT bị reload/redirect giữa chừng (vd mời email NGOÀI tên miền phải navigate qua /admin/identity bật toggle) làm chết context content script, background chờ vô hạn → task kẹt 3-5 phút rồi báo TIMEOUT.",
    details: [
      "USER REPORT (2026-06-18): mời 'hil@gmail.com' (ngoài domain xác minh 'ndaigroup.org') → task IN_PROGRESS 343s rồi auto-cleanup TIMEOUT 'extension không trả kết quả'.",
      "ROOT CAUSE: runOnce gọi `await sendToContent(tab.id, request)` (Phase 1) KHÔNG bọc timeout. chrome.tabs.sendMessage không có timeout sẵn. Email ngoài domain đi nhánh setExternalInvites → navigateTo('/admin/identity') ↔ '/admin/members' nhiều lần; nếu ChatGPT hard-reload / redirect auth ở giữa, content script context bị huỷ TRƯỚC khi executeInvite return → onMessage listener không bao giờ gọi sendResponse → background await treo vĩnh viễn → task kẹt tới backend lazy-cleanup (STUCK_THRESHOLDS invite=3 phút; hiện 343s do cleanup chạy lazy lúc pick task kế).",
      "Phase 2 (VERIFY_PENDING_INVITE) đã được bọc withTimeout từ v0.7.12, nhưng Phase 1 bị bỏ sót — đây là lỗ hổng còn lại của cùng class bug.",
      "FIX (runner.ts): bọc Phase 1 sendToContent trong withTimeout theo từng loại task (CONTENT_TIMEOUTS): UI ops (invite/remove/role/license/revoke) 150s, sync_member/billing 210s, sync_data/harvest 330s, purchase 450s, default 270s. Mỗi cap LỚN hơn thời gian chạy hợp lệ tối đa của content nhưng NHỎ hơn ngưỡng treo backend ~30s → extension tự fail TRƯỚC, báo error_code mới CONTENT_TIMEOUT rõ ràng + giải phóng service worker + task kế chạy ngay.",
      "KHÔNG dọn phantom khi timeout: không chắc invite đã submit hay chưa (content có thể đã gửi trước khi context chết) → để task FAILED → backend completion.py phantom cleanup (Case 1 xoá record của task) hoặc SYNC_DATA định kỳ tự reconcile. Tránh xoá nhầm member đã mời thật.",
      "File đổi: apps/extension/src/background/runner.ts (CONTENT_TIMEOUTS + bọc Phase 1), apps/extension/src/shared/messages.ts (+error_code CONTENT_TIMEOUT), version.ts. Docs: apps/extension/src/content/actions/invite/README.md.",
    ],
  },
  {
    version: "0.8.3",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "Đổi loại giấy phép (CHANGE_LICENSE_TYPE): khi tìm thấy email mà license type thật trên ChatGPT đã ĐÚNG target rồi thì bỏ qua, không thao tác đổi nữa.",
    details: [
      "Sau khi định vị row (lọc theo email + lật trang), đọc license type hiện tại trên DOM bằng findLicenseTypeInRow; nếu đã = target → clearMemberFilter + trả ok:true, skipped:'already' (KHÔNG mở menu '...' / không đổi / không hiện dialog xác nhận thừa).",
      "Tin cậy hơn skip cũ dựa trên oldLicenseType từ DB (có thể stale) vì đọc giá trị thật đang hiển thị. Backend completion vẫn set Member.license_type=target (idempotent) nên DB & UI luôn khớp.",
      "File: content/actions/change-license-type/execute-change-license-type.ts.",
    ],
  },
  {
    version: "0.8.2",
    date: "2026-06-17",
    kind: "feature",
    summary:
      "Đồng bộ 1 tài khoản lẻ (SYNC_MEMBER): nút 'Đồng bộ' per-row ở member đang chờ → tìm email ở tab Lời mời, không thấy thì fallback tab Người dùng; thấy ở Người dùng nghĩa là đã tham gia → chuyển trạng thái 'đang hoạt động'; không thấy cả 2 tab → báo email không tồn tại trong workspace. Read-only, không thao tác phá huỷ.",
    details: [
      "Action mới content/actions/sync-member: scroll-scan tab Lời mời (tái dùng scrollScanForRow) → fallback locateMemberRow tab Người dùng.",
      "Trả data.found_in ∈ {pending, active, none}; backend completion set status='active' khi 'active', KHÔNG mark removed khi 'none' (tránh xoá oan).",
      "Backend: POST /sync-member (chống-spam >2 lần/60s → cooldown 5 phút) + rate-limit full-sync 1 lần/ngày cho admin phụ + GET /sync-quota để web ẩn/hiện nút.",
    ],
  },
  {
    version: "0.8.1",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "SYNC_DATA số lượng lớn: fix 'cập nhật hàng loạt không hoạt động' — phần lớn member bị mark 'removed' oan sau khi đồng bộ workspace nhiều member (>200).",
    details: [
      "ROOT CAUSE: runner SYNC_DATA chia members thành chunk 200 rồi gọi bulk-upsert nhiều lần, MỖI chunk kèm scrapedStatuses → backend reconcile theo từng chunk: incoming_emails chỉ là 200 email của chunk đó → mọi member khác (email NOT IN chunk) bị mark 'removed'. Sync ≤200 (1 chunk) đúng, nên bug chỉ hiện sau v0.6.15 (lật hết trang phân trang → list lớn).",
      "FIX extension (runner.ts + api.ts): upsert từng chunk với isFullSync:false (KHÔNG reconcile), rồi 1 request cuối (members rỗng) truyền reconcileEmails = TẤT CẢ email đã scrape + reconcilePendingEmails + scrapedStatuses → backend reconcile/rogue 1 lần trên toàn bộ. Scrape rỗng (0 member) → skip reconcile, tránh xoá oan cả team.",
      "FIX backend (schemas.py + members/reconcile.py): MemberBulkUpsert thêm reconcile_emails/reconcile_pending_emails; reconcile dùng các list này làm tập 'đã scrape' (fallback body.members khi None). Test: tests/test_bulk_upsert_chunked_reconcile.py.",
    ],
  },
  {
    version: "0.7.16",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "XOÁ thành viên: tìm item menu + nút xác nhận BỀN hơn — quét rộng role (menuitem/menuitemradio/option/button trong [role=menu]) thay vì chỉ [role=menuitem], nút xác nhận quét cả [role=dialog]/[role=alertdialog]. Khi fail thì error_message in luôn các item/nút THẬT đang thấy để pinpoint. Fix tiếp 'Menu mở nhưng không có item Remove' dù v0.7.14 đã thêm nhãn 'Loại bỏ thành viên'.",
    details: [
      "USER REPORT: sau v0.7.14 (thêm nhãn 'Loại bỏ thành viên') task REMOVE_MEMBER VẪN fail 'UI_ELEMENT_NOT_FOUND: Menu mở nhưng không có item Remove' (saptv2019, nguyenthihieuhp82, caothuy031025, dthh110483...). User mô tả đúng flow: ấn 'Loại bỏ thành viên' → popup → ấn nút đỏ 'Xóa' (bỏ qua 'Hủy bỏ').",
      "ROOT CAUSE: execute-remove dò item bằng queryByText('[role=menuitem]', t) — CHỈ quét role=menuitem. ChatGPT (Radix UI) render item xoá có thể là menuitemradio/option/button trong [role=menu], KHÔNG phải menuitem thuần → dù nhãn 'Loại bỏ thành viên' đã có trong fallback vẫn không có element nào khớp selector → waitFor 5s timeout. (change-license-type đã quét rộng role nên không dính lỗi này.)",
      "FIX 1 (menu item): openMenuItems() quét '[role=menu] [role=menuitem], [role=menu] [role=menuitemradio], [role=menu] [role=option], [role=menu] button, [role=menuitem], [role=menuitemradio], [role=option]'. findMenuItemByText match substring sau normalize trên TẤT CẢ phần tử đó.",
      "FIX 2 (confirm button): findConfirmRemoveButton quét '[role=dialog] button, [role=alertdialog] button, button', match CHÍNH XÁC hoặc startsWith nhãn ('Xóa'/'Remove'/…) để KHÔNG dính nút 'Hủy bỏ'.",
      "FIX 3 (diagnostic): fail item → error_message in JSON các item menu thật (rỗng = menu không mở = lỗi nút '...'; có item = sai text/role). Fail confirm → in các nút trong dialog. Hết đoán mò.",
      "FIX 4 (🔴 SELF-HEAL CHẾT — vì sao các bản fix trước test nhầm code cũ): isExtensionStale() chỉ phát hiện build mới qua 404 của file content-script CŨ. Nhưng vite.config để emptyOutDir:false (giữ file cũ) → file cũ không bao giờ 404 → isExtensionStale luôn false → extension KHÔNG BAO GIỜ tự reload sau npm run build → mỗi bản fix phải reload tay, user test nhầm code cũ nhiều vòng. FIX: isExtensionStale đọc thêm manifest.json TRÊN ĐĨA (cache:no-store) và so content_scripts với manifest trong RAM — khác = build mới = reload. Guard sig/count cũ chống loop nguyên vẹn.",
      "File đổi: apps/extension/src/content/actions/remove/execute-remove.ts, apps/extension/src/background/runner.ts (isExtensionStale 2 tầng), version.ts. Docs: actions/remove/README.md, docs/Extension_Runtime/Self_Heal_Stale_Build.md.",
    ],
  },
  {
    version: "0.7.15",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "Giảm thời gian chờ F5 khi verify lời mời đang chờ xử lý xuống ~10s. Phase 2 không còn ngủ cố định 2.5s + retry [0,3s,6s] (tổng ~11.5s); thay bằng: render xong → kiểm tra → nếu chưa thấy email thì F5 reload THẬT ngay, lặp trong ngân sách 10s.",
    details: [
      "USER REQUEST (2026-06-17): 'giảm thời gian chờ F5 lúc verify pending xuống còn 10s — chuyển sang tab Lời mời, render xong mà không thấy email cần tìm thì F5 reload luôn.'",
      "TRƯỚC: execute-verify-pending ngủ cố định sleep(2500) rồi vòng retry nội bộ delays [0,3000,6000]ms (bounce tab Người dùng để ép re-fetch) → ngay cả khi email đã hiện vẫn tốn 2.5s; case index chậm tốn tới ~11.5s.",
      "SAU (content): bỏ sleep cố định + vòng retry. waitForPendingListStable(emails, 4000) trả NGAY khi đủ email hiện trong DOM (fast path sub-second), scrape 1 lần, rồi báo needs_reload_retry nếu còn email chưa thấy. KHÔNG bounce tab (bounce serve React Query cache stale).",
      "SAU (background runner): bọc F5+verify trong vòng lặp ngân sách VERIFY_BUDGET_MS=10s, tối đa MAX_VERIFY_RELOADS=3 vòng. Mỗi vòng = chrome.tabs.reload (F5 THẬT, ép re-fetch từ server) + re-inject + VERIFY_PENDING_INVITE. Dừng sớm khi đủ email / scrape fail / hết budget. waitForTabComplete per-round 20s→15s.",
      "File đổi: apps/extension/src/content/actions/invite/execute-verify-pending.ts, apps/extension/src/background/runner.ts, version.ts. Docs: apps/extension/src/content/actions/invite/README.md.",
    ],
  },
  {
    version: "0.7.14",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "XOÁ thành viên hết fail 'Menu mở nhưng không có item Remove': bổ sung nhãn tiếng Việt thật của ChatGPT — item menu là 'Loại bỏ thành viên' (không phải 'Xoá ...'). Thêm 'Loại bỏ thành viên' / 'Loại bỏ' vào TEXT_FALLBACKS.removeMenuItem + confirmRemoveButton.",
    details: [
      "USER REPORT: task REMOVE_MEMBER (saptv2019@gmail.com) FAILED 'UI_ELEMENT_NOT_FOUND: Menu mở nhưng không có item Remove.' User chỉ rõ: nếu UI tiếng Việt thì text là 'Loại bỏ thành viên'.",
      "ROOT CAUSE: TEXT_FALLBACKS.removeMenuItem CHỈ có 'Remove'/'Remove member'/'Xoá'/'Xóa'/'Xoá khỏi workspace' — KHÔNG có 'Loại bỏ thành viên'. queryByText match theo substring sau normalize; không nhãn nào là substring của 'loại bỏ thành viên' → waitFor 5s không thấy item → fail. (README cũ đã liệt kê 'Loại bỏ thành viên' nhưng code thực tế chưa từng có chuỗi này — doc lệch code.)",
      "FIX: thêm 'Loại bỏ thành viên' + 'Loại bỏ' vào TEXT_FALLBACKS.removeMenuItem (đặt trước các biến thể 'Xoá').",
      "Dialog xác nhận: tiêu đề là 'Loại bỏ thành viên' nhưng nút đỏ xác nhận là 'Xóa' (nút huỷ 'Hủy bỏ') → confirmRemoveButton KHÔNG cần đổi, 'Xóa'/'Xoá' đã phủ sẵn (queryByText chỉ quét <button> nên tiêu đề dialog không match nhầm).",
      "File đổi: apps/extension/src/content/i18n-ui.ts, version.ts. Docs: apps/extension/src/content/actions/remove/README.md.",
    ],
  },
  {
    version: "0.7.13",
    date: "2026-06-17",
    kind: "feature",
    summary:
      "Thu hồi (REVOKE_INVITES) tự fallback sang XOÁ: nếu email cần thu hồi KHÔNG còn trên tab 'Lời mời đang chờ xử lý' (thường vì người đó đã chấp nhận lời mời → thành member active), extension tự chuyển sang tab 'Người dùng', tìm và xoá họ khỏi workspace thay vì báo fail.",
    details: [
      "USER REPORT: 'khi đang chờ tham gia cũng chưa có hành động thu hồi; nếu ấn thu hồi mà search email không có thì cần chuyển sang tab người dùng, tìm và xoá người dùng đó khỏi workspace'.",
      "ROOT CAUSE: revokeInvite chỉ tìm row trên tab 'Lời mời'. Khi invite đã được chấp nhận, email rời tab pending → 'Row không tìm thấy' → fail, không có hành động tiếp.",
      "FIX: revoke-invite.ts gắn cờ notInPending khi scroll-scan hết list mà không thấy row. execute-revoke-batch.ts sau vòng revoke gom các email notInPending, gọi executeRemove (tự click tab 'Người dùng' + lọc/lật trang + confirm + verify) để xoá khỏi workspace. Kết quả gắn viaRemove=true.",
      "Backend KHÔNG đổi: completion.py đã mark mọi email trong payload REVOKE_INVITES (pending|active) thành 'removed' khi task COMPLETED → cả invite thu hồi lẫn member bị xoá fallback đều đồng bộ đúng.",
      "File đổi: apps/extension/src/content/actions/revoke/revoke-invite.ts, execute-revoke-batch.ts, version.ts. Docs: apps/extension/src/content/actions/revoke/README.md.",
    ],
  },
  {
    version: "0.7.12",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "INVITE không còn kẹt 5 phút: thêm hard-timeout 60s cho vòng VERIFY Phase 2 (trước đây KHÔNG có timeout → content treo = SW chờ vô hạn → task IN_PROGRESS tới lazy-cleanup backend 5 phút). Vượt 60s → coi verify scrape failed (giữ pending, SYNC_DATA reconcile sau) → task COMPLETED ngay.",
    details: [
      "USER REPORT: 'mời đang lỗi, 1 mời đến tận 5 phút'. Dữ liệu thật: invite COMPLETED bình thường ~28-44s, nhưng 3 invite gần nhất kẹt 339-396s — 2 cái TIMEOUT (kẹt phase 'submit-done', SW không trả kết quả) + 1 VERIFY_FAILED chạy thật 396s.",
      "ROOT CAUSE: chrome.tabs.sendMessage(VERIFY_PENDING_INVITE) ở runner Phase 2 KHÔNG bọc timeout. Verify scrape chậm/treo (ChatGPT index pending 1-5s, retry [0,3000,6000] + nhiều pass scrape, cap nội bộ 60s/scrape) → round-trip có thể kéo vài phút hoặc treo tới khi SW chết → backend lazy-cleanup mới dọn (STUCK_THRESHOLD).",
      "FIX: helper withTimeout() bọc verify round-trip, cap VERIFY_ROUNDTRIP_TIMEOUT_MS=60s. Vượt → reject → rơi vào catch sẵn có → response verify_scrape_failed=true → reportToBackend mark COMPLETED (KHÔNG dọn phantom vì scrape coi như fail, giữ record pending). 60s < ngưỡng treo invite backend (3 phút) nên SW còn sống luôn tự kết thúc trước, không bị TIMEOUT oan.",
      "BACKEND đi kèm: execution.py STUCK_THRESHOLD 5 phút cứng → per-type (invite/remove/role/revoke 3 phút, sync_billing 4, sync_data/harvest 6, purchase 8) — task UI chết được dọn nhanh, task dài không bị auto-fail oan (tồn đọng #4 execution.md).",
      "File đổi: apps/extension/src/background/runner.ts (withTimeout + bọc verify), version.ts. Backend: apps/api/app/routers/queue/execution.py. Docs: docs/Workspace_Management/Invite_Member.md, execution.md.",
    ],
  },
  {
    version: "0.7.11",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "Scrape ngày renew thêm fallback dạng ĐƠN (vd 'gia hạn vào 11 thg 7, 2026' / 'Renews on Jul 11, 2026'). Trước đây chỉ bắt dạng KHOẢNG '11 thg 5 - 11 thg 6' → 1 số plan renewal về null → dashboard giá '—' dù sync OK.",
    details: [
      "USER REPORT: workspace synced OK, 8 hoá đơn paid, nhưng 'Giá 1 slot hôm nay' + 'Giá full month' + 'Ngày renew' đều '—' vì renewal_date = null.",
      "ROOT CAUSE: parseRenewalDateVi chỉ match VI_MONTH_RE / ZH_MONTH_RE (dạng khoảng X - Y). Plan hiển thị renew dạng ngày đơn không khớp → null → computeTodayPerSlotPrice thoát sớm note 'no_renewal_date'.",
      "FIX: thêm parseRenewalSingleDate — neo theo từ khoá (gia hạn|renew|next billing/payment|续订|下次…) rồi bắt 1 ngày đơn (vi/en/zh, year optional, suy năm = tương lai gần nhất) trong cửa sổ ~80 ký tự. Range vẫn ưu tiên trước.",
      "DIAGNOSTIC: logBillingDiagnostic khi renewal=null giờ dump renewal_context (text quanh từ khoá) + date_tokens → nếu vẫn miss, 1 dòng SW console là đủ hoàn thiện regex.",
      "File đổi: apps/extension/src/content/scrapers/billing.ts, .../sync-billing/log-diagnostic.ts, version.ts.",
    ],
  },
  {
    version: "0.7.10",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "Self-heal stale build reload NGAY khi rebuild, KỂ CẢ lúc rảnh (bỏ gate pending>0). Mỗi `npm run build` tự áp build mới trong ≤1 phút mà không cần reload tay chrome://extensions.",
    details: [
      "USER REPORT: sau khi rebuild extension, task SYNC_BILLING bị TIMEOUT 5 phút (IN_PROGRESS 301s) — SW stale claim task rồi bị reload/kill giữa chừng → backend không ai báo → lazy-cleanup auto-fail.",
      "ROOT CAUSE: gate v0.7.5 `countPendingTasks() > 0` mới self-heal → lúc rảnh build stale KHÔNG tự reload; task PENDING đầu tiên tới có thể bị SW stale claim trước khi heal → mồ côi → TIMEOUT.",
      "FIX: bỏ gate pending>0 trong selfHealIfStale + doRunUntilIdle — hễ isExtensionStale() = true thì reloadForStaleBuild() ngay, kể cả lúc rảnh. Chống loop GIỮ NGUYÊN bằng sig-dedup (MAX_RELOADS_PER_SIG lần/build): mỗi build = 1 sig mới = reload 1 lần.",
      "TRADEOFF: có thể thoáng bật chrome://extensions + mở lại tab ChatGPT lúc rảnh sau mỗi build — chấp nhận để 'update tự áp dụng'. Khi đang dev nên dùng `npm run dev` (CRXJS HMR) — file dev-server luôn tồn tại nên không bị coi là stale, self-heal không xen vào.",
      "File đổi: apps/extension/src/background/runner.ts (bỏ countPendingTasks gate), version.ts. Docs: docs/Extension_Runtime/Self_Heal_Stale_Build.md.",
    ],
  },
  {
    version: "0.7.9",
    date: "2026-06-16",
    kind: "chore",
    summary:
      "Giảm 30% thời gian chờ giữa 2 task: betweenTasksMs 1200→840ms. Throughput tăng ~30% khi chạy nhiều task liên tiếp (invite/role/remove…).",
    details: [
      "RATE_LIMIT.betweenTasksMs: 1200 → 840 (-30%). Đây là min delay giữa 2 task BẤT KỲ trong runner (applyRateLimit), chống ChatGPT nghi bot. Lịch sử: 5000→2000→1200→840.",
      "batchSize (10) + batchPause (6–12s mỗi 10 task) GIỮ NGUYÊN — chỉ giảm nhịp chờ giữa từng task.",
      "Lưu ý: 3 setting workspace rate_limit_invite_ms/role_ms/remove_ms trong UI Settings hiện KHÔNG được code execute đọc (dead config) — tốc độ thực tế do RATE_LIMIT này quyết định, không phải 3 số đó.",
    ],
  },
  {
    version: "0.7.8",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "STALE_BUILD: phát hiện build cũ NGAY trước khi inject → bỏ 3 step executeScript chắc-chắn-fail (~23s + phá tab) → mark task FAILED rõ ràng rồi tự reload extension. Guard count-based cho thêm 1 lần reload khi Chrome chậm nạp build (hết kẹt CONTENT_NOT_INJECTED vĩnh viễn)",
    details: [
      "USER REPORT: task fail CONTENT_NOT_INJECTED, diag 'Could not load file: assets/index.ts-loader-CycUqvAL.js' — cả 3 step fallback (executeScript / reload tab / recreate tab) đều THREW 'Could not load file', tốn ~23s rồi give up. Kèm theo: toggle 'mời ngoài tên miền' không tự bật — thực ra là HỆ QUẢ (content script chưa hề inject thì executeInvite/setExternalInvites không chạy), KHÔNG phải bug riêng.",
      "ROOT CAUSE 1 (3 step vô ích): manifest đang chạy trỏ file content-script đã bị xoá khỏi đĩa (rebuild đổi hash, Chrome chưa reload). Cả 3 step trong ensureContentInjected đều dùng chrome.scripting.executeScript({files}) với CHÍNH file đã mất → luôn THREW 'Could not load file'. 3 step chỉ reload TAB, không bao giờ reload EXTENSION → về bản chất không thể chữa stale build, chỉ phí thời gian + phá tab user (Step 3 NUCLEAR).",
      "ROOT CAUSE 2 (self-heal kẹt): guard v0.7.5 chặn CỨNG sau đúng 1 reload/sig (lastSig===sig → không reload nữa). Nếu chrome.runtime.reload() lần đầu KHÔNG kéo được build mới vào (Chrome chậm áp dụng unpacked build) → manifest kẹt hash cũ → sig không đổi → guard chặn vĩnh viễn → mọi task fail tới khi reload tay. Guard nhầm 'đã reload 1 lần' = 'build hỏng' trong khi đĩa có build tốt.",
      "FIX 1 (ensureContentInjected): sau initial ping fail → check isExtensionStale() NGAY. Nếu stale → bỏ qua hẳn 3 step executeScript (chắc chắn fail), return {stale:true}. Tiết kiệm ~23s + không phá tab user.",
      "FIX 2 (sendToContent + runOnce): stale → error_code MỚI 'STALE_BUILD' (tách khỏi CONTENT_NOT_INJECTED). runOnce reportToBackend mark task FAILED (immediate, KHÔNG kẹt 5 phút chờ lazy-cleanup TIMEOUT) RỒI mới reloadForStaleBuild() → SW restart, task kế chạy bình thường không cần user reload tay.",
      "FIX 3 (reloadForStaleBuild + guard count-based): tách logic reload ra hàm riêng dùng chung cho selfHealIfStale (đầu drain) + runOnce. Thay guard 'chặn cứng sau 1 lần' bằng đếm STALE_RELOAD_COUNT_KEY: cho phép tối đa MAX_RELOADS_PER_SIG=2 reload/sig rồi mới bỏ cuộc → Chrome chậm nạp build vẫn được thử lại 1 lần, nhưng build hỏng thật vẫn bound (không loop vô hạn). sig đổi → count reset.",
      "File đổi: background/runner.ts (reloadForStaleBuild + STALE_RELOAD_COUNT_KEY/MAX_RELOADS_PER_SIG + stale short-circuit trong ensureContentInjected + map STALE_BUILD trong sendToContent + trigger reload trong runOnce), shared/messages.ts (+error_code STALE_BUILD).",
    ],
  },
  {
    version: "0.7.7",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "Định vị member khi đổi giấy phép/xoá: thử lọc cả full email + log [autogpt-locate] để debug 'không tìm thấy email'",
    details: [
      "USER: sau khi nạp bản mới, đổi seat hết lỗi inject (self-heal v0.7.4+) nhưng báo UI_ELEMENT_NOT_FOUND 'Không tìm thấy <email> sau khi lọc + lật mọi trang'.",
      "filterAndFindRow (dùng chung REMOVE + CHANGE_LICENSE_TYPE): trước chỉ gõ local-part vào ô lọc. Giờ thử local-part RỒI full email (giống user gõ tay) — humanType tự clear nên gọi lại an toàn.",
      "Thêm log [autogpt-locate]: ô lọc tìm thấy chưa (+placeholder), số row hiển thị sau mỗi lần lọc, thấy/không thấy row, vào nhánh lật trang + thấy ở trang mấy → đọc console biết chính xác bước nào trượt.",
      "Web: hiển thị tiến trình task (đổi giấy phép/xoá/đổi vai trò) ngay trên trang Thành viên dashboard.",
      "File đổi: remove/member-filter.ts, remove/locate-member.ts; web Members.tsx.",
    ],
  },
  {
    version: "0.7.5",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "SELF-HEAL chỉ pop chrome://extensions khi extension THỰC SỰ có build mới (guard theo chữ ký build) + chỉ khi có task PENDING — hết cảnh tự reload + mở tab ChatGPT lặp lại lúc rảnh",
    details: [
      "USER REPORT: extension đang chạy trên tab ChatGPT của user, rồi tự bật chrome://extensions, xong tự mở thêm 1 tab ChatGPT khác — lặp lại rất khó chịu. Yêu cầu: chỉ pop chrome://extensions khi extension thực sự có thay đổi.",
      "ROOT CAUSE: self-heal (v0.7.4) chạy ở đầu doRunUntilIdle nên kích hoạt ở MỌI nhịp drain (poll 5s SSE + alarm 1 phút) kể cả lúc rảnh. Guard cũ dùng TIMESTAMP 15s: nếu build cứ stale thì cứ mỗi 15s lại chrome.runtime.reload() → Chrome bật chrome://extensions + SW boot lại mở tab ChatGPT → pop lặp vô hạn dù build KHÔNG đổi gì thêm.",
      "FIX 1 — guard theo CHỮ KÝ BUILD (manifestBuildSig: danh sách file content-script kèm hash trong manifest). Thay STALE_RELOAD_KEY (timestamp) bằng STALE_RELOAD_SIG_KEY (sig). Chỉ chrome.runtime.reload() khi sig KHÁC sig đã reload lần trước = đĩa có build MỚI thật sự → pop ĐÚNG 1 LẦN cho mỗi build. Nếu vẫn stale với cùng sig (Chrome chưa nạp / build hỏng) → log lỗi, KHÔNG reload lại → hết loop pop.",
      "FIX 2 — gate bằng countPendingTasks() trong doRunUntilIdle: chỉ self-heal khi isExtensionStale() VÀ có ≥1 task PENDING. Rảnh (0 task) thì im lặng, không pop, không mở tab thừa. isExtensionStale() (fetch file local) check trước nên case bình thường không tốn request mạng.",
      "Giữ nguyên khả năng tự phục hồi: build stale + có task chờ → vẫn tự reload đúng như v0.7.4 (không quay lại bug CONTENT_NOT_INJECTED), nhưng giờ tối đa 1 pop cho mỗi build mới.",
      "File đổi: background/runner.ts (manifestBuildSig + guard sig trong selfHealIfStale + import countPendingTasks + gate trong doRunUntilIdle).",
    ],
  },
  {
    version: "0.7.4",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "SELF-HEAL: SW tự chrome.runtime.reload() khi phát hiện manifest trỏ file đã bị xoá (rebuild) — KHÔNG còn phải reload tay ở chrome://extensions, fix gốc CONTENT_NOT_INJECTED",
    details: [
      "USER REPORT: task CHANGE_LICENSE_TYPE fail CONTENT_NOT_INJECTED, diag: 'Could not load file: assets/index.ts-loader-D8UHvaps.js'. Manifest SW đang chạy trỏ hash CŨ (D8UHvaps) trong khi đĩa đã rebuild ra hash MỚI (CCL10K53) + file cũ bị xoá → cả auto-injection lẫn 3 step executeScript fallback đều 'Could not load file'.",
      "ROOT CAUSE (mọi lần vá trước — v0.4.17/0.4.18/0.6.3/0.6.7 — đều xử lý phần ngọn): sau `vite build` Chrome KHÔNG tự reload extension unpacked → service worker giữ manifest cũ trong RAM, trỏ tới file content-script đã bị xoá. Mọi task fail tới khi user bấm reload ở chrome://extensions.",
      "FIX (runner.ts): thêm isExtensionStale() — fetch từng file js mà manifest tham chiếu qua chrome.runtime.getURL; file 404 = stale build. selfHealIfStale() gọi chrome.runtime.reload() để Chrome đọc lại manifest+file MỚI từ đĩa (extension unpacked), tự sửa hash. Guard 15s (timestamp trong chrome.storage.local, sống sót qua reload) chống loop nếu build thật sự thiếu file.",
      "Đặt ở ĐẦU doRunUntilIdle — 1 điểm chặn duy nhất mà mọi đường drain (SSE task-available, SSE poll 5s, alarm backup 1 phút, popup run-pending, boot SW) đều đi qua, và chạy TRƯỚC pickNextTask nên không task nào bị claim rồi bỏ dở khi SW restart.",
      "KẾT QUẢ: sau khi rebuild extension, lần drain kế tiếp (≤5s nếu SSE connected, ≤1 phút qua alarm) SW tự reload → task chạy tiếp tự động. KHÔNG cần thao tác chrome://extensions thủ công nữa.",
      "File đổi: background/runner.ts (isExtensionStale + selfHealIfStale + chèn vào doRunUntilIdle).",
    ],
  },
  {
    version: "0.7.3",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "Đổi giấy phép: LỌC THEO TÊN bằng email trước khi bấm '...' (như REMOVE) — fix không đổi được trên list 100+ member phân trang",
    details: [
      "USER chỉ rõ thao tác: tab Người dùng → 'Lọc theo tên' → nhập email → bấm '...' → 'Thay đổi loại giấy phép' → ChatGPT/Codex.",
      "ROOT CAUSE: v0.7.0–0.7.2 gọi findMemberRow(email) thẳng trên DOM. List 108 member phân trang (5 trang × 25 row ảo) → row cần đổi thường KHÔNG nằm trong viewport → findMemberRow null → task FAILED, ChatGPT không đổi gì.",
      "FIX: executeChangeLicenseType tái dùng locateMemberRow + clearMemberFilter của REMOVE: clickTabAndWait('tab_active_members') → lọc theo email (zoom còn 1 row) → bấm '...' → chọn ChatGPT/Codex → clear filter. Giữ log [autogpt-license] + dump menu + xử lý submenu + dialog xác nhận của v0.7.2.",
      "File đổi: change-license-type/execute-change-license-type.ts (import locate-member + member-filter từ ../remove, clickTabAndWait từ ../sync).",
    ],
  },
  {
    version: "0.7.2",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "CHANGE_LICENSE_TYPE: log chi tiết + dump menu items + xử lý submenu (hover/pointer/ArrowRight) + dialog xác nhận — debug 'đổi giấy phép không ăn'",
    details: [
      "USER REPORT: scrape license đã OK nhưng đổi giấy phép không tác động lên ChatGPT (UI đang English).",
      "execute-change-license-type viết lại: console.log từng bước (prefix [autogpt-license]) + dumpOpenMenus() in text mọi menu item đang mở → biết chính xác menu '...' chứa gì.",
      "openSubmenu(): mở submenu 'Change license type' bằng nhiều cách — pointerover/pointerenter/mouseover/mousemove + focus + phím ArrowRight + click (Radix Menu.Sub mở theo pointer/keyboard, không chỉ click).",
      "findConfirmButton(): nếu ChatGPT bật dialog xác nhận sau khi chọn → tự click nút Change/Confirm/Switch/Đổi/Xác nhận.",
      "Nếu vẫn fail: error_message hướng dẫn xem console [autogpt-license] để lấy danh sách menu items thật.",
      "File đổi: change-license-type/execute-change-license-type.ts.",
    ],
  },
  {
    version: "0.7.1",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "Scrape license_type mạnh hơn — bắt được cả khi 'ChatGPT/Codex' nằm trong nút/dropdown (kèm mũi tên), không chỉ text thuần",
    details: [
      "USER REPORT: dashboard cột 'Giấy phép' trống dù tab Người dùng trên ChatGPT có hiển thị loại giấy phép.",
      "Nguyên nhân: findLicenseTypeInRow v0.7.0 chỉ match element LÁ có text ĐÚNG y hệt 'ChatGPT'/'Codex'. UI thật render trong button/dropdown (đổi được) nên text kèm mũi tên '▾' hoặc icon → không phải lá hoặc không bằng đúng chuỗi → trượt.",
      "Fix: duyệt mọi element, lấy DIRECT TEXT (bỏ text của element con để cô lập nhãn 1 cell), strip caret ▼▾▿⌄⇣ rồi so khớp 'chatgpt'/'codex'. Vẫn tránh false-positive từ email/tên vì direct text của ô email là cả địa chỉ.",
      "Thêm console.warn tối đa 3 row đầu khi không tìm thấy (in row.text rút gọn) để debug DOM nếu vẫn trượt.",
      "Cần SYNC lại workspace sau khi load bản này để điền license_type.",
      "File đổi: row-extractors/license-type.ts.",
    ],
  },
  {
    version: "0.7.0",
    date: "2026-06-15",
    kind: "feature",
    summary:
      "CHANGE_LICENSE_TYPE — đổi loại suất cấp phép (ChatGPT/Codex) của member từ dashboard + scrape license_type khi SYNC",
    details: [
      "USER REQUEST 2026-06-15 (kèm ảnh menu '...' /admin/members): mỗi member có 'Loại suất cấp phép' = ChatGPT | Codex, đổi qua menu '...' → 'Thay đổi loại giấy phép' → ChatGPT/Codex. Cần đưa thông tin này vào dashboard + cho đổi.",
      "Action mới CHANGE_LICENSE_TYPE (mirror CHANGE_ROLE): dashboard (super-admin) chọn ChatGPT/Codex trong dropdown cột 'Giấy phép' → PATCH /workspaces/{id}/members/{mid}/license-type → QueueItem CHANGE_LICENSE_TYPE → SSE → extension thực thi.",
      "execute-change-license-type.ts: findMemberRow(email) → click nút '...' → tìm option ChatGPT/Codex (mở submenu 'Thay đổi loại giấy phép' nếu cần) → click. Bỏ qua nếu old==new.",
      "SYNC_DATA giờ scrape thêm license_type mỗi row (row-extractors/license-type.ts: tìm element lá có text đúng 'ChatGPT'/'Codex', tránh false-positive từ email/tên). bulk-upsert lưu Member.license_type.",
      "Backend: Member.license_type (migration 0014), MemberOut/MemberUpsert + LicenseType schema, queue.update_task sync license_type khi task COMPLETED. Permission tái dùng MEMBER_CHANGE_ROLE.",
      "File đổi: ext messages.ts, i18n-ui.ts, scrape-all-rows.ts, runner.ts, content/index.ts, api.ts, change-license-type/*; api models.py, schemas.py, routers/members.py, routers/queue.py, alembic 0014; web types.ts, Members.tsx, i18n vi/zh-CN.",
    ],
  },
  {
    version: "0.6.19",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "REMOVE member: lật trang + scroll như SYNC để không tìm sót trong list dài (hết kick 'ảo')",
    details: [
      "Bug: trên workspace đông member (list phân trang/virtualized), executeRemove chỉ dựa ô lọc → tìm sót row → báo UI_ELEMENT_NOT_FOUND dù member vẫn còn → backend reconcile nhầm thành 'đã removed' (kick ảo, member thực tế vẫn trong workspace).",
      "locate-member.ts mới: thử ô lọc trước, không thấy thì clear lọc + về trang 1 + lật từng trang + scroll-scan (tái dùng pagination.ts của SYNC) tới khi thấy row hoặc hết trang.",
      "Backend (queue.py): BỎ auto-reconcile UI_ELEMENT_NOT_FOUND→COMPLETED cho REMOVE_MEMBER — không tự đánh dấu removed nữa; task để FAILED, SYNC là nguồn chân lý.",
    ],
  },
  {
    version: "0.6.18",
    date: "2026-06-14",
    kind: "fix",
    summary:
      "Sync bỏ tab 'Yêu cầu đang chờ xử lý' — members=tab Người dùng, invites=tab Lời mời, both=cả 2",
    details: [
      "User yêu cầu: không quét tab 'Yêu cầu đang chờ xử lý' nữa.",
      "execute-sync.ts: bỏ block scrape tab_pending_requests. scope 'invites' giờ CHỈ quét tab 'Lời mời đang chờ xử lý'; 'members' chỉ tab 'Người dùng'; 'both' = cả 2 tab đó.",
    ],
  },
  {
    version: "0.6.17",
    date: "2026-06-14",
    kind: "fix",
    summary:
      "Sync 'Lời mời': verify URL ?tab=invites đã đổi tab mới scrape (hết bug vẫn ở tab Người dùng)",
    details: [
      "User report: đồng bộ 'Lời mời đang chờ xử lý' KHÔNG đổi tab, vẫn ở tab Người dùng → scrape nhầm.",
      "Nguyên nhân: clickTabAndWait chỉ humanClick rồi sleep cố định, KHÔNG kiểm chứng tab đã đổi. humanClick đôi khi không trigger React onClick / match nhầm element → tab không đổi nhưng code vẫn proceed scrape DOM hiện tại.",
      "Fix: clickTabAndWait thêm tham số verifyTabParam. Với tab Lời mời truyền 'tab=invites' → sau click POLL location.search tới khi khớp (tab thực sự đổi); chưa khớp thì RETRY click (tối đa 3 lần); hết retry vẫn sai → return false → execute-sync BỎ QUA, KHÔNG scrape nhầm tab Người dùng.",
      "Tab Người dùng / Yêu cầu giữ hành vi cũ (không truyền verifyTabParam) để không đổi behavior ngoài phạm vi bug.",
      "File đổi: click-tab-and-wait.ts, execute-sync.ts.",
    ],
  },
  {
    version: "0.6.16",
    date: "2026-06-14",
    kind: "fix",
    summary:
      "Verify invite: email KHÔNG có trong tab 'Lời mời' bị GỠ khỏi dashboard (hết phantom 'đang chờ') + bắt buộc bật toggle ngoài-domain mới mời",
    details: [
      "BUG 1 (phantom 'đã add'): sau invite, verify scrape tab 'Lời mời đang chờ xử lý'. Trước đây email KHÔNG xuất hiện trong pending vẫn giữ Member status=pending (backend tạo lúc bấm mời) → dashboard hiển thị 'đang chờ' dù ChatGPT chưa nhận. FIX: runner gọi endpoint mới POST /members/reconcile-after-invite với danh sách unverified → backend mark các Member pending đó = 'removed' (chỉ pending, KHÔNG đụng active). Nếu scrape pending FAIL thì giữ nguyên (tránh xoá oan).",
      "execute-verify-pending.ts không còn early-return ok:false khi 0 verified — luôn trả verified/unverified cho runner. Runner quyết định: 0 verified + scrape OK → task FAILED (VERIFY_FAILED) SAU khi đã dọn phantom; có verified → COMPLETED.",
      "BUG 2 (toggle ngoài-domain): khi có email ngoài domain xác minh, BẮT BUỘC bật toggle 'Cho phép lời mời ngoài tên miền' và XÁC NHẬN state=ON trước khi mời. setExternalInvites() trả thêm `confirmed`. Nếu không xác nhận được ON (không thấy toggle / click không ăn) → execute-invite return FAIL EXTERNAL_TOGGLE_FAILED, KHÔNG submit (tránh ChatGPT từ chối silently → phantom). Sau invite vẫn force OFF như cũ.",
      "EXTERNAL_TOGGLE_FAILED cũng kích hoạt reconcile dọn phantom (vì chưa hề submit invite).",
      "File đổi: api/routers/members.py (+reconcile-after-invite), api/schemas.py (InviteVerifyReconcileIn), ext set-toggle.ts (confirmed), execute-invite.ts (fail-on-toggle + force OFF), execute-verify-pending.ts (luôn ok:true), runner.ts (reconcile + status), shared/api.ts (reconcileAfterInvite).",
    ],
  },
  {
    version: "0.6.15",
    date: "2026-06-09",
    kind: "fix",
    summary: "Pagination sync: lật hết mọi trang (3/5, 10/10…), không cố định 2 trang",
    details: [
      "Loop while hasMorePages() — mỗi vòng đọc lại indicator N/M từ DOM (total có thể > 2).",
      "goToFirstPage() guard tăng tới 200 — kể cả user đang ở trang cuối.",
      "visitedPages Set chống loop; waitForPageAdvance(from) thay vì hard-code page+1.",
    ],
  },
  {
    version: "0.6.14",
    date: "2026-06-09",
    kind: "fix",
    summary: "SYNC_DATA lật từng trang khi ChatGPT admin members có phân trang (vd 1/2)",
    details: [
      "Symptom: danh sách Người dùng ChatGPT > ~1 trang (pagination '1 / 2') nhưng extension chỉ scrape trang hiện tại → dashboard thiếu member.",
      "Fix: pagination.ts detect indicator N/M + nút prev/next, goToFirstPage() rồi scrape + clickNextPage() lần lượt tới hết.",
      "Fallback: nếu không có pagination → giữ scroll-until-loaded như cũ (virtualized list 1 trang dài).",
    ],
  },
  {
    version: "0.6.13",
    date: "2026-05-21",
    kind: "chore",
    summary: "Mỗi action có README.md riêng kèm code — AI mở folder action là đọc được logic + history; user sửa dễ",
    details: [
      "Move 9 file Logic_<action>.md từ docs/Extension_Refactor/ (gitignored) vào apps/extension/src/content/actions/<action>/README.md (tracked trong source tree).",
      "Mục đích: (1) AI khi navigate vào folder action thấy README ngay → context đầy đủ về logic/flow/history mà không phải tìm doc folder riêng; (2) user sửa doc cạnh code, không phải nhảy file xa.",
      "Thêm apps/extension/src/content/actions/README.md làm index 9 actions + quy tắc code structure pattern cho người mới.",
      "Path trong README đã fix relative để link đúng từ vị trí mới: refs tới ../human.ts, ../../../shared/, ../<other-action>/README.md, ../../../../../web/src/... và ../../../../../api/app/...",
      "QUY TẮC MỚI: mỗi action PHẢI có README.md kế bên code, mỗi bug fix PHẢI append entry vào section 'Lịch sử sửa lỗi' của README tương ứng — không chỉ JSDoc trong code.",
      "KHÔNG đổi behavior code — chỉ thêm 10 file .md.",
    ],
  },
  {
    version: "0.6.12",
    date: "2026-05-20",
    kind: "chore",
    summary: "Refactor (Pha 0): chuẩn bị tách action mỗi hàm 1 file riêng — chưa đổi behavior",
    details: [
      "Tạo branch refactor/extension-actions-split để chia nhỏ các file actions/*.ts đang quá fat (invite 802 dòng, purchase-seat 894 dòng, harvest-labels 738 dòng, sync 648 dòng).",
      "Kế hoạch chi tiết tại docs/Extension_Refactor/Plan_Split_Actions_Per_File.md (gitignored, local-only).",
      "Mục tiêu: mỗi action thành 1 folder, mỗi hàm public 1 file riêng, helper theo concern (finders/, pages/, modal1/, modal2/, row-extractors/). Tổng ~58 file mới thay cho 10 file fat.",
      "QUY TẮC PHA REFACTOR: PURE FILE-SPLIT, KHÔNG đổi logic/behavior. JSDoc copy nguyên si để giữ context lịch sử (v0.6.4 vì sao bỏ scrapedStatuses, v0.6.6 vì sao force OFF, ...).",
      "Public API contract giữ nguyên qua barrel index.ts mỗi folder — content/index.ts dispatcher chỉ đổi 1 import (./actions/revoke-invites-batch → ./actions/revoke).",
      "9 pha tiếp theo (1 commit/pha): change-role+revoke → external-invites → remove+sync-billing → sync → invite → purchase-seat → harvest-labels → smoke test.",
      "Pha 0 này CHƯA tách file nào — chỉ bump version + ghi entry CHANGELOG để các pha sau có baseline rõ ràng.",
    ],
  },
  {
    version: "0.6.11",
    date: "2026-05-20",
    kind: "fix",
    summary: "REMOVE_MEMBER: search qua ô 'Lọc theo tên' trước khi mở menu '...' → 'Loại bỏ thành viên' — fix miss row khi list dài",
    details: [
      "USER REQUEST 2026-05-20 (kèm ảnh ChatGPT /admin/members tab Người dùng): 'khi thực hiện xóa bất kì user nào thì tìm kiếm người dùng xong rồi thực hiện xóa loại bỏ thành viên'. Ảnh tham chiếu thứ 2 cho thấy menu '...' mở ra hiển thị 'Thay đổi loại giấy phép' + 'Loại bỏ thành viên' (đỏ).",
      "ROOT CAUSE: executeRemove cũ chỉ gọi findMemberRow(email) trên DOM hiện tại. Khi workspace > 50 member, row cần xoá có thể chưa scroll vào viewport (ChatGPT virtualize list) → trả null → UI_ELEMENT_NOT_FOUND. User phải tự cuộn tới row trước khi extension chạy được.",
      "FIX (remove.ts executeRemove): thêm 2 bước trước flow cũ:",
      "  1. clickTabAndWait('tab_active_members') — đảm bảo đang ở tab Người dùng (REMOVE chỉ làm được trên active list, không phải tab Lời mời/Yêu cầu). Best-effort, không fail nếu tab button không có.",
      "  2. filterAndFindRow(email) — type local-part email (phần trước '@') vào input 'Lọc theo tên' → đợi ChatGPT debounce filter (~600ms) → waitFor row khớp tới 4s. Filter zoom thẳng vào 1 row duy nhất, KHÔNG cần scroll.",
      "Sau khi xoá xong verify (member biến mất khỏi list đã filter), CLEAR filter input để list về full state (user mở tab admin lên thấy toàn bộ member, không bị stuck ở state filter '@yaakovajax0054' chẳng hạn).",
      "Selector mới `SELECTORS.memberFilterInput`: input[type='search'] + placeholder/aria-label 'Lọc'/'Filter'/'筛选'/'过滤' (vi/en/zh). Fallback theo placeholder attribute vì ChatGPT chưa có data-testid trên input này.",
      "Tại sao type local-part chứ không full email: ChatGPT filter match trên cả tên + email; dùng prefix 'yaakovajax0054' đủ unique mà tránh case input có maxlength giới hạn ký tự đặc biệt ('@' / '.').",
      "Fallback (nếu không tìm được filter input — vd UI mới đổi): rơi về scroll-find cũ (findMemberRow trực tiếp). KHÔNG hard-fail vì có thể workspace nhỏ < 10 member thì filter không xuất hiện.",
      "File đã đổi: selectors.ts (thêm memberFilterInput), remove.ts (filterAndFindRow + clearMemberFilter + tab navigate).",
    ],
  },
  {
    version: "0.6.10",
    date: "2026-05-20",
    kind: "chore",
    summary: "Bỏ nút ↻ sync billing trong popup — dashboard 'Cập nhật giá & ngày renew' là single source of truth, popup tự refresh khi task xong",
    details: [
      "USER REQUEST 2026-05-20: 'bỏ cái mũi tên sync billing đi, từ giờ chạy ở dashboard lệnh cập nhật giá thì cũng update cả extension luôn'.",
      "Bối cảnh: popup có 2 chỗ trigger SYNC_BILLING — (a) nút ↻ bên cạnh 'Plan/Seat' trong popup (thêm ở v0.4.16), (b) nút 'Cập nhật giá & ngày renew' trong dashboard (WorkspaceLayout). Cả 2 đều tạo cùng QueueItem type=SYNC_BILLING → trùng UX.",
      "Decision: xoá nút popup, giữ nút dashboard. Popup ĐÃ có sẵn auto-refresh useEffect (v0.4.16, App.tsx:74-101) detect khi SYNC_BILLING terminal COMPLETED → re-fetch whoami → popup hiển thị seat mới. Logic này hoạt động bất kể task được trigger từ đâu (popup hay dashboard) — chỉ cần xoá nút popup, không cần đổi logic auto-refresh.",
      "FILES đã xoá:",
      "  • popup/App.tsx: nút ↻ + state `syncingBilling` + handler `onSyncBilling` + import `triggerSyncBilling`",
      "  • shared/api.ts: hàm `triggerSyncBilling` (chỉ popup dùng)",
      "  • i18n vi.json + zh-CN.json: key `popup.syncBillingTooltip` (chỉ popup dùng)",
      "  • Backend queue.py: endpoint POST /api/v1/queue/sync-billing (chỉ extension dùng)",
      "Flow MỚI: user click 'Cập nhật giá & ngày renew' trên dashboard → POST /workspaces/{id}/sync-billing → task PENDING → SSE → extension scrape → task COMPLETED → DB update + popup polling fetchActiveTask 1.5s → thấy recent_completed.type=SYNC_BILLING → re-fetch whoami → popup hiển thị seat mới (≤ 2-3s sau khi task xong).",
      "Không có functional regression: nếu popup ĐÓNG khi task chạy, lần mở sau verify(config) trên mount sẽ fetch whoami → seat mới tự xuất hiện.",
    ],
  },
  {
    version: "0.6.7",
    date: "2026-05-20",
    kind: "fix",
    summary: "CONTENT_NOT_INJECTED: propagate diag step-by-step vào error_message — dashboard hiển thị thẳng step nào fail",
    details: [
      "USER REPORT: liên tục 5+ task fail với CONTENT_NOT_INJECTED (INVITE/SYNC_DATA/REVOKE_INVITES). Error message generic: 'Tab chatgpt.com/admin không thể inject content script sau 3 bước fallback' — KHÔNG nói step nào fail, vì sao fail. User mù → phải mở chrome://extensions/ → Service Worker → DevTools mới biết.",
      "ROOT CAUSE visibility: ensureContentInjected chỉ console.warn từng step nội bộ, không truyền lý do ra ngoài. 3 step thử inject (executeScript / tabs.reload / tabs.remove+create) đều có thể fail vì nhiều lý do khác nhau (tab redirect khỏi /admin, executeScript permission, ping timeout, ChatGPT logout giữa chừng, ...) — message generic không phân biệt được.",
      "FIX (runner.ts ensureContentInjected): thêm array `diag: string[]` collect 1 dòng mỗi event (ping attempt, executeScript resolve/throw, tabs.reload result, tab URL sau mỗi bước). Mỗi dòng có prefix `+{elapsed}ms` để thấy timing. Return type đổi `{ok, tabId}` → `{ok, tabId, diag}`. KHÔNG đổi logic 3 step.",
      "FIX (sendToContent): khi !ready.ok → append `\\n\\nChi tiết từng bước:\\n{diag.join('\\n')}` vào error_message. Dashboard hiển thị toàn bộ trace — biết ngay step nào fail.",
      "Diag bao gồm: tab state snapshot ban đầu (url + status), kết quả mỗi executeScript (resolved / THREW + message), URL sau mỗi tabs.reload + tabs.create, ping retry count cụ thể, abort reasons.",
      "Ví dụ output mới (FAILED task): 'Cách khắc phục: (1) F5 tab, (2) reload extension, (3) cùng browser+login. Chi tiết: +0ms tab 123 state: status=complete url=https://chatgpt.com/auth/login | +15ms initial ping fail | +20ms ⚠ tab URL không chứa /admin — có thể đã logout/redirect | ...'",
      "Hành động đề xuất user (sau khi update): chạy 1 task SYNC_DATA test, nếu vẫn fail thì copy diag vào issue — sẽ biết chính xác problem để fix dứt điểm (vs guess như 5 lần trước).",
      "Khả năng cao root cause hiện tại: ChatGPT tab đã logout giữa chừng (session expired) → tab.url=/auth/login → 3 step đều redirect → all fail. Diag mới sẽ confirm trong 1 task test.",
    ],
  },
  {
    version: "0.6.6",
    date: "2026-05-20",
    kind: "fix",
    summary: "FORCE tắt toggle external invites sau invite (không restore prev) + Phase 1 đợi DOM list pending stable trước F5 + Phase 2 retry tăng cường",
    details: [
      "USER REPORT v0.6.5: (a) sau invite, toggle 'Cho phép lời mời ngoài tên miền' không tự tắt. (b) Email trong tab 'Lời mời đang chờ xử lý' load thiếu trên dashboard so với ChatGPT thật.",
      "ROOT CAUSE (a): withExternalInvitesEnabled finally chỉ restore khi setResult.changed=true (= extension đã click bật ON). Nếu user manually bật ON từ trước → prev=ON, changed=false → finally SKIP restore → toggle giữ ON. Vi phạm spec user 'sau mời xong phải tắt mời ngoài'.",
      "FIX 1 (external-invites.ts): LUÔN force OFF sau invite (kể cả prev đã ON). Spec mới: 'Cho phép lời mời ngoài' là rủi ro bảo mật — sau mỗi invite extension phải tắt OFF, user có thể bật lại thủ công nếu cần. Bỏ điều kiện 'if changed' trong finally.",
      "ROOT CAUSE (b): Phase 1 click tab 'Lời mời đang chờ xử lý' (v0.6.5) với postClickWait 1500ms, sau đó return ngay → background F5. ChatGPT React Query fetch pending list mất 2-5s; nếu F5 ngắt giữa fetch → sau F5 có thể serve cache cũ → Phase 2 scrape miss email vừa mời.",
      "FIX 2 (invite.ts executeInvite): Sau clickTabAndWait (tăng 1500→3000ms), thêm waitForPendingListStable(emails, 8s) — poll DOM email-text-node count tới khi: (i) tất cả email vừa mời xuất hiện, HOẶC (ii) count stable 2 tick liên tiếp. Đảm bảo F5 chạy ở state DOM ổn định.",
      "FIX 3 (invite.ts executeVerifyPendingInvite): Tăng initial sleep sau F5 từ 800ms → 2500ms (Phase 2 chờ DOM render xong). Retry chain [0, 2500] (v0.6.5) → [0, 3000, 6000] (v0.6.6) — 3 attempt với gap dài hơn, xử lý case ChatGPT backend index pending list chậm.",
      "Tradeoff: invite ~3-7s chậm hơn v0.6.5 nhưng độ chính xác cao hơn nhiều. User 'load thiếu' > user 'chậm'.",
      "File đã đổi: external-invites.ts (force OFF), invite.ts (waitForPendingListStable + sleep + retry).",
    ],
  },
  {
    version: "0.6.5",
    date: "2026-05-20",
    kind: "fix",
    summary: "Fix thứ tự bước trong invite flow: TẮT toggle external invites TRƯỚC khi chuyển tab 'Lời mời'",
    details: [
      "v0.6.4 thêm clickTabAndWait('tab_pending_invites') vào CUỐI executeInviteInner — SAI THỨ TỰ. Trình tự thực tế khi đó: bật toggle → invite → click tab Lời mời (URL có ?tab=invites) → finally của withExternalInvitesEnabled navigate /admin/identity tắt toggle → navigate /admin/members (URL MẤT ?tab=invites) → F5 ở URL không có tab param → ChatGPT load tab 'Người dùng' default thay vì 'Lời mời' → Phase 2 phải tự click lại tab. Vô hiệu hoá tối ưu v0.6.4.",
      "User correct (2026-05-20): 'bật mời ngoài → mời thành viên → tắt mời ngoài → chuyển tab lời chờ xử lý → F5 → verify → ghi DB'. Trình tự đúng: restore toggle PHẢI chạy TRƯỚC khi chuyển tab Lời mời.",
      "Fix: Move clickTabAndWait('tab_pending_invites') từ cuối executeInviteInner ra scope ngoài của executeInvite, đặt SAU withExternalInvitesEnabled return (= sau khi finally đã restore toggle + navigate /admin/members). URL khi runner F5 sẽ chính xác /admin/members?tab=invites → ChatGPT load thẳng pending list.",
      "executeInviteInner giờ CHỈ làm submit invite + return awaiting_reload_verify=true (single responsibility). Tab management là concern của executeInvite (scope ngoài).",
      "Sequence chính xác (v0.6.5):",
      "  1. withExternalInvitesEnabled: nav /admin/identity → check state → nếu OFF thì bật ON (lưu prev) → nav /admin/members",
      "  2. executeInviteInner: open dialog → type email → set role → submit → wait toast/dialog close → return",
      "  3. withExternalInvitesEnabled finally: nếu prev=false thì nav /admin/identity tắt OFF → nav /admin/members",
      "  4. (NEW v0.6.5) clickTabAndWait('tab_pending_invites') → URL = /admin/members?tab=invites",
      "  5. Runner F5 → ChatGPT load pending list từ server vào view",
      "  6. Phase 2 executeVerifyPendingInvite scrape → verified emails",
      "  7. Runner bulk-upsert (isFullSync=false) → DB → dashboard hiển thị",
      "File đã đổi: invite.ts (executeInvite + executeInviteInner refactor).",
    ],
  },
  {
    version: "0.6.4",
    date: "2026-05-20",
    kind: "fix",
    summary: "Verify pending nhanh hơn (chuyển tab 'Lời mời' TRƯỚC F5) + fix bug a12 bị mark removed oan do bulk-upsert reconcile",
    details: [
      "BUG (a12 'biến mất'): User invite a12 (08:34) → ChatGPT nhận thật. Sau invite g12 (08:37) extension verify scrape tab 'Lời mời' tại 08:38 chỉ thấy g12 (a12 chưa được ChatGPT index về client) → bulk-upsert với scraped_statuses=['pending'] → backend reconcile mark a12=removed oan. Phantom cleanup INVITE_MEMBER vẫn đúng (verify_scrape_failed=true → giữ); lỗi nằm ở bulk-upsert dùng chung endpoint cho cả full sync + verify after invite.",
      "FIX 1 — Extension (runner.ts INVITE_MEMBER reportToBackend): thêm option isFullSync=false vào bulkUpsertMembers, bỏ scrapedStatuses. Backend nhận is_full_sync=false → CHỈ upsert email trong payload, KHÔNG reconcile. Verify chỉ là 'confirm những email này đang pending', không nói gì về email khác.",
      "FIX 2 — Backend (members.py bulk_upsert_members) defense-in-depth: reconcile WHERE NOT (invited_by_user_id IS NOT NULL AND created_at > NOW() - INTERVAL '10 minutes'). Nếu extension lỡ gửi is_full_sync=true sau khi vừa invite, member mới vẫn an toàn.",
      "UX SPEEDUP — Approach của user 2026-05-20: 'sau khi mời xong chuyển sang tab Lời mời đang xử lý, chờ load rồi reload trang là thấy toàn bộ'. Phase 1 (invite.ts executeInviteInner) cuối: thêm clickTabAndWait('tab_pending_invites', ..., 1500) NGAY trước khi return awaiting_reload_verify=true → URL = /admin/members?tab=invites khi runner F5 → ChatGPT load thẳng pending list từ server vào view (không cần navigate phụ).",
      "Phase 2 (executeVerifyPendingInvite) simplify: initial sleep 1500ms → 800ms (DOM đã ở đúng tab), retry chain [0, 3000, 5000] → [0, 2500] (data tươi hơn sau F5 đúng URL). Tiết kiệm ~3-5s mỗi invite.",
      "Lợi ích kép: nhanh hơn + né được race của bug a12 (scrape data từ server response của F5 thay vì DOM stale của tab cũ).",
      "File đã đổi: invite.ts (Phase 1+2), sync.ts (export clickTabAndWait), api.ts (bulkUpsertMembers thêm isFullSync), runner.ts (INVITE_MEMBER no-reconcile), members.py (reconcile skip recent invite).",
    ],
  },
  {
    version: "0.6.3",
    date: "2026-05-20",
    kind: "fix",
    summary: "Re-thêm Step 3 NUCLEAR (recreate tab) + Step 2 inject thêm lần 2 — fix CONTENT_NOT_INJECTED hiếm gặp",
    details: [
      "User report: invite tamnm@ibcgroup.vn FAILED với CONTENT_NOT_INJECTED dù tab ChatGPT đang ở /admin và đã login. v0.4.20 bỏ Step 3 NUCLEAR vì gây regression INVITE (tab recreate phá dialog state). Sau v0.6.2 invite đã tách thành Phase 1 (submit) + Phase 2 (F5 + verify), regression cũ không còn áp dụng → an toàn re-thêm Step 3.",
      "Step 3 NUCLEAR mới: chrome.tabs.remove tab cũ → chrome.tabs.create tab mới hoàn toàn (URL = /admin/members) → waitForTabComplete 20s → chrome.scripting.executeScript explicit phòng auto-inject lỗi → 5 retry ping (800/1200/1500/2000/2000ms). sendToContent đã có sẵn logic dùng tabId mới nếu Step 3 đổi tab.",
      "Step 2 strengthen: sau khi chrome.tabs.reload + tab load complete, GỌI THÊM chrome.scripting.executeScript một lần nữa (belt-and-suspenders). Manifest auto-inject ở document_idle thường ok nhưng đôi khi CRXJS loader fail do CSP/timing — executeScript explicit là backup. Cộng thêm 2 retry delay (2000ms x2) nâng tổng wait sau reload từ ~5.8s → ~9.8s.",
      "Sửa error message CONTENT_NOT_INJECTED: text cũ nói 'sau 3 bước fallback' nhưng v0.4.20 chỉ còn 2 bước → vô lý. Giờ code có thật 3 bước, text đúng sự thật.",
    ],
  },
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
