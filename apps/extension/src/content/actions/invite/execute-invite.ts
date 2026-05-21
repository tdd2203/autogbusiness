import type {
  ExecuteActionResponse,
  ChatGPTRole,
} from "../../../shared/messages";
import { sleep } from "../../human";
import { TEXT_FALLBACKS } from "../../selectors";
import { withExternalInvitesEnabled } from "../external-invites";
import { clickTabAndWait } from "../sync";
import { executeInviteInner } from "./execute-invite-inner";
import { waitForPendingListStable } from "./wait-for-pending-list-stable";

export async function executeInvite(
  taskId: string,
  emails: string[],
  role: ChatGPTRole,
): Promise<ExecuteActionResponse> {
  console.log(
    `[autogpt-invite] START ${emails.length} email(s) role=${role} pathname=${location.pathname}`,
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
  const inviteResult = await withExternalInvitesEnabled(() =>
    executeInviteInner(taskId, emails, role),
  );

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
