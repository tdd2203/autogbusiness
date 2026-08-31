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
  updateTask,
} from "../shared/api";
import { getCanvaConfig } from "../shared/storage";

const PEOPLE_URL = "https://www.canva.com/settings/people";

/** Chờ tab nạp xong (hoặc hết giờ) rồi trả lại thông tin tab. */
async function waitTabLoaded(tabId: number, timeoutMs = 30000): Promise<chrome.tabs.Tab | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return null; // tab bị đóng giữa chừng
    }
    if (tab.status === "complete") return tab;
    if (Date.now() >= deadline) return tab ?? null;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Tab canva.com đang mở (nếu có), ưu tiên tab đang ở đúng trang thành viên. */
async function findCanvaTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ url: ["https://www.canva.com/*", "https://canva.com/*"] });
  const onPeople = tabs.find((t) => /\/settings\/(people|members)/.test(t.url ?? ""));
  return onPeople ?? tabs[0] ?? null;
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
  let tab = await findCanvaTab();
  if (!tab?.id) {
    tab = await chrome.tabs.create({ url: PEOPLE_URL, active: false });
  } else if (!/\/settings\/(people|members)/.test(tab.url ?? "")) {
    await chrome.tabs.update(tab.id, { url: PEOPLE_URL });
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
  const loaded = await waitTabLoaded(tab.id);
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

  // Content script sẵn sàng chưa (trang vừa nạp xong vẫn cần vài trăm ms).
  for (let i = 0; i < 20; i += 1) {
    const pong = await sendToTab(tab.id, { kind: "CANVA_PING" });
    if (pong?.ok) return { tabId: tab.id };
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    error: {
      ok: false,
      error_code: "TIMEOUT",
      error_message: "Content script Canva không phản hồi — thử tải lại tab canva.com.",
    },
  };
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

function emailsFromPayload(payload: Record<string, unknown>): string[] {
  const many = payload.emails;
  if (Array.isArray(many)) return many.filter((e): e is string => typeof e === "string");
  const one = payload.email;
  return typeof one === "string" ? [one] : [];
}

async function runOne(config: ExtensionConfig, task: QueueItem): Promise<void> {
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
      request = {
        kind: "CANVA_INVITE",
        taskId: task.id,
        entries: emailsFromPayload(payload).map((email) => ({ email, role })),
      };
      break;
    }
    case "SYNC_DATA":
      request = { kind: "CANVA_SYNC", taskId: task.id };
      break;
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

  const res = await sendToTab(tabId, request);
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
  if (task.type === "SYNC_DATA" && task.workspace_id && Array.isArray(data.members)) {
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
