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
import { pickSeatFields, withExtraData } from "./invite-seat-fields";
import {
  planSeatReloadAfterPurchase,
  seatReloadFailureResponse,
  seatReloadRetryRequest,
} from "./seat-reload-plan";
import {
  judgeSeatsAfterReload,
  type SeatReadout,
} from "./seat-reload-verify";
import { markAdminActivity, markAdminTabActivity, setRunnerBusy } from "./idle-close";
import {
  acquireSlot,
  getSlotTabId,
  releaseSlot,
  replaceSlotTab,
  setSlotTabId,
  TAB_SLOTS,
  type TabSlot,
} from "./tab-pool";
import {
  acquireSeatLease,
  seatDemandForTask,
  type SeatLease,
} from "./seat-gate";
import { decideInviteOutcome, type SubmitEvidence } from "./invite-outcome";
import { waitForFreshContent } from "./content-ready";
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

const CHATGPT_ADMIN_URL = "https://chatgpt.com/admin/members";
// Trang "Ghi đè mỗi người dùng" — SET_USAGE_LIMIT thao tác ở đây (KHÁC /admin/members).
const CHATGPT_USAGE_LIMIT_URL =
  "https://chatgpt.com/admin/billing/manage_member_usage_limit";
const TAB_LOAD_TIMEOUT_MS = 30_000;

/**
 * Quy tắc quản lý tab chatgpt.com/admin — user chốt lại 2026-08-24 (thay quy tắc
 * "tái dùng tab MỚI NHẤT" 2026-06-23):
 *
 *   - Extension ĐÁNH DẤU tab của mình: mỗi tab tự mở được ghi vào một Ô
 *     (`tab-pool.ts`). Tối đa **2 ô** ⇒ tối đa 2 tab ⇒ **2 lệnh chạy đồng thời**.
 *   - Tab admin do USER tự mở KHÔNG bị đụng tới: không F5, không điều hướng,
 *     không đóng. (Trước đây runner tóm bất kỳ tab admin nào đang mở rồi F5 —
 *     kể cả tab user đang thao tác dở — và idle-close đóng sạch mọi tab admin.)
 *   - Ô đã có tab → **F5 làm mới dữ liệu trước khi chạy**. Ô trống → mở tab mới
 *     (đã là dữ liệu mới, không F5 thêm).
 *   - Action nào TỰ điều hướng/F5 ngay đầu luồng (SET_USAGE_LIMIT, PURCHASE_SEAT
 *     skip-mode) → bỏ qua lần F5 này, khỏi load thừa.
 *   - Task tiêu/mua suất (INVITE_MEMBER, PURCHASE_SEAT) đi qua KHOÁ SUẤT
 *     (`seat-gate.ts`): dư suất thì hai lệnh mời vẫn chạy song song, thiếu suất
 *     (phải mua) thì chạy LẦN LƯỢT dù có 2 ô.
 */

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
  // INVITE_MEMBER (2026-08-22): mời có thể phải MUA SUẤT trước nên tốn thêm gần
  // bằng một PURCHASE_SEAT — 150s sẽ cắt task GIỮA LÚC thanh toán (tiền đã trừ
  // mà task báo CONTENT_TIMEOUT), nên từng nâng lên 450s ngang backend (8').
  //
  // Hạ về 300s từ 26/8/2026, sau khi lượt gọi content bị CẮT LÀM HAI
  // (`awaiting_seat_reload`): lượt dài nhất giờ là lượt MUA — navigate + hộp
  // "Quản lý suất" + chờ giao dịch 120s + lớp phủ 20s ≈ 240s — rồi trả quyền về
  // background. Không còn lượt nào cần tới 450s.
  //
  // Vì sao PHẢI hạ chứ không để dư cho chắc: 450s DÀI HƠN tuổi thọ service
  // worker MV3, nên trong đúng ca nó sinh ra để bắt (SW bị Chrome khai tử giữa
  // lượt gọi dài — ba lệnh mời 26/8) đồng hồ này chết theo SW trước khi kịp nổ,
  // task im lặng tới lúc backend dọn ở 8'. Đặt dưới ngưỡng đó thì phần lớn ca
  // treo được extension tự báo `CONTENT_TIMEOUT` kèm số suất đã mua.
  INVITE_MEMBER: 300_000,
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
 * Đảm bảo Ô `slot` có một tab chatgpt.com/admin/members dùng được cho action.
 *
 * Quy tắc tab của user (2026-08-24 — thay quy tắc "tái dùng tab MỚI NHẤT" cũ):
 *   1. Ô đã có tab (extension mở từ lần trước, tab vẫn sống):
 *      - `preReload` → F5 làm mới dữ liệu TRƯỚC khi chạy. Đang ở /admin/members
 *        SẠCH thì reload tại chỗ; ở trang/sub-tab khác thì điều hướng về URL
 *        sạch — cũng là một lần load mới, mà lại rớt đúng tab "Người dùng"
 *        (reload nguyên URL sẽ giữ `?tab=invites` do action trước để lại).
 *      - `preReload=false` → dùng luôn. Dành cho action TỰ điều hướng/F5 ngay
 *        đầu luồng: F5 ở đây chỉ là một lần load thừa.
 *   2. Ô trống → mở tab MỚI. Tab mới nạp thẳng từ server nên đã là dữ liệu mới,
 *      KHÔNG F5 thêm.
 *   3. Tab bị redirect khỏi /admin (chưa đăng nhập ChatGPT) → trả null.
 *
 * TUYỆT ĐỐI không đụng tab admin do USER tự mở: chỉ tab nằm trong ô mới bị F5/
 * điều hướng/đóng. Trước đây runner tóm bất kỳ tab admin nào đang mở rồi F5 —
 * kể cả tab user đang thao tác dở.
 */
async function ensureAdminTab(
  slot: TabSlot,
  opts: { preReload: boolean },
): Promise<chrome.tabs.Tab | null> {
  const existingId = await getSlotTabId(slot);

  if (existingId !== null) {
    let current: chrome.tabs.Tab | null = null;
    try {
      current = await chrome.tabs.get(existingId);
    } catch {
      current = null;
    }
    if (current) {
      // Đồng hồ "để không" của RIÊNG tab này bắt đầu lại từ đây: tab đang được
      // đem ra chạy lệnh. Tab của ô kia không bị ảnh hưởng — xem `idle-close.ts`.
      await markAdminTabActivity(existingId);
      const url = current.url ?? "";
      // URL "sạch" = đúng /admin/members, không mang ?tab=invites/requests và
      // không phải sub-page. Chỉ khi đó F5 tại chỗ mới ra đúng tab Người dùng.
      const onCleanMembers =
        url.startsWith(CHATGPT_ADMIN_URL) &&
        url.length === CHATGPT_ADMIN_URL.length;

      if (!opts.preReload && url.includes("/admin")) {
        console.log(
          `[autogpt-runner] ô ${slot}: dùng lại tab ${existingId} KHÔNG F5 (action tự làm mới trang)`,
        );
        return current;
      }

      console.log(
        `[autogpt-runner] ô ${slot}: tab ${existingId} — ${
          onCleanMembers ? "F5 tại chỗ" : `điều hướng về ${CHATGPT_ADMIN_URL}`
        } để làm mới dữ liệu`,
      );
      if (onCleanMembers) {
        await chrome.tabs.reload(existingId);
      } else {
        await chrome.tabs.update(existingId, {
          url: CHATGPT_ADMIN_URL,
          active: false,
        });
      }
      const loaded = await waitForTabComplete(existingId, TAB_LOAD_TIMEOUT_MS);
      if (!loaded || !loaded.url) {
        console.warn(`[autogpt-runner] ô ${slot}: tab không load được sau F5`);
        return null;
      }
      if (!loaded.url.includes("/admin")) {
        console.warn(
          `[autogpt-runner] ô ${slot}: tab bị redirect khỏi /admin (${loaded.url}) — user chưa login ChatGPT`,
        );
        return null;
      }
      console.log(`[autogpt-runner] ô ${slot}: tab ${existingId} sẵn sàng ${loaded.url}`);
      return loaded;
    }
    // Tab trong sổ đã bị đóng (user đóng / Chrome dọn) → xoá sổ, mở tab mới.
    await setSlotTabId(slot, null);
  }

  console.log(
    `[autogpt-runner] ô ${slot}: mở tab admin MỚI ${CHATGPT_ADMIN_URL} (nền) — dữ liệu đã mới, không F5`,
  );
  const created = await chrome.tabs.create({
    url: CHATGPT_ADMIN_URL,
    active: false,
  });
  if (created.id === undefined) return null;
  await setSlotTabId(slot, created.id);
  await markAdminTabActivity(created.id);

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
    `[autogpt-runner] ô ${slot}: tab mới ${created.id} sẵn sàng ${loaded.url}`,
  );
  return loaded;
}

/**
 * Task TIÊU hoặc MUA suất đi qua KHOÁ SUẤT (`seat-gate.ts`) trước khi chạy —
 * luật do user chốt 2026-08-26:
 *
 *   - Còn dư suất sẵn (không phải mua) → hai lệnh mời chạy SONG SONG trong 2 ô tab.
 *   - Thiếu suất (phải mua) hoặc không biết còn bao nhiêu → 1 workspace chỉ chạy
 *     MỘT lệnh tại một thời điểm. Hai lệnh cùng đọc "còn 1 suất trống", cùng kết
 *     luận đủ, lệnh sau mời vào chỗ lệnh trước vừa lấy → ChatGPT bật hộp "Mua suất
 *     người dùng và gửi lời mời" (mua + mời trong MỘT cú bấm, không biết trước hết
 *     bao nhiêu tiền) — đúng cái hộp mà cả thiết kế đếm-suất-trước sinh ra để tránh.
 *
 * PURCHASE_SEAT luôn chạy một mình. Mọi loại task khác không đụng tới khoá này.
 *
 * Lease CHIA SẺ đi kèm một ràng buộc gửi xuống content: `noSeatPurchase` — đang
 * chạy song song thì TUYỆT ĐỐI không được mua suất. Content đếm lại tận nơi thấy
 * không đủ → trả `SEAT_LOCK_REQUIRED`, runner nâng khoá lên độc quyền rồi chạy
 * lại y hệt (xem chỗ gọi `seatLease.upgrade()`).
 */

async function pingContent(tabId: number): Promise<boolean> {
  return (await readContentLoadId(tabId)) !== null;
}

/**
 * `loadId` của content script đang trả lời trên tab, hoặc null nếu không ai trả
 * lời. Content script cũ (extension chưa reload sau khi build) không gửi `loadId`
 * → coi như chuỗi rỗng: vẫn "có người trả lời", chỉ mất khả năng phân biệt
 * instance — đúng hành vi cũ, không tệ hơn.
 */
async function readContentLoadId(tabId: number): Promise<string | null> {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { kind: "PING" });
    if (!resp?.ok) return null;
    const loadId = (resp.data as { loadId?: unknown } | undefined)?.loadId;
    return typeof loadId === "string" ? loadId : "";
  } catch {
    return null;
  }
}

/**
 * Sau một lần runner ĐIỀU HƯỚNG tab: chờ tới khi content script TRẢ LỜI LÀ
 * INSTANCE MỚI rồi mới cho gửi lệnh. Xem `content-ready.ts` để biết vì sao
 * `waitForTabComplete` một mình là chưa đủ (trang cũ vẫn trả lời PING trong khe
 * giữa "ra lệnh điều hướng" và "navigation commit", nhận lệnh xong mới tụt vào
 * bfcache → kênh đứt giữa chừng).
 *
 * Hết giờ mà vẫn chỉ có instance CŨ trả lời → inject lại bằng `executeScript`
 * (tạo instance mới, `loadId` mới) rồi thử lần cuối. Vẫn không được thì trả false
 * — caller PHẢI dừng, tuyệt đối không gửi lệnh vào instance cũ.
 */
async function ensureFreshContentAfterNav(
  tabId: number,
  prevLoadId: string | null,
  timeoutMs = 12_000,
): Promise<boolean> {
  const deps = {
    ping: () => readContentLoadId(tabId),
    now: () => Date.now(),
    sleep,
  };
  let r = await waitForFreshContent(prevLoadId, timeoutMs, deps);
  if (r.fresh) return true;
  console.warn(
    `[autogpt-runner] sau điều hướng, content script tab ${tabId} vẫn là instance CŨ ` +
      `(${r.reason}, loadId=${r.loadId ?? "?"}) → inject lại rồi thử lần cuối`,
  );
  const ready = await ensureContentInjected(tabId);
  if (!ready.ok) return false;
  r = await waitForFreshContent(prevLoadId, 3_000, {
    ...deps,
    ping: () => readContentLoadId(ready.tabId),
  });
  if (!r.fresh) {
    console.warn(
      `[autogpt-runner] vẫn instance CŨ (${r.reason}) — DỪNG, không gửi lệnh vào trang sắp bị đóng băng`,
    );
  }
  return r.fresh;
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
    // Ô đang trỏ tab vừa bị đóng → trỏ sang tab mới. Thiếu bước này thì ô giữ
    // một tabId chết còn tab mới thành mồ côi (idle-close không dọn được).
    await replaceSlotTab(tabId, newTabId);
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
 * Tắt toggle "mời ngoài tên miền" bằng một LỆNH RIÊNG sau khi lần mời đã trả kết
 * quả. Best-effort tuyệt đối: mọi lỗi chỉ log — task mời đã có kết luận, không
 * được để bước dọn dẹp này lật ngược nó.
 *
 * Trang có thể bị đóng băng (bfcache) trong lúc điều hướng sang /admin/identity —
 * đó chính là lý do bước này KHÔNG còn nằm trong lần mời. Ở đây kênh đứt chỉ có
 * nghĩa "không xác nhận được đã tắt", và người dùng còn thấy cảnh báo trong log.
 */
async function restoreExternalInvites(
  tabId: number,
  taskId: string,
): Promise<void> {
  try {
    const resp = await withTimeout(
      sendToContent(tabId, {
        kind: "SET_EXTERNAL_INVITES",
        taskId,
        enabled: false,
      }),
      60_000,
      "content-SET_EXTERNAL_INVITES",
    );
    const confirmed =
      resp.ok && (resp.data as { confirmed?: boolean } | undefined)?.confirmed;
    if (confirmed) {
      console.log("[autogpt-runner] đã tắt lại toggle 'mời ngoài tên miền'");
    } else {
      console.warn(
        "[autogpt-runner] KHÔNG xác nhận được toggle 'mời ngoài tên miền' đã tắt — " +
          "kiểm tra trên ChatGPT /admin/identity và tắt tay nếu cần. " +
          (resp.ok ? "" : `Lỗi: ${resp.error_code} ${resp.error_message}`),
      );
    }
  } catch (e) {
    console.warn(
      `[autogpt-runner] lệnh tắt toggle 'mời ngoài tên miền' lỗi (bỏ qua): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
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
      // Gợi ý số suất (backend `_seat_hint`) → content bỏ qua bước mở hộp
      // "Quản lý suất" khi thừa chỗ. Backend cũ chưa gửi → undefined.
      const rawHint = p.seat_hint;
      let seatHint:
        | { total: number | null; occupied: number; pending?: number }
        | undefined;
      if (rawHint && typeof rawHint === "object") {
        const h = rawHint as Record<string, unknown>;
        const total = typeof h.total === "number" && h.total > 0 ? h.total : null;
        const occupied =
          typeof h.occupied === "number" && h.occupied >= 0 ? h.occupied : null;
        // `pending` = nợ suất của lời mời đang treo. Backend cũ chưa gửi →
        // undefined → content tính chỗ trống y như trước.
        const pending =
          typeof h.pending === "number" && h.pending >= 0 ? h.pending : undefined;
        if (occupied !== null) seatHint = { total, occupied, pending };
      }
      return {
        kind: "INVITE_MEMBER",
        taskId: task.id,
        emails,
        role: (p.role as "owner" | "admin" | "member") ?? "member",
        verifiedDomain,
        newSeatCount,
        seatHint,
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
            seat_total?: number | null;
            seat_assigned?: number | null;
            seat_uncertain?: boolean;
            seat_stepper_total?: number | null;
            seat_modal_text?: string | null;
            invites_scanned?: boolean;
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
      // Backend TỪ CHỐI reconcile (nghi mẻ sync này thiếu dữ liệu) → member cũ
      // được giữ nguyên, KHÔNG ai bị mark removed. Phải báo về trong result:
      // backend dùng cờ này để KHÔNG tự mua bù suất theo số lời mời chờ trong DB
      // — đúng ca reconcile bị từ chối là ca DB còn ôm lời mời đã chết.
      let reconcileSkipped = false;
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
          reconcileSkipped = result.reconcile_skipped === true;
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
          // Số suất vừa đọc ở hộp "Quản lý suất" (null = không đọc được). Backend
          // ghi vào workspace nên tổng suất trên dashboard tươi lại sau mỗi lần
          // bấm "Đồng bộ từ ChatGPT" — xem `_absorb_seat_reading` (queue/completion.py).
          seat_total: typeof data?.seat_total === "number" ? data.seat_total : null,
          seat_assigned:
            typeof data?.seat_assigned === "number" ? data.seat_assigned : null,
          // Ba cờ chốt chặn cho việc backend TỰ MUA bù suất (tiền thật): số suất
          // có chắc chắn không, mẻ này có quét tab "Lời mời đang chờ" không, và
          // reconcile có bị từ chối không (bị từ chối = lời mời chết chưa dọn).
          seat_uncertain: data?.seat_uncertain === true,
          // Chỉ CÓ Ý NGHĨA khi `seat_uncertain` — giá trị bộ đếm và nội dung hộp,
          // để truy nguyên nhân vênh mà không phải nhờ người mở ChatGPT xem hộ.
          seat_stepper_total:
            typeof data?.seat_stepper_total === "number"
              ? data.seat_stepper_total
              : null,
          seat_modal_text:
            typeof data?.seat_modal_text === "string" ? data.seat_modal_text : null,
          invites_scanned: data?.invites_scanned === true,
          reconcile_skipped: reconcileSkipped,
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

  // HAI luồng chạy song song, mỗi luồng giữ một ô tab (user 2026-08-24: "cho phép
  // mở tối đa 2 tab để thực hiện lệnh, tức là có thể có 2 lệnh được thực hiện
  // đồng thời"). `acquireSlot` là chốt chặn thật: có 2 ô nên nhiều nhất 2 task
  // chạy cùng lúc, luồng thứ 3 (nếu sau này thêm) sẽ phải đợi.
  //
  // An toàn khi pick song song: `/api/v1/queue/next` chọn task bằng
  // `SELECT ... FOR UPDATE SKIP LOCKED` nên hai luồng KHÔNG bao giờ nhận trùng
  // một task. Riêng task tiêu/mua suất còn phải qua KHOÁ SUẤT (`seat-gate.ts`):
  // dư suất thì vẫn song song, thiếu suất thì lần lượt — xem chú thích ở đó.
  const MAX_TASKS_PER_DRAIN = 50;
  let processed = 0;
  let stopped = false;
  let lastStatus = "idle";
  let lastDetail: string | undefined;

  const worker = async (): Promise<void> => {
    while (!stopped && processed < MAX_TASKS_PER_DRAIN) {
      const r = await runOnce();
      lastStatus = r.status;
      lastDetail = r.detail;
      if (
        r.status === "idle" ||
        r.status === "no-config" ||
        r.status === "unauthorized" ||
        r.status === "network-error" ||
        r.status === "no-admin-tab"
      ) {
        // Hết task, hoặc lỗi setup → dừng CẢ HAI luồng (luồng kia chạy nốt task
        // đang dở rồi thoát, không nhận thêm).
        stopped = true;
        return;
      }
      processed += 1;
    }
  };

  await Promise.all(TAB_SLOTS.map(() => worker()));
  if (!stopped && processed >= MAX_TASKS_PER_DRAIN) {
    return { processed, lastStatus: "max-iterations" };
  }
  return { processed, lastStatus, lastDetail };
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
  slot: TabSlot,
): Promise<{ status: string; detail?: string }> {
  const taskId = task.id;
  const reportPhase = async (phase: string, message: string) => {
    try {
      await updateProgress(config, taskId, { phase, message });
    } catch {}
  };

  await reportPhase("opening_tab", "Đang mở tab chatgpt.com/admin/billing?tab=invoices...");

  // Việc đầu tiên của skip-mode là điều hướng tab sang /admin/billing?tab=invoices
  // — một lần load mới hoàn toàn. F5 /admin/members trước đó là load thừa.
  const tab = await ensureAdminTab(slot, { preReload: false });
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

/**
 * Chạy MỘT task: giữ một ô tab (tối đa 2 ô = 2 lệnh song song), chạy, rồi trả ô.
 *
 * Ô luôn được trả trong `finally` — kẹt ô là runner đứng im vĩnh viễn. Lease của
 * KHOÁ SUẤT (task mời/mua suất) cũng nhả ở đây, kể cả khi task ném lỗi.
 */
export async function runOnce(): Promise<{ status: string; detail?: string }> {
  const slot = await acquireSlot();
  // Bọc trong object để TypeScript không thu hẹp kiểu về `never` (biến chỉ được
  // gán bên trong closure nên nó tưởng không bao giờ có giá trị).
  const seat: { lease: SeatLease | null } = { lease: null };
  try {
    return await runOnceOnSlot(slot, async (task: QueueItem) => {
      const demand = seatDemandForTask(task);
      if (!demand) return null;
      const lease = await acquireSeatLease(demand);
      seat.lease = lease;
      console.log(
        `[autogpt-runner] khoá suất ${task.type}: ` +
          `${lease.shared ? "CHIA SẺ — chạy song song được" : "ĐỘC QUYỀN — chạy một mình"} ` +
          `(dashboard báo trống ${demand.free ?? "?"}, lệnh này cần ${demand.need})`,
      );
      return lease;
    });
  } finally {
    seat.lease?.release();
    releaseSlot(slot);
  }
}

async function runOnceOnSlot(
  slot: TabSlot,
  onTaskPicked: (task: QueueItem) => Promise<SeatLease | null>,
): Promise<{ status: string; detail?: string }> {
  console.log(`[autogpt-runner] runOnce: starting (ô ${slot})`);
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

  console.log(`[autogpt-runner] picked task ${task.type} ${task.id} (ô ${slot})`);
  // Task tiêu/mua suất phải xếp hàng sau task cùng loại đang chạy ở ô kia.
  const seatLease = await onTaskPicked(task);

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
    return await handlePurchaseSeatSkipMode(config, task, slot);
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
  // Lease CHIA SẺ = đang (hoặc sắp) chạy song song với lệnh khác ⇒ content KHÔNG
  // được mua suất: hai luồng cùng mua theo cùng một con số là mua đúp bằng tiền
  // thật. Đếm lại tận nơi mà thiếu thì content dừng với `SEAT_LOCK_REQUIRED`,
  // runner nâng khoá lên độc quyền rồi chạy lại (ngay dưới, sau Phase 1).
  if (request.kind === "INVITE_MEMBER") {
    request.noSeatPurchase = seatLease?.shared === true;
  }

  if (isLongOp) {
    await reportRunnerProgress(config, task.id, {
      phase: "opening_tab",
      message: "Đang tìm/mở tab chatgpt.com/admin...",
      current: 0,
      total: task.type === "HARVEST_LABELS" ? 18 : 100,
    });
  }
  // F5 tab đang mở để lấy dữ liệu mới trước khi chạy — TRỪ action tự điều hướng
  // sang trang khác ngay sau đây (F5 /admin/members rồi bỏ đi là load thừa).
  // Tab vừa mở mới thì `ensureAdminTab` cũng tự bỏ qua F5.
  const selfNavigates = task.type === "SET_USAGE_LIMIT";
  const tab = await ensureAdminTab(slot, { preReload: !selfNavigates });
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
    const prevLoadId = await readContentLoadId(tab.id);
    await chrome.tabs.update(tab.id, { url: CHATGPT_ADMIN_URL, active: false });
    const navigated = await waitForTabComplete(tab.id, 20_000);
    if (navigated?.url && !navigated.url.includes("/admin")) {
      console.warn(
        `[autogpt-runner] sau navigate, tab bị redirect khỏi /admin (${navigated.url}) — có thể đã logout ChatGPT`,
      );
    }
    // Chốt instance MỚI trước khi gửi lệnh — `status=complete` một mình không đủ,
    // trang cũ vẫn trả lời PING trong khe trước lúc navigation commit rồi mới tụt
    // vào bfcache (xem `content-ready.ts`). Ở đây không có tiền như nhánh mời,
    // nhưng gửi lệnh vào trang cũ nghĩa là thao tác trên DANH SÁCH CŨ: REMOVE lọc
    // nhầm, CHANGE_ROLE bấm nhầm dòng. Không chốt được thì vẫn đi tiếp (giữ hành
    // vi cũ) — chỉ cảnh báo, vì lệnh sau còn tự kiểm tra trang/element.
    if (!(await ensureFreshContentAfterNav(tab.id, prevLoadId))) {
      console.warn(
        `[autogpt-runner] ${task.type}: chưa chốt được trang mới sau navigate — đi tiếp, lệnh sẽ tự kiểm tra element`,
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
    const prevLoadId = await readContentLoadId(tab.id);
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
    // Như nhánh trên: chốt instance mới rồi mới gửi lệnh (xem `content-ready.ts`).
    // Gửi vào trang cũ ở đây = đặt giới hạn tín dụng theo danh sách CŨ.
    if (!(await ensureFreshContentAfterNav(tab.id, prevLoadId))) {
      console.warn(
        "[autogpt-runner] SET_USAGE_LIMIT: chưa chốt được trang mới sau navigate — đi tiếp, lệnh sẽ tự kiểm tra trang",
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
  // PHASE 1 với hard-cap timeout (v0.7.17): nếu content không trả kết quả trong
  // ngưỡng của loại task (vd context bị huỷ khi navigate /admin/identity lúc mời
  // email ngoài domain) → fail sớm `CONTENT_TIMEOUT` thay vì treo tới backend
  // lazy-cleanup. KHÔNG dọn phantom ở đây: không chắc invite đã gửi hay chưa
  // (content có thể submit trước khi context chết) → để FAILED → backend phantom
  // cleanup (completion.py Case 1) hoặc SYNC_DATA định kỳ tự reconcile.
  const phase1Timeout = CONTENT_TIMEOUTS[task.type] ?? DEFAULT_CONTENT_TIMEOUT_MS;
  const phase1TabId = tab.id;
  const dispatchPhase1 = async (): Promise<ExecuteActionResponse> => {
    console.log(`[autogpt-runner] sending ${request.kind} to content script...`);
    try {
      return await withTimeout(
        sendToContent(phase1TabId, request),
        phase1Timeout,
        `content-${request.kind}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[autogpt-runner] Phase 1 ${request.kind} TIMEOUT/throw sau ${phase1Timeout}ms: ${msg}`,
      );
      return {
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
  };
  let response = await dispatchPhase1();

  // ─── Mời song song mà tới nơi mới lộ ra THIẾU SUẤT ────────────────────────
  // Số suất dashboard gửi kèm task chỉ là gợi ý (có thể CŨ). Content đếm lại
  // bằng số THẬT trên trang; thiếu mà lease đang là CHIA SẺ thì nó KHÔNG tự mua
  // (đang chạy song song — hai luồng cùng mua là mua đúp bằng tiền thật) mà dừng
  // ngay với `SEAT_LOCK_REQUIRED`, TRƯỚC khi mở dialog mời.
  //
  // Ở đây nâng khoá lên ĐỘC QUYỀN (chờ lệnh kia chạy xong) rồi gửi lại y hệt.
  // Chạy lại an toàn vì bước suất là bước ĐẦU TIÊN của luồng mời: chưa bấm gì,
  // chưa bật toggle nào, tiền chưa suy suyển. Lần hai `noSeatPurchase=false` nên
  // content được phép mua bù như luồng cũ, và không thể lặp lần ba.
  if (
    !response.ok &&
    response.error_code === "SEAT_LOCK_REQUIRED" &&
    request.kind === "INVITE_MEMBER"
  ) {
    console.log(
      "[autogpt-runner] mời song song nhưng đếm tận nơi thấy thiếu suất → " +
        "nâng khoá suất lên ĐỘC QUYỀN rồi chạy lại lệnh mời",
    );
    await seatLease?.upgrade();
    request.noSeatPurchase = false;
    await applyRateLimit();
    response = await dispatchPhase1();
  }
  console.log(
    `[autogpt-runner] content script response: ok=${response.ok}`,
    response.ok ? "" : `err=${response.error_code}: ${response.error_message}`,
  );
  state.lastTaskAt = Date.now();
  state.tasksInBatch += 1;

  // ─── PRE-RELOAD sau khi MUA SUẤT (26/8/2026) ─────────────────────────────
  // Content đã mua bù suất (TIỀN ĐÃ TRỪ) nhưng hộp mua để lại lớp phủ trên trang
  // → mọi cú bấm của bước mời sẽ rơi vào lớp phủ.
  //
  // VÌ SAO PHẢI CẮT LƯỢT GỌI Ở ĐÂY: ba lệnh mời ngày 26/8 (fdeeadc5 11:25,
  // cd03d5ff 11:50, 3bc11c7b 12:10) chết im từ mốc `seat-purchased` tới khi
  // backend dọn ở mốc 8′, dù lời mời ĐÃ đi thật. `CONTENT_TIMEOUT` 450s cũng
  // không nổ — vì service worker giữ đồng hồ đó đã bị Chrome khai tử: cả lệnh
  // chạy trong MỘT lượt gọi content 4–5 phút (riêng hộp "Xác nhận mua" chờ
  // 180–200s). Dấu vết: một kết nối `/queue/stream` mới nằm giữa mốc tiến độ cuối
  // và lúc dọn = SW vừa khởi động lại. Lệnh mời không mua suất xong dưới 2 phút
  // nên không dính. Content tự điều hướng dọn trang cũng cắt kênh theo kiểu khác
  // (nhánh click `<a>` = điều hướng thật → back/forward cache, tai nạn 31/7).
  //
  // Nay content chỉ TRẢ CỜ, background dọn: hard-reload tab rồi gọi lại lệnh mời
  // trong LƯỢT MỚI — hai lượt ngắn thay cho một lượt dài.
  //   `seat_recheck_needed=false` → suất đã chốt bằng bộ đếm hộp mua → gọi lại với
  //                                `seatsReady` (bỏ hẳn bước suất) và mời ngay.
  //   `seat_recheck_needed=true`  → bộ đếm không chốt được tổng → gọi lại với
  //                                `seatsPurchasedAlready` để ĐỌC KIỂM, cấm mua lần hai.
  // Ba mệnh đề dính tiền của khối này (không mua lần hai, giữ số `seat_*`, hỏng
  // thì dừng trước khi mời) nằm trong `seat-reload-plan.ts` dạng hàm thuần để
  // test khoá được — ở đây chỉ còn phần điều khiển tab.
  const seatReloadPlan = planSeatReloadAfterPurchase(task.type, request.kind, response);
  // `request.kind` đã nằm trong điều kiện của `planSeatReloadAfterPurchase`; lặp
  // lại ở đây để TypeScript thu hẹp union về đúng nhánh lệnh MỜI.
  if (seatReloadPlan.kind === "reload" && request.kind === "INVITE_MEMBER") {
    const { purchased, recheck: recheckNeeded, seatFields: seatFieldsFromPurchase } =
      seatReloadPlan;
    console.log(
      `[autogpt-runner] INVITE suất: đã mua ${purchased} suất, trang còn lớp phủ → ` +
        `HARD-RELOAD ${CHATGPT_ADMIN_URL} (tab ${tab.id}) rồi ` +
        `${recheckNeeded ? "ĐỌC KIỂM lại số suất" : "mời ngay"}.`,
    );
    await reportRunnerProgress(config, task.id, {
      phase: "seat-reload",
      message: recheckNeeded
        ? `Đã mua ${purchased} suất (tiền đã trừ) — tải lại trang admin để đọc lại số suất rồi mời...`
        : `Đã mua ${purchased} suất (tiền đã trừ) — tải lại trang admin cho sạch rồi mời...`,
    });

    try {
      const prevLoadId = await readContentLoadId(tab.id);
      await chrome.tabs.update(tab.id, { url: CHATGPT_ADMIN_URL, active: false });
      const reloaded = await waitForTabComplete(tab.id, 20_000);
      if (!reloaded?.url?.includes("/admin")) {
        response = seatReloadFailureResponse(purchased, {
          reason: "off_admin",
          url: reloaded?.url ?? null,
        });
      } else if (!(await ensureFreshContentAfterNav(tab.id, prevLoadId))) {
        // Trang MỚI chưa chắc đã tiếp quản → KHÔNG gửi lệnh mời vào trang sắp bị
        // đóng băng (đúng chuỗi tai nạn 31/7 đã làm hoàn 340k oan). Dừng ở đây thì
        // chưa ai được mời — suất đã mua vẫn nằm trong workspace, lần chạy sau
        // thấy đủ suất và không mua nữa.
        response = seatReloadFailureResponse(purchased, { reason: "stale_content" });
      } else {
        const retry = seatReloadRetryRequest(request, seatReloadPlan);
        response = await withTimeout(
          sendToContent(tab.id, retry),
          phase1Timeout,
          `content-${retry.kind}-seatsReady`,
        );
        console.log(
          `[autogpt-runner] INVITE sau reload suất: ok=${response.ok}`,
          response.ok
            ? ""
            : `err=${(response as { error_code?: string }).error_code}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[autogpt-runner] INVITE sau reload suất TIMEOUT/throw: ${msg}`);
      response = {
        ok: false,
        error_code: "CONTENT_TIMEOUT",
        error_message:
          `ĐÃ MUA ${purchased} suất (tiền đã trừ trên ChatGPT). Sau khi tải lại trang, ` +
          `content không trả kết quả mời trong ${Math.round(phase1Timeout / 1000)}s. ` +
          SESSION_RECOVERY_HINT +
          ` Lỗi gốc: ${msg}`,
      };
    }

    // Số liệu suất chỉ tồn tại ở lượt MUA — lượt sau bỏ qua bước suất (hoặc chỉ
    // đọc kiểm) nên phải gắp sang kết quả cuối, kể cả khi lượt sau hỏng: "đã tiêu
    // tiền mua N suất" là thông tin quan trọng nhất của một task hỏng.
    if (Object.keys(seatFieldsFromPurchase).length > 0) {
      response = withExtraData(response, seatFieldsFromPurchase);
    }
  }

  // ─── F5 KIỂM CHỨNG khi mua suất kết thúc trong mập mờ (26/8/2026) ────────
  //
  // Ca user gửi ảnh 26/8: bấm nút cuối xong ChatGPT in băng-rôn đỏ "Đã xảy ra sự
  // cố khi cập nhật gói đăng ký của bạn" rồi TREO nguyên hộp. Băng-rôn đó không
  // nói được tiền đã trừ hay chưa, mà hộp còn che thì content cũng không đọc nổi
  // thẻ số suất trên trang. Vậy: background F5 trang admin → gọi lại content ở
  // chế độ CHỈ ĐỌC số suất → so với mốc trước khi mua:
  //   suất đã lên đủ  → giao dịch ĐÃ đi qua, task xong (không bấm thêm gì);
  //   suất y nguyên   → đọc lại vài lượt cho chắc (ChatGPT cập nhật chậm), vẫn
  //                     y nguyên thì chạy lại luồng mua ĐÚNG MỘT LẦN (user chốt);
  //   nhập nhằng      → DỪNG, báo admin — thà để người quyết còn hơn mua đúp.
  if (
    response.ok &&
    task.type === "PURCHASE_SEAT" &&
    request.kind === "PURCHASE_SEAT" &&
    (response.data as { needs_seat_reload_verify?: boolean } | undefined)
      ?.needs_seat_reload_verify === true
  ) {
    const buyData = ((response as { data?: Record<string, unknown> }).data ??
      {}) as Record<string, unknown>;
    const asNum = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    const qty = request.quantity;
    const banner =
      typeof buyData.charge_error_banner === "string"
        ? buyData.charge_error_banner
        : null;
    /**
     * Hộp xác nhận có nói "thay đổi có hiệu lực từ kỳ gia hạn sau" không. Có thì
     * số suất hôm nay KHÔNG phải bằng chứng gì cả — cấm đường mua lại.
     */
    const effectiveLaterText =
      typeof buyData.charge_effective_later_text === "string"
        ? buyData.charge_effective_later_text
        : null;
    /**
     * ChatGPT có in băng-rôn xanh "Gói đăng ký của bạn đã được cập nhật thành
     * công" không. Có ⇒ tiền ĐÃ trừ, cấm hẳn nhánh mua lại dù số suất đứng im.
     */
    const successToastText =
      typeof buyData.charge_success_toast === "string"
        ? buyData.charge_success_toast
        : null;
    /** Số suất trang in ra TRƯỚC khi bấm mua — mốc so chuẩn nhất (cùng nguồn). */
    const pageBefore: SeatReadout | null =
      buyData.seat_page_standard_before != null ||
      buyData.seat_page_total_before != null
        ? {
            standard: asNum(buyData.seat_page_standard_before),
            total: asNum(buyData.seat_page_total_before),
          }
        : null;

    console.log(
      `[autogpt-runner] PURCHASE_SEAT kết thúc mập mờ (banner=${banner ?? "không có"}) → ` +
        `HARD-RELOAD ${CHATGPT_ADMIN_URL} (tab ${tab.id}) rồi đọc lại số suất.`,
    );
    await reportRunnerProgress(config, task.id, {
      phase: "seat-reload-verify",
      message: successToastText
        ? `ChatGPT báo "${successToastText}" — tải lại trang để đọc số suất mới...`
        : banner
          ? `ChatGPT báo "${banner}" — tải lại trang để xem số suất đã lên chưa...`
          : "Chưa xác nhận được số suất — tải lại trang để đọc lại...",
    });

    /** Tải lại tab admin cho sạch. Trả null nếu xong, ngược lại là lý do hỏng. */
    const hardReloadAdmin = async (): Promise<string | null> => {
      const prevLoadId = await readContentLoadId(phase1TabId);
      await chrome.tabs.update(phase1TabId, {
        url: CHATGPT_ADMIN_URL,
        active: false,
      });
      const reloaded = await waitForTabComplete(phase1TabId, 20_000);
      if (!reloaded?.url?.includes("/admin")) {
        return (
          `tải lại /admin/members thì tab bị đẩy khỏi /admin (url=${reloaded?.url ?? "?"}) — ` +
          "có thể đã logout ChatGPT"
        );
      }
      if (!(await ensureFreshContentAfterNav(phase1TabId, prevLoadId))) {
        return (
          "sau khi tải lại, extension không xác nhận được trang MỚI đã tiếp quản nên " +
          "KHÔNG dám đọc số suất (đọc trúng trang cũ là số cũ)"
        );
      }
      return null;
    };

    try {
      // ChatGPT cập nhật gói đăng ký BẤT ĐỒNG BỘ: trang tải lại ngay sau giao dịch
      // có thể còn in số suất CŨ. Đọc đúng một lần rồi kết luận "chưa mua" là đủ
      // để mua đúp bằng tiền thật — nên chỉ dám nói "chưa mua" sau khi tải lại và
      // đọc lại ngần này lượt mà con số vẫn y nguyên. Phán quyết khác (đã mua /
      // không rõ) thì chốt ngay từ lượt đầu, không chờ thêm.
      const READ_ROUNDS = 3;
      const ROUND_GAP_MS = 6_000;
      let reloadErr: string | null = null;
      let verdict: ReturnType<typeof judgeSeatsAfterReload> | null = null;
      let after: SeatReadout = { total: null, standard: null };
      let assignedAfter: number | null = null;

      for (let round = 1; round <= READ_ROUNDS; round++) {
        if (round > 1) {
          await reportRunnerProgress(config, task.id, {
            phase: "seat-reload-verify",
            message:
              `Số suất chưa đổi (lượt ${round - 1}/${READ_ROUNDS}) — chờ ChatGPT cập nhật ` +
              "rồi tải lại đọc lần nữa trước khi quyết định...",
          });
          await sleep(ROUND_GAP_MS);
        }
        reloadErr = await hardReloadAdmin();
        if (reloadErr) break;

        const readReq: ExecuteActionRequest = { ...request, readSeatsOnly: true };
        const readResp = await withTimeout(
          sendToContent(tab.id, readReq),
          phase1Timeout,
          "content-PURCHASE_SEAT-readSeatsOnly",
        );
        const readData = ((readResp as { data?: Record<string, unknown> }).data ??
          {}) as Record<string, unknown>;
        after = {
          total: asNum(readData.seat_page_total),
          standard: asNum(readData.seat_page_standard),
        };
        assignedAfter = asNum(readData.seat_page_assigned);
        verdict = readResp.ok
          ? judgeSeatsAfterReload({
              qty,
              counterBefore: asNum(buyData.initial_seat),
              pageBefore,
              after,
              // Hộp nói "có hiệu lực vào kỳ sau" ⇒ cấm kết luận "chưa mua".
              effectiveLaterText,
              // ChatGPT đã báo "cập nhật thành công" ⇒ cũng cấm "chưa mua".
              successToastText,
            })
          : {
              kind: "unclear",
              reason:
                "đọc lại số suất sau khi tải trang cũng hỏng: " +
                `${(readResp as { error_code?: string }).error_code} — ` +
                `${(readResp as { error_message?: string }).error_message ?? "?"}`,
            };
        console.log(
          `[autogpt-runner] PURCHASE_SEAT lượt đọc ${round}/${READ_ROUNDS}: ${verdict.kind}`,
        );
        // Chỉ "chưa mua" mới đáng đọc lại — nó là phán quyết dẫn tới TIÊU TIỀN.
        if (verdict.kind !== "not_purchased") break;
      }

      if (reloadErr) {
        response = {
          ok: false,
          error_code: "SEAT_RELOAD_FAILED",
          error_message:
            `Đã bấm 'Xác nhận mua' ${qty} suất nhưng ChatGPT không xác nhận` +
            (banner ? ` (báo: "${banner}")` : "") +
            `. Không kiểm chứng được vì ${reloadErr}. ` +
            "CHƯA rõ tiền đã trừ hay chưa: admin mở ChatGPT xem số suất trước khi tạo task mua mới.",
          data: buyData,
        };
      } else if (!verdict) {
        response = {
          ok: false,
          error_code: "VERIFY_FAILED",
          error_message:
            `Đã bấm 'Xác nhận mua' ${qty} suất nhưng không chạy nổi lượt đọc lại nào ` +
            "sau khi tải lại trang. CHƯA rõ tiền đã trừ hay chưa — admin mở ChatGPT xem số suất.",
          data: buyData,
        };
      } else {

        const verifyFields: Record<string, unknown> = {
          seat_reload_verified: true,
          seat_reload_verdict: verdict.kind,
          seat_reload_basis: verdict.kind === "unclear" ? null : verdict.basis,
          seat_reload_before: verdict.kind === "unclear" ? null : verdict.before,
          seat_reload_after: verdict.kind === "unclear" ? null : verdict.after,
          seat_reload_delta: verdict.kind === "unclear" ? null : verdict.delta,
          seat_reload_reason: verdict.kind === "unclear" ? verdict.reason : null,
          seat_page_total_after_reload: after.total,
          seat_page_standard_after_reload: after.standard,
          seat_effective_later_text: effectiveLaterText,
          seat_success_toast: successToastText,
        };
        // Số đọc trên trang VỪA TẢI LẠI là số tươi nhất ta có → gửi cho backend
        // cập nhật `workspace.seat_total` (xem `_absorb_seat_reading`). KHÔNG gửi
        // ở nhánh mua lại: lượt hai sẽ đổi số ngay sau đó, gửi số cũ là ghi đè lùi.
        const freshSeatFields: Record<string, unknown> =
          after.total != null && after.total > 0
            ? {
                seat_total_after: after.total,
                ...(assignedAfter != null ? { seat_assigned_after: assignedAfter } : {}),
              }
            : {};
        console.log(
          `[autogpt-runner] PURCHASE_SEAT sau F5: ${verdict.kind}` +
            (verdict.kind === "unclear"
              ? ` (${verdict.reason})`
              : ` (${verdict.before} → ${verdict.after}, mốc ${verdict.basis})`),
        );

        if (verdict.kind === "purchased") {
          // Giao dịch ĐÃ đi qua, chỉ có màn hình ChatGPT hỏng. Không bấm gì thêm.
          response = {
            ok: true,
            data: {
              ...buyData,
              ...verifyFields,
              ...freshSeatFields,
              needs_seat_reload_verify: false,
              note:
                `✓ Đã mua ${qty} suất.` +
                (banner ? ` ChatGPT có báo "${banner}" nhưng` : " Hộp không đóng nhưng") +
                ` tải lại trang thì số suất đã lên ${verdict.before} → ${verdict.after} ` +
                "⇒ giao dịch đã đi qua, tiền đã trừ. Không mua lại.",
            },
          };
        } else if (verdict.kind === "not_purchased") {
          // Suất y nguyên sau khi tải lại ⇒ ChatGPT không ghi nhận gì. User chốt
          // 26/8: chạy lại luồng mua ĐÚNG MỘT LẦN. Lượt hai KHÔNG được vào lại
          // nhánh này (mua lại lần nữa là mua đúp) — kết quả của nó là kết quả
          // cuối, dù có mập mờ tiếp.
          console.log(
            `[autogpt-runner] PURCHASE_SEAT: suất vẫn ${verdict.after} sau F5 → mua lại ĐÚNG 1 lần`,
          );
          await reportRunnerProgress(config, task.id, {
            phase: "seat-repurchase",
            message:
              `Tải lại trang thấy số suất vẫn ${verdict.after} (chưa trừ tiền) — ` +
              "chạy lại lệnh mua đúng một lần...",
          });
          const retryResp = await withTimeout(
            sendToContent(phase1TabId, request),
            phase1Timeout,
            "content-PURCHASE_SEAT-retry-after-reload",
          );
          const retryData = ((retryResp as { data?: Record<string, unknown> })
            .data ?? {}) as Record<string, unknown>;
          const retryFields: Record<string, unknown> = {
            ...verifyFields,
            seat_repurchase_attempted: true,
            seat_first_attempt_error_banner: banner,
            // Lượt hai đã là lượt cuối: tắt cờ để không ai F5-kiểm-chứng thêm vòng nữa.
            needs_seat_reload_verify: false,
          };
          const retryAlsoUnclear =
            retryResp.ok && retryData.needs_seat_reload_verify === true;
          const retryIntro =
            `Lượt đầu ChatGPT báo hỏng${banner ? ` ("${banner}")` : ""} và tải lại trang xác nhận ` +
            `số suất chưa đổi (${verdict.before} → ${verdict.after}) nên đã mua lại. `;
          if (retryResp.ok && !retryAlsoUnclear) {
            response = {
              ok: true,
              data: {
                ...retryData,
                ...retryFields,
                note: retryIntro + `Kết quả lượt hai: ${String(retryData.note ?? "(không có ghi chú)")}`,
              },
            };
          } else if (retryAlsoUnclear) {
            // Lượt hai lại kết thúc mập mờ. KHÔNG kiểm chứng/mua thêm vòng nào
            // nữa — báo hỏng để admin cầm số thật mà quyết, còn hơn báo COMPLETED
            // cho một giao dịch không ai biết đã đi qua chưa.
            response = {
              ok: false,
              error_code: "VERIFY_FAILED",
              error_message:
                retryIntro +
                "Lượt hai CŨNG không xác nhận được: " +
                `${String(retryData.note ?? "(không có ghi chú)")} ` +
                "DỪNG tại đây, KHÔNG mua thêm lần nào — admin mở ChatGPT xem số suất thật " +
                "(có thể đã trừ tiền 1 hoặc 2 lần) rồi quyết.",
              data: { ...retryData, ...retryFields },
            };
          } else {
            response = withExtraData(retryResp, retryFields);
          }
        } else {
          // Không đủ căn cứ ⇒ DỪNG. Mua lại ở đây là canh bạc bằng tiền thật.
          response = {
            ok: false,
            error_code: "VERIFY_FAILED",
            error_message:
              `Đã bấm 'Xác nhận mua' ${qty} suất, ChatGPT không xác nhận` +
              (banner ? ` (báo: "${banner}")` : "") +
              `. Đã tải lại trang đọc lại số suất nhưng vẫn không kết luận được: ${verdict.reason}. ` +
              "KHÔNG mua lại để tránh mua đúp bằng tiền thật — admin mở ChatGPT xem số suất thật " +
              "rồi tạo task mua mới nếu còn thiếu.",
            data: { ...buyData, ...verifyFields, ...freshSeatFields },
          };
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[autogpt-runner] PURCHASE_SEAT F5 kiểm chứng TIMEOUT/throw: ${msg}`);
      response = {
        ok: false,
        error_code: "CONTENT_TIMEOUT",
        error_message:
          `Đã bấm 'Xác nhận mua' ${qty} suất nhưng ChatGPT không xác nhận` +
          (banner ? ` (báo: "${banner}")` : "") +
          `. Vòng tải lại trang để đọc lại số suất cũng không xong trong ` +
          `${Math.round(phase1Timeout / 1000)}s. CHƯA rõ tiền đã trừ hay chưa — ` +
          "admin mở ChatGPT xem số suất trước khi tạo task mua mới. " +
          SESSION_RECOVERY_HINT +
          ` Lỗi gốc: ${msg}`,
        data: buyData,
      };
    }
  }

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
    // Số liệu SUẤT (đọc tận nơi + mua bù) chỉ tồn tại ở Phase A: lần gọi thứ hai
    // (externalReady) BỎ QUA hẳn bước suất. Mọi nhánh bên dưới đều GHI ĐÈ
    // `response`, nên phải chụp lại ngay đây rồi gắp sang kết quả cuối.
    //
    // Ca thật 26/8/2026 — GPT1: lệnh mời mua bù 1 suất, ChatGPT lên 152 mà
    // dashboard vẫn 151. Nguyên nhân: mọi lệnh mời email NGOÀI TÊN MIỀN đều đi
    // đường hai pha này, kết quả về backend TRẮNG mọi trường `seat_*` nên
    // `_absorb_seat_reading` không có gì để ghi — `workspace.seat_total` đứng yên
    // vô thời hạn, kể cả khi extension vừa tiêu tiền thật để mua suất.
    const seatFieldsFromPhaseA = pickSeatFields(
      (response as { data?: Record<string, unknown> }).data,
    );

    try {
      // `loadId` của instance ĐANG chạy — đọc TRƯỚC khi ra lệnh điều hướng để
      // bên dưới nhận ra "trang mới" bằng cách so instance, không phải bằng cách
      // tin vào status=complete. Xem `ensureFreshContentAfterNav`.
      const prevLoadId = await readContentLoadId(tab.id);
      await chrome.tabs.update(tab.id, { url: CHATGPT_ADMIN_URL, active: false });
      const reloaded = await waitForTabComplete(tab.id, 20_000);
      if (!reloaded?.url?.includes("/admin")) {
        response = {
          ok: false,
          error_code: "EXTERNAL_TOGGLE_FAILED",
          error_message:
            `Sau khi bật 'mời ngoài tên miền', tải lại /admin/members thì tab bị redirect khỏi /admin (url=${reloaded?.url ?? "?"}) — có thể đã logout ChatGPT. Huỷ mời để tránh phantom.`,
        };
      } else if (!(await ensureFreshContentAfterNav(tab.id, prevLoadId))) {
        // Chưa chắc trang mới đã tiếp quản → KHÔNG gửi lệnh mời. Gửi vào trang
        // sắp bị đóng băng là đúng chuỗi tai nạn 31/7 (mời đi thật rồi mất kênh
        // → hoàn 340k oan). Dừng ở đây thì chưa ai được mời, hoàn phí là ĐÚNG.
        response = {
          ok: false,
          error_code: "EXTERNAL_TOGGLE_FAILED",
          error_message:
            "Sau khi bật 'mời ngoài tên miền' và tải lại trang admin, extension không xác nhận được " +
            "trang MỚI đã tiếp quản (trang cũ vẫn đang giữ kênh liên lạc, sắp bị Chrome đóng băng). " +
            "Đã huỷ TRƯỚC khi mời để không mời trong lúc mất kênh — chưa email nào được mời. " +
            "Chạy lại lệnh; nếu lặp lại, F5 tab ChatGPT rồi thử lần nữa.",
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

    // Gắp số liệu suất của Phase A sang kết quả cuối (mọi nhánh trên đều đã ghi
    // đè `response`). Chỉ lấy các khoá `seat_*` — KHÔNG mang theo
    // `awaiting_external_reload`, nó là cờ điều phối của riêng Phase A. Khoá do
    // Phase A' tự sinh được ưu tiên giữ.
    //
    // Gắp cả khi Phase A' HỎNG là cố ý: nếu suất đã mua (tiền đã trừ) thì đó là
    // thông tin quan trọng nhất của cả task hỏng đó.
    if (Object.keys(seatFieldsFromPhaseA).length > 0) {
      response = withExtraData(response, seatFieldsFromPhaseA);
      console.log(
        `[autogpt-runner] INVITE external: gắp ${Object.keys(seatFieldsFromPhaseA).length} ` +
          `trường số liệu suất từ Phase A sang kết quả cuối ` +
          `(tổng=${String(seatFieldsFromPhaseA.seat_total ?? "?")}, ` +
          `mua thêm=${String(seatFieldsFromPhaseA.seat_purchased ?? 0)})`,
      );
    }

    // ─── TẮT LẠI TOGGLE (spec bảo mật) — LÀM Ở ĐÂY, KHÔNG PHẢI TRONG LẦN MỜI ──
    // Bước tắt phải điều hướng sang /admin/identity. Trước đây content tự làm
    // trong `finally` của chính lần mời, nên trang đang giữ kênh message bị Chrome
    // đẩy vào back/forward cache và kết quả mời KHÔNG về được background → task
    // báo hỏng dù lời mời ĐÃ đi → backend hoàn phí + xoá bản ghi (ca 2a5d6450
    // ngày 31/7/2026: hoàn 340.000đ oan, hôm sau phải thu lại tay).
    //
    // Giờ `response` đã nằm trong tay, mọi thứ sau đây là DỌN DẸP: mất kênh ở
    // bước tắt cũng không đổi được kết luận của task. Chạy KHÔNG ĐIỀU KIỆN cho
    // nhánh external (không phụ thuộc cờ `needs_external_restore`): mời hỏng thì
    // toggle vẫn ON, càng phải tắt; content bản cũ tự tắt rồi thì lệnh này thấy
    // OFF sẵn và bỏ qua.
    await restoreExternalInvites(tab.id, task.id);
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
    // ⚠️ SỐ SUẤT cũng CHỈ có ở Phase 1 — và `response = verifyResp` bên dưới ghi
    // đè sạch `data` của Phase 1. Chụp lại ngay đây rồi gắp sang kết quả cuối.
    //
    // CA THẬT 28/8/2026 — GPT1: lệnh mời 10:08 về backend TRẮNG mọi trường
    // `seat_*` nên `_absorb_seat_reading` không có gì để ghi; dashboard đứng ở
    // 257 suất trong khi ChatGPT đã 270. Đây là nhánh đi của GẦN NHƯ MỌI lệnh
    // mời (submit xong là F5 verify), nặng hơn hẳn nhánh mời-ngoài-tên-miền vốn
    // đã được vá bằng đúng cách này (xem `invite-seat-fields.ts`).
    const seatFieldsFromSubmit = pickSeatFields(submitData);
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
        const prevLoadId = await readContentLoadId(tab.id);
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
        // …và phải là instance của trang VỪA LOAD. Trang cũ cũng trả lời PING
        // trong khe trước lúc navigation commit; verify trên DOM cũ = đọc danh
        // sách Lời mời CHƯA có email vừa mời → kết luận "không thấy" → báo hỏng
        // oan đúng lúc lời mời đã đi thật. Không chắc thì bỏ vòng verify này,
        // để `scrapeFailedFallback` nói thẳng là chưa xác minh được.
        if (!(await ensureFreshContentAfterNav(ready.tabId, prevLoadId))) {
          console.warn(
            `[autogpt-runner] sau F5 (lần ${round}): chưa chắc trang mới đã tiếp quản → verify skipped`,
          );
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

    // Gắp SỐ SUẤT của Phase 1 sang kết quả cuối — làm SAU cùng để mọi nhánh trên
    // (verify OK, scrape fail, salvage giữ lỗi gốc) đều mang được số về backend.
    // Khoá do Phase 2 tự sinh vẫn thắng: nó là lần đọc mới hơn.
    if (Object.keys(seatFieldsFromSubmit).length > 0) {
      response = withExtraData(response, seatFieldsFromSubmit);
      console.log(
        `[autogpt-runner] invite F5-verify: gắp ${Object.keys(seatFieldsFromSubmit).length} ` +
          `trường số liệu suất từ Phase 1 sang kết quả cuối ` +
          `(tổng=${String(seatFieldsFromSubmit.seat_total ?? "?")}, ` +
          `đã gán=${String(seatFieldsFromSubmit.seat_assigned ?? "?")}, ` +
          `mua thêm=${String(seatFieldsFromSubmit.seat_purchased ?? 0)})`,
      );
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
