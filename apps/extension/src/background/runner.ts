import type {
  ExecuteActionRequest,
  ExecuteActionResponse,
} from "../shared/messages";
import { SESSION_RECOVERY_HINT } from "../shared/messages";
import {
  ApiError,
  bulkUpsertMembers,
  pickNextTask,
  postHarvestLabels,
  pushBillingSync,
  reconcileAfterInvite,
  updateExtensionInfo,
  updateProgress,
  updateTask,
} from "../shared/api";
import { getConfig } from "../shared/storage";
import type { ExtensionConfig, QueueItem } from "../shared/types";
import { runPaymentChain, scrapeInvoiceDetailInTab } from "./payment-chain";
import { markAdminActivity, setRunnerBusy } from "./idle-close";
import { decideInviteOutcome, type SubmitEvidence } from "./invite-outcome";
import { shouldSalvageInvite } from "./invite-salvage";

const RATE_LIMIT = {
  /** Min delay giữa 2 task bất kỳ (anti-detection). 5000→2000→1200→840 (-30%). */
  betweenTasksMs: 840,
  /** Số task chạy liên tục trước khi nghỉ batch. Tăng 5→10. */
  batchSize: 10,
  /** Sleep min/max giữa 2 batch. 30-60s → 10-20s → 6-12s (-40%). */
  batchPauseMinMs: 6_000,
  batchPauseMaxMs: 12_000,
};

/**
 * Lệch số lượng sau sync (backend đối chiếu ở request reconcile cuối). Đích danh
 * email để dashboard cảnh báo admin — KHÔNG tự xoá/sửa. Xem
 * `apps/api/app/routers/members/reconcile.py` (khối MEMBER_SYNC_MISMATCH).
 */
type SyncMismatch = {
  /** ChatGPT header báo (active). null nếu extension cũ không gửi expected_total. */
  expected_total: number | null;
  /** Số row active extension bắt được lần scrape này. */
  scraped_active: number;
  /** Active trong AutoGPT sau sync. */
  db_active: number;
  /** Active ở AutoGPT mà ChatGPT scrape KHÔNG thấy (đã loại vùng bảo vệ 10'). */
  extra_in_autogpt: string[];
  /** ChatGPT scrape thấy active mà AutoGPT không active. */
  missing_in_autogpt: string[];
  /** Header đếm nhiều hơn số row bắt được → dòng chưa lấy được danh tính. */
  unresolved_count: number;
};

const CHATGPT_TAB_MATCH = "https://chatgpt.com/admin/*";
const CHATGPT_ADMIN_URL = "https://chatgpt.com/admin/members";
// Trang "Ghi đè mỗi người dùng" — SET_USAGE_LIMIT thao tác ở đây (KHÁC /admin/members).
const CHATGPT_USAGE_LIMIT_URL =
  "https://chatgpt.com/admin/billing/manage_member_usage_limit";
const TAB_LOAD_TIMEOUT_MS = 30_000;

/**
 * Quy tắc quản lý tab chatgpt.com/admin (yêu cầu user 2026-06-19, REVISED
 * 2026-06-22, REVISED 2026-06-23 — TÁI DÙNG mặc định):
 *   - TÁI DÙNG tab MỚI NHẤT cho MỌI action khi đã có ≥1 tab admin. Trước khi dùng
 *     thì F5 (reload nếu đang ở `/admin/members`, hoặc nav về `/admin/members`
 *     nếu ở sub-page khác) để lấy DOM/server-state sạch + re-inject content script.
 *     KHÔNG mở tab mới, KHÔNG đóng tab.
 *   - Chỉ mở tab MỚI khi KHÔNG còn tab admin nào (0 tab).
 *   - Backstop chống phình: > ADMIN_TAB_HARD_MAX (≥4 tab — user chủ động mở quá
 *     nhiều) → tự đóng các tab CŨ nhất cho còn ADMIN_TAB_HARD_MAX (=3), rồi tái
 *     dùng tab mới nhất (F5).
 *   Lý do bỏ "≤2 tab → mở tab mới mỗi action" (v0.8.13–v0.8.20): batch nhiều lệnh
 *   GIỐNG NHAU (vd 30+ REMOVE_MEMBER) khiến mỗi task mở+đóng 1 tab → spam tab liên
 *   tục, vô ích. F5 tab cũ cho kết quả sạch tương đương tab mới mà không spam tab.
 */
const ADMIN_TAB_HARD_MAX = 3;

/**
 * Hard-cap cho vòng VERIFY_PENDING_INVITE (Phase 2 sau F5). Verify scrape có thể
 * chậm/treo (ChatGPT index pending list 1-5s, React Query cache, retry chain +
 * nhiều pass scrape). Trước đây KHÔNG có timeout → nếu content treo, runOnce
 * treo tới khi SW chết → task kẹt IN_PROGRESS đến lazy-cleanup backend (5 phút,
 * user report "1 mời đến 5 phút"). Cap 75s: vượt → coi như verify scrape failed
 * (benefit-of-doubt, giữ record pending → SYNC_DATA định kỳ reconcile sau), task
 * vẫn COMPLETED ngay thay vì kẹt. 60s đủ cho case index chậm mà tổng flow (Phase
 * 1 ~30-80s + F5 ~20s + verify ≤60s) vẫn < ngưỡng treo invite của backend (3
 * phút = 180s) → SW còn sống luôn tự kết thúc trước, không bị auto-fail oan.
 */
const VERIFY_ROUNDTRIP_TIMEOUT_MS = 60_000;

/**
 * v0.7.15 (2026-06-17): mục tiêu user "giảm thời gian chờ F5 verify còn ~10s".
 * Trước đây Phase 2 (content) tự ngủ cố định 2.5s + retry chain [0,3000,6000] →
 * tổng ~11.5s ngay cả khi đã đủ email. Giờ Phase 2 scrape 1 lần nhanh (poll
 * render-aware) rồi báo `needs_reload_retry`; runner đứng ra F5 THẬT lại +
 * verify nhiều vòng trong NGÂN SÁCH này. Dừng sớm khi đủ email / scrape fail /
 * hết budget. ~10s đủ cho 2 vòng F5 (mỗi vòng reload+render ~3-5s).
 */
/**
 * Ngân sách cho vòng F5+verify. 10s → 30s (user 2026-08-04): 10s là quá sát khi
 * ChatGPT index chậm — hết budget mà chưa thấy email thì trước đây bị kết luận hỏng.
 * CỐ Ý không chèn nhịp nghỉ cố định trước/sau F5: mời trót lọt là ca gần như luôn
 * xảy ra, bắt nó chờ thêm vài giây mỗi lần để phòng một rủi ro hiếm là đắt. Nới trần
 * thì chỉ ca CHẬM mới dùng tới, ca nhanh không mất gì.
 */
const VERIFY_BUDGET_MS = 30_000;
/** Số vòng F5+verify tối đa (backstop chống loop khi ChatGPT index chậm bất thường). */
const MAX_VERIFY_RELOADS = 3;

/**
 * Hard-cap cho PHASE 1 (round-trip background→content `sendToContent`) THEO LOẠI
 * task. v0.7.17 (2026-06-18) — fix bug "Mời thành viên kẹt IN_PROGRESS 343s rồi
 * TIMEOUT".
 *
 * Nguyên nhân gốc: `chrome.tabs.sendMessage` ở background KHÔNG có timeout sẵn.
 * Nếu content script bị HUỶ context giữa chừng (tab ChatGPT hard-reload / redirect
 * auth khi action navigate qua `/admin/identity` để bật toggle 'mời ngoài tên
 * miền' — case email ngoài domain), HOẶC content treo / message thất lạc, thì
 * `sendResponse` KHÔNG bao giờ được gọi → `await sendToContent` treo VĨNH VIỄN →
 * task kẹt IN_PROGRESS tới khi backend lazy-cleanup (3 phút) — đúng triệu chứng
 * user gặp. Phase 2 (VERIFY_PENDING_INVITE) đã được bọc `withTimeout` từ trước;
 * Phase 1 thì CHƯA → đây là lỗ hổng.
 *
 * Cap PHẢI: (a) lớn hơn thời gian chạy hợp lệ tối đa của content (INVITE worst
 * case ~100s gồm 2 lần navigate identity + dialog 20s + toast 15s + stable 8s;
 * SYNC_DATA lật nhiều trang ~137s), (b) NHỎ HƠN ngưỡng treo backend
 * (`STUCK_THRESHOLDS` trong execution.py) ~30s để EXTENSION tự fail TRƯỚC →
 * báo `CONTENT_TIMEOUT` rõ ràng + giải phóng SW + task kế chạy ngay, thay vì để
 * backend auto-cleanup mơ hồ sau khi đã treo lâu.
 */
const CONTENT_TIMEOUTS: Record<string, number> = {
  // INVITE_MEMBER (2026-08-22): mời giờ có thể phải MUA SUẤT trước (kiểm tra số
  // suất → thiếu thì mua bù → đọc lại → mới mời), tốn thêm gần bằng một
  // PURCHASE_SEAT. Giữ 150s sẽ cắt task GIỮA LÚC thanh toán: tiền đã trừ mà task
  // báo CONTENT_TIMEOUT. Nâng ngang PURCHASE_SEAT (backend 8' → 450s).
  INVITE_MEMBER: 450_000,
  // Backend 180s (3') → extension tự fail ở 150s.
  REMOVE_MEMBER: 150_000,
  CHANGE_ROLE: 150_000,
  CHANGE_LICENSE_TYPE: 150_000,
  SET_USAGE_LIMIT: 150_000,
  REVOKE_INVITES: 150_000,
  EXPORT_MEMBER_DATA: 150_000,
  DELETE_MEMBER_DATA: 150_000,
  // Backend 240s (4') → 210s.
  SYNC_MEMBER: 210_000,
  SYNC_BILLING: 210_000,
  // Backend 360s (6') → 330s. Batch quét TOÀN BỘ tab Lời mời 1 lần + check N
  // email còn lại ở tab Người dùng → cùng ngân sách với SYNC_DATA.
  SYNC_MEMBERS_BATCH: 330_000,
  SYNC_DATA: 330_000,
  HARVEST_LABELS: 330_000,
  // Backend 480s (8') → 450s.
  PURCHASE_SEAT: 450_000,
};
/** Backend default 300s (5') → 270s. */
const DEFAULT_CONTENT_TIMEOUT_MS = 270_000;

/**
 * Promise.race với timeout. Reject `Error("timeout:<label>")` nếu `p` không
 * settle trong `ms`. Dùng bọc các round-trip background→content (chrome.tabs.
 * sendMessage) vốn KHÔNG có timeout sẵn — tránh treo SW khi content không phản
 * hồi.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout:${label} sau ${ms}ms`)), ms),
    ),
  ]);
}

type RunnerState = {
  lastTaskAt: number;
  tasksInBatch: number;
};

const state: RunnerState = { lastTaskAt: 0, tasksInBatch: 0 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Key lưu CHỮ KÝ BUILD (danh sách file content-script kèm hash) của lần self-heal
 * reload gần nhất. chrome.storage.local sống sót qua chrome.runtime.reload() (chỉ
 * mất khi uninstall) → SW mới đọc lại để so sánh.
 *
 * Mục đích: reload (pop chrome://extensions) ĐÚNG MỘT LẦN cho mỗi build mới thật
 * sự. Nếu sau reload VẪN stale với ĐÚNG sig đã reload → Chrome chưa nạp build mới
 * / build hỏng → KHÔNG reload lại (tránh loop). Chỉ reload khi sig KHÁC = đĩa có
 * build mới khác hẳn lần trước.
 */
const STALE_RELOAD_SIG_KEY = "autogpt.lastStaleReloadSig";

/**
 * Số lần đã chrome.runtime.reload() cho ĐÚNG build signature ở STALE_RELOAD_SIG_KEY.
 * Reset về 0 khi sig đổi (= đĩa có build mới khác). Dùng làm guard chống loop:
 * cho phép tối đa MAX_RELOADS_PER_SIG lần reload cho mỗi build stale rồi bỏ cuộc.
 *
 * Trước đây guard chặn CỨNG sau đúng 1 reload (lastSig === sig → không reload nữa).
 * Nhược điểm: nếu chrome.runtime.reload() lần đầu KHÔNG kéo được build mới vào
 * (Chrome chậm áp dụng unpacked build) thì manifest đang chạy kẹt ở hash cũ, sig
 * không bao giờ đổi → guard chặn vĩnh viễn → mọi task fail CONTENT_NOT_INJECTED
 * tới khi reload tay. Đếm lần (cho thêm 1 lần thử) khắc phục case kẹt tạm thời mà
 * vẫn bound được loop khi build hỏng thật.
 */
const STALE_RELOAD_COUNT_KEY = "autogpt.staleReloadCount";
const MAX_RELOADS_PER_SIG = 2;

/**
 * Chữ ký build = danh sách (đã sort) các file js content-script trong manifest
 * đang chạy. Tên file chứa hash (vd index.ts-loader-<hash>.js) nên sig đổi ⟺
 * build đổi. Dùng làm "đã reload cho build này rồi" để không pop lặp lại.
 */
function manifestBuildSig(): string {
  const manifest = chrome.runtime.getManifest();
  const scripts = (manifest.content_scripts ?? []) as Array<{ js?: string[] }>;
  return scripts
    .flatMap((cs) => cs.js ?? [])
    .sort()
    .join("|");
}

/**
 * Phát hiện "stale build": manifest đang load (trong RAM của SW) trỏ tới file
 * content-script đã bị xoá khỏi đĩa. Xảy ra khi `vite build` sinh hash mới
 * (vd index.ts-loader-<hash>.js) nhưng Chrome chưa reload extension → SW cũ vẫn
 * giữ manifest cũ → executeScript / auto-injection "Could not load file" →
 * CONTENT_NOT_INJECTED, mọi task fail tới khi reload tay.
 *
 * Cách check (2 tầng):
 *  (1) Fetch từng file js mà manifest ĐANG CHẠY (RAM) tham chiếu. File đã xoá →
 *      404/throw → stale. Bắt được case `emptyOutDir:true` (vite xoá file cũ).
 *  (2) Đọc `manifest.json` TRÊN ĐĨA (luôn ở path cố định, vite ghi đè mỗi build)
 *      và so danh sách content-script với manifest trong RAM. Khác nhau ⟺ đĩa có
 *      build MỚI mà SW chưa nạp. CẦN tầng này vì repo để `emptyOutDir:false`
 *      (vite.config) — file cũ KHÔNG bị xoá nên (1) luôn 200 → không bao giờ bắt
 *      được build mới → self-heal "chết" → mỗi lần build phải reload tay (đây là
 *      lý do nhiều bản fix trước test nhầm code cũ). v0.7.16.
 * SW fetch resource cùng origin của chính extension → đọc thẳng từ đĩa, không cần
 * web_accessible_resources.
 */
async function isExtensionStale(): Promise<boolean> {
  const manifest = chrome.runtime.getManifest();
  const scripts = (manifest.content_scripts ?? []) as Array<{ js?: string[] }>;
  const files = scripts.flatMap((cs) => cs.js ?? []);
  // (1) File cũ bị xoá khỏi đĩa.
  for (const file of files) {
    try {
      const resp = await fetch(chrome.runtime.getURL(file));
      if (!resp.ok) return true;
    } catch {
      return true;
    }
  }
  // (2) manifest.json trên đĩa trỏ content-script khác in-memory → build mới.
  try {
    const resp = await fetch(chrome.runtime.getURL("manifest.json"), {
      cache: "no-store",
    });
    if (resp.ok) {
      const disk = (await resp.json()) as {
        content_scripts?: Array<{ js?: string[] }>;
      };
      const diskSig = (disk.content_scripts ?? [])
        .flatMap((cs) => cs.js ?? [])
        .sort()
        .join("|");
      const memSig = files.slice().sort().join("|");
      if (diskSig && diskSig !== memSig) return true;
    }
  } catch {
    // Không đọc được manifest đĩa → chỉ dựa tầng (1), không coi là stale.
  }
  return false;
}

/**
 * chrome.runtime.reload() để Chrome đọc lại manifest+file MỚI từ đĩa (extension
 * unpacked), tự sửa hash. SW hiện tại bị kill ngay; SW mới boot lại sẽ thấy file
 * hợp lệ và drain queue bình thường.
 *
 * Guard chống loop bằng (CHỮ KÝ BUILD + số lần đã reload): chỉ reload tối đa
 * MAX_RELOADS_PER_SIG lần cho mỗi build stale. Nếu vẫn stale sau ngần ấy lần với
 * cùng sig → Chrome không nạp được build mới / build hỏng thật → bỏ cuộc, để user
 * reload tay. sig đổi (đĩa có build khác) → count reset, được reload lại.
 *
 * Trả về true nếu đã trigger reload (caller nên dừng ngay, SW sắp chết); false
 * nếu guard chặn (đã thử tối đa).
 */
async function reloadForStaleBuild(reason: string): Promise<boolean> {
  const sig = manifestBuildSig();
  const stored = await chrome.storage.local.get([
    STALE_RELOAD_SIG_KEY,
    STALE_RELOAD_COUNT_KEY,
  ]);
  const lastSig = stored[STALE_RELOAD_SIG_KEY] as string | undefined;
  const prevCount =
    lastSig === sig ? Number(stored[STALE_RELOAD_COUNT_KEY] ?? 0) : 0;
  if (prevCount >= MAX_RELOADS_PER_SIG) {
    console.error(
      `[autogpt-selfheal] đã reload ${prevCount} lần cho CÙNG build signature mà VẪN stale ` +
        `(${reason}) — Chrome không nạp được build mới hoặc \`dist\` thiếu file content-script ` +
        `(build hỏng?). KHÔNG reload nữa để tránh loop pop chrome://extensions. ` +
        `Reload tay tại chrome://extensions + chạy lại \`npm run build\`.`,
    );
    return false;
  }

  await chrome.storage.local.set({
    [STALE_RELOAD_SIG_KEY]: sig,
    [STALE_RELOAD_COUNT_KEY]: prevCount + 1,
  });
  console.warn(
    `[autogpt-selfheal] stale build (${reason}) → chrome.runtime.reload() lần ` +
      `${prevCount + 1}/${MAX_RELOADS_PER_SIG} để Chrome đọc lại từ đĩa.`,
  );
  chrome.runtime.reload();
  return true;
}

/**
 * Nếu phát hiện stale build → reload extension (qua reloadForStaleBuild).
 *
 * Gọi TRƯỚC pickNextTask để không claim task rồi bỏ dở khi SW restart.
 * Trả về true nếu đã trigger reload (caller nên dừng ngay, SW sắp chết).
 *
 * ⚠ v0.7.6 (2026-06-17): BỎ gate `pending>0`. Trước đây chỉ reload khi có task
 * PENDING → build mới (sau `npm run build`) KHÔNG tự áp lúc rảnh, và task đầu
 * tiên tới có thể bị SW stale claim rồi bỏ dở → TIMEOUT 5 phút (xem
 * docs/Extension_Runtime/Self_Heal_Stale_Build.md). User muốn "update là tự áp
 * dụng" → giờ stale = reload NGAY kể cả lúc rảnh. Chống loop vẫn an toàn nhờ
 * `reloadForStaleBuild` dedup theo build signature (tối đa MAX_RELOADS_PER_SIG
 * lần / mỗi build): mỗi `npm run build` = 1 sig mới = reload 1 lần rồi thôi.
 */
async function selfHealIfStale(): Promise<boolean> {
  if (!(await isExtensionStale())) return false;
  return reloadForStaleBuild("phát hiện stale build — reload ngay (kể cả lúc rảnh)");
}

/**
 * Lấy tất cả tab chatgpt.com/admin/* đang mở, sắp xếp CŨ → MỚI.
 * Dùng tab.id làm proxy "mới nhất" (Chrome cấp id tăng dần theo thời điểm tạo).
 */
async function queryAdminTabs(): Promise<chrome.tabs.Tab[]> {
  const tabs = await chrome.tabs.query({ url: CHATGPT_TAB_MATCH });
  return tabs
    .filter((t) => t.id !== undefined)
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

/**
 * Đóng bớt các tab admin CŨ nhất sao cho chỉ còn tối đa `keep` tab. Dùng trước
 * khi mở tab mới để giữ tổng số tab trong giới hạn. Không throw nếu đóng lỗi
 * (tab có thể đã đóng). Trả về danh sách tab còn lại (đã query lại).
 */
async function pruneStaleAdminTabs(
  tabs: chrome.tabs.Tab[],
  keep: number,
): Promise<chrome.tabs.Tab[]> {
  if (tabs.length <= keep) return tabs;
  const stale = tabs.slice(0, tabs.length - keep);
  const staleIds = stale
    .map((t) => t.id)
    .filter((id): id is number => id !== undefined);
  console.log(
    `[autogpt-runner] ${tabs.length} admin tab — tự đóng ${staleIds.length} tab cũ (giữ ${keep}): ${staleIds.join(",")}`,
  );
  try {
    await chrome.tabs.remove(staleIds);
  } catch (e) {
    console.warn(
      `[autogpt-runner] đóng tab cũ lỗi (bỏ qua): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return queryAdminTabs();
}

/**
 * Đợi tab load xong (status='complete') hoặc timeout.
 * Cần thiết sau khi tabs.create / tabs.update để content script kịp inject
 * và DOM admin page render.
 */
function waitForTabComplete(
  tabId: number,
  timeoutMs: number,
): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const cleanup = (): void => {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onUpdated.removeListener(listener);
    };
    const listener = (
      id: number,
      info: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ): void => {
      if (id !== tabId) return;
      if (info.status !== "complete") return;
      cleanup();
      resolve(tab);
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      if (resolved) return;
      cleanup();
      chrome.tabs.get(tabId).then(resolve).catch(() => resolve(null));
    }, timeoutMs);
  });
}

/**
 * Đảm bảo có tab chatgpt.com/admin/members sạch cho action, theo quy tắc tab của
 * user (2026-06-19, REVISED 2026-06-23 — TÁI DÙNG mặc định, chỉ mở mới khi 0 tab):
 *   1. Đếm tab admin đang mở (sắp xếp cũ → mới).
 *   2. > ADMIN_TAB_HARD_MAX (≥4 tab) → đóng các tab CŨ nhất cho còn 3 (backstop
 *      chống phình khi user chủ động mở quá nhiều). ≤3 → KHÔNG đóng gì.
 *   3. Còn ≥1 tab → TÁI DÙNG tab MỚI NHẤT + F5 (reload nếu đang ở /admin/members,
 *      hoặc nav về /admin/members nếu ở sub-page khác), đợi load, verify /admin.
 *      KHÔNG mở tab mới, KHÔNG đóng tab. Đây là đường đi mặc định cho mọi action
 *      → batch nhiều lệnh giống nhau (vd 30+ REMOVE) KHÔNG còn spam mở/đóng tab.
 *   4. 0 tab → mở tab MỚI tới /admin/members.
 *   5. Tab dùng cho action verify URL vẫn ở /admin (redirect tới login = chưa
 *      đăng nhập ChatGPT) → trả null.
 *
 * Trả về tab dùng được hoặc null nếu user chưa đăng nhập ChatGPT.
 */
async function ensureAdminTab(): Promise<chrome.tabs.Tab | null> {
  let tabs = await queryAdminTabs();

  // (2) Backstop chống phình: chỉ tự đóng khi VƯỢT hard-max (≥4) → còn 3.
  if (tabs.length > ADMIN_TAB_HARD_MAX) {
    tabs = await pruneStaleAdminTabs(tabs, ADMIN_TAB_HARD_MAX);
  }

  // (3) Có ≥1 tab → tái dùng tab MỚI NHẤT + F5 (không mở mới, không đóng). Đây là
  // hành vi MẶC ĐỊNH: tránh spam mở/đóng tab khi chạy batch nhiều lệnh giống nhau.
  if (tabs.length >= 1) {
    const newest = tabs[tabs.length - 1];
    if (newest?.id !== undefined) {
      const reusedId = newest.id;
      const onMembers = newest.url?.includes("/admin/members") ?? false;
      console.log(
        `[autogpt-runner] ${tabs.length} tab admin — tái dùng tab mới nhất ${reusedId} + F5 (onMembers=${onMembers}), KHÔNG mở tab mới`,
      );
      if (onMembers) {
        // Đang đúng trang → F5 thật để lấy DOM/server-state sạch.
        await chrome.tabs.reload(reusedId);
      } else {
        // Ở sub-page khác → nav về /admin/members (chính là 1 lần load mới).
        await chrome.tabs.update(reusedId, {
          url: CHATGPT_ADMIN_URL,
          active: false,
        });
      }
      const loaded = await waitForTabComplete(reusedId, TAB_LOAD_TIMEOUT_MS);
      if (!loaded || !loaded.url) {
        console.warn("[autogpt-runner] tab tái dùng không load được sau F5");
        return null;
      }
      if (!loaded.url.includes("/admin")) {
        console.warn(
          `[autogpt-runner] tab tái dùng bị redirect khỏi /admin: ${loaded.url} — user chưa login ChatGPT`,
        );
        return null;
      }
      console.log(
        `[autogpt-runner] admin tab tái dùng OK: tab ${reusedId} ${loaded.url}`,
      );
      return loaded;
    }
  }

  // (4) 0 tab admin → mở tab MỚI cho action này
  console.log(
    `[autogpt-runner] mở tab admin MỚI ${CHATGPT_ADMIN_URL} (background) cho action`,
  );
  const created = await chrome.tabs.create({
    url: CHATGPT_ADMIN_URL,
    active: false,
  });
  if (created.id === undefined) return null;

  const loaded = await waitForTabComplete(created.id, TAB_LOAD_TIMEOUT_MS);
  if (!loaded || !loaded.url) {
    console.warn("[autogpt-runner] tab vừa tạo không load được");
    return null;
  }
  // ChatGPT chưa đăng nhập sẽ redirect tới /auth/login hoặc /
  if (!loaded.url.includes("/admin")) {
    console.warn(
      `[autogpt-runner] tab bị redirect khỏi /admin: ${loaded.url} — user chưa login ChatGPT trong browser này`,
    );
    return null;
  }
  console.log(
    `[autogpt-runner] admin tab mới tạo OK: tab ${created.id} ${loaded.url}`,
  );
  return loaded;
}

async function pingContent(tabId: number): Promise<boolean> {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { kind: "PING" });
    return Boolean(resp?.ok);
  } catch {
    return false;
  }
}

/**
 * Lấy JS files của content script chạy trên chatgpt.com/admin từ manifest.
 * Sau khi vite build, source `.ts` được rename thành `assets/index.ts-<hash>.js`
 * — hash đổi mỗi build nên KHÔNG hardcode được. Đọc manifest runtime.
 */
function getChatGPTContentScriptFiles(): string[] {
  const manifest = chrome.runtime.getManifest();
  const scripts = (manifest.content_scripts ?? []) as Array<{
    matches?: string[];
    js?: string[];
  }>;
  const entry = scripts.find((cs) =>
    (cs.matches ?? []).some((m) => m.includes("chatgpt.com/admin")),
  );
  return entry?.js ?? [];
}

/**
 * Đảm bảo content script đã inject ở tab `tabId`. KHÔNG bao giờ yêu cầu user
 * thao tác — tự động qua 3 step fallback:
 *
 *   Step 1: chrome.scripting.executeScript inject loader → retry ping ~3s
 *   Step 2: chrome.tabs.reload (F5 tab) → executeScript lần 2 → retry ping ~9s
 *   Step 3 NUCLEAR: chrome.tabs.remove + chrome.tabs.create tab mới hoàn toàn
 *           → wait load → executeScript → retry ping ~6s
 *
 * v0.6.3 re-thêm Step 3 NUCLEAR (đã bị bỏ ở v0.4.20). Lý do an toàn lại: sau
 * v0.6.2, INVITE_MEMBER tách thành Phase 1 (submit) + Phase 2 (F5 + verify).
 * Step 3 NUCLEAR ở Phase 1 không phá dialog vì dialog chưa mở; nếu cần ở
 * Phase 2 thì verify scrape là idempotent.
 *
 * Trả về:
 *   - { ok: true, tabId: N } — content script ready, có thể là tab khác nếu
 *     Step 3 recreate. Caller phải dùng tabId mới.
 *   - { ok: false } — cả 3 step thất bại (rất hiếm: ChatGPT không login, hoặc
 *     extension permission bị block).
 */
async function ensureContentInjected(
  tabId: number,
): Promise<{ ok: boolean; tabId: number; diag: string[]; stale?: boolean }> {
  // v0.6.7: thu thập diag chi tiết step-by-step. Trước đây 3 step fail thầm
  // chỉ in console.warn → user mở DevTools service worker mới biết step nào
  // hỏng. Giờ collect array → propagate vào error_message của task → dashboard
  // hiển thị thẳng. KHÔNG thay đổi logic 3 step, chỉ thêm visibility.
  const diag: string[] = [];
  const t0 = Date.now();
  const log = (msg: string): void => {
    const elapsed = Date.now() - t0;
    const line = `+${elapsed}ms ${msg}`;
    console.log(`[autogpt-ensure] ${line}`);
    diag.push(line);
  };

  // Snapshot tab state ngay đầu — biết URL/status hiện tại để phân biệt:
  // (a) tab đã logout về /auth/login, (b) tab đang loading, (c) tab healthy
  try {
    const tab = await chrome.tabs.get(tabId);
    log(`tab ${tabId} state: status=${tab.status} url=${tab.url ?? "?"}`);
    if (tab.url && !tab.url.includes("/admin")) {
      log(`⚠ tab URL không chứa /admin — có thể đã logout/redirect`);
    }
  } catch (e) {
    log(`chrome.tabs.get(${tabId}) THREW: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (await pingContent(tabId)) {
    log("initial ping OK — content script đã sẵn sàng");
    return { ok: true, tabId, diag };
  }
  log("initial ping fail — content script chưa response");

  // STALE-BUILD SHORT-CIRCUIT: nếu manifest đang chạy trỏ tới file content-script
  // đã bị xoá khỏi đĩa (rebuild đổi hash, Chrome chưa reload) thì executeScript ở
  // CẢ 3 step dưới CHẮC CHẮN ném "Could not load file" — vô ích + phí ~23s + phá
  // tab (Step 3 NUCLEAR). Phát hiện sớm → bỏ qua 3 step, báo stale lên caller để
  // mark task FAILED rồi reloadForStaleBuild() (self-heal đúng cách = reload
  // EXTENSION, không phải reload TAB).
  if (await isExtensionStale()) {
    log(
      "⚠ extension STALE (manifest trỏ file content-script đã xoá khỏi đĩa) — " +
        "bỏ qua 3 step executeScript (chắc chắn fail 'Could not load file'). Caller sẽ self-heal reload.",
    );
    return { ok: false, tabId, diag, stale: true };
  }

  // Step 1: executeScript inject loader
  const files = getChatGPTContentScriptFiles();
  if (files.length === 0) {
    log("⚠ manifest KHÔNG có content_script cho chatgpt.com/admin — abort");
    return { ok: false, tabId, diag };
  }
  log(`Step 1: executeScript files=[${files.join(", ")}]`);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
    log("Step 1 executeScript resolved");
  } catch (e) {
    log(`Step 1 executeScript THREW: ${e instanceof Error ? e.message : String(e)}`);
  }
  const RETRY_DELAYS_MS = [250, 500, 700, 800, 800];
  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
    if (await pingContent(tabId)) {
      log(`Step 1 ping ${i + 1}/${RETRY_DELAYS_MS.length} OK — ready`);
      return { ok: true, tabId, diag };
    }
  }
  log(`Step 1 ping fail toàn bộ ${RETRY_DELAYS_MS.length} retry`);

  // Step 2: AUTO-RELOAD tab + executeScript LẦN 2 (belt-and-suspenders)
  log("Step 2: tabs.reload + executeScript lại");
  try {
    await chrome.tabs.reload(tabId);
    const reloaded = await waitForTabComplete(tabId, 15_000);
    log(`Step 2 reload done, url=${reloaded?.url ?? "?"} status=${reloaded?.status ?? "?"}`);
    if (reloaded?.url?.includes("/admin")) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files });
        log("Step 2 executeScript resolved");
      } catch (e) {
        log(`Step 2 executeScript THREW: ${e instanceof Error ? e.message : String(e)}`);
      }
      const POST_RELOAD_DELAYS_MS = [500, 800, 1000, 1200, 1500, 2000, 2000];
      for (let i = 0; i < POST_RELOAD_DELAYS_MS.length; i++) {
        await new Promise((r) => setTimeout(r, POST_RELOAD_DELAYS_MS[i]));
        if (await pingContent(tabId)) {
          log(`Step 2 ping ${i + 1}/${POST_RELOAD_DELAYS_MS.length} OK — ready`);
          return { ok: true, tabId, diag };
        }
      }
      log(`Step 2 ping fail toàn bộ ${POST_RELOAD_DELAYS_MS.length} retry`);
    } else {
      log(`⚠ Step 2 ABORT: sau reload tab redirect khỏi /admin (url=${reloaded?.url}) — likely logged out`);
    }
  } catch (e) {
    log(`Step 2 tabs.reload THREW: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Step 3 NUCLEAR: tab cũ stuck → tạo tab mới hoàn toàn
  log("Step 3 NUCLEAR: tabs.remove + tabs.create");
  let newTabId = tabId;
  try {
    try {
      await chrome.tabs.remove(tabId);
      log("Step 3 tabs.remove resolved");
    } catch (e) {
      log(`Step 3 tabs.remove THREW (tab có thể đã đóng): ${e instanceof Error ? e.message : String(e)}`);
    }
    const created = await chrome.tabs.create({
      url: CHATGPT_ADMIN_URL,
      active: false,
    });
    if (created.id === undefined) {
      log("⚠ Step 3 tabs.create KHÔNG trả tabId");
      return { ok: false, tabId, diag };
    }
    newTabId = created.id;
    log(`Step 3 created tab ${newTabId}, đợi load...`);
    const recreated = await waitForTabComplete(newTabId, 20_000);
    log(`Step 3 wait load done, url=${recreated?.url ?? "?"} status=${recreated?.status ?? "?"}`);
    if (!recreated?.url?.includes("/admin")) {
      log(`⚠ Step 3 ABORT: tab mới redirect khỏi /admin → user chưa login ChatGPT trong browser này`);
      return { ok: false, tabId: newTabId, diag };
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId: newTabId }, files });
      log("Step 3 executeScript resolved");
    } catch (e) {
      log(`Step 3 executeScript THREW: ${e instanceof Error ? e.message : String(e)}`);
    }
    const POST_RECREATE_DELAYS_MS = [800, 1200, 1500, 2000, 2000];
    for (let i = 0; i < POST_RECREATE_DELAYS_MS.length; i++) {
      await new Promise((r) => setTimeout(r, POST_RECREATE_DELAYS_MS[i]));
      if (await pingContent(newTabId)) {
        log(`Step 3 ping ${i + 1}/${POST_RECREATE_DELAYS_MS.length} OK — ready (tab ${newTabId})`);
        return { ok: true, tabId: newTabId, diag };
      }
    }
    log(`Step 3 ping fail toàn bộ ${POST_RECREATE_DELAYS_MS.length} retry`);
  } catch (e) {
    log(`Step 3 unexpected THREW: ${e instanceof Error ? e.message : String(e)}`);
  }

  log(`Cả 3 step đều fail — give up. tab=${newTabId}`);
  return { ok: false, tabId: newTabId, diag };
}

async function sendToContent(
  tabId: number,
  request: ExecuteActionRequest,
): Promise<ExecuteActionResponse> {
  const ready = await ensureContentInjected(tabId);
  // QUAN TRỌNG: nếu Step 3 NUCLEAR recreate đổi tabId, dùng tabId MỚI để gửi
  // message — không gửi tabId cũ đã bị remove.
  const effectiveTabId = ready.tabId;
  if (!ready.ok) {
    // v0.6.7: propagate diag step-by-step vào error_message để dashboard hiển
    // thị thẳng — không bắt user mở DevTools service worker mới biết lỗi gì.
    const diagText = ready.diag.length > 0
      ? "\n\nChi tiết từng bước:\n" + ready.diag.join("\n")
      : "";
    // STALE_BUILD: extension chạy build cũ (manifest trỏ file đã xoá khỏi đĩa).
    // error_code riêng để runOnce biết mark FAILED xong thì reloadForStaleBuild()
    // → SW restart, các task sau chạy lại bình thường (không cần user reload tay).
    if (ready.stale) {
      return {
        ok: false,
        error_code: "STALE_BUILD",
        error_message:
          "Extension đang chạy build CŨ (manifest trỏ file content-script đã bị xoá khỏi đĩa sau rebuild). " +
          "Đang tự reload extension để Chrome nạp build mới — task này sẽ chạy lại ở lần kế. " +
          "Nếu lặp lại nhiều lần: chrome://extensions/ → reload AutoGPT thủ công + chạy lại `npm run build`." +
          diagText,
      };
    }
    return {
      ok: false,
      error_code: "CONTENT_NOT_INJECTED",
      error_message:
        "Tab chatgpt.com/admin không thể inject content script sau 3 bước fallback (executeScript / reload / recreate tab). " +
        "Cách khắc phục thường gặp: (1) F5 ChatGPT tab thủ công, (2) chrome://extensions/ → reload AutoGPT, " +
        "(3) đảm bảo extension + ChatGPT cùng browser profile + đã login. " +
        SESSION_RECOVERY_HINT +
        diagText,
    };
  }
  try {
    return await chrome.tabs.sendMessage(effectiveTabId, request);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error_code: "UNKNOWN",
      error_message: `Lỗi gửi message tới content script: ${msg}.`,
    };
  }
}

/**
 * Báo progress lifecycle từ background (trước cả khi content script chạy).
 * Dùng cho task long-op (HARVEST_LABELS, SYNC_DATA) để dashboard không bị
 * "đứng yên" trong 5-30s mở tab + inject content script + rate-limit.
 * Best-effort: silent fail.
 */
async function reportRunnerProgress(
  config: ExtensionConfig,
  taskId: string,
  progress: { phase: string; message: string; current?: number; total?: number },
): Promise<void> {
  try {
    await updateProgress(config, taskId, progress);
  } catch (e) {
    console.warn("[autogpt-runner] reportRunnerProgress failed", e);
  }
}

function taskToRequest(task: QueueItem): ExecuteActionRequest | null {
  const p = task.payload;
  switch (task.type) {
    case "INVITE_MEMBER": {
      // Backward-compat: payload.email (single) hoặc payload.emails (batch).
      // Cả 2 đều convert thành emails: string[] cho extension action.
      const rawEmails = p.emails;
      let emails: string[] = [];
      if (Array.isArray(rawEmails)) {
        emails = rawEmails.filter((e): e is string => typeof e === "string");
      } else if (typeof p.email === "string") {
        emails = [p.email];
      }
      const verifiedDomain =
        typeof p.verified_domain === "string" ? p.verified_domain : null;
      // Số suất MỚI lệnh mời này chiếm (backend tính, KHÁC emails.length khi có
      // email đang là member active). Backend cũ chưa gửi → undefined, content
      // tự rơi về emails.length.
      const rawSeatCount = p.new_seat_count;
      const newSeatCount =
        typeof rawSeatCount === "number" && Number.isFinite(rawSeatCount) && rawSeatCount >= 0
          ? rawSeatCount
          : undefined;
      return {
        kind: "INVITE_MEMBER",
        taskId: task.id,
        emails,
        role: (p.role as "owner" | "admin" | "member") ?? "member",
        verifiedDomain,
        newSeatCount,
        // Action "Mời lại": chạy tiền tố tìm-thu-hồi trước khi mời (payload.reinvite).
        reinvite: p.reinvite === true,
      };
    }
    case "REMOVE_MEMBER":
      return {
        kind: "REMOVE_MEMBER",
        taskId: task.id,
        email: String(p.email ?? ""),
      };
    case "EXPORT_MEMBER_DATA":
    case "DELETE_MEMBER_DATA":
      return {
        kind: task.type,
        taskId: task.id,
        email: String(p.email ?? ""),
      };
    case "SYNC_MEMBER":
      return {
        kind: "SYNC_MEMBER",
        taskId: task.id,
        email: String(p.email ?? ""),
      };
    case "SYNC_MEMBERS_BATCH": {
      const rawEmails = (p.emails as unknown) ?? [];
      const emails = Array.isArray(rawEmails)
        ? rawEmails.filter((e): e is string => typeof e === "string")
        : [];
      return { kind: "SYNC_MEMBERS_BATCH", taskId: task.id, emails };
    }
    case "SET_USAGE_LIMIT":
      return {
        kind: "SET_USAGE_LIMIT",
        taskId: task.id,
        email: String(p.email ?? ""),
        limit_credits: Number(p.limit_credits ?? 0),
        old_limit_credits:
          p.old_limit_credits == null ? null : Number(p.old_limit_credits),
      };
    case "CHANGE_ROLE":
      return {
        kind: "CHANGE_ROLE",
        taskId: task.id,
        email: String(p.email ?? ""),
        new_role: (p.new_role as "owner" | "admin" | "member") ?? "member",
        old_role: (p.old_role as "owner" | "admin" | "member" | null) ?? null,
      };
    case "CHANGE_LICENSE_TYPE":
      return {
        kind: "CHANGE_LICENSE_TYPE",
        taskId: task.id,
        email: String(p.email ?? ""),
        new_license_type:
          (p.new_license_type as "ChatGPT" | "Codex") ?? "ChatGPT",
        old_license_type:
          (p.old_license_type as "ChatGPT" | "Codex" | null) ?? null,
      };
    case "SYNC_DATA": {
      // Dashboard có thể truyền expected_locale ('vi' | 'en' | 'zh') trong
      // payload để extension check locale ChatGPT khớp chưa. Null = không check.
      const rawLocale = p.expected_locale;
      const expectedLocale: "vi" | "en" | "zh" | null =
        rawLocale === "vi" || rawLocale === "en" || rawLocale === "zh"
          ? rawLocale
          : null;
      const rawScope = p.sync_scope;
      const scope: "members" | "invites" | "both" =
        rawScope === "members" || rawScope === "invites" || rawScope === "both"
          ? rawScope
          : (p.include_pending as boolean | undefined) !== false
            ? "both"
            : "members";
      return {
        kind: "SYNC_DATA",
        taskId: task.id,
        scope,
        expectedLocale,
      };
    }
    case "SYNC_BILLING":
      return { kind: "SYNC_BILLING", taskId: task.id };
    case "REVOKE_INVITES": {
      const rawEmails = (task.payload?.emails as unknown) ?? [];
      const emails = Array.isArray(rawEmails)
        ? rawEmails.filter((e): e is string => typeof e === "string")
        : [];
      return { kind: "REVOKE_INVITES", taskId: task.id, emails };
    }
    case "HARVEST_LABELS": {
      const rawLocale = String(task.payload?.locale ?? "").toLowerCase();
      const locale: "vi" | "en" | "zh" =
        rawLocale === "vi" || rawLocale === "zh" ? rawLocale : "en";
      return { kind: "HARVEST_LABELS", taskId: task.id, locale };
    }
    case "PURCHASE_SEAT": {
      const rawQty = Number(p.quantity);
      const quantity = Number.isFinite(rawQty) && rawQty > 0 ? Math.floor(rawQty) : 1;
      const skipToPayment = p.skip_to_payment === true;
      return { kind: "PURCHASE_SEAT", taskId: task.id, quantity, skipToPayment };
    }
    default:
      return null;
  }
}

const CHUNK_SIZE = 200;

/** Trần số hoá đơn mở chi tiết mỗi lần sync (chống phát hiện + giới hạn thời gian). */
const MAX_INVOICE_DETAILS_PER_SYNC = 12;

type BillingInvoiceWire = {
  date: string;
  amount_vnd: number;
  status: string;
  detail_url?: string | null;
  detail_scraped?: boolean;
  quantity?: number | null;
  unit_price_vnd?: number | null;
  subtotal_vnd?: number | null;
  vat_vnd?: number | null;
  total_vnd?: number | null;
  period_start?: string | null;
  period_end?: string | null;
  invoice_number?: string | null;
};

type BillingWire = {
  plan?: string | null;
  seat_total?: number | null;
  seat_used?: number | null;
  billing_status?: "PAID" | "UNPAID" | "UNKNOWN" | null;
  renewal_date?: string | null;
  invoices?: BillingInvoiceWire[];
};

function randDelayMs(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

function invoiceDateMs(inv: BillingInvoiceWire): number {
  const d = new Date(inv.date);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * cycle_start = cùng ngày-trong-tháng nhưng LÙI 1 THÁNG LỊCH (không phải trừ 30
 * ngày cứng). Khớp `cycleStartFromRenewal` ở web billing-math. Quan trọng: chu kỳ
 * dài 31 ngày (vd 11/7→11/8) — trừ 30 ngày sẽ ra 12/7, đẩy hoá đơn GỐC chu kỳ ngày
 * 11/7 ra ngoài cửa sổ → không mở được chi tiết. Lùi 1 tháng lịch cho ra đúng 11/7.
 */
function cycleStartMs(cycleEndMs: number): number {
  const d = new Date(cycleEndMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, d.getUTCDate());
}

/**
 * Ngày kết thúc "Current cycle" từ tab Kế hoạch (billing.renewal_date) → ms UTC
 * nửa đêm. Đây là CHU KỲ CHUẨN. Nếu giá trị scrape được đã qua (đúng ngày renew
 * mà tab Kế hoạch chưa kịp cuộn sang chu kỳ mới) → tiến 1 tháng lịch để chu kỳ
 * chuẩn là chu kỳ ĐANG chạy (hôm nay < renewal). Trả null nếu không parse được.
 */
function parsePlanRenewalMs(
  renewalIso: string | null | undefined,
  todayMs: number,
): number | null {
  if (!renewalIso) return null;
  const d = new Date(renewalIso);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCHours(0, 0, 0, 0);
  let ms = d.getTime();
  let guard = 0;
  while (ms <= todayMs && guard < 3) {
    const dd = new Date(ms);
    ms = Date.UTC(dd.getUTCFullYear(), dd.getUTCMonth() + 1, dd.getUTCDate());
    guard++;
  }
  return ms;
}

/** Đọc chi tiết 1 hoá đơn (mở tab Stripe) và gộp vào phần tử invoice. */
async function openAndMergeDetail(
  inv: BillingInvoiceWire,
  taskId: string,
): Promise<void> {
  const detail = await scrapeInvoiceDetailInTab(inv.detail_url as string, taskId);
  if (detail && detail.quantity !== null) {
    inv.detail_scraped = true;
    inv.quantity = detail.quantity;
    inv.unit_price_vnd = detail.unit_price_vnd;
    inv.subtotal_vnd = detail.subtotal_vnd;
    inv.vat_vnd = detail.vat_vnd;
    inv.total_vnd = detail.total_vnd;
    inv.period_start = detail.period_start;
    inv.period_end = detail.period_end;
    inv.invoice_number = detail.invoice_number;
    if (detail.status) inv.status = detail.status;
  } else {
    inv.detail_scraped = false;
  }
}

/**
 * Đọc chi tiết CHỈ các hoá đơn Paid thuộc CHU KỲ HIỆN TẠI (không mở tràn lan).
 *
 * CHU KỲ CHUẨN = "Current cycle" trên tab Kế hoạch (billing.renewal_date = ngày
 * KẾT THÚC chu kỳ). Đây là nguồn ưu tiên — đúng quy trình: đọc chu kỳ ở tab Kế
 * hoạch TRƯỚC, rồi mới đối chiếu hoá đơn vào cửa sổ [cycle_start, renewal).
 * Cửa sổ chu kỳ = [renewal − 1 tháng lịch, renewal).
 *
 * Chiến lược mở:
 *   1. Có chu kỳ chuẩn → mở các hoá đơn Paid có NGÀY (trên list) trong cửa sổ.
 *   2. Chu kỳ chuẩn CHƯA có hoá đơn nào (đúng ngày renew, hoá đơn mới chưa lên) →
 *      vẫn mở hoá đơn Paid MỚI NHẤT (của chu kỳ TRƯỚC) để web lấy được giá/seat
 *      kỳ trước làm ƯỚC TÍNH. KHÔNG ghi đè chu kỳ chuẩn bằng period kỳ trước.
 *   3. KHÔNG có chu kỳ chuẩn (tab Kế hoạch không đọc được renewal) → dự phòng:
 *      mở hoá đơn mới nhất, suy chu kỳ từ `period_end` của nó.
 * Mở TUẦN TỰ + delay ngẫu nhiên; 1 hoá đơn lỗi → detail_scraped=false, không fail.
 */
async function enrichInvoicesWithDetails(
  config: ExtensionConfig,
  taskId: string,
  billing: BillingWire,
): Promise<void> {
  const invoices = billing.invoices ?? [];
  if (invoices.length === 0) return;

  const paid = invoices
    .filter((inv) => inv.status === "paid" && inv.detail_url)
    .sort((a, b) => invoiceDateMs(b) - invoiceDateMs(a)); // mới → cũ
  if (paid.length === 0) return;

  const opened = new Set<BillingInvoiceWire>();
  const todayMs = new Date().setUTCHours(0, 0, 0, 0);

  // Bước 1: chu kỳ CHUẨN từ tab Kế hoạch (nguồn ưu tiên).
  let cycleEnd: number | null = parsePlanRenewalMs(billing.renewal_date, todayMs);
  let cycleStart: number | null = cycleEnd !== null ? cycleStartMs(cycleEnd) : null;

  const inWindow = (inv: BillingInvoiceWire, cs: number, ce: number): boolean => {
    const t = invoiceDateMs(inv);
    return t >= cs && t < ce;
  };

  // Bước 2: hoá đơn thuộc chu kỳ chuẩn (theo NGÀY hoá đơn trên list).
  let targets: BillingInvoiceWire[] =
    cycleStart !== null && cycleEnd !== null
      ? paid.filter((inv) => inWindow(inv, cycleStart as number, cycleEnd as number))
      : [];

  // Bước 3: mở hoá đơn mới nhất khi (a) không có chu kỳ chuẩn → suy chu kỳ từ nó;
  // hoặc (b) chu kỳ chuẩn rỗng → nó là hoá đơn kỳ TRƯỚC, mở để web ước tính giá.
  const newest = paid[0];
  if (cycleEnd === null || targets.length === 0) {
    await reportRunnerProgress(config, taskId, {
      phase: "scraping",
      message: "Xác định chu kỳ: đọc hoá đơn mới nhất...",
    });
    await openAndMergeDetail(newest, taskId);
    opened.add(newest);
    // Chỉ SUY chu kỳ từ period hoá đơn khi tab Kế hoạch KHÔNG cho chu kỳ chuẩn.
    if (cycleEnd === null && newest.detail_scraped && newest.period_end) {
      cycleEnd = new Date(newest.period_end).setUTCHours(0, 0, 0, 0);
      cycleStart = cycleStartMs(cycleEnd);
      const cs = cycleStart;
      const ce = cycleEnd;
      targets = paid.filter((inv) => inWindow(inv, cs, ce));
    }
  }

  const toOpen = targets
    .filter((inv) => !opened.has(inv))
    .slice(0, MAX_INVOICE_DETAILS_PER_SYNC);
  if (targets.length > toOpen.length + opened.size) {
    console.warn(
      `[autogpt-billing] ${targets.length} hoá đơn trong chu kỳ, mở ${toOpen.length + opened.size} (trần ${MAX_INVOICE_DETAILS_PER_SYNC}).`,
    );
  }

  const total = toOpen.length + opened.size;
  for (let i = 0; i < toOpen.length; i++) {
    await reportRunnerProgress(config, taskId, {
      phase: "scraping",
      message: `Đọc chi tiết hoá đơn ${opened.size + i + 1}/${total}...`,
      current: opened.size + i + 1,
      total,
    });
    await openAndMergeDetail(toOpen[i], taskId);
    opened.add(toOpen[i]);
    if (i < toOpen.length - 1) {
      await new Promise((r) => setTimeout(r, randDelayMs(1500, 4000)));
    }
  }

  // Bước 4: chốt renewal_date.
  //  - Có chu kỳ chuẩn → GIỮ ngày kết thúc chu kỳ chuẩn (kể cả khi đã tiến 1 tháng
  //    cho trường hợp đúng ngày renew). KHÔNG để period hoá đơn kỳ trước ghi đè.
  //  - Không có chu kỳ chuẩn → suy từ period_end hoá đơn gốc chu kỳ (period_start
  //    sớm nhất) làm dự phòng.
  if (cycleEnd !== null) {
    billing.renewal_date = new Date(cycleEnd).toISOString();
  } else {
    const withPeriod = [...opened].filter(
      (inv) => inv.detail_scraped && inv.period_start && inv.period_end,
    );
    if (withPeriod.length > 0) {
      const base = withPeriod.reduce((a, b) =>
        new Date(b.period_start as string).getTime() <
        new Date(a.period_start as string).getTime()
          ? b
          : a,
      );
      if (base.period_end) billing.renewal_date = base.period_end;
    }
  }
}

async function reportToBackend(
  config: ExtensionConfig,
  task: QueueItem,
  response: ExecuteActionResponse,
): Promise<void> {
  if (response.ok) {
    // Special case: SYNC_BILLING mang theo billing → PATCH workspace billing fields.
    if (task.type === "SYNC_BILLING") {
      const data = response.data as { billing?: BillingWire } | undefined;
      const billing = data?.billing;
      if (!billing) {
        await updateTask(config, task.id, {
          status: "FAILED",
          error_code: "UI_ELEMENT_NOT_FOUND",
          error_message: "Extension không trả billing data",
        });
        return;
      }
      // Mở chi tiết từng hoá đơn Paid trong chu kỳ để lấy số lượng/đơn giá/period
      // CHÍNH XÁC (thay cho đoán bằng phép chia). Best-effort — lỗi 1 hoá đơn
      // không làm hỏng cả sync.
      try {
        await enrichInvoicesWithDetails(config, task.id, billing);
      } catch (e) {
        console.warn("[autogpt-billing] enrich chi tiết hoá đơn lỗi (bỏ qua):", e);
      }
      try {
        const updated = await pushBillingSync(config, billing);
        await updateTask(config, task.id, {
          status: "COMPLETED",
          result: {
            seat_total: updated.seat_total,
            seat_used: updated.seat_used,
            plan: updated.plan,
            billing_status: updated.billing_status,
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await updateTask(config, task.id, {
          status: "FAILED",
          error_code: "BILLING_SYNC_FAILED",
          error_message: msg,
        });
      }
      return;
    }

    // Special case: HARVEST_LABELS mang theo labels → POST /ui-labels/harvest.
    if (task.type === "HARVEST_LABELS") {
      const data = response.data as
        | {
            harvest?: {
              locale: "vi" | "en" | "zh";
              pages: Array<{
                page: string;
                labels: Array<{
                  control_key: string;
                  label_text?: string | null;
                  aria_label?: string | null;
                }>;
              }>;
            };
            total?: number;
          }
        | undefined;
      const harvest = data?.harvest;
      if (!harvest) {
        await updateTask(config, task.id, {
          status: "FAILED",
          error_code: "UI_ELEMENT_NOT_FOUND",
          error_message: "Extension không trả harvest payload",
        });
        return;
      }
      try {
        const result = await postHarvestLabels(config, harvest);
        await updateTask(config, task.id, {
          status: "COMPLETED",
          result: {
            locale: result.locale,
            total: result.total,
            pages: result.pages,
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await updateTask(config, task.id, {
          status: "FAILED",
          error_code: "HARVEST_UPSERT_FAILED",
          error_message: msg,
        });
      }
      return;
    }

    // Special case: SYNC_DATA mang theo members → chunked bulk-upsert.
    if (task.type === "SYNC_DATA" && task.workspace_id) {
      // Đọc include_pending từ task.payload để báo backend scope reconcile:
      //   - true (default) → scraped active+pending tab → backend reconcile cả 2
      //   - false → chỉ scraped active → backend chỉ reconcile active, KHÔNG
      //     đụng tới pending (giữ trạng thái pending từ sync trước)
      const rawScope = task.payload?.sync_scope as string | undefined;
      const scope: "members" | "invites" | "both" =
        rawScope === "members" || rawScope === "invites" || rawScope === "both"
          ? rawScope
          : (task.payload?.include_pending as boolean | undefined) !== false
            ? "both"
            : "members";
      // Báo backend đúng scope reconcile: chỉ reconcile status đã thực sự scrape.
      const scrapedStatuses: Array<"active" | "pending"> =
        scope === "both"
          ? ["active", "pending"]
          : scope === "invites"
            ? ["pending"]
            : ["active"];
      const data = response.data as
        | {
            members?: Array<Record<string, unknown>>;
            user_info?: { email?: string | null; name?: string | null };
            expected_total?: number | null;
            invites_tab_ok?: boolean;
            active_tab_ok?: boolean;
          }
        | undefined;
      const members = (data?.members ?? []) as Array<{
        email: string;
        name?: string | null;
        chatgpt_role?: "owner" | "admin" | "member" | null;
        license_type?: "ChatGPT" | "Codex" | null;
        status?: "active" | "pending" | "removed";
      }>;
      // Tổng active header ChatGPT báo — forward về backend làm mốc chống
      // reconcile khi sync thiếu (xoá oan cả team).
      const expectedTotal =
        typeof data?.expected_total === "number" ? data.expected_total : null;

      // Update workspace's connected ChatGPT user nếu scrape được
      if (data?.user_info && (data.user_info.email || data.user_info.name)) {
        try {
          await updateExtensionInfo(config, data.user_info);
        } catch (e) {
          console.warn("[autogpt] updateExtensionInfo failed:", e);
        }
      }

      let totalCreated = 0;
      let totalUpdated = 0;
      const rogueEmailsAggregated: string[] = [];
      // Đích danh email biến động (backend trả per-call, cap 50/call) — gom để
      // đẩy vào task.result cho banner dashboard liệt kê thay đổi sau sync:
      // created = ChatGPT có mà hệ thống chưa có; removed = hệ thống có mà
      // ChatGPT không còn (user 2026-08-01).
      const createdEmailsAggregated: string[] = [];
      const removedEmailsAggregated: string[] = [];
      // Lệch số lượng sau sync (do backend đối chiếu ở request reconcile cuối) —
      // đích danh email để dashboard cảnh báo admin. null = khớp.
      let syncMismatch: SyncMismatch | null = null;
      try {
        // Bước 1: upsert từng chunk KHÔNG reconcile (isFullSync:false). Reconcile
        // per-chunk sẽ mark removed oan member của chunk khác (mỗi chunk chỉ thấy
        // 200 email của nó) — bug khi sync số lượng lớn (>200) tách nhiều chunk.
        for (let i = 0; i < members.length; i += CHUNK_SIZE) {
          const chunk = members.slice(i, i + CHUNK_SIZE);
          const result = (await bulkUpsertMembers(
            config,
            task.workspace_id,
            chunk,
            { isFullSync: false },
          )) as {
            created: number;
            updated: number;
            created_emails?: string[];
          };
          totalCreated += result.created;
          totalUpdated += result.updated;
          if (Array.isArray(result.created_emails)) {
            createdEmailsAggregated.push(...result.created_emails);
          }
          console.log(
            `[autogpt-sync-upsert] chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(
              members.length / CHUNK_SIZE,
            )}: +${result.created} ~${result.updated}`,
          );
        }

        // Bước 2: reconcile 1 LẦN trên TOÀN BỘ email đã scrape (members rỗng).
        // Bỏ qua nếu scrape rỗng — tránh xoá oan toàn team khi scrape lỗi/trống.
        // rogue-pending cũng tính từ tập đầy đủ này.
        //
        // NGOẠI LỆ (user 2026-07-22): "Lời mời chờ xử lý" (scope=invites) quét ra
        // 0 row mà ĐÃ VÀO ĐƯỢC tab (`invites_tab_ok`) = tab rỗng THẬT, không phải
        // scrape hỏng → VẪN phải gửi reconcile với danh sách RỖNG TƯỜNG MINH, để
        // backend đối chiếu và phát hiện mọi pending trên dashboard đều đã rời tab
        // Lời mời (→ tra tiếp tab Người dùng xem ai đã tham gia). Trước đây nhánh
        // này bị bỏ qua nên nút không đối chiếu được gì. An toàn: reconcile
        // scope=['pending'] không được phép mark removed (removal_scopes bỏ
        // 'pending' khi thiếu 'active' — reconcile.py).
        const invitesTabEmptyButValid =
          members.length === 0 &&
          scope === "invites" &&
          data?.invites_tab_ok === true;
        if (members.length > 0 || invitesTabEmptyButValid) {
          const reconcileEmails = members.map((m) => m.email);
          const reconcilePendingEmails = members
            .filter((m) => m.status === "pending")
            .map((m) => m.email);
          const result = (await bulkUpsertMembers(config, task.workspace_id, [], {
            scrapedStatuses,
            reconcileEmails,
            reconcilePendingEmails,
            // Gửi mốc header để backend đối chiếu trước khi mark removed.
            expectedTotal,
          })) as {
            rogue_pending_emails?: string[];
            reconcile_skipped?: boolean;
            reconcile_skip_reason?: string | null;
            joined_check_count?: number;
            joined_check_task_id?: string | null;
            mismatch?: SyncMismatch | null;
            removed_emails?: string[];
          };
          if (Array.isArray(result.rogue_pending_emails)) {
            rogueEmailsAggregated.push(...result.rogue_pending_emails);
          }
          if (Array.isArray(result.removed_emails)) {
            removedEmailsAggregated.push(...result.removed_emails);
          }
          // Lệch số lượng sau sync (đích danh email) → giữ để đẩy vào task.result
          // cho dashboard cảnh báo admin. Chỉ báo, KHÔNG tự xử lý ở đây.
          if (result.mismatch) {
            syncMismatch = result.mismatch;
            console.warn(
              `[autogpt-sync] LỆCH sau sync: ChatGPT header ${result.mismatch.expected_total ?? "?"} ` +
                `· AutoGPT ${result.mismatch.db_active} · thừa ${result.mismatch.extra_in_autogpt.length} ` +
                `· thiếu ${result.mismatch.missing_in_autogpt.length} · chưa xác định ${result.mismatch.unresolved_count}`,
            );
          }
          if (result.joined_check_count) {
            // Backend đã đối chiếu tab Lời mời với danh sách chờ tham gia và tự
            // tạo task tra tab "Người dùng" cho nhóm lệch — extension sẽ pick ở
            // vòng kế (hoặc ngay qua SSE task-available).
            console.log(
              `[autogpt-sync] ${result.joined_check_count} email lệch khỏi tab Lời mời ` +
                `→ đã tạo task tra tab Người dùng (${result.joined_check_task_id ?? "dedupe"})`,
            );
          }
          if (result.reconcile_skipped) {
            // Backend từ chối reconcile vì nghi sync thiếu → member đã upsert vẫn
            // được lưu, nhưng KHÔNG mark removed (dữ liệu cũ được giữ nguyên).
            console.warn(
              `[autogpt-sync] backend BỎ QUA reconcile (nghi sync thiếu): ` +
                `${result.reconcile_skip_reason ?? "?"} — sẽ đối chiếu ở lần sync đủ sau.`,
            );
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await updateTask(config, task.id, {
          status: "FAILED",
          error_code: "BULK_UPSERT_FAILED",
          error_message: msg,
        });
        return;
      }

      // Rogue emails (invite trên ChatGPT mà KHÔNG có Member record trong DB)
      // được đẩy vào task.result để dashboard hiển thị + hỏi admin xác nhận.
      // KHÔNG auto-revoke ở đây — admin chọn trên dashboard.
      if (rogueEmailsAggregated.length > 0) {
        console.log(
          `[autogpt-sync] phát hiện ${rogueEmailsAggregated.length} rogue pending invite(s):`,
          rogueEmailsAggregated,
        );
      }

      await updateTask(config, task.id, {
        status: "COMPLETED",
        result: {
          total: members.length,
          created: totalCreated,
          updated: totalUpdated,
          chunks: Math.ceil(members.length / CHUNK_SIZE),
          rogue_pending_emails: rogueEmailsAggregated,
          // Lệch sau sync (null nếu khớp) → dashboard hiện toast + banner cảnh báo.
          mismatch: syncMismatch,
          // Đích danh email biến động sau sync → banner liệt kê thay đổi.
          created_emails: createdEmailsAggregated,
          removed_emails: removedEmailsAggregated,
        },
      });
      return;
    }

    // Special case: INVITE_MEMBER. Sau khi click invite + verify dialog success,
    // extension đã scrape tab "Lời mời đang chờ xử lý" + tách verified vs
    // unverified emails. Chỉ verified members được bulk-upsert (scope='pending')
    // → dashboard không update records cho email mà ChatGPT KHÔNG nhận.
    if (task.type === "INVITE_MEMBER" && task.workspace_id) {
      const data = response.data as
        | {
            emails?: string[];
            pending_members?: Array<Record<string, unknown>>;
            verified_emails?: string[];
            unverified_emails?: string[];
            verify_scrape_failed?: boolean;
            submit_evidence?: SubmitEvidence;
          }
        | undefined;
      const pending = (data?.pending_members ?? []) as Array<{
        email: string;
        name?: string | null;
        chatgpt_role?: "owner" | "admin" | "member" | null;
        status?: "active" | "pending" | "removed";
      }>;
      const verifiedEmails = data?.verified_emails ?? [];
      const unverifiedEmails = data?.unverified_emails ?? [];
      const verifyScrapeFailed = data?.verify_scrape_failed === true;
      // Tổng email đã mời (từ verify data, fallback ghép verified+unverified).
      const emails =
        data?.emails ?? [...verifiedEmails, ...unverifiedEmails];

      let mappedCount = 0;
      if (pending.length > 0) {
        try {
          for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
            const chunk = pending.slice(i, i + CHUNK_SIZE);
            // v0.6.4 fix: isFullSync=false + bỏ scrapedStatuses → backend chỉ
            // upsert email trong chunk, KHÔNG reconcile/mark removed cho pending
            // members khác. Trước đây dùng scrapedStatuses=["pending"] gây bug:
            // verify g12 cùng giây với invite a12, scrape chưa thấy a12 → backend
            // reconcile → a12 bị mark "removed" oan. Lưu ý: việc reconcile thật
            // sự thuộc về SYNC_DATA task chuyên dụng, KHÔNG phải verify sau invite.
            await bulkUpsertMembers(config, task.workspace_id, chunk, {
              isFullSync: false,
            });
            mappedCount += chunk.length;
          }
          console.log(
            `[autogpt-invite] verify+map: ${mappedCount} verified email được upsert (no-reconcile)`,
          );
        } catch (e) {
          console.warn(
            "[autogpt-invite] bulk-upsert verified pending FAILED — task vẫn COMPLETED:",
            e,
          );
        }
      }
      // DỌN PHANTOM: email vừa mời nhưng KHÔNG có trong tab "Lời mời" (scrape OK)
      // → báo backend mark Member pending tương ứng 'removed'. Chỉ chạy khi scrape
      // KHÔNG fail (nếu fail thì giữ nguyên, SYNC_DATA sau sẽ reconcile chuẩn).
      // Đây là fix bug "đã add nhưng không có trong pending vẫn hiện trên web".
      // MỘT chỗ quyết định duy nhất cho cả "có dọn phantom không" lẫn "task hỏng hay
      // không" — xem invite-outcome.ts (có test). Bằng chứng toast của ChatGPT được
      // tin hơn việc email đã kịp xuất hiện trong danh sách hay chưa.
      const outcome = decideInviteOutcome({
        submitEvidence: data?.submit_evidence ?? "unknown",
        verifiedEmails,
        unverifiedEmails,
        verifyScrapeFailed,
      });
      let reconciledRemoved = 0;
      if (unverifiedEmails.length > 0) {
        console.warn(
          `[autogpt-invite] ${unverifiedEmails.length} email UNVERIFIED (KHÔNG tìm thấy trong tab Lời mời) — ` +
            `quyết định: ${outcome.status}/${outcome.reason}:`,
          unverifiedEmails,
        );
        if (outcome.shouldReconcile) {
          try {
            const r = await reconcileAfterInvite(config, task.workspace_id, {
              verifiedEmails,
              unverifiedEmails,
              verifyScrapeFailed,
            });
            reconciledRemoved = r.removed;
            console.log(
              `[autogpt-invite] reconcile-after-invite: ${r.removed} phantom pending member(s) đã mark removed`,
            );
          } catch (e) {
            console.warn(
              "[autogpt-invite] reconcile-after-invite FAILED — phantom members có thể còn:",
              e,
            );
          }
        }
      }

      // Status task lấy thẳng từ `outcome` (invite-outcome.ts — có test): chỉ báo
      // FAILED khi quét sạch, trắng tay VÀ ChatGPT cũng không hề xác nhận đã gửi.
      // Có toast xác nhận mà danh sách chưa hiện → COMPLETED + để email ở diện chưa
      // xác minh, backend hoãn 10' rồi resolver 20' phân xử bằng bằng chứng.
      const totalMissScrapeOk = outcome.status === "FAILED" && emails.length > 0;
      const resultPayload = {
        outcome_reason: outcome.reason,
        submit_evidence: data?.submit_evidence ?? "unknown",
        data: response.data ?? null,
        mapped_pending: mappedCount,
        verified_count: verifiedEmails.length,
        unverified_count: unverifiedEmails.length,
        unverified_emails: unverifiedEmails,
        verify_scrape_failed: verifyScrapeFailed,
        reconciled_removed: reconciledRemoved,
      };
      if (totalMissScrapeOk) {
        await updateTask(config, task.id, {
          status: "FAILED",
          error_code: "VERIFY_FAILED",
          error_message:
            `Đã submit ${emails.length} email + F5 verify nhưng KHÔNG email nào xuất hiện trong tab ` +
            `'Lời mời đang chờ xử lý'. Có thể: (a) toggle 'mời ngoài tên miền' chưa bật, ` +
            `(b) email đã là thành viên, (c) ChatGPT từ chối. Đã gỡ ${reconciledRemoved} bản ghi tạm khỏi dashboard. ` +
            `Email: ` +
            unverifiedEmails.slice(0, 5).join(", ") +
            (unverifiedEmails.length > 5
              ? ` +${unverifiedEmails.length - 5}`
              : ""),
          result: resultPayload,
        });
      } else {
        await updateTask(config, task.id, {
          status: "COMPLETED",
          result: resultPayload,
        });
      }
      return;
    }

    await updateTask(config, task.id, {
      status: "COMPLETED",
      result: { data: response.data ?? null },
    });
  } else {
    // INVITE_MEMBER fail vì KHÔNG bật được toggle external invites → extension đã
    // KHÔNG submit invite (xem execute-invite.ts). Backend đã pre-create Member
    // pending lúc bấm mời → phải DỌN để không hiện phantom "đang chờ".
    if (
      task.type === "INVITE_MEMBER" &&
      task.workspace_id &&
      response.error_code === "EXTERNAL_TOGGLE_FAILED"
    ) {
      const p = (task.payload ?? {}) as Record<string, unknown>;
      const payloadEmails: string[] = Array.isArray(p.emails)
        ? (p.emails as string[])
        : typeof p.email === "string"
          ? [p.email]
          : [];
      if (payloadEmails.length > 0) {
        try {
          const r = await reconcileAfterInvite(config, task.workspace_id, {
            verifiedEmails: [],
            unverifiedEmails: payloadEmails,
            verifyScrapeFailed: false,
          });
          console.log(
            `[autogpt-invite] EXTERNAL_TOGGLE_FAILED → dọn ${r.removed} phantom pending member(s)`,
          );
        } catch (e) {
          console.warn(
            "[autogpt-invite] reconcile sau EXTERNAL_TOGGLE_FAILED thất bại:",
            e,
          );
        }
      }
    }
    // BẰNG CHỨNG "đã bấm Gửi lời mời" phải theo được xuống backend: task FAILED mà
    // cú click ĐÃ xảy ra thì lời mời CÓ THỂ đang bay — backend KHÔNG được hoàn phí +
    // xoá bản ghi ngay, phải đi đối chiếu trước (xem completion.py::
    // defer_unverified_invite). Ở đây chỉ báo SỰ THẬT quan sát được, quyết định thuộc
    // backend. Extension cũ không gửi cờ này ⇒ backend giữ nguyên hành vi hoàn phí
    // ngay (không đổi hành vi cho bản cũ).
    const failData = (response as { data?: Record<string, unknown> }).data;
    const submitClicked =
      task.type === "INVITE_MEMBER" && failData?.submit_clicked === true;
    // GIỮ `data` của lỗi vào `result`. Trước đây chỉ giữ khi submit_clicked=true,
    // nên mọi số liệu đính kèm lỗi đều bị vứt — đúng lúc cần nhất để chẩn đoán.
    // Ca thật 22-23/8/2026: các task mời FAILED vì bước đếm suất đều có
    // seat_total/seat_free/seat_needed trong data, nhưng cột result trong DB là
    // NULL nên không tra được gì, phải đoán từ mỗi câu error_message.
    await updateTask(config, task.id, {
      status: "FAILED",
      error_code: response.error_code,
      error_message: response.error_message,
      ...(failData && Object.keys(failData).length > 0
        ? {
            result: {
              ...failData,
              ...(submitClicked
                ? {
                    submit_clicked: true,
                    chatgpt_error_hint: failData.chatgpt_error_hint ?? null,
                  }
                : {}),
            },
          }
        : {}),
    });
  }
}

async function applyRateLimit(): Promise<void> {
  const sinceLast = Date.now() - state.lastTaskAt;
  if (state.lastTaskAt > 0 && sinceLast < RATE_LIMIT.betweenTasksMs) {
    await sleep(RATE_LIMIT.betweenTasksMs - sinceLast);
  }

  if (state.tasksInBatch >= RATE_LIMIT.batchSize) {
    const pause =
      RATE_LIMIT.batchPauseMinMs +
      Math.floor(
        Math.random() *
          (RATE_LIMIT.batchPauseMaxMs - RATE_LIMIT.batchPauseMinMs),
      );
    console.log(`[autogpt] batch reached ${RATE_LIMIT.batchSize}, nghỉ ${pause}ms`);
    await sleep(pause);
    state.tasksInBatch = 0;
  }
}

let runUntilIdleInFlight: Promise<{
  processed: number;
  lastStatus: string;
  lastDetail?: string;
}> | null = null;

export function runUntilIdle(): Promise<{
  processed: number;
  lastStatus: string;
  lastDetail?: string;
}> {
  if (runUntilIdleInFlight) return runUntilIdleInFlight;
  // Đang xử lý queue → khoá auto-close tab admin (không cắt ngang task đang chạy).
  setRunnerBusy(true);
  runUntilIdleInFlight = doRunUntilIdle()
    .then(async (r) => {
      // CHỈ đánh dấu "vừa dùng tab admin" khi THỰC SỰ có task chạy. Backup poll
      // gọi runUntilIdle mỗi phút; nếu mark ở đây kể cả khi rỗng thì bộ đếm idle
      // sẽ reset liên tục → tab không bao giờ đóng.
      if (r.processed > 0) {
        try {
          await markAdminActivity();
        } catch (e) {
          console.warn("[autogpt-runner] markAdminActivity lỗi (bỏ qua)", e);
        }
      }
      return r;
    })
    .finally(() => {
      setRunnerBusy(false);
      runUntilIdleInFlight = null;
    });
  return runUntilIdleInFlight;
}

async function doRunUntilIdle(): Promise<{
  processed: number;
  lastStatus: string;
  lastDetail?: string;
}> {
  // SELF-HEAL: trước khi đụng tới queue, kiểm tra extension có "stale" không
  // (rebuild đổi hash file nhưng Chrome chưa reload). Nếu có → tự reload từ đĩa.
  // Chạy TRƯỚC pickNextTask nên không task nào bị claim rồi bỏ dở khi SW restart.
  //
  // ⚠ v0.7.6: reload NGAY khi stale, KỂ CẢ lúc rảnh (bỏ gate pending>0 của
  // v0.7.5) — để mỗi `npm run build` tự áp dụng trong ≤1 phút mà không cần
  // reload tay tại chrome://extensions. `reloadForStaleBuild` dedup theo build
  // signature (tối đa MAX_RELOADS_PER_SIG lần/build) nên KHÔNG loop dù dev
  // rebuild liên tục. isExtensionStale() (fetch file local) check trước nên case
  // bình thường (không stale) không tốn request mạng nào. Khi đang dev nên dùng
  // `npm run dev` (CRXJS HMR) — files do dev-server phục vụ luôn tồn tại nên
  // KHÔNG bị coi là stale → HMR tự reload, self-heal không xen vào.
  if (await selfHealIfStale()) {
    return { processed: 0, lastStatus: "self-heal-reloading" };
  }

  let processed = 0;
  for (let i = 0; i < 50; i++) {
    const r = await runOnce();
    if (r.status === "idle") {
      return { processed, lastStatus: r.status, lastDetail: r.detail };
    }
    if (
      r.status === "no-config" ||
      r.status === "unauthorized" ||
      r.status === "network-error" ||
      r.status === "no-admin-tab"
    ) {
      // Lỗi setup → dừng, không cố thử tiếp
      return { processed, lastStatus: r.status, lastDetail: r.detail };
    }
    processed += 1;
  }
  return { processed, lastStatus: "max-iterations" };
}

/**
 * Skip Phase 1+2 (modal chatgpt.com) — chỉ chạy Phase 3 (tab Hóa đơn scrape) +
 * Phase 4 (Stripe + Link payment chain). Background execute inline qua
 * chrome.scripting.executeScript thay vì depend on content script — tránh hẳn
 * vấn đề CRXJS loader fail sau extension reload.
 */
async function handlePurchaseSeatSkipMode(
  config: ExtensionConfig,
  task: QueueItem,
): Promise<{ status: string; detail?: string }> {
  const taskId = task.id;
  const reportPhase = async (phase: string, message: string) => {
    try {
      await updateProgress(config, taskId, { phase, message });
    } catch {}
  };

  await reportPhase("opening_tab", "Đang mở tab chatgpt.com/admin/billing?tab=invoices...");

  const tab = await ensureAdminTab();
  if (!tab || tab.id === undefined) {
    await updateTask(config, taskId, {
      status: "FAILED",
      error_code: "NOT_LOGGED_IN_CHATGPT",
      error_message:
        "Không mở được tab chatgpt.com/admin — user chưa đăng nhập ChatGPT trong browser này. " +
        SESSION_RECOVERY_HINT,
    });
    return { status: "no-admin-tab" };
  }
  const tabId = tab.id;

  // Navigate tab tới /admin/billing?tab=invoices nếu chưa
  if (!tab.url?.includes("billing") || !tab.url?.includes("tab=invoices")) {
    await chrome.tabs.update(tabId, {
      url: "https://chatgpt.com/admin/billing?tab=invoices",
      active: false,
    });
    await waitForTabComplete(tabId, 20_000);
    await sleep(2500);
  }

  await reportPhase("scrape_invoice", "Đang scrape invoice 'Đến hạn'...");

  // executeScript inline scrape — KHÔNG depend on content script
  let scraped: { url?: string; amount?: string; error?: string } | undefined;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        // Đợi anchor invoice.stripe.com xuất hiện (SPA mất 1-2s render)
        const deadline = Date.now() + 18_000;
        while (Date.now() < deadline) {
          const anchors = Array.from(
            document.querySelectorAll<HTMLAnchorElement>(
              'a[href*="invoice.stripe.com"]',
            ),
          );
          for (const a of anchors) {
            let row: HTMLElement | null = a;
            for (let i = 0; i < 6 && row; i++) {
              const rowText = (row.textContent ?? "").toLowerCase();
              const isDue =
                /đến\s*hạn|đến\s*ngày|due|unpaid|past\s*due|chưa\s*thanh\s*toán|未\s*付款|未支付|逾期/i.test(
                  rowText,
                );
              const isPaid = /đã\s*thanh\s*toán|paid|已\s*付款|已支付/i.test(rowText);
              if (isDue && !isPaid) {
                const amountMatch = (row.textContent ?? "").match(
                  /(\d{1,3}(?:[.,]\d{3}){1,3}(?:[.,]\d{1,2})?)\s*[₫đ]/i,
                );
                return {
                  url: a.href,
                  amount: amountMatch ? amountMatch[0].trim() : undefined,
                };
              }
              row = row.parentElement;
            }
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        return { error: "Timeout 18s — không tìm thấy invoice 'Đến hạn'" };
      },
    });
    scraped = results[0]?.result as typeof scraped;
  } catch (e) {
    await updateTask(config, taskId, {
      status: "FAILED",
      error_code: "UNKNOWN",
      error_message: `executeScript scrape failed: ${e instanceof Error ? e.message : String(e)}`,
    });
    return { status: "task-failed", detail: "scrape-exec-fail" };
  }

  if (!scraped?.url) {
    await updateTask(config, taskId, {
      status: "FAILED",
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        scraped?.error ?? "Không scrape được invoice 'Đến hạn' từ tab Hóa đơn.",
    });
    return { status: "task-failed", detail: "no-invoice" };
  }
  if (!scraped.amount) {
    await updateTask(config, taskId, {
      status: "FAILED",
      error_code: "VERIFY_FAILED",
      error_message: `Tìm thấy URL Stripe ${scraped.url} nhưng KHÔNG scrape được amount → không chain để tránh charge sai.`,
    });
    return { status: "task-failed", detail: "no-amount" };
  }

  console.log(
    `[autogpt-runner-skip] scraped: url=${scraped.url}, amount=${scraped.amount}`,
  );
  await reportPhase(
    "payment_chain",
    `Mở Stripe + Link checkout cho invoice ${scraped.amount}...`,
  );

  const chain = await runPaymentChain({
    taskId,
    stripeInvoiceUrl: scraped.url,
    expectedAmountText: scraped.amount,
  });

  await updateTask(config, taskId, {
    status: chain.ok ? "COMPLETED" : "FAILED",
    error_code: chain.ok ? undefined : chain.error_code,
    error_message: chain.ok ? undefined : chain.error_message,
    result: {
      data: {
        mode: "skip_to_payment_background",
        stripe_invoice_url: scraped.url,
        charge_amount_text: scraped.amount,
        payment_chain_stage: chain.stage,
        payment_chain_ok: chain.ok,
        payment_chain_stripe: chain.stripe_result?.ok ? chain.stripe_result.data ?? null : null,
        payment_chain_link: chain.link_result?.ok ? chain.link_result.data ?? null : null,
        payment_chain_stripe_error:
          chain.stripe_result && !chain.stripe_result.ok ? chain.stripe_result.error_message : null,
        payment_chain_link_error:
          chain.link_result && !chain.link_result.ok ? chain.link_result.error_message : null,
      },
    },
  });
  return {
    status: chain.ok ? "done" : "task-failed",
    detail: chain.ok ? undefined : chain.error_code,
  };
}

// Task PHÁ HUỶ (tạo thay đổi thật trên ChatGPT) → BỎ QUA khi workspace bật
// dry-run. Task read-only (SYNC_*/HARVEST/PING) KHÔNG nằm đây: vẫn chạy để
// dashboard có dữ liệu mới.
const DRY_RUN_BLOCKED_TYPES = new Set<string>([
  "INVITE_MEMBER",
  "REMOVE_MEMBER",
  "CHANGE_ROLE",
  "CHANGE_LICENSE_TYPE",
  "SET_USAGE_LIMIT",
  "REVOKE_INVITES",
  "PURCHASE_SEAT",
  // Cả 2 đều tạo thay đổi THẬT trên ChatGPT (xoá dữ liệu KHÔNG hoàn tác; xuất dữ
  // liệu gửi bản sao dữ liệu ra ngoài) → dry-run phải bỏ qua.
  "EXPORT_MEMBER_DATA",
  "DELETE_MEMBER_DATA",
]);

export async function runOnce(): Promise<{ status: string; detail?: string }> {
  console.log("[autogpt-runner] runOnce: starting");
  const config = await getConfig();
  if (!config) {
    console.warn("[autogpt-runner] runOnce: no-config (chưa save API key trong popup)");
    return { status: "no-config" };
  }

  let task: QueueItem | null;
  try {
    task = await pickNextTask(config);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      console.warn("[autogpt-runner] runOnce: 401 unauthorized");
      return { status: "unauthorized", detail: "API key sai" };
    }
    console.warn("[autogpt-runner] runOnce: pickNextTask network error", e);
    return { status: "network-error", detail: String(e) };
  }
  if (!task) {
    console.log("[autogpt-runner] runOnce: idle (no task)");
    return { status: "idle" };
  }

  console.log(`[autogpt-runner] picked task ${task.type} ${task.id}`);

  // ─── SHORT-CIRCUIT: DRY-RUN (workspace.dry_run_mode) ───────────────────
  // Backend đính `dry_run:true` vào payload khi workspace bật dry-run. Với task
  // PHÁ HUỶ, KHÔNG thao tác thật trên ChatGPT: báo COMPLETED kèm result.dry_run
  // để completion.py BỎ QUA mọi side-effect DB. Đặt TRƯỚC nhánh PURCHASE_SEAT
  // skip-mode vì mode đó tính tiền thật.
  if (task.payload?.dry_run === true && DRY_RUN_BLOCKED_TYPES.has(task.type)) {
    console.log(
      `[autogpt-runner] DRY-RUN: bỏ qua thao tác thật cho ${task.type} ${task.id}`,
    );
    await updateTask(config, task.id, {
      status: "COMPLETED",
      result: {
        dry_run: true,
        skipped: true,
        message: `Dry-run: KHÔNG thực thi ${task.type} thật trên ChatGPT.`,
      },
    });
    return { status: "dry-run-skipped", detail: task.type };
  }

  // ─── SHORT-CIRCUIT: PURCHASE_SEAT skip_to_payment mode ─────────────────
  // Mode này bypass content script chatgpt.com (vốn không reliable với CRXJS
  // loader sau khi extension reload). Background tự executeScript inline để
  // scrape invoice URL + amount → rồi chain Stripe + Link như bình thường.
  if (
    task.type === "PURCHASE_SEAT" &&
    (task.payload?.skip_to_payment as boolean | undefined) === true
  ) {
    return await handlePurchaseSeatSkipMode(config, task);
  }

  // Long-op task: báo progress lifecycle ngay từ background để dashboard biết
  // extension đã nhận task (không bị đứng yên trong khi mở tab + inject content).
  const isLongOp =
    task.type === "HARVEST_LABELS" || task.type === "SYNC_DATA";
  if (isLongOp) {
    await reportRunnerProgress(config, task.id, {
      phase: "queued",
      message: "Extension đã nhận task — đang chuẩn bị tab ChatGPT...",
      current: 0,
      total: task.type === "HARVEST_LABELS" ? 18 : 100,
    });
  }

  const request = taskToRequest(task);
  if (!request) {
    console.warn(`[autogpt-runner] task type chưa support: ${task.type}`);
    await updateTask(config, task.id, {
      status: "FAILED",
      error_code: "UNKNOWN",
      error_message: `Loại task chưa support: ${task.type}`,
    });
    return { status: "task-not-supported", detail: task.type };
  }

  if (isLongOp) {
    await reportRunnerProgress(config, task.id, {
      phase: "opening_tab",
      message: "Đang tìm/mở tab chatgpt.com/admin...",
      current: 0,
      total: task.type === "HARVEST_LABELS" ? 18 : 100,
    });
  }
  const tab = await ensureAdminTab();
  if (!tab || tab.id === undefined) {
    console.warn(
      "[autogpt-runner] NOT_LOGGED_IN_CHATGPT — không mở được admin tab (chưa login ChatGPT trong browser này)",
    );
    await updateTask(config, task.id, {
      status: "FAILED",
      error_code: "NOT_LOGGED_IN_CHATGPT",
      error_message:
        "Đã thử mở chatgpt.com/admin/members nhưng bị redirect — user chưa đăng nhập ChatGPT trong browser này. " +
        SESSION_RECOVERY_HINT,
    });
    return { status: "no-admin-tab" };
  }
  console.log(`[autogpt-runner] using admin tab ${tab.id} ${tab.url}`);

  // Các action thao tác trên LIST "Người dùng" của /admin/members (định vị row
  // theo email rồi mở menu "..."/dropdown). ensureAdminTab giờ LUÔN mở tab mới ở
  // /admin/members nên thường đã đúng trang; guard này giữ làm safety-net phòng
  // tab bị navigate đi đâu đó (vd action trước drift sang /admin/billing,
  // /admin/identity...). Nếu không ở /admin/members → ép navigate về, vì 3 sub-tab
  // Người dùng/Lời mời/Yêu cầu chỉ tồn tại trên trang này (nếu sai trang,
  // clickTabAndWait("Người dùng") no-op → locateMemberRow quét nhầm →
  // UI_ELEMENT_NOT_FOUND).
  const MEMBER_LIST_TASKS = new Set([
    "REMOVE_MEMBER",
    "CHANGE_ROLE",
    "CHANGE_LICENSE_TYPE",
    // 2 mục menu dữ liệu cũng chỉ có ở sub-tab "Người dùng" (member đã tham gia).
    "EXPORT_MEMBER_DATA",
    "DELETE_MEMBER_DATA",
  ]);
  // Các action này thao tác trên sub-tab "Người dùng". Phải ép về /admin/members SẠCH
  // (không query) khi tab SAI ở 1 trong 2 dạng:
  //   (a) KHÔNG ở /admin/members  — drift sang /admin/billing, /admin/identity…
  //   (b) Ở /admin/members NHƯNG còn ?tab=invites / ?tab=requests do action TRƯỚC
  //       để lại. ensureAdminTab (v0.8.21) tái dùng tab + chrome.tabs.reload() reload
  //       NGUYÊN URL → giữ ?tab=invites → reload thẳng vào tab "Lời mời". Check cũ
  //       `!includes('/admin/members')` KHÔNG bắt được vì URL có ?tab=invites VẪN
  //       chứa '/admin/members' → REMOVE lọc nhầm danh sách Lời mời, member active
  //       không có ở đó → REMOVE kết luận "đã rời business" → mark removed OAN
  //       (bug user 2026-06-29). Navigate về URL sạch luôn rớt về tab Người dùng.
  const memberTabUrl = tab.url ?? "";
  const onWrongSubTab = /[?&]tab=(invites|requests)/.test(memberTabUrl);
  const notOnMembersList = !memberTabUrl.includes("/admin/members");
  if (
    MEMBER_LIST_TASKS.has(task.type) &&
    tab.id !== undefined &&
    (notOnMembersList || onWrongSubTab)
  ) {
    console.log(
      `[autogpt-runner] ${task.type}: tab đang ở "${tab.url}" (không phải sub-tab Người dùng) → navigate về ${CHATGPT_ADMIN_URL}`,
    );
    await chrome.tabs.update(tab.id, { url: CHATGPT_ADMIN_URL, active: false });
    const navigated = await waitForTabComplete(tab.id, 20_000);
    if (navigated?.url && !navigated.url.includes("/admin")) {
      console.warn(
        `[autogpt-runner] sau navigate, tab bị redirect khỏi /admin (${navigated.url}) — có thể đã logout ChatGPT`,
      );
    }
    await sleep(1500); // chờ list member render xong trước khi locate
  }

  // SET_USAGE_LIMIT thao tác trên trang "Ghi đè mỗi người dùng"
  // (/admin/billing/manage_member_usage_limit) — KHÁC /admin/members. Nếu tab chưa
  // ở đúng trang → navigate tới, đợi render rồi mới dispatch (action sẽ check
  // pathname + lọc theo tên).
  if (
    task.type === "SET_USAGE_LIMIT" &&
    tab.id !== undefined &&
    !(tab.url ?? "").includes("manage_member_usage_limit")
  ) {
    console.log(
      `[autogpt-runner] SET_USAGE_LIMIT: tab đang ở "${tab.url}" → navigate tới ${CHATGPT_USAGE_LIMIT_URL}`,
    );
    await chrome.tabs.update(tab.id, {
      url: CHATGPT_USAGE_LIMIT_URL,
      active: false,
    });
    const navigated = await waitForTabComplete(tab.id, 20_000);
    if (navigated?.url && !navigated.url.includes("/admin")) {
      console.warn(
        `[autogpt-runner] sau navigate usage-limit, tab bị redirect khỏi /admin (${navigated.url}) — có thể đã logout ChatGPT`,
      );
    }
    await sleep(1500); // chờ list + ô lọc render xong trước khi locate
  }

  if (isLongOp) {
    await reportRunnerProgress(config, task.id, {
      phase: "rate_limit",
      message: "Đang chờ rate-limit + inject content script...",
      current: 0,
      total: task.type === "HARVEST_LABELS" ? 18 : 100,
    });
  }
  await applyRateLimit();
  console.log(`[autogpt-runner] sending ${request.kind} to content script...`);
  // PHASE 1 với hard-cap timeout (v0.7.17): nếu content không trả kết quả trong
  // ngưỡng của loại task (vd context bị huỷ khi navigate /admin/identity lúc mời
  // email ngoài domain) → fail sớm `CONTENT_TIMEOUT` thay vì treo tới backend
  // lazy-cleanup. KHÔNG dọn phantom ở đây: không chắc invite đã gửi hay chưa
  // (content có thể submit trước khi context chết) → để FAILED → backend phantom
  // cleanup (completion.py Case 1) hoặc SYNC_DATA định kỳ tự reconcile.
  const phase1Timeout = CONTENT_TIMEOUTS[task.type] ?? DEFAULT_CONTENT_TIMEOUT_MS;
  let response: ExecuteActionResponse;
  try {
    response = await withTimeout(
      sendToContent(tab.id, request),
      phase1Timeout,
      `content-${request.kind}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[autogpt-runner] Phase 1 ${request.kind} TIMEOUT/throw sau ${phase1Timeout}ms: ${msg}`,
    );
    response = {
      ok: false,
      error_code: "CONTENT_TIMEOUT",
      error_message:
        `Content script không trả kết quả cho ${request.kind} trong ` +
        `${Math.round(phase1Timeout / 1000)}s. Có thể tab ChatGPT bị reload/redirect ` +
        `giữa chừng (mất context content script) hoặc thao tác treo. Task được fail ` +
        `sớm để giải phóng hàng đợi thay vì kẹt tới auto-cleanup. ` +
        SESSION_RECOVERY_HINT +
        ` Lỗi gốc: ${msg}`,
    };
  }
  console.log(
    `[autogpt-runner] content script response: ok=${response.ok}`,
    response.ok ? "" : `err=${response.error_code}: ${response.error_message}`,
  );
  state.lastTaskAt = Date.now();
  state.tasksInBatch += 1;

  // ─── PRE-RELOAD cho INVITE email NGOÀI domain (v0.8.14) ───────────────────
  // Phase A (content) đã bật toggle 'mời ngoài tên miền' = ON và trả
  // `awaiting_external_reload`. SPA-nav KHÔNG làm ChatGPT refetch org-config →
  // dialog Mời vẫn cảnh báo "ngoài miền" + disable Send (user "luôn bị
  // EXTERNAL_TOGGLE_FAILED"). Background HARD-RELOAD /admin/members (full
  // navigation) để refetch config với external=ON, rồi gọi lại INVITE_MEMBER với
  // externalReady=true → content mở dialog mời thật sự (Phase A'). Đảm bảo 100%
  // setting đã có hiệu lực trước khi mời.
  if (
    response.ok &&
    task.type === "INVITE_MEMBER" &&
    request.kind === "INVITE_MEMBER" &&
    (response.data as { awaiting_external_reload?: boolean } | undefined)
      ?.awaiting_external_reload === true
  ) {
    console.log(
      `[autogpt-runner] INVITE external: Phase A bật toggle xong — HARD-RELOAD ${CHATGPT_ADMIN_URL} (tab ${tab.id}) để refetch org-config rồi mời.`,
    );
    await reportRunnerProgress(config, task.id, {
      phase: "external-reload",
      message:
        "Đã bật 'mời ngoài tên miền' — tải lại trang admin để setting có hiệu lực trước khi mời...",
    });
    try {
      await chrome.tabs.update(tab.id, { url: CHATGPT_ADMIN_URL, active: false });
      const reloaded = await waitForTabComplete(tab.id, 20_000);
      if (!reloaded?.url?.includes("/admin")) {
        response = {
          ok: false,
          error_code: "EXTERNAL_TOGGLE_FAILED",
          error_message:
            `Sau khi bật 'mời ngoài tên miền', tải lại /admin/members thì tab bị redirect khỏi /admin (url=${reloaded?.url ?? "?"}) — có thể đã logout ChatGPT. Huỷ mời để tránh phantom.`,
        };
      } else {
        const reinvite: ExecuteActionRequest = { ...request, externalReady: true };
        response = await withTimeout(
          sendToContent(tab.id, reinvite),
          phase1Timeout,
          `content-${reinvite.kind}-externalReady`,
        );
        console.log(
          `[autogpt-runner] INVITE external Phase A' response: ok=${response.ok}`,
          response.ok
            ? ""
            : `err=${(response as { error_code?: string }).error_code}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[autogpt-runner] INVITE external Phase A' TIMEOUT/throw: ${msg}`,
      );
      response = {
        ok: false,
        error_code: "CONTENT_TIMEOUT",
        error_message:
          `Sau khi bật 'mời ngoài tên miền' + reload, content không trả kết quả mời trong ` +
          `${Math.round(phase1Timeout / 1000)}s. ` +
          SESSION_RECOVERY_HINT +
          ` Lỗi gốc: ${msg}`,
      };
    }
  }

  // ─── PHASE 2 INVITE: F5 + VERIFY ──────────────────────────────────────────
  // Content's Phase 1 (submit) trả `awaiting_reload_verify: true` → background
  // chrome.tabs.reload(tab) để ChatGPT BUỘC fetch lại pending list từ server
  // (KHÔNG cache React Query). Sau khi load xong + content re-inject, gửi
  // VERIFY_PENDING_INVITE → content scrape pending → trả về verify result.
  // Merge result → reportToBackend như invite COMPLETED bình thường.
  //
  // SALVAGE (v0.10.1, bug user 2026-08-01): Phase 1 chết kiểu VÔ ĐỊNH — kênh
  // message đóng giữa chừng ("message channel closed" khi tab reload/navigate
  // sau khi content ĐÃ click Send), CONTENT_TIMEOUT, hoặc VERIFY_FAILED sau khi
  // đã bấm Gửi (v0.11.3, CA 1 ngày 12/8/2026) — thì invite CÓ THỂ đã đi rồi.
  // Trước đây báo FAILED luôn → backend hoàn phí + xoá phantom, nhưng người được
  // mời VẪN nhận lời mời → tham gia → sync auto-create member "chưa thanh toán"
  // (mất phí oan). Nay: chạy CHÍNH vòng verify Phase 2 để phân xử — thấy email ở
  // tab Lời mời/Người dùng → success thật; không thấy → giữ FAILED gốc.
  // Ranh giới "vô định vs hỏng thật" nằm trong invite-salvage.ts (có test).
  const inviteSalvageMode =
    !response.ok &&
    task.type === "INVITE_MEMBER" &&
    request.kind === "INVITE_MEMBER" &&
    shouldSalvageInvite(response);
  const inviteSalvageOriginalFailure: ExecuteActionResponse | null =
    inviteSalvageMode ? response : null;
  if (
    (response.ok || inviteSalvageMode) &&
    task.type === "INVITE_MEMBER" &&
    request.kind === "INVITE_MEMBER" &&
    (inviteSalvageMode ||
      (response.ok &&
        (response.data as { awaiting_reload_verify?: boolean } | undefined)
          ?.awaiting_reload_verify === true))
  ) {
    if (inviteSalvageMode) {
      console.warn(
        `[autogpt-runner] invite Phase 1 chết VÔ ĐỊNH (${!response.ok ? response.error_code : "?"}) — ` +
          `KHÔNG kết luận FAILED vội, chạy verify để phân xử. Lỗi gốc: ${!response.ok ? response.error_message : ""}`,
      );
      await reportRunnerProgress(config, task.id, {
        phase: "f5-verify",
        message:
          "Mất kết nối với trang giữa chừng (kết quả chưa rõ) — đang F5 + kiểm tra tab Lời mời để xác định lời mời đã đi chưa...",
      });
    } else {
      console.log(`[autogpt-runner] invite submit OK — F5 tab ${tab.id} để verify pending list`);
    }
    // Snapshot data submit để merge vào mọi fallback (giữ emails/count/role).
    // Salvage mode: Phase 1 không có data → snapshot rỗng.
    const submitData: Record<string, unknown> = response.ok
      ? (((response as { ok: true; data?: Record<string, unknown> }).data) ?? {})
      : {};
    // Bằng chứng ChatGPT đã NÓI RÕ "đã gửi lời mời" (toast) — chỉ Phase 1 đọc được.
    // PHẢI mang sang response của Phase 2 (xem chỗ gán `response = verifyResp`), nếu
    // không thì `decideInviteOutcome` luôn nhận "unknown".
    const submitEvidence = submitData.submit_evidence;
    // Fallback khi verify không chạy được: submit-OK → COMPLETED với
    // verify_scrape_failed (hành vi cũ); salvage → GIỮ NGUYÊN lỗi gốc (không có
    // bằng chứng invite đã đi thì không được báo thành công).
    const scrapeFailedFallback: ExecuteActionResponse = inviteSalvageMode
      ? (inviteSalvageOriginalFailure as ExecuteActionResponse)
      : {
          ok: true,
          data: {
            ...submitData,
            verified_emails: [],
            unverified_emails: request.emails,
            pending_members: [],
            verify_scrape_failed: true,
          },
        };

    // v0.7.15: vòng lặp F5 THẬT + verify trong NGÂN SÁCH VERIFY_BUDGET_MS (~10s).
    // Mỗi vòng: chrome.tabs.reload → wait complete → re-inject → VERIFY_PENDING_INVITE.
    // Dừng sớm khi: đủ email (Phase 2 báo needs_reload_retry=false), scrape fail,
    // hết MAX_VERIFY_RELOADS vòng, hoặc hết budget 10s.
    const verifyStart = Date.now();
    let round = 0;
    while (round < MAX_VERIFY_RELOADS) {
      round++;
      const elapsed = Date.now() - verifyStart;
      await reportRunnerProgress(config, task.id, {
        phase: "f5-verify",
        message:
          round === 1
            ? "Submit invite OK — F5 trang admin để ChatGPT load lại pending list..."
            : `Còn email chưa thấy — F5 lại (lần ${round}) để ChatGPT load tiếp...`,
      });
      try {
        await chrome.tabs.reload(tab.id);
        const reloaded = await waitForTabComplete(tab.id, 15_000);
        if (!reloaded?.url?.includes("/admin")) {
          console.warn(
            `[autogpt-runner] F5 sau invite (lần ${round}): tab redirect khỏi /admin (url=${reloaded?.url}) — verify skipped`,
          );
          response = scrapeFailedFallback;
          break;
        }
        // Re-inject content script vào tab vừa load
        const ready = await ensureContentInjected(tab.id);
        if (!ready.ok) {
          console.warn(`[autogpt-runner] sau F5 (lần ${round}): content inject failed → verify skipped`);
          response = scrapeFailedFallback;
          break;
        }
        const verifyResp = (await withTimeout(
          chrome.tabs.sendMessage(ready.tabId, {
            kind: "VERIFY_PENDING_INVITE",
            taskId: task.id,
            emails: request.emails,
            role: request.role,
          } satisfies ExecuteActionRequest),
          VERIFY_ROUNDTRIP_TIMEOUT_MS,
          "verify-pending-invite",
        )) as ExecuteActionResponse;
        console.log(
          `[autogpt-runner] verify round ${round}: ok=${verifyResp?.ok}`,
          verifyResp?.ok ? "" : `err=${verifyResp?.error_code}: ${verifyResp?.error_message}`,
        );
        // Verify response thay thế response submit (đã merge emails/count/role)
        response = verifyResp;

        const vdata =
          verifyResp?.ok
            ? ((verifyResp.data as Record<string, unknown> | undefined) ?? {})
            : {};
        // ⚠️ BƠM LẠI BẰNG CHỨNG SUBMIT (fix v0.11.3, CA 2 ngày 12/8/2026).
        // `response = verifyResp` GHI ĐÈ data của Phase 1, mà data của Phase 2
        // (execute-verify-pending.ts) KHÔNG có `submit_evidence` → tới
        // `decideInviteOutcome` luôn là "unknown" ⇒ nhánh "trusted-toast" của
        // invite-outcome.ts thành CODE CHẾT: ChatGPT đã báo "đã gửi lời mời" mà tab
        // Lời mời index trễ vẫn bị chốt total-miss → FAILED + hoàn phí + mark member
        // 'removed' dù lời mời đã đi thật. Chính cái nhánh v0.11.1 viết ra để chặn
        // mất tiền chưa từng chạy được lần nào.
        if (verifyResp?.ok && submitEvidence !== undefined) {
          if (vdata.submit_evidence === undefined) {
            vdata.submit_evidence = submitEvidence;
          }
          verifyResp.data = vdata;
        }
        // Scrape fail → reload nữa cũng không scrape được, giữ kết quả + thoát.
        if (vdata.verify_scrape_failed === true) break;
        // Đủ email (hoặc Phase 2 không yêu cầu reload) → xong.
        if (vdata.needs_reload_retry !== true) break;
        // Còn email thiếu nhưng hết budget → dùng kết quả cuối (unverified sẽ
        // được reconcile/cleanup ở backend). +1 vòng F5 ~3-5s nên cắt khi đã
        // tiêu quá nửa budget để không vượt 10s.
        if (Date.now() - verifyStart > VERIFY_BUDGET_MS) {
          console.log(
            `[autogpt-runner] verify hết budget ${VERIFY_BUDGET_MS}ms (elapsed ${elapsed}ms) — dừng, dùng kết quả vòng ${round}`,
          );
          break;
        }
      } catch (e) {
        console.warn(`[autogpt-runner] F5+verify vòng ${round} FAILED — fallback ok với scrape failed:`, e);
        response = scrapeFailedFallback;
        break;
      }
    }

    // Phase 2b: các email vẫn KHÔNG thấy trong tab "Lời mời" (scrape OK) có thể
    // đã được người dùng CHẤP NHẬN NHANH → rời tab Lời mời, sang tab "Người dùng"
    // (active). Kiểm tra CHÍNH các email đó ở tab Người dùng TRƯỚC khi reconcile
    // mark 'removed' — nếu không, email đã tham gia bị xoá oan (user report: lần
    // đồng bộ lời mời mới nhất). Chạy MỘT lần, ngoài vòng F5 (không làm chậm reload).
    if (response.ok && request.kind === "INVITE_MEMBER") {
      const vdata = (response.data as Record<string, unknown> | undefined) ?? {};
      const stillUnverified = (vdata.unverified_emails as string[] | undefined) ?? [];
      const scrapeFailed = vdata.verify_scrape_failed === true;
      if (!scrapeFailed && stillUnverified.length > 0) {
        try {
          const ready = await ensureContentInjected(tab.id);
          if (ready.ok) {
            const activeResp = (await withTimeout(
              chrome.tabs.sendMessage(ready.tabId, {
                kind: "CHECK_ACTIVE_AFTER_INVITE",
                taskId: task.id,
                emails: stillUnverified,
              } satisfies ExecuteActionRequest),
              VERIFY_ROUNDTRIP_TIMEOUT_MS,
              "check-active-after-invite",
            )) as ExecuteActionResponse;
            if (activeResp?.ok) {
              const adata =
                (activeResp.data as
                  | {
                      active_members?: Array<Record<string, unknown>>;
                      active_emails?: string[];
                    }
                  | undefined) ?? {};
              const activeEmails = (adata.active_emails ?? []).map((e) =>
                e.toLowerCase(),
              );
              if (activeEmails.length > 0) {
                const activeSet = new Set(activeEmails);
                const d = response.data as Record<string, unknown>;
                const prevVerified = (d.verified_emails as string[] | undefined) ?? [];
                const prevPending =
                  (d.pending_members as Array<Record<string, unknown>> | undefined) ?? [];
                // active → verified (upsert đúng status); loại khỏi unverified
                // (reconcile KHÔNG mark removed); gộp scraped member để upsert active.
                d.verified_emails = [...prevVerified, ...activeEmails];
                d.unverified_emails = stillUnverified.filter(
                  (e) => !activeSet.has(e.toLowerCase()),
                );
                d.pending_members = [...prevPending, ...(adata.active_members ?? [])];
                console.log(
                  `[autogpt-runner] Phase 2b: ${activeEmails.length} email đã sang tab Người dùng (active) — loại khỏi unverified, upsert active:`,
                  activeEmails,
                );
              } else {
                console.log(
                  `[autogpt-runner] Phase 2b: ${stillUnverified.length} email unverified KHÔNG có ở tab Người dùng → reconcile như cũ`,
                );
              }
            } else {
              console.warn(
                "[autogpt-runner] Phase 2b CHECK_ACTIVE_AFTER_INVITE không ok — giữ nguyên unverified:",
                activeResp?.error_code,
              );
            }
          }
        } catch (e) {
          console.warn(
            "[autogpt-runner] Phase 2b check active FAILED — giữ nguyên unverified:",
            e,
          );
        }
      }
    }

    // SALVAGE phân xử (sau cả Phase 2 + 2b): chỉ báo thành công khi CÓ BẰNG
    // CHỨNG (≥1 email thấy ở tab Lời mời hoặc Người dùng). Không bằng chứng /
    // scrape fail → trả về ĐÚNG lỗi gốc Phase 1 → backend hoàn phí như cũ.
    if (inviteSalvageMode && !response.ok) {
      // Verify tự nó cũng lỗi → không phân xử được. Trả về lỗi GỐC Phase 1
      // (dễ hiểu hơn lỗi phụ của vòng verify) → backend hoàn phí như cũ.
      response = inviteSalvageOriginalFailure as ExecuteActionResponse;
    } else if (inviteSalvageMode && response.ok) {
      const d = (response.data as Record<string, unknown> | undefined) ?? {};
      const verified = (d.verified_emails as string[] | undefined) ?? [];
      if (d.verify_scrape_failed === true || verified.length === 0) {
        console.warn(
          "[autogpt-runner] SALVAGE: verify không tìm thấy email nào — giữ kết luận FAILED gốc của Phase 1.",
        );
        response = inviteSalvageOriginalFailure as ExecuteActionResponse;
      } else {
        // Đánh dấu để trace: task này suýt bị báo FAILED oan.
        d.salvaged_after_indeterminate_error =
          inviteSalvageOriginalFailure && !inviteSalvageOriginalFailure.ok
            ? `${inviteSalvageOriginalFailure.error_code}: ${inviteSalvageOriginalFailure.error_message}`
            : "unknown";
        console.log(
          `[autogpt-runner] SALVAGE THÀNH CÔNG: ${verified.length}/${request.emails.length} email xác nhận đã mời dù Phase 1 mất kết nối — báo COMPLETED thay vì FAILED oan.`,
        );
      }
    }
  }

  await reportToBackend(config, task, response);

  // STALE_BUILD: task vừa được mark FAILED (immediate, không kẹt 5 phút). Giờ
  // self-heal reload EXTENSION để Chrome nạp build mới từ đĩa → task kế chạy được
  // ngay, không cần user reload tay. Đặt SAU reportToBackend để tránh limbo
  // IN_PROGRESS. reloadForStaleBuild() có guard count chống loop khi build hỏng.
  if (
    !response.ok &&
    (response as { error_code?: string }).error_code === "STALE_BUILD"
  ) {
    await reloadForStaleBuild("phát hiện khi gửi task tới content script");
    // reload kill SW ngay — return dưới có thể không chạy tới.
  }

  return {
    status: response.ok ? "done" : "task-failed",
    detail: response.ok ? undefined : (response as { error_code?: string }).error_code,
  };
}
