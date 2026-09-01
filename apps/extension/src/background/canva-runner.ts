/**
 * Runner nhánh CANVA — lấy lệnh của team Canva rồi thao tác trên canva.com.
 *
 * ĐỂ RIÊNG, KHÔNG động vào `runner.ts` (3.7k dòng bám chặt DOM ChatGPT: tab pool,
 * mua suất, chuỗi thanh toán Stripe, cứu lệnh dở dang). Nhánh Canva đơn giản hơn hẳn
 * — một tab, một trang, ba loại lệnh — nên nhét chung chỉ làm cả hai bên khó đọc và
 * mỗi lần sửa Canva lại phải sợ hỏng ChatGPT.
 *
 * Dùng chung phần đã có: `shared/api.ts` (nhận `config` nên chỉ cần truyền khoá
 * Canva), kiểu lệnh trong hàng đợi giữ NGUYÊN TÊN (INVITE_MEMBER / SYNC_DATA /
 * REMOVE_MEMBER) nên toàn bộ máy móc hoàn tất lệnh, hoàn phí, nhật ký bên backend
 * chạy y như nhánh ChatGPT.
 *
 * CHẠY MỘT LỆNH MỘT LÚC (`inFlight`): một Chrome chạy cả hai nhánh, hai tab tự động
 * giành CPU với nhau thì lệnh nào cũng chậm và dễ hỏng giữa chừng.
 */

import type { CanvaActionRequest, CanvaActionResponse, CanvaRole } from "../shared/messages";
import type { ExtensionConfig, QueueItem } from "../shared/types";
import {
  bulkUpsertMembers,
  pickNextTaskSingle,
  postCanvaInviteLinks,
  updateProgress,
  updateTask,
} from "../shared/api";
import { getCanvaConfig } from "../shared/storage";

const PEOPLE_URL = "https://www.canva.com/settings/people";
const PEOPLE_URL_RE = /canva\.com\/settings\/(people|members)/i;

/**
 * Chờ tab nạp xong (hoặc hết giờ) rồi trả lại thông tin tab.
 *
 * `expectUrl` = vừa ra lệnh điều hướng: phải chờ tab ĐỔI HẲN sang địa chỉ mới, không
 * chỉ chờ `status === "complete"`. Ngay sau `tabs.update`, Chrome vẫn báo trang CŨ
 * đang "complete" → hàm này trả về tức thì, rồi background ping vào content script
 * đang bị gỡ và nhận đủ 20 lượt im lặng (ca thật 31/8/2026: lệnh 53e28888 chết
 * TIMEOUT sau đúng 10,2 giây — vừa bằng 20 lượt ping).
 */
async function waitTabLoaded(
  tabId: number,
  timeoutMs = 30000,
  expectUrl: RegExp | null = null,
): Promise<chrome.tabs.Tab | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return null; // tab bị đóng giữa chừng
    }
    const urlOk = !expectUrl || expectUrl.test(tab.url ?? "");
    if (tab.status === "complete" && urlOk) return tab;
    if (Date.now() >= deadline) return tab ?? null;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * Tab canva.com đang ở TRANG CÀI ĐẶT (nếu có), ưu tiên tab đúng trang thành viên.
 *
 * Chỉ nhận tab `/settings/`: bản cũ lấy bừa `tabs[0]` — bất kỳ tab canva.com nào —
 * rồi điều hướng nó sang trang thành viên, tức là cướp luôn tab thiết kế người dùng
 * đang mở dở. Không có tab cài đặt thì mở tab nền mới, rẻ hơn nhiều so với việc đó.
 */
async function findCanvaSettingsTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({
    url: ["https://www.canva.com/settings/*", "https://canva.com/settings/*"],
  });
  const onPeople = tabs.find((t) => PEOPLE_URL_RE.test(t.url ?? ""));
  return onPeople ?? tabs[0] ?? null;
}

/** File JS của content script Canva, đọc từ MANIFEST ĐANG CHẠY.
 *
 * Vite build đổi tên `src/content/canva/index.ts` thành `assets/index.ts-<hash>.js`,
 * hash đổi mỗi lần build. Không hardcode được, mà cũng không dò trong `dist/` được:
 * thư mục đó không bao giờ được dọn nên chứa cả file của những bản build cũ. Chỉ
 * manifest của bản đang chạy mới nói đúng file nào.
 */
function canvaContentScriptFiles(): string[] {
  const scripts = (chrome.runtime.getManifest().content_scripts ?? []) as Array<{
    matches?: string[];
    js?: string[];
  }>;
  const entry = scripts.find((cs) =>
    (cs.matches ?? []).some((m) => m.includes("canva.com/settings")),
  );
  return entry?.js ?? [];
}

/** Diễn biến lần chữa gần nhất — nhét vào thông báo lỗi khi cả ba nấc đều hỏng. */
let healLog: string[] = [];

async function pingCanva(tabId: number): Promise<boolean> {
  return (await sendToTab(tabId, { kind: "CANVA_PING" }))?.ok === true;
}

/** Ping lại theo lịch chờ cho sẵn; trả `true` ngay khi có tiếng trả lời. */
async function pingRetries(tabId: number, delaysMs: number[]): Promise<boolean> {
  for (const ms of delaysMs) {
    await new Promise((r) => setTimeout(r, ms));
    if (await pingCanva(tabId)) return true;
  }
  return false;
}

/**
 * Đảm bảo content script Canva còn sống trong tab — TỰ CHỮA, không bắt người dùng F5.
 *
 * Vì sao cần: reload extension (hoặc build lại bản mới) giết mọi content script đã
 * nạp trong các tab đang mở. Tab vẫn nằm đúng trang thành viên, nhìn không khác gì,
 * nhưng không còn ai trả lời ping. Ca thật 1/9/2026: lệnh lúc 03:06 chết TIMEOUT sau
 * 20 giây ping, người dùng F5 tay thì lệnh ngay sau đó xong trong 2,7 giây — tức là
 * extension đã biết thừa phải làm gì mà lại đi bảo người dùng làm hộ.
 *
 * Ba nấc, xong ở nấc nào thì dừng ở đó:
 *   1. Tiêm lại content script (`scripting.executeScript`) — rẻ nhất, giữ nguyên trang.
 *   2. F5 tab rồi tiêm lại — đúng thao tác người dùng đang phải làm tay.
 *   3. Đóng tab, mở tab nền mới.
 *
 * Trả về tabId dùng được (có thể là tab MỚI ở nấc 3), hoặc null nếu chịu thua.
 */
async function ensureCanvaContentAlive(tabId: number): Promise<number | null> {
  healLog = [];
  const note = (m: string): void => {
    healLog.push(m);
    console.log(`[autogpt-canva] ${m}`);
  };

  // Trang vừa nạp xong vẫn cần vài trăm ms để content script kịp đăng ký.
  if (await pingCanva(tabId)) return tabId;
  if (await pingRetries(tabId, [300, 500, 700, 1000, 1500])) return tabId;
  note("ping đầu im lặng");

  const files = canvaContentScriptFiles();
  if (files.length === 0) {
    note("manifest không khai content script cho canva.com/settings");
    return null;
  }

  // Nấc 1 — tiêm lại.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
    note("đã tiêm lại content script");
  } catch (e) {
    note(`tiêm lại hỏng: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (await pingRetries(tabId, [250, 500, 700, 800, 1000])) {
    note("tiêm lại ăn");
    return tabId;
  }

  // Nấc 2 — F5 tab rồi tiêm lại.
  try {
    await chrome.tabs.reload(tabId);
    const reloaded = await waitTabLoaded(tabId, 20000, PEOPLE_URL_RE);
    note(`đã F5 tab, url=${reloaded?.url ?? "?"}`);
    if (reloaded?.url && PEOPLE_URL_RE.test(reloaded.url)) {
      if (await pingRetries(tabId, [500, 800, 1000])) {
        note("F5 xong là ăn");
        return tabId;
      }
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files });
      } catch (e) {
        note(`tiêm sau F5 hỏng: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (await pingRetries(tabId, [500, 800, 1000, 1500, 2000])) {
        note("F5 kèm tiêm lại ăn");
        return tabId;
      }
    }
  } catch (e) {
    note(`F5 tab hỏng: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Nấc 3 — bỏ hẳn tab cũ, mở tab nền mới.
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    /* tab có thể đã đóng — không sao, đằng nào cũng đang bỏ nó */
  }
  const fresh = await chrome.tabs.create({ url: PEOPLE_URL, active: false });
  if (fresh.id === undefined) {
    note("mở tab mới không ra tabId");
    return null;
  }
  note(`đã mở tab mới ${fresh.id}`);
  const loaded = await waitTabLoaded(fresh.id, 30000, PEOPLE_URL_RE);
  if (!loaded?.url || !PEOPLE_URL_RE.test(loaded.url)) {
    note(`tab mới không vào được trang thành viên (url=${loaded?.url ?? "?"})`);
    return null;
  }
  if (await pingRetries(fresh.id, [500, 800, 1000, 1500, 2000, 2000])) {
    note("tab mới ăn");
    return fresh.id;
  }
  note("tab mới vẫn im lặng");
  return null;
}

/**
 * Đảm bảo có một tab đang ở trang thành viên Canva và content script đã sẵn sàng.
 *
 * Mở tab NỀN (`active: false`): người dùng vẫn đang làm việc của họ, cướp màn hình
 * mỗi lần chạy lệnh là không dùng nổi.
 */
async function ensurePeopleTab(): Promise<
  { tabId: number } | { error: CanvaActionResponse & { ok: false } }
> {
  let tab = await findCanvaSettingsTab();
  let navigating = false;
  if (!tab?.id) {
    tab = await chrome.tabs.create({ url: PEOPLE_URL, active: false });
    navigating = true;
  } else if (!PEOPLE_URL_RE.test(tab.url ?? "")) {
    await chrome.tabs.update(tab.id, { url: PEOPLE_URL });
    navigating = true;
  }
  if (!tab?.id) {
    return {
      error: {
        ok: false,
        error_code: "UNKNOWN",
        error_message: "Không mở được tab canva.com.",
      },
    };
  }
  const loaded = await waitTabLoaded(tab.id, 30000, navigating ? PEOPLE_URL_RE : null);
  if (!loaded?.url) {
    return {
      error: { ok: false, error_code: "TIMEOUT", error_message: "Tab Canva không nạp xong." },
    };
  }
  if (!/canva\.com\/settings\//.test(loaded.url)) {
    // Canva đá về trang đăng nhập/trang chủ ⇒ chưa đăng nhập tài khoản đội.
    return {
      error: {
        ok: false,
        error_code: "NOT_LOGGED_IN_CANVA",
        error_message: `Tab bị chuyển khỏi trang cài đặt Canva (${loaded.url}) — đăng nhập tài khoản đội trong Chrome này trước.`,
      },
    };
  }

  const alive = await ensureCanvaContentAlive(tab.id);
  if (alive === null) {
    return {
      error: {
        ok: false,
        error_code: "TIMEOUT",
        error_message:
          "Content script Canva không phản hồi kể cả sau khi tiêm lại, tải lại tab và mở tab mới " +
          `— kiểm tra extension còn bật và đã đăng nhập Canva chưa. Diễn biến: ${healLog.join(" › ")}`,
      },
    };
  }
  return { tabId: alive };
}

/** Gửi message vào tab; lỗi kênh trả `null` thay vì ném (tab có thể vừa đóng). */
async function sendToTab(
  tabId: number,
  msg: CanvaActionRequest,
): Promise<CanvaActionResponse | null> {
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) as CanvaActionResponse;
  } catch {
    return null;
  }
}

/** Vai trò Canva lấy từ payload lệnh; thiếu/không hợp lệ → thành viên thường. */
function roleFromPayload(payload: Record<string, unknown>): CanvaRole {
  return payload.canva_role === "brand_designer" ? "brand_designer" : "member";
}

/**
 * Vai trò cho lệnh ĐỔI VAI TRÒ. Trả null khi xin một vai trò Canva không cho đặt.
 *
 * Không có mặc định ở đây, khác hẳn `roleFromPayload` của lệnh mời: mời thì đoán
 * thành viên thường là an toàn, còn đổi vai trò mà đoán bừa là tự ý nâng hoặc hạ
 * quyền một người đang dùng thật. Xin "admin"/"owner" thì DỪNG và báo rõ.
 *
 * Đọc cả `canva_role` lẫn `new_role` vì endpoint đổi vai trò đang dùng chung với
 * nhánh ChatGPT (payload bên đó đặt tên là `new_role`).
 */
function changeRoleFromPayload(payload: Record<string, unknown>): CanvaRole | null {
  const raw = payload.canva_role ?? payload.new_role ?? payload.role;
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (v === "brand_designer" || v === "team_brand_designer" || v === "designer") {
    return "brand_designer";
  }
  if (v === "member" || v === "team_member") return "member";
  return null;
}

function emailsFromPayload(payload: Record<string, unknown>): string[] {
  const many = payload.emails;
  if (Array.isArray(many)) return many.filter((e): e is string => typeof e === "string");
  const one = payload.email;
  return typeof one === "string" ? [one] : [];
}

/** Bao nhiêu lâu báo nhịp một lần trong lúc content script đang thao tác. */
const HEARTBEAT_MS = 20000;

/**
 * Bơm nhịp tiến độ suốt lượt chạy, trả về hàm tắt nhịp.
 *
 * Hai việc trong một. (1) `stuck_verdict` bên API đếm im lặng TỪ TICK GẦN NHẤT chứ
 * không từ lúc nhận lệnh, nên lệnh đang chạy thật không bị dọn oan giữa chừng.
 * (2) Mỗi tick là một lượt gọi mạng của extension — đủ để Chrome không coi service
 * worker là đang rảnh rồi giết nó trong lúc nó đứng chờ tab trả lời.
 *
 * Nhánh Canva trước đây KHÔNG báo nhịp nào (khác hẳn nhánh ChatGPT): lệnh mời
 * wiliamdio ngày 1/9/2026 nằm im ở IN_PROGRESS, không lỗi, không kết quả, và kéo cả
 * hàng đợi Canva đứng theo vì hàng đợi chạy tuần tự một lệnh một lúc.
 */
function startHeartbeat(config: ExtensionConfig, taskId: string, phase: string): () => void {
  let stopped = false;
  void (async () => {
    for (let beat = 1; !stopped; beat += 1) {
      await new Promise((r) => setTimeout(r, HEARTBEAT_MS));
      if (stopped) break;
      try {
        await updateProgress(config, taskId, {
          phase,
          message: `Đang thao tác trên trang Canva (${(beat * HEARTBEAT_MS) / 1000}s)`,
        });
      } catch {
        /* rớt một nhịp vì mạng — nhịp sau thử lại, không được làm hỏng lượt chạy */
      }
    }
  })();
  return () => {
    stopped = true;
  };
}

async function runOne(config: ExtensionConfig, task: QueueItem): Promise<void> {
  const stopHeartbeat = startHeartbeat(config, task.id, task.type.toLowerCase());
  try {
    await runOneInner(config, task);
  } finally {
    stopHeartbeat();
  }
}

async function runOneInner(config: ExtensionConfig, task: QueueItem): Promise<void> {
  const payload = (task.payload ?? {}) as Record<string, unknown>;
  const ready = await ensurePeopleTab();
  if ("error" in ready) {
    await updateTask(config, task.id, {
      status: "FAILED",
      error_code: ready.error.error_code,
      error_message: ready.error.error_message,
    });
    return;
  }
  const { tabId } = ready;

  let request: CanvaActionRequest;
  switch (task.type) {
    case "INVITE_MEMBER": {
      const role = roleFromPayload(payload);
      const emails = emailsFromPayload(payload);
      // "Gửi lại lời mời" trên dashboard đẻ ra INVITE_MEMBER kèm cờ `reinvite`. Nhánh
      // ChatGPT hiểu cờ đó là "thu hồi lời mời cũ rồi mời lại" vì bên đó không có nút
      // gửi lại. Canva CÓ nút "Resend invite" ngay trong dòng — đi lối thu hồi rồi
      // mời lại là làm hỏng link cũ khách đang giữ, và hộp mời cũng sẽ từ chối vì
      // email đã có lời mời treo. Xem `content/canva/resend.ts`.
      if (payload.reinvite === true && emails.length === 1) {
        request = { kind: "CANVA_RESEND_INVITE", taskId: task.id, email: emails[0] };
        break;
      }
      request = {
        kind: "CANVA_INVITE",
        taskId: task.id,
        entries: emails.map((email) => ({ email, role })),
      };
      break;
    }
    case "SYNC_DATA":
    // SYNC_MEMBER / SYNC_MEMBERS_BATCH: backend tự sinh sau lệnh mời để tra lại vài
    // email cụ thể ("đã vào đội chưa"). Bên ChatGPT phải lọc từng email vì danh sách
    // dài và chia trang; trang Canva chỉ có tối đa 50 người trên MỘT trang nên quét
    // trọn bảng đã trả lời luôn câu hỏi đó — dùng chung kịch bản đồng bộ.
    //
    // Không nhận hai loại này thì mỗi lần mời xong lại đẻ một lệnh FAILED
    // "chưa hỗ trợ" nằm chình ình trong nhật ký (ca thật 2026-09-01).
    case "SYNC_MEMBER":
    case "SYNC_MEMBERS_BATCH":
      request = { kind: "CANVA_SYNC", taskId: task.id };
      break;
    case "CHANGE_ROLE": {
      const email = emailsFromPayload(payload)[0];
      const role = changeRoleFromPayload(payload);
      if (!email) {
        await updateTask(config, task.id, {
          status: "FAILED",
          error_code: "UNKNOWN",
          error_message: "Lệnh đổi vai trò không có email.",
        });
        return;
      }
      if (!role) {
        await updateTask(config, task.id, {
          status: "FAILED",
          error_code: "UNSUPPORTED",
          error_message:
            "Team Canva chỉ đặt được hai vai trò: Thành viên đội và Nhà thiết kế thương hiệu " +
            `của đội. Lệnh này xin "${String(
              payload.canva_role ?? payload.new_role ?? payload.role,
            )}".`,
        });
        return;
      }
      request = { kind: "CANVA_CHANGE_ROLE", taskId: task.id, email, role };
      break;
    }
    case "REMOVE_MEMBER":
    // REVOKE_INVITES = thu hồi lời mời của người CHƯA bấm nhận. Trên Canva vẫn là
    // cùng một thao tác trong menu của dòng đó, nên dùng chung kịch bản gỡ. Job
    // "hết hạn tự gỡ" của backend sinh ra loại lệnh này cho member `pending`.
    case "REVOKE_INVITES":
      request = { kind: "CANVA_REMOVE", taskId: task.id, emails: emailsFromPayload(payload) };
      break;
    default:
      await updateTask(config, task.id, {
        status: "FAILED",
        error_code: "UNSUPPORTED",
        error_message: `Nhánh Canva chưa hỗ trợ lệnh ${task.type}.`,
      });
      return;
  }

  let res = await sendToTab(tabId, request);

  // Gửi lại lời mời mà email không còn trong bảng ⇒ chưa từng mời, hoặc lời mời đã
  // hết hạn rơi khỏi danh sách. Mời mới luôn thay vì bắt đại lý bấm lại lần nữa.
  if (
    request.kind === "CANVA_RESEND_INVITE" &&
    res?.ok === true &&
    res.data?.fallback_invite === true
  ) {
    console.log("[autogpt-canva] không còn lời mời để gửi lại — chuyển sang mời mới");
    request = {
      kind: "CANVA_INVITE",
      taskId: task.id,
      entries: [{ email: request.email, role: roleFromPayload(payload) }],
    };
    res = await sendToTab(tabId, request);
  }

  if (!res) {
    await updateTask(config, task.id, {
      status: "FAILED",
      error_code: "TIMEOUT",
      error_message: "Mất kênh với tab Canva giữa chừng (tab bị đóng hoặc tải lại?).",
    });
    return;
  }
  if (!res.ok) {
    await updateTask(config, task.id, {
      status: "FAILED",
      error_code: res.error_code,
      error_message: res.error_message,
      result: (res.data ?? null) as Record<string, unknown> | null,
    });
    return;
  }

  // ── Thành công: đẩy dữ liệu quét được rồi mới chốt lệnh ────────────────────
  const data = res.data ?? {};
  const SCRAPE_TYPES = ["SYNC_DATA", "SYNC_MEMBER", "SYNC_MEMBERS_BATCH"];
  if (SCRAPE_TYPES.includes(task.type) && task.workspace_id && Array.isArray(data.members)) {
    const members = data.members.map((m) => ({
      email: m.email,
      name: m.name ?? null,
      // Cột vai trò ChatGPT dùng chung cho cả hai nhánh: chủ đội Canva map về
      // "owner" để dashboard loại họ khỏi doanh thu như bên ChatGPT.
      chatgpt_role:
        m.role === "owner" ? ("owner" as const) : m.role === "admin" ? ("admin" as const) : ("member" as const),
      status: m.status,
    }));
    await bulkUpsertMembers(config, task.workspace_id, members, {
      scrapedStatuses: ["active", "pending"],
      isFullSync: true,
      expectedTotal: typeof data.team_size === "number" ? data.team_size : null,
    });
  }

  if (task.type === "INVITE_MEMBER" && task.workspace_id) {
    const links = data.invite_links;
    if (links && typeof links === "object" && Object.keys(links).length > 0) {
      try {
        await postCanvaInviteLinks(config, task.workspace_id, links as Record<string, string>);
      } catch (e) {
        // Link chỉ là tiện ích để đại lý gửi khách — mất link KHÔNG được phép làm
        // hỏng một lệnh mời đã gửi thật và đã trừ tiền.
        console.warn("[autogpt-canva] lưu liên kết mời thất bại", e);
      }
    }
  }

  await updateTask(config, task.id, {
    status: "COMPLETED",
    result: data as Record<string, unknown>,
  });
}

let inFlight: Promise<{ processed: number }> | null = null;

/** Rút cạn hàng đợi của team Canva. Gọi chồng nhau an toàn (chia sẻ cùng lượt chạy). */
export function runCanvaUntilIdle(): Promise<{ processed: number }> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let processed = 0;
    try {
      const config = await getCanvaConfig();
      if (!config) return { processed: 0 };
      for (let guard = 0; guard < 20; guard += 1) {
        const task = await pickNextTaskSingle(config);
        if (!task) break;
        console.log(`[autogpt-canva] chạy lệnh ${task.type} ${task.id}`);
        try {
          await runOne(config, task);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.warn("[autogpt-canva] lệnh lỗi", message);
          try {
            await updateTask(config, task.id, {
              status: "FAILED",
              error_code: "UNKNOWN",
              error_message: message,
            });
          } catch {
            /* mất mạng — để lệnh treo cho job dọn của backend xử lý */
          }
        }
        processed += 1;
      }
    } finally {
      inFlight = null;
    }
    return { processed };
  })();
  return inFlight;
}
