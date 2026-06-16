import type {
  ExecuteActionResponse,
  ChatGPTRole,
} from "../../../shared/messages";
import { sleep } from "../../human";
import { TEXT_FALLBACKS } from "../../selectors";
import { navigateTo } from "../external-invites/navigate";
import { setExternalInvites } from "../external-invites/set-toggle";
import { clickTabAndWait } from "../sync";
import { executeInviteInner } from "./execute-invite-inner";
import { waitForPendingListStable } from "./wait-for-pending-list-stable";

const MEMBERS_PATH = "/admin/members";

/** Predicate: đã ở /admin/members VÀ page đã render (main + có button). */
function membersPageReady(): boolean {
  if (!location.pathname.includes(MEMBERS_PATH)) return false;
  const main = document.querySelector("main, [role='main']");
  const hasButtons = document.querySelectorAll("button").length > 2;
  return !!main && hasButtons;
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
): Promise<ExecuteActionResponse> {
  console.log(
    `[autogpt-invite] START ${emails.length} email(s) role=${role} verifiedDomain=${verifiedDomain ?? "(chưa cấu hình)"} pathname=${location.pathname}`,
  );

  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}). Mở chatgpt.com/admin/members trước.`,
    };
  }
  if (emails.length === 0) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: "Danh sách emails rỗng",
    };
  }

  // Spec (v0.6.6, theo user 2026-05-20):
  //   1. Kiểm tra toggle "Cho phép lời mời ngoài tên miền" hiện đang ON/OFF.
  //      - Nếu OFF → bật ON.
  //      - Nếu đã ON → skip click (giữ nguyên cho invite).
  //   2. Navigate /admin/members + mời thành viên (executeInviteInner).
  //   3. SAU KHI INVITE XONG (finally của withExternalInvitesEnabled):
  //      LUÔN tắt toggle về OFF — KỂ CẢ prev=ON (user bật vĩnh viễn). Đây
  //      là spec bảo mật user xác nhận: external invites là rủi ro → sau
  //      mỗi invite extension phải về OFF, user bật lại thủ công nếu cần.
  //   4. SAU KHI ĐÃ TẮT TOGGLE, chuyển sang tab "Lời mời đang chờ xử lý" →
  //      URL = /admin/members?tab=invites. ĐỢI DOM render list pending stable
  //      (waitForPendingListStable, max 8s) — đảm bảo F5 chạy ở state ổn định,
  //      không cắt giữa lúc ChatGPT React Query đang fetch.
  //   5. Background runner F5 + gọi VERIFY_PENDING_INVITE (Phase 2) →
  //      executeVerifyPendingInvite scrape pending tab → trả verified emails →
  //      runner bulk-upsert (isFullSync=false) vào DB → dashboard hiển thị.
  //
  // QUAN TRỌNG: Trình tự PHẢI là 'tắt toggle TRƯỚC, chuyển tab Lời mời SAU'.
  // Nếu đảo lại (chuyển tab → restore toggle navigate qua /admin/identity →
  // navigate về /admin/members) thì URL mất ?tab=invites → F5 load tab "Người
  // dùng" default → Phase 2 phải click lại tab, chậm hơn + dễ race với cache.
  //
  // TỐI ƯU (theo user): nếu MỌI email thuộc tên miền đã xác minh của workspace
  // thì KHÔNG cần bật toggle "mời ngoài tên miền" → bỏ qua 2 lần navigate
  // /admin/identity (nhanh hơn + không để workspace mở external). Chỉ khi
  // domain chưa cấu hình HOẶC có email ngoài domain mới dùng wrapper.
  let inviteResult: ExecuteActionResponse;
  if (allEmailsInVerifiedDomain(emails, verifiedDomain)) {
    console.log(
      `[autogpt-invite] mọi email thuộc domain xác minh "${verifiedDomain}" → BỎ QUA toggle external invites`,
    );
    // executeInviteInner yêu cầu đang ở /admin/members → điều hướng trước.
    await navigateTo(MEMBERS_PATH, membersPageReady, 10_000);
    inviteResult = await executeInviteInner(taskId, emails, role);
  } else {
    // Có email NGOÀI domain xác minh (hoặc domain chưa cấu hình) → BẮT BUỘC bật
    // toggle "Cho phép lời mời ngoài tên miền" trước khi mời. Nếu KHÔNG xác nhận
    // được toggle về ON → KHÔNG mời (return FAIL). Lý do (user yêu cầu): nếu mời
    // khi toggle vẫn OFF, ChatGPT từ chối email ngoài domain silently → dashboard
    // tạo phantom "đang chờ" cho email chưa thực sự được mời. Thà fail rõ ràng.
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
      `[autogpt-invite] toggle external invites đã ON (prev=${ensured.prev ? "ON" : "OFF"}) → tiến hành mời`,
    );
    try {
      await navigateTo(MEMBERS_PATH, membersPageReady, 10_000);
      inviteResult = await executeInviteInner(taskId, emails, role);
    } finally {
      // Spec bảo mật: LUÔN tắt toggle về OFF sau invite (kể cả prev=ON hay
      // invite throw) + về /admin/members cho task kế tiếp.
      try {
        await setExternalInvites(false);
      } catch (e) {
        console.warn(
          "[autogpt-invite] force OFF toggle external invites FAILED — tắt thủ công nếu cần.",
          e,
        );
      }
      try {
        await navigateTo(MEMBERS_PATH, membersPageReady, 10_000);
      } catch (e) {
        console.warn("[autogpt-invite] navigate về /admin/members fail", e);
      }
    }
  }

  // Bước 4: chuyển tab "Lời mời" SAU khi toggle đã tắt + đã ở /admin/members.
  // Chỉ chạy khi invite submit thành công — fail thì không cần verify.
  if (inviteResult.ok) {
    await sleep(500); // chờ DOM ổn định sau navigate cuối của wrapper
    const switched = await clickTabAndWait(
      "tab_pending_invites",
      TEXT_FALLBACKS.tabPendingInvites,
      3000, // v0.6.6: tăng 1500 → 3000ms vì ChatGPT cần thời gian fetch +
            // render pending list lần đầu (lazy load + React Query fetch).
    );
    if (switched) {
      // v0.6.6: Đợi DOM render danh sách pending ỔN ĐỊNH trước khi return.
      // Lý do: ChatGPT React Query fetch pending list xong vài giây sau khi
      // tab active. Nếu return ngay → background F5 → ngắt giữa fetch →
      // sau F5 ChatGPT có thể serve cache cũ → scrape thấy thiếu email
      // (user report "load thiếu" v0.6.5).
      //
      // Strategy: poll DOM row count (text node email pattern) cho tới khi
      // STABLE 2 ticks liên tiếp HOẶC chứa email vừa mời. Cap 8s.
      console.log(
        "[autogpt-invite] click tab 'Lời mời' OK — đợi DOM render list pending stable...",
      );
      await waitForPendingListStable(emails, 8_000);
      console.log(
        "[autogpt-invite] DOM list pending đã stable — return cho runner F5",
      );
    } else {
      console.warn(
        "[autogpt-invite] không click được tab 'Lời mời' — Phase 2 sau F5 sẽ tự navigate",
      );
    }
  }

  return inviteResult;
}
