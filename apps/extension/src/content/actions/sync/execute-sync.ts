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
import { checkSeatAvailability } from "../purchase-seat/check-seat-availability";
import {
  clickTabAndWait,
  DEFAULT_TAB_VERIFY,
  findTabButton,
  onWrongSubTab,
} from "./click-tab-and-wait";
import {
  MAX_SYNC_MS,
  scrapeCurrentTab,
  visibleEmails,
} from "./scrape-current-tab";

/**
 * Trần cho nhịp đọc số suất ở CUỐI mẻ sync. Phần này là phần THÊM (hỏng cũng
 * không sao) nhưng lại nằm sau khi đồng hồ sync đã chốt, nên trước 3/9/2026 nó
 * là phần đẩy tổng thời gian vượt trần 330s của background. Xem `MAX_SYNC_MS`.
 */
const SEAT_READ_MAX_MS = 30_000;

/** Chạy `p`, quá `ms` thì bỏ cuộc và trả `null` (không ném). */
async function withCap<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

export async function executeSync(
  taskId: string,
  scope: SyncScope = "both",
  expectedLocale: ChatGPTLocale | null = null,
): Promise<ExecuteActionResponse> {
  // Đồng hồ chạy từ ĐÂY — trước cả nhịp chờ thanh tab render (tới 10s) — để
  // ngân sách của content bao trọn mọi thứ nó làm, không chỉ phần quét. Xem
  // `MAX_SYNC_MS` về ba trần lồng nhau.
  const startedAt = Date.now();
  const isOverTime = () => Date.now() - startedAt > MAX_SYNC_MS;

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

  // Merged result — key theo email. Status từ tab cuối cùng scrape được sẽ
  // override. Thứ tự ưu tiên: active > pending. → Scrape active CUỐI CÙNG
  // để nếu cùng email xuất hiện ở "Lời mời" cũ và "Người dùng" mới thì
  // active thắng. Nhưng thường email pending không trùng với active.
  const merged = new Map<string, ScrapedMember>();

  // Đã VÀO ĐƯỢC tab "Lời mời đang chờ xử lý" hay chưa (URL đã có ?tab=invites).
  // Phân biệt "tab rỗng THẬT" với "không vào được tab / scrape hỏng" — quét ra 0
  // row chỉ đáng tin khi cờ này true. Xem guard `members.length === 0` bên dưới.
  let invitesTabFound = false;
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
        0,
        // URL đổi trước, bảng đổi sau: đòi thêm chốt "danh sách đã khác trước
        // lúc bấm" mới cho quét, kẻo gắn nhãn 'pending' cho bảng Người dùng.
        { signature: visibleEmails },
      )
    ) {
      invitesTabFound = true;
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
  } else if (
    await clickTabAndWait(
      "tab_active_members",
      TEXT_FALLBACKS.tabActiveMembers,
      1500,
      DEFAULT_TAB_VERIFY,
      0,
      { signature: visibleEmails },
    )
  ) {
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
  } else if (onWrongSubTab() || invitesTabFound) {
    // Vừa quét xong tab "Lời mời" mà KHÔNG chốt được tab "Người dùng" — hoặc URL
    // còn ?tab=invites, hoặc danh sách chưa đổi khỏi bảng lời mời. Đường fallback
    // bên dưới (scrape DOM hiện tại như tab active) ở đây là TAI HOẠ — nó gắn
    // nhãn `active` cho cả danh sách lời mời đang chờ, backend nâng hết pending →
    // active. Thà báo lỗi.
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        `Không quay lại được tab "Người dùng" (URL '${location.search}') — ` +
        `dừng để không gắn nhãn "đã tham gia" cho danh sách lời mời đang chờ.`,
    };
  } else {
    // Tab buttons không có → có thể trang không phải /admin/members.
    // Fallback: scrape DOM hiện tại như tab "active". Chỉ đi vào đây khi URL
    // KHÔNG ở sub-tab nào khác (guard ngay bên trên).
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

  // "Lời mời chờ xử lý" (scope=invites) quét ra 0 row là KẾT QUẢ HỢP LỆ, không
  // phải lỗi: nghĩa là mọi lời mời đã được nhận (hoặc bị thu hồi) hết. Trước đây
  // rơi thẳng vào guard dưới → task FAILED `UI_ELEMENT_NOT_FOUND` → backend không
  // nhận được gì → KHÔNG đối chiếu được với danh sách "chờ tham gia" của dashboard
  // (user 2026-07-22: "lệnh đồng bộ lời mời lỗi, không đối chiếu email"). Chính ca
  // 0-row mới là ca cần đối chiếu nhất: 14 pending trên dashboard mà tab Lời mời
  // trống ⇒ cả 14 đều đáng nghi đã tham gia.
  //
  // Chỉ tin 0-row khi ĐÃ VÀO ĐƯỢC tab (URL có ?tab=invites) — không vào được thì
  // vẫn là lỗi như cũ. Với scope có 'active', 0 row vẫn luôn là lỗi (tab Người
  // dùng rỗng = dấu hiệu scrape hỏng, reconcile theo đó sẽ xoá oan cả team).
  const invitesOnlyEmptyButValid =
    scrapeInvites && !scrapeActive && invitesTabFound;
  if (members.length === 0 && !invitesOnlyEmptyButValid) {
    const localeHint = localeCheck.match
      ? ""
      : ` LANGUAGE_MISMATCH: ${localeCheck.hint}`;
    return {
      ok: false,
      error_code: localeCheck.match ? "UI_ELEMENT_NOT_FOUND" : "LANGUAGE_MISMATCH",
      error_message:
        `Không tìm được row member nào (tab1=${tab1Found}, invitesTab=${invitesTabFound}, ` +
        `${elapsedMs}ms, ChatGPT locale='${detectedLocale ?? "unknown"}'). ` +
        `URL hiện tại: ${location.pathname}.${localeHint}`,
    };
  }

  if (timedOut) {
    return {
      ok: false,
      error_code: "TIMEOUT",
      error_message:
        `Sync vượt quá ${MAX_SYNC_MS / 1000}s nên dừng giữa chừng ` +
        `(mới thu ${members.length} dòng: ${members.filter((m) => m.status === "active").length} đang dùng + ` +
        `${members.filter((m) => m.status === "pending").length} chờ tham gia; tab Người dùng=${tab1Found}, ` +
        `tab Lời mời=${invitesTabFound}) — chưa chắc đủ nên KHÔNG đối chiếu để tránh xoá oan. ` +
        `Danh sách trên ChatGPT đang tải ì chứ không phải mất phiên đăng nhập; chạy lại lúc máy rảnh.`,
    };
  }

  // ── Đọc số suất (CHỈ-ĐỌC, không bắt buộc) ───────────────────────────────
  // Từ 26/8/2026 tab "Người dùng" in sẵn hàng thẻ "Suất Tiêu chuẩn · Đã gán
  // 60/62" + "Suất Cao cấp · Đã gán 0/0" → `checkSeatAvailability` cộng các thẻ
  // lại và KHÔNG mở hộp nào. Workspace chưa có thẻ thì vẫn mở hộp như trước.
  // Tổng suất trên dashboard trước đây chỉ đổi khi chạy SYNC_BILLING hoặc khi có
  // lệnh mời — nên nó ôm số cũ hàng tuần (24/8/2026: dashboard ghi 148 trong khi
  // ChatGPT đang có 151). Nút "Đồng bộ từ ChatGPT" là thứ admin bấm thường xuyên
  // nhất, và lúc này ta đang đứng sẵn ở tab "Người dùng" — nơi có nút "Quản lý số
  // suất". Đọc thêm một nhịp ở đây là cách rẻ nhất để con số luôn khớp thực tế.
  //
  // HỎNG CŨNG KHÔNG SAO: đây là phần THÊM của sync, không phải mục đích của nó.
  // Không đọc được thì bỏ trống, backend giữ nguyên số cũ. TUYỆT ĐỐI không để
  // nhánh này làm task sync FAILED — nên nó nằm SAU mọi chốt lỗi (0 row, quá giờ)
  // và sau khi `elapsedMs` đã chốt: đọc suất mất tới ~28s, tính vào đồng hồ sync
  // thì một mẻ sync đang thành công có thể bị đẩy quá `MAX_SYNC_MS`.
  //
  // NHƯNG nằm ngoài đồng hồ sync không có nghĩa là được chạy vô hạn: chính nó là
  // phần đẩy tổng thời gian của content vượt trần 330s của background (3 mẻ hỏng
  // 1/9 + 3/9/2026 đều bị chém đúng lúc đang ở nhịp này, ngay sau khi đã quét
  // xong). `SEAT_READ_MAX_MS` khoá lại: quá hạn thì bỏ số suất, mẻ sync vẫn về
  // đích với danh sách member — đúng tinh thần "hỏng cũng không sao".
  let seatTotal: number | null = null;
  let seatAssigned: number | null = null;
  // Hai chỗ trong hộp nói hai tổng khác nhau. Backend dựa vào cờ này để KHÔNG tự
  // mua bù theo số chưa chắc — mua theo số sai là mất tiền thật.
  let seatUncertain = false;
  // Giá trị bộ đếm + nội dung hộp: khi hai nguồn lệch thì đây là toàn bộ manh mối
  // về nguyên nhân. Bản trước chỉ gửi cờ `uncertain` nên mỗi lần gặp lại vẫn phải
  // nhờ người mở ChatGPT nhìn tận mắt.
  let seatStepperTotal: number | null = null;
  let seatModalText: string | null = null;
  if (scrapeActive) {
    try {
      const seat = await withCap(checkSeatAvailability(), SEAT_READ_MAX_MS);
      if (!seat) {
        seatUncertain = true;
        console.warn(
          `[autogpt-sync] bỏ đọc số suất: quá ${SEAT_READ_MAX_MS / 1000}s — ` +
            `trả kết quả sync trước khi background hết kiên nhẫn`,
        );
      } else {
        // `ratioTotal` = tổng của dòng "147/151 đã gán" = số suất workspace ĐANG
        // giữ. Xem `check-seat-availability.ts` vì sao không lấy `availability.total`.
        seatTotal = seat.ratioTotal;
        seatAssigned = seat.availability?.assigned ?? null;
        seatUncertain = seat.uncertain;
        seatStepperTotal = seat.stepperTotal;
        seatModalText = seat.modalText;
        console.log(
          `[autogpt-sync] suất đọc từ ` +
            `${seat.source === "page_cards" ? "hàng thẻ trên trang Thành viên" : "hộp 'Quản lý suất'"}` +
            `: ${seatAssigned ?? "?"}/${seatTotal ?? "?"}` +
            (seat.uncertain ? ` (số chưa chắc — ${seat.uncertainReason ?? "?"})` : "") +
            (seat.error ? ` (lỗi: ${seat.error})` : ""),
        );
      }
    } catch (e) {
      seatUncertain = true;
      console.warn(
        `[autogpt-sync] không đọc được số suất (bỏ qua): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
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
      // Đã vào được tab tương ứng chưa — runner cần biết để phân biệt "quét ra 0
      // row vì tab rỗng THẬT" (vẫn phải reconcile) với "0 row vì scrape hỏng"
      // (bỏ qua reconcile kẻo xoá oan).
      invites_tab_ok: invitesTabFound,
      active_tab_ok: tab1Found,
      // Số suất đọc tận nơi ở hộp "Quản lý suất" (null = không đọc được, backend
      // giữ nguyên số cũ). Runner forward vào task.result → backend ghi vào
      // workspace (`_absorb_seat_reading`).
      seat_total: seatTotal,
      seat_assigned: seatAssigned,
      seat_uncertain: seatUncertain,
      seat_stepper_total: seatStepperTotal,
      seat_modal_text: seatModalText,
      // Mẻ này có QUÉT tab "Lời mời đang chờ" hay không. Backend chỉ dám tự mua
      // bù suất cho lời mời đang treo khi cờ này TRUE: chưa quét tab đó thì số
      // lời mời trong DB là số của lần sync trước, có thể đã chết (hết hạn / bị
      // thu hồi) → mua theo nó là mua thừa bằng tiền thật.
      invites_scanned: scrapeInvites && invitesTabFound,
    },
  };
}
