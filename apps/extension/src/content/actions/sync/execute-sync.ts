import type {
  ExecuteActionResponse,
  ScrapedMember,
  SyncScope,
} from "../../../shared/messages";
import { sleep } from "../../human";
import {
  checkLocaleMatch,
  detectChatGPTLocale,
  type ChatGPTLocale,
} from "../../i18n-ui";
import { reportProgress } from "../../progress";
import { getChatGPTUserInfo } from "../../scrapers/user";
import { TEXT_FALLBACKS } from "../../selectors";
import { clickTabAndWait, findTabButton } from "./click-tab-and-wait";
import { MAX_SYNC_MS, scrapeCurrentTab } from "./scrape-current-tab";

export async function executeSync(
  taskId: string,
  scope: SyncScope = "both",
  expectedLocale: ChatGPTLocale | null = null,
): Promise<ExecuteActionResponse> {
  // scope: 'members' = chỉ tab Người dùng (active); 'invites' = chỉ tab Lời mời
  // đang chờ xử lý (pending); 'both' = cả hai. Tab "Yêu cầu đang chờ xử lý"
  // KHÔNG còn quét (user 2026-06-14).
  const scrapeInvites = scope !== "members";
  const scrapeActive = scope !== "invites";
  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}). Mở chatgpt.com/admin/members trước.`,
    };
  }

  // Phát hiện ngôn ngữ ChatGPT — log để dashboard FAILED banner show context.
  // Nếu dashboard truyền `expectedLocale` (vd 'vi') và ChatGPT đang locale khác
  // (vd 'en'), TEXT_FALLBACKS multi-pattern thường vẫn match được nên KHÔNG
  // fail-fast. Chỉ log warning. Nếu cuối cùng scrape 0 row → trả error có
  // include locale hint để user biết hướng fix.
  const detectedLocale = detectChatGPTLocale();
  const localeCheck = checkLocaleMatch(expectedLocale);
  console.log(
    `[autogpt-sync] locale check: detected='${detectedLocale}' expected='${expectedLocale ?? "any"}' match=${localeCheck.match}`,
  );
  if (!localeCheck.match) {
    console.warn("[autogpt-sync] LOCALE_MISMATCH:", localeCheck.hint);
  }

  // Tab "Users/Pending invites/Pending requests" chỉ tồn tại trên /admin/members.
  // Nếu admin tab đang ở /admin/billing hay /admin/something-else thì điều
  // hướng tới /admin/members. Ưu tiên click <a href> trong sidebar (Next.js
  // router catches reliably) → fallback pushState nếu không có anchor.
  if (!location.pathname.includes("/admin/members")) {
    console.log(
      `[autogpt-sync] đang ở ${location.pathname}, điều hướng sang /admin/members`,
    );
    await reportProgress(
      taskId,
      { phase: "discover", message: "Điều hướng sang /admin/members..." },
      true,
    );
    const sidebarLink = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ).find((a) => {
      const href = a.getAttribute("href") ?? "";
      return (
        href === "/admin/members" ||
        href === "/admin/members/" ||
        a.pathname === "/admin/members" ||
        a.pathname === "/admin/members/"
      );
    });
    if (sidebarLink) {
      console.log(`[autogpt-sync] click <a href="${sidebarLink.getAttribute("href")}">`);
      sidebarLink.click();
    } else {
      console.log("[autogpt-sync] không tìm thấy sidebar link, pushState fallback");
      history.pushState({}, "", "/admin/members");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }

  // ĐỢI thanh tab (Người dùng / Lời mời / Yêu cầu) RENDER — chạy DÙ đã ở sẵn
  // /admin/members hay vừa navigate. FIX 2026-06-20: từ v0.8.13 mỗi action mở tab
  // /admin/members MỚI → content chạy NGAY khi trang vừa load; nhánh navigate ở
  // trên bị SKIP (vì path đã đúng) nên TRƯỚC ĐÂY không chờ render → clickTabAndWait
  // pending chạy trước khi React render thanh tab → kẹt ở tab Người dùng (cùng lớp
  // bug với sync-member). Poll tới 10s cho thanh tab render rồi mới chuyển tab.
  let tabReady = false;
  for (let i = 0; i < 20; i++) {
    if (findTabButton("tab_active_members", TEXT_FALLBACKS.tabActiveMembers)) {
      tabReady = true;
      break;
    }
    await sleep(500);
  }
  if (!tabReady) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message:
        `Không thấy thanh tab /admin/members sau 10s (path hiện tại: ${location.pathname}, ChatGPT locale='${detectedLocale ?? "unknown"}'). ` +
        `Mở tab chatgpt.com/admin/members thủ công và thử lại.` +
        (localeCheck.match ? "" : ` ${localeCheck.hint}`),
    };
  }

  const startedAt = Date.now();
  const isOverTime = () => Date.now() - startedAt > MAX_SYNC_MS;

  // Merged result — key theo email. Status từ tab cuối cùng scrape được sẽ
  // override. Thứ tự ưu tiên: active > pending. → Scrape active CUỐI CÙNG
  // để nếu cùng email xuất hiện ở "Lời mời" cũ và "Người dùng" mới thì
  // active thắng. Nhưng thường email pending không trùng với active.
  const merged = new Map<string, ScrapedMember>();

  if (scrapeInvites) {
    // ----- Tab 1: Lời mời đang chờ xử lý (pending invites) -----
    // verifyTabParam="tab=invites": bắt buộc URL đổi sang ?tab=invites mới coi là
    // đã đổi tab (fix bug "sync lời mời vẫn ở tab Người dùng" — humanClick không
    // trigger đổi tab thì retry, hết retry thì bỏ qua thay vì scrape nhầm).
    if (
      await clickTabAndWait(
        "tab_pending_invites",
        TEXT_FALLBACKS.tabPendingInvites,
        1500,
        "tab=invites",
      )
    ) {
      const { members } = await scrapeCurrentTab(
        taskId,
        "pending",
        "Lời mời",
        isOverTime,
      );
      console.log(`[autogpt-sync] tab Lời mời: ${members.length} entries`);
      for (const m of members) merged.set(m.email, m);
    }
    // Tab "Yêu cầu đang chờ xử lý" (pending requests): KHÔNG quét nữa (user
    // 2026-06-14). 'invites' = chỉ tab Lời mời đang chờ xử lý.
  } else {
    console.log(`[autogpt-sync] scope=${scope} → bỏ qua tab Lời mời`);
  }

  // ----- Tab 3: Người dùng (active members) — scrape CUỐI để status active
  //         thắng nếu trùng email với 2 tab trên (race condition giữa các sync).
  let tab1Found = false;
  // Tổng active header ChatGPT báo (vd "49 thành viên") — forward về backend làm
  // "nguồn sự thật" chống reconcile khi sync THIẾU (xoá oan cả team). null = không
  // đọc được header → backend dùng heuristic fallback.
  let activeExpectedTotal: number | null = null;
  if (!scrapeActive) {
    console.log(`[autogpt-sync] scope=${scope} → bỏ qua tab Người dùng`);
  } else if (await clickTabAndWait("tab_active_members", TEXT_FALLBACKS.tabActiveMembers)) {
    tab1Found = true;
    const { members, expectedTotal } = await scrapeCurrentTab(
      taskId,
      "active",
      "Người dùng",
      isOverTime,
    );
    activeExpectedTotal = expectedTotal;
    console.log(
      `[autogpt-sync] tab Người dùng: ${members.length} entries (header ${expectedTotal ?? "?"})`,
    );
    for (const m of members) merged.set(m.email, m);
  } else {
    // Tab buttons không có → có thể trang không phải /admin/members.
    // Fallback: scrape DOM hiện tại như tab "active".
    console.warn(
      "[autogpt-sync] không tìm được tab buttons — scrape DOM hiện tại như Người dùng",
    );
    const { members, expectedTotal } = await scrapeCurrentTab(
      taskId,
      "active",
      "DOM hiện tại",
      isOverTime,
    );
    activeExpectedTotal = expectedTotal;
    for (const m of members) merged.set(m.email, m);
  }

  const members = Array.from(merged.values());
  const elapsedMs = Date.now() - startedAt;
  const timedOut = isOverTime();

  await reportProgress(
    taskId,
    {
      phase: "uploading",
      current: members.length,
      total: members.length,
      message: `Hoàn tất scrape ${members.length} member (${members.filter((m) => m.status === "active").length} active + ${members.filter((m) => m.status === "pending").length} pending), đang upload...`,
    },
    true,
  );

  if (members.length === 0) {
    const localeHint = localeCheck.match
      ? ""
      : ` LANGUAGE_MISMATCH: ${localeCheck.hint}`;
    return {
      ok: false,
      error_code: localeCheck.match ? "UI_ELEMENT_NOT_FOUND" : "LANGUAGE_MISMATCH",
      error_message:
        `Không tìm được row member nào (tab1=${tab1Found}, ${elapsedMs}ms, ChatGPT locale='${detectedLocale ?? "unknown"}'). ` +
        `URL hiện tại: ${location.pathname}.${localeHint}`,
    };
  }

  if (timedOut) {
    return {
      ok: false,
      error_code: "TIMEOUT",
      error_message: `Sync vượt quá ${MAX_SYNC_MS}ms (đã thu được ${members.length} members, không chắc đủ).`,
    };
  }

  const userInfo = getChatGPTUserInfo();
  console.log(
    `[autogpt-sync] DONE: ${members.length} members (active+pending) in ${elapsedMs}ms, user=${userInfo.email}`,
  );
  return {
    ok: true,
    data: {
      members,
      user_info: userInfo,
      elapsed_ms: elapsedMs,
      // Tổng active ChatGPT báo ở header. Backend so với số active scrape được để
      // phát hiện sync THIẾU và BỎ QUA reconcile (không mark removed oan). null
      // khi scope không quét active hoặc không đọc được header.
      expected_total: activeExpectedTotal,
    },
  };
}
