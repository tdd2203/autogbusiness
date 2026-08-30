import type {
  ExecuteActionResponse,
  ChatGPTRole,
} from "../../../shared/messages";
import { SESSION_RECOVERY_HINT } from "../../../shared/messages";
import { sleep, waitFor } from "../../human";
import { findControlByKey } from "../../i18n-ui";
import { reportProgress } from "../../progress";
import { TEXT_FALLBACKS } from "../../selectors";
import { navigateTo } from "../external-invites/navigate";
import { setExternalInvites } from "../external-invites/set-toggle";
import { locatePendingRow } from "../revoke/locate-pending-row";
import { revokeInvite } from "../revoke";
import { clickTabAndWait } from "../sync";
import { ensureSeatsForInvite, type SeatHint } from "./ensure-seats";
import { executeInviteInner } from "./execute-invite-inner";
import { findInviteOpenButton } from "./finders/find-invite-open-button";
import { scanPendingForEmails } from "./scan-pending-page";

const RE_LOG = "[autogpt-reinvite]";

/**
 * TIỀN TỐ cho action "Mời lại" (chạy 1 lần trước khi mời — xem executeInvite).
 *
 * Chỉ còn MỘT việc: vào tab "Lời mời đang chờ" THU HỒI lời mời cũ của các email sắp
 * mời lại. ChatGPT không cho mời một email đang có lời mời chờ → không thu hồi thì
 * lệnh mời lại fail ngay trên UI.
 *
 * Bước "quét tab Người dùng → huỷ lệnh nếu email còn là thành viên" ĐÃ BỎ (user
 * 2026-08-22): "mời lại là mời lại một lần nữa, đã thanh toán và còn hạn thì cứ mời,
 * không cần check". Ca DB ghi active nhưng người đó đã rời đội trước đây bị kẹt vĩnh
 * viễn vì bước này. Backend giữ phần kiểm soát (chặn 409 member active trừ khi lần
 * đồng bộ gần nhất không thấy — xem `_unblock_active_if_sync_missing`).
 *
 * Lỗi thu hồi được BỎ QUA (vẫn mời tiếp): mời lại tạo lời mời mới đè lên.
 */
async function runReinvitePreSteps(emails: string[]): Promise<void> {
  const onPending = await clickTabAndWait(
    "tab_pending_invites",
    TEXT_FALLBACKS.tabPendingInvites,
    1200,
    "tab=invites",
    12_000,
  );
  if (!onPending) {
    console.warn(`${RE_LOG} không vào được tab Lời mời — bỏ qua bước thu hồi`);
    return;
  }
  for (const email of emails) {
    try {
      const pendingRow = await locatePendingRow(email);
      if (pendingRow) {
        const res = await revokeInvite(email);
        console.log(`${RE_LOG} thu hồi lời mời cũ ${email}: ok=${res.ok}`);
      } else {
        console.log(`${RE_LOG} ${email} không có lời mời cũ trong tab Lời mời`);
      }
    } catch (e) {
      console.warn(`${RE_LOG} thu hồi lời mời cũ ${email} lỗi (bỏ qua, vẫn mời):`, e);
    }
  }
}

const MEMBERS_PATH = "/admin/members";

/** Predicate: đã ở /admin/members VÀ page đã render (main + có button). */
function membersPageReady(): boolean {
  if (!location.pathname.includes(MEMBERS_PATH)) return false;
  const main = document.querySelector("main, [role='main']");
  const hasButtons = document.querySelectorAll("button").length > 2;
  return !!main && hasButtons;
}

/**
 * FIX A (2026-07-15): CỔNG CHỜ SPA render XONG khu vực /admin/members TRƯỚC mọi
 * thao tác mời. Nền (ensureAdminTab) sau F5 CHỈ chờ sự kiện "load" của trình
 * duyệt (waitForTabComplete → status==="complete") rồi PING content — nhưng
 * ChatGPT là React SPA: "load" xong React vẫn đang fetch org-config + render
 * thanh tab + nút Mời trong vài giây nữa. Nếu chạy tiền tố "Mời lại" (chuyển 2
 * tab) hoặc mở dialog khi CHƯA render → chuyển tab hỏng, "Không tìm thấy nút Mời"
 * (8s cũ), hoặc mất context content-script → CONTENT_TIMEOUT (user report
 * 2026-07-15: mời trước ổn giờ lỗi sau khi thêm tiền tố Mời lại + Phase 2b).
 *
 * `membersPageReady` cũ quá yếu (>2 button là true rất sớm). Ở đây chờ tới khi
 * thấy DẤU HIỆU nav THẬT SỰ đã render: nút Mời, HOẶC tab "Người dùng"/"Lời mời".
 * `waitFor` poll → trả NGAY khi sẵn sàng (case thường ~1 poll, không làm chậm),
 * chỉ chờ khi tab vừa F5 chưa rehydrate. Trả false nếu hết `timeoutMs` (không
 * throw — finder sâu hơn phía sau sẽ quyết định fail cuối cùng).
 */
async function waitForMembersNavReady(timeoutMs = 20_000): Promise<boolean> {
  try {
    await waitFor(() => {
      if (findInviteOpenButton()) return true;
      const usersTab = findControlByKey(
        "tab_active_members",
        TEXT_FALLBACKS.tabActiveMembers,
        { page: "/admin/members" },
      );
      if (usersTab) return true;
      const pendingTab = findControlByKey(
        "tab_pending_invites",
        TEXT_FALLBACKS.tabPendingInvites,
        { page: "/admin/members" },
      );
      return pendingTab ? true : null;
    }, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/** Lấy phần domain sau '@' của email (lowercase). "" nếu không hợp lệ. */
function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
}

/**
 * True nếu `verifiedDomain` đã cấu hình VÀ MỌI email đều thuộc domain đó.
 * Khi đó invite không cần bật toggle "mời ngoài tên miền" → bỏ qua /admin/identity.
 */
function allEmailsInVerifiedDomain(
  emails: string[],
  verifiedDomain: string | null,
): boolean {
  if (!verifiedDomain) return false;
  const dom = verifiedDomain.trim().toLowerCase().replace(/^@/, "");
  if (!dom) return false;
  return emails.every((e) => emailDomain(e) === dom);
}

export async function executeInvite(
  taskId: string,
  emails: string[],
  role: ChatGPTRole,
  verifiedDomain: string | null = null,
  externalReady = false,
  reinvite = false,
  newSeatCount?: number,
  seatHint?: SeatHint,
  noSeatPurchase = false,
  seatsReady = false,
  seatsPurchasedAlready?: number,
): Promise<ExecuteActionResponse> {
  console.log(
    `[autogpt-invite] START ${emails.length} email(s) role=${role} verifiedDomain=${verifiedDomain ?? "(chưa cấu hình)"} externalReady=${externalReady} reinvite=${reinvite} pathname=${location.pathname}`,
  );

  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message:
        `Trang hiện tại không phải admin (${location.pathname}). Mở chatgpt.com/admin/members trước. ` +
        SESSION_RECOVERY_HINT,
    };
  }
  if (emails.length === 0) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: "Danh sách emails rỗng",
    };
  }

  // FIX A: nếu đang ở /admin/members (đường mặc định sau ensureAdminTab F5), CHỜ
  // SPA render xong nav/nút Mời trước khi làm bất cứ gì (tiền tố Mời lại / mở
  // dialog). Trang chưa render là nguyên nhân "Không tìm thấy nút Mời" +
  // CONTENT_TIMEOUT khi tab vừa bị F5. Case thường trả về ngay (nav đã có).
  if (location.pathname.includes(MEMBERS_PATH)) {
    const navReady = await waitForMembersNavReady(20_000);
    if (!navReady) {
      console.warn(
        "[autogpt-invite] SPA /admin/members chưa render nav/nút Mời sau 20s — vẫn tiếp tục (finder sâu hơn sẽ quyết định fail).",
      );
    }
  }

  // Lượt gọi LẠI sau khi background tải lại trang vì hộp mua suất (`seatsReady` /
  // `seatsPurchasedAlready`) — mọi bước CHỈ-CHẠY-MỘT-LẦN phải bỏ qua ở lượt này.
  const afterSeatReload = seatsReady || seatsPurchasedAlready !== undefined;

  // Action "Mời lại": chạy TIỀN TỐ 1 lần (trước Phase A/toggle). !externalReady để
  // KHÔNG lặp lại ở lần gọi thứ 2 sau khi background hard-reload. Mời lại HÀNG LOẠT
  // (re-invite-batch) gửi cả bó trong 1 task → thu hồi lời mời cũ cho MỌI email.
  if (reinvite && !externalReady && !afterSeatReload) {
    await runReinvitePreSteps(emails.map((e) => e.trim().toLowerCase()));
  }

  // ─── BƯỚC SUẤT (2026-08-22): đủ suất rồi mới được mời ────────────────────
  // Chạy SAU tiền tố "Mời lại" vì tiền tố đó thu hồi lời mời cũ → TRẢ LẠI suất,
  // đếm trước khi thu hồi sẽ ra thiếu và đi mua thừa.
  // Chỉ chạy ở lần gọi THỨ NHẤT: lần 2 (externalReady) là quay lại sau khi
  // background hard-reload, suất đã được đảm bảo ở lần 1 rồi.
  let seatData: Record<string, unknown> = {};
  // `seatsReady`: lượt gọi LẠI sau khi background tải lại trang vì hộp mua suất
  // để lại lớp phủ. Tổng suất mới đã chốt bằng bộ đếm của hộp mua ở lượt trước →
  // mở hộp lần nữa chỉ tốn thời gian và thêm một cơ hội hộp kẹt.
  if (!externalReady && !seatsReady) {
    // `newSeatCount` do backend tính (`_count_new_invite_seats`): email đang là
    // thành viên ACTIVE đã giữ một suất rồi nên KHÔNG cần mua thêm. Đếm bừa theo
    // emails.length là đi mua thừa — mất tiền thật.
    //
    // Thiếu (backend cũ) → rơi về emails.length: mua thừa còn hơn mua thiếu, vì
    // mua thiếu thì ChatGPT bật luồng "mua kèm gửi lời mời" mà ta không kiểm
    // soát được số tiền.
    const need = newSeatCount ?? emails.length;
    if (newSeatCount !== undefined && newSeatCount !== emails.length) {
      console.log(
        `[autogpt-invite] cần ${need} suất MỚI cho ${emails.length} email ` +
          `(${emails.length - need} email đang là thành viên, đã giữ suất sẵn)`,
      );
    }
    const seats = await ensureSeatsForInvite(taskId, need, emails, seatHint, {
      noPurchase: noSeatPurchase,
      alreadyPurchased: seatsPurchasedAlready,
    });
    seatData = seats.data;
    // ── ĐÃ MUA SUẤT MÀ TRANG CÒN BẨN → NHỜ BACKGROUND TẢI LẠI ───────────────
    // Tiền đã trừ. Trang còn lớp phủ của hộp mua nên mọi cú bấm của bước mời sẽ
    // rơi vào lớp phủ. TRẢ QUYỀN VỀ BACKGROUND ngay tại đây, vì hai lẽ:
    //   1. Cắt lượt gọi content cho ngắn. Mời-kèm-mua chạy 4–5′ trong một lượt →
    //      service worker MV3 bị Chrome khai tử giữa chừng, mất cả kênh chờ trả
    //      lời lẫn đồng hồ 450s ⇒ không còn ai báo lỗi (ca 26/8/2026: 3 lệnh mời
    //      im lặng tới khi backend chốt timeout 8′ dù lời mời ĐÃ đi).
    //   2. Content tự điều hướng để dọn trang là tự cắt kênh: `navigateTo` có
    //      nhánh click <a>, điều hướng thật thì trang bị đẩy vào back/forward
    //      cache (lớp tai nạn 31/7 — hoàn 340k oan).
    // Cơ chế trả quyền y hệt `awaiting_external_reload`/`awaiting_reload_verify`.
    if (seats.needsPageReload) {
      console.log(
        `[autogpt-invite] đã mua suất nhưng trang còn bẩn (${seats.needsPageReload}) → ` +
          "yêu cầu background HARD-RELOAD /admin/members rồi gọi lại để mời.",
      );
      return {
        ok: true,
        data: {
          awaiting_seat_reload: true,
          seat_recheck_needed: seats.needsPageReload === "recheck_seats",
          emails,
          count: emails.length,
          role,
          ...seatData,
        },
      };
    }
    if (!seats.ok) {
      console.warn(`[autogpt-invite] DỪNG trước khi mời: ${seats.error_message}`);
      // KHÔNG dùng VERIFY_FAILED ở đây: `invite-salvage.ts` chỉ cứu ca
      // VERIFY_FAILED có `submit_clicked=true` (đã bấm Gửi lời mời rồi mới lỗi).
      // Ta chưa hề mở dialog mời — dùng mã riêng để không lẫn vào đường cứu đó.
      // `SEAT_LOCK_REQUIRED` KHÔNG phải lỗi: lệnh đang chạy song song mà chỗ
      // trống không còn chắc chắn → background nâng khoá suất lên độc quyền rồi
      // gọi lại lệnh này. Trả nguyên mã để runner nhận ra, đừng nhét vào
      // NOT_ENOUGH_SEATS (mã đó đi thẳng về backend = task hỏng oan).
      return {
        ok: false,
        error_code:
          seats.error_code === "SEAT_LOCK_REQUIRED"
            ? "SEAT_LOCK_REQUIRED"
            : seats.error_code === "SEAT_CHECK_FAILED"
              ? "FAILED_UI_CHANGED"
              : "NOT_ENOUGH_SEATS",
        error_message: seats.error_message ?? "Không đủ suất để mời.",
        data: seatData,
      };
    }
  }

  // Spec (v0.6.6, theo user 2026-05-20):
  //   1. Kiểm tra toggle "Cho phép lời mời ngoài tên miền" hiện đang ON/OFF.
  //      - Nếu OFF → bật ON.
  //      - Nếu đã ON → skip click (giữ nguyên cho invite).
  //   2. Navigate /admin/members + mời thành viên (executeInviteInner).
  //   3. SAU KHI INVITE XONG (finally, gọi setExternalInvites(false)):
  //      LUÔN tắt toggle về OFF — KỂ CẢ prev=ON (user bật vĩnh viễn). Đây
  //      là spec bảo mật user xác nhận: external invites là rủi ro → sau
  //      mỗi invite extension phải về OFF, user bật lại thủ công nếu cần.
  //   4. SAU KHI ĐÃ TẮT TOGGLE, chuyển sang tab "Lời mời đang chờ xử lý" →
  //      URL = /admin/members?tab=invites → QUÉT ngay danh sách tìm email vừa
  //      mời (scanPendingForEmails, max 8s).
  //   5a. THẤY ĐỦ → xác minh xong TẠI CHỖ: trả verified_emails + pending_members,
  //      KHÔNG set awaiting_reload_verify → runner bỏ hẳn vòng F5 (~10s).
  //   5b. CÒN THIẾU → giữ awaiting_reload_verify: background runner F5 + gọi
  //      VERIFY_PENDING_INVITE (Phase 2) → quét lại sau khi ChatGPT nạp mới.
  //      Runner bulk-upsert (isFullSync=false) vào DB → dashboard hiển thị.
  //
  // QUAN TRỌNG: Trình tự PHẢI là 'tắt toggle TRƯỚC, chuyển tab Lời mời SAU'.
  // Nếu đảo lại (chuyển tab → restore toggle navigate qua /admin/identity →
  // navigate về /admin/members) thì URL mất ?tab=invites → F5 load tab "Người
  // dùng" default → Phase 2 phải click lại tab, chậm hơn + dễ race với cache.
  //
  // TỐI ƯU (theo user): nếu MỌI email thuộc tên miền đã xác minh của workspace
  // thì KHÔNG cần bật toggle "mời ngoài tên miền" → bỏ qua 2 lần navigate
  // /admin/identity (nhanh hơn + không để workspace mở external). Chỉ khi
  // domain chưa cấu hình HOẶC có email ngoài domain mới cần bật toggle.
  const needExternal = !allEmailsInVerifiedDomain(emails, verifiedDomain);

  let inviteResult: ExecuteActionResponse;
  /**
   * Đã bật toggle "mời ngoài tên miền" ⇒ background PHẢI tắt lại sau khi nhận
   * kết quả (`needs_external_restore` trong `data`). Xem chú thích ở Phase A'.
   */
  let externalRestorePending = false;
  if (!needExternal) {
    console.log(
      `[autogpt-invite] mọi email thuộc domain xác minh "${verifiedDomain}" → BỎ QUA toggle external invites`,
    );
    // executeInviteInner yêu cầu đang ở /admin/members → điều hướng trước.
    await navigateTo(MEMBERS_PATH, membersPageReady, 10_000);
    inviteResult = await executeInviteInner(taskId, emails, role);
  } else if (!externalReady) {
    // ─── PHASE A (lần gọi INVITE_MEMBER thứ 1) ───────────────────────────────
    // Có email NGOÀI domain xác minh (hoặc domain chưa cấu hình) → BẮT BUỘC bật
    // toggle "Cho phép lời mời ngoài tên miền" trước khi mời. Nếu KHÔNG xác nhận
    // được toggle về ON → KHÔNG mời (return FAIL): mời khi toggle OFF → ChatGPT
    // từ chối email ngoài domain silently → dashboard tạo phantom "đang chờ".
    //
    // QUAN TRỌNG (fix v0.8.14, user 2026-06-19 "luôn bị EXTERNAL_TOGGLE_FAILED"):
    // sau khi bật toggle ở /admin/identity, KHÔNG mở dialog mời ngay trong cùng
    // context. Lý do gốc: `navigateTo` dùng SPA-nav (click <a>/pushState) →
    // ChatGPT KHÔNG refetch org-config/verified-domains → dialog Mời vẫn validate
    // theo config CŨ (external=OFF) → hiện banner "ngoài miền" + disable Send →
    // banner KHÔNG BAO GIỜ tự clear (8s poll vô ích) → EXTERNAL_TOGGLE_FAILED.
    // Cách chắc chắn 100%: background HARD-RELOAD /admin/members (refetch config)
    // RỒI mới mở dialog (Phase A'). Content tự reload sẽ chết context →
    // CONTENT_TIMEOUT, nên reload phải do background điều phối. Ta báo background
    // qua `awaiting_external_reload` (giống cơ chế `awaiting_reload_verify` của
    // F5 verify Phase 2).
    const ensured = await setExternalInvites(true);
    if (!ensured.confirmed) {
      console.warn(
        "[autogpt-invite] KHÔNG xác nhận được toggle external invites = ON → huỷ invite (tránh phantom).",
      );
      return {
        ok: false,
        error_code: "EXTERNAL_TOGGLE_FAILED",
        error_message:
          ensured.prev === null
            ? "Không tìm thấy toggle 'Cho phép lời mời ngoài tên miền' trên /admin/identity — không thể đảm bảo bật trước khi mời email ngoài domain. Kiểm tra lại trang/UI ChatGPT rồi thử lại."
            : "Đã click bật toggle 'mời ngoài tên miền' nhưng không xác nhận được trạng thái ON. Huỷ invite để tránh thêm nhầm email vào dashboard.",
      };
    }
    console.log(
      `[autogpt-invite] PHASE A: toggle external invites đã ON (prev=${ensured.prev ? "ON" : "OFF"}) → yêu cầu background HARD-RELOAD /admin/members rồi gọi lại để mời.` +
        (ensured.toast ? ` ChatGPT báo: "${ensured.toast}"` : ""),
    );
    return {
      ok: true,
      data: {
        awaiting_external_reload: true,
        emails,
        count: emails.length,
        role,
        // Câu ChatGPT in ra khi lưu xong công tắc. Chỉ để soi lại — cờ cho phép
        // mời vẫn là `ensured.confirmed` đọc từ chính công tắc.
        external_toggle_toast: ensured.toast ?? null,
        // Lần gọi 2 (externalReady) BỎ QUA bước suất → số liệu chỉ có ở đây,
        // đính kèm để dashboard vẫn ghi nhận được.
        ...seatData,
      },
    };
  } else {
    // ─── PHASE A' (lần gọi INVITE_MEMBER thứ 2, externalReady=true) ───────────
    // Toggle external ĐÃ ON ở Phase A + trang /admin/members vừa được background
    // HARD-RELOAD → org-config đã fresh (external=ON) → dialog Mời không còn
    // banner "ngoài miền". Giờ mở dialog mời thật sự.
    console.log(
      "[autogpt-invite] PHASE A': trang đã hard-reload với external=ON → mở dialog mời.",
    );
    // ⚠️ KHÔNG tắt toggle ở đây nữa (sửa 24/8/2026 — ca 2a5d6450 ngày 31/7 mất
    // 340.000đ). Bước tắt phải điều hướng sang /admin/identity, mà điều hướng
    // NGAY TRONG lần mời này thì trang đang giữ kênh message bị Chrome đẩy vào
    // back/forward cache → kết quả mời KHÔNG về được background → task báo hỏng
    // dù lời mời đã tới hộp thư người nhận → backend hoàn phí + xoá bản ghi.
    // Nay `needs_external_restore` báo cho background tự gọi lệnh
    // SET_EXTERNAL_INVITES sau khi đã nhận kết quả. Xem `execute-set-toggle.ts`.
    //
    // Bọc try/catch (thay cho try/finally cũ): lỗi văng ra vẫn phải trả về một
    // response CÓ CỜ, kẻo toggle nằm ON mà không ai biết mà tắt.
    try {
      await navigateTo(MEMBERS_PATH, membersPageReady, 10_000);
      inviteResult = await executeInviteInner(taskId, emails, role);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[autogpt-invite] Phase A' văng lỗi: ${msg}`);
      inviteResult = {
        ok: false,
        error_code: "UNKNOWN",
        error_message: `Lỗi khi mời (Phase A'): ${msg}`,
        data: { needs_external_restore: true },
      };
    }
    externalRestorePending = true;
  }

  // Bước 4: chuyển tab "Lời mời" + QUÉT NGAY, SAU khi toggle đã tắt + đã ở
  // /admin/members. Chỉ chạy khi invite submit thành công — fail thì không verify.
  //
  // v0.11.4 (user 2026-08-13): dialog mời của ChatGPT phản hồi chậm, NHƯNG chuyển
  // sang tab "Lời mời đang chờ xử lý" là thấy người vừa mời NGAY. Nên xác minh
  // ngay tại đây thay vì mặc định F5 rồi mới quét: thấy đủ ⇒ khỏi F5 (tiết kiệm
  // trọn vòng verify ~10s + 1-3 lần reload tab). Thiếu ⇒ mới nhờ runner F5.
  /**
   * Gắn nốt số liệu suất + cờ dọn-dẹp toggle rồi trả kết quả. Có HAI đường ra khỏi
   * hàm này (bỏ qua bước quét vì đã xác minh tại chỗ, và đường thường), cả hai đều
   * phải qua đây — thiếu `seatData` là dashboard đứng im số suất dù vừa tiêu tiền
   * thật (ca GPT1 ngày 28/8/2026).
   */
  const finish = (res: ExecuteActionResponse): ExecuteActionResponse => {
    if (Object.keys(seatData).length > 0) {
      const withData = res as { data?: Record<string, unknown> };
      withData.data = { ...(withData.data ?? {}), ...seatData };
    }
    if (externalRestorePending) {
      const withData = res as { data?: Record<string, unknown> };
      withData.data = { ...(withData.data ?? {}), needs_external_restore: true };
    }
    return res;
  };

  if (inviteResult.ok) {
    const data = (inviteResult as { ok: true; data?: Record<string, unknown> })
      .data ?? {};
    // Lượt mời vừa rồi đã tự soi 2 tab và thấy đủ (đường `afterSilentSubmit`) →
    // quét lại là quét vào chỗ đã biết câu trả lời, chỉ tốn thêm chục giây.
    const alreadyVerified = data.verified_without_reload === true;
    if (alreadyVerified) {
      console.log(
        "[autogpt-invite] lượt mời đã xác minh tại chỗ ở tab Lời mời/Người dùng — bỏ qua bước quét lại",
      );
      return finish(inviteResult);
    }
    // BÁO NHỊP trước khi vào bước quét: từ đây tới lúc background nhận kết quả là
    // chặng dài nhất mà dashboard không nghe thấy gì (ca `0d191682` ngày
    // 30/8/2026: im 483s → backend chốt treo 8 phút dù lời mời đã đi).
    await reportProgress(
      taskId,
      {
        phase: "scan-pending",
        message: `Đã gửi ${emails.length} lời mời — sang tab "Lời mời đang chờ xử lý" soi lại...`,
        current: 0,
        total: emails.length,
      },
      true,
    );
    await sleep(500); // chờ DOM ổn định sau navigate cuối của wrapper
    const scan = await scanPendingForEmails(emails, 8_000);
    await reportProgress(
      taskId,
      {
        phase: "scan-pending",
        message: scan.usable
          ? `Tab "Lời mời đang chờ xử lý": thấy ${scan.matched.length}/${emails.length} email` +
            (scan.missing.length > 0 ? " — phần còn lại chờ vòng F5 soi tiếp..." : ".")
          : 'Không vào được tab "Lời mời đang chờ xử lý" — để vòng F5 soi lại...',
        current: scan.matched.length,
        total: emails.length,
      },
      true,
    );

    if (scan.usable && scan.missing.length === 0) {
      console.log(
        `[autogpt-invite] ĐÃ THẤY đủ ${emails.length} email trong tab Lời mời — BỎ QUA F5 + Phase 2`,
      );
      // Bỏ awaiting_reload_verify → runner đi thẳng reportToBackend với chính
      // các trường mà Phase 2 vẫn trả (verified/unverified/pending_members).
      delete data.awaiting_reload_verify;
      data.verified_emails = emails.map((e) => e.trim().toLowerCase());
      data.unverified_emails = [];
      data.pending_members = scan.matched;
      data.verify_scrape_failed = false;
      data.verified_without_reload = true;
      (inviteResult as { ok: true; data?: Record<string, unknown> }).data = data;
    } else if (!scan.usable) {
      console.warn(
        "[autogpt-invite] không vào được tab 'Lời mời' — để Phase 2 sau F5 tự navigate + quét",
      );
    } else {
      console.log(
        `[autogpt-invite] còn ${scan.missing.length}/${emails.length} email chưa thấy — nhờ runner F5 rồi quét lại:`,
        scan.missing,
      );
    }
  }

  // Gắn số liệu suất vào kết quả để dashboard cập nhật seat_total/seat_used từ
  // con số THẬT của ChatGPT (chính xác hơn scrape trang Thanh toán).
  //
  // Gắn cho CẢ ca HỎNG (trước đây chỉ gắn khi `ok`): chính lúc mời hỏng mới cần
  // biết bước suất đã thấy gì. Hai task VERIFY_FAILED ngày 22/8/2026 để lại đúng
  // `{submit_clicked:true}` trong DB, không một con số suất nào — phải suy ngược
  // từ hành vi mới đoán ra là chốt suất đã bị bỏ qua. (v0.13.1 đã giữ `data` của
  // lỗi vào `result`, nhưng `seatData` vẫn rơi ở đây nên vẫn trắng thông tin.)
  // Cờ dọn-dẹp: gắn cho CẢ ca hỏng — mời hỏng thì toggle vẫn đang ON, càng phải
  // tắt. Background đọc cờ này ở `runner.ts` (nhánh external) rồi gọi
  // SET_EXTERNAL_INVITES. Background bản mới thực ra luôn tắt sau nhánh external
  // dù có cờ hay không; cờ để log/chẩn đoán và cho bản background cũ hơn.
  return finish(inviteResult);
}
