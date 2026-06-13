import type { ScrapedMember } from "../../../shared/messages";
import { TEXT_FALLBACKS } from "../../selectors";
import { clickTabAndWait } from "./click-tab-and-wait";
import { scrapeCurrentTab } from "./scrape-current-tab";

/**
 * Quick scrape của tab "Lời mời đang chờ xử lý" — dùng sau khi invite xong để
 * map dữ liệu lên dashboard. KHÔNG navigate (caller phải đảm bảo đã ở
 * /admin/members), KHÔNG scrape các tab khác → ngắn gọn, không đụng tới
 * `status='active'` của dashboard.
 *
 * Trả empty array (không throw) nếu tab không tìm thấy / page sai — caller
 * không nên fail invite nếu mapping thất bại.
 *
 * Hard cap 60s — dài hơn dialog typing nhưng đảm bảo không treo task quá lâu.
 *
 * @param forceReload Khi true, click tab "Người dùng" trước rồi mới click lại
 * tab "Lời mời" để ép ChatGPT re-fetch pending list (dùng cho retry attempt
 * khi attempt đầu thấy 0 email vừa mời — list có thể đang cache stale).
 */
export async function scrapePendingInvitesAfterInvite(
  taskId: string,
  forceReload: boolean = false,
): Promise<ScrapedMember[]> {
  if (!location.pathname.includes("/admin/members")) {
    console.warn(
      `[autogpt-invite-mapping] không ở /admin/members (${location.pathname}) — skip pending scrape`,
    );
    return [];
  }
  // Force re-fetch: click "Người dùng" rồi quay lại "Lời mời" → ChatGPT mount
  // lại component → useEffect / SWR re-trigger → list mới nhất.
  if (forceReload) {
    console.log("[autogpt-invite-mapping] forceReload: bounce qua tab Người dùng để ép re-fetch");
    await clickTabAndWait("tab_active_members", TEXT_FALLBACKS.tabActiveMembers, 800);
  }
  const clicked = await clickTabAndWait(
    "tab_pending_invites",
    TEXT_FALLBACKS.tabPendingInvites,
    forceReload ? 2500 : 1500,
  );
  if (!clicked) {
    console.warn("[autogpt-invite-mapping] tab 'Lời mời' không tìm thấy → skip");
    return [];
  }
  const startedAt = Date.now();
  const isOverTime = () => Date.now() - startedAt > 60_000;
  const { members } = await scrapeCurrentTab(
    taskId,
    "pending",
    "Map lời mời",
    isOverTime,
  );
  // CHỦ Ý KHÔNG click lại "Người dùng" — extension dừng ở tab "Lời mời đang chờ
  // xử lý" để user mở tab admin lên là thấy ngay email vừa mời (không cần F5).
  // Lý do bỏ bounce-back (v0.6.2): ChatGPT cache pending list qua React Query;
  // nếu extension click qua "Người dùng" rồi user click lại "Lời mời", ChatGPT
  // re-mount component và có thể serve từ cache stale (chưa thấy invite mới).
  // Để extension idle TẠI tab "Lời mời" thì DOM đã render data mới (extension
  // vừa scrape) — user nhìn thấy ngay. Task sau (REMOVE/CHANGE_ROLE) tự click
  // tab "Người dùng" qua findControlByKey nên không lệ thuộc end-state này.
  return members;
}
