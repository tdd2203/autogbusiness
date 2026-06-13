/**
 * Toggle "Cho phép lời mời từ miền bên ngoài" trên /admin/identity.
 *
 * Workspace setting bảo mật: khi BẬT, mọi member trong workspace có thể mời
 * người ở bất kỳ domain nào (rất rủi ro nếu để ON lâu dài). Khi TẮT, chỉ mời
 * được người trong các domain đã verify.
 *
 * Use case: dashboard cần invite một email ngoài domain → tự bật ON ngay
 * trước khi invite, restore về trạng thái ban đầu (thường OFF) sau khi invite
 * xong, kể cả invite FAIL.
 *
 * Hàm chính: `withExternalInvitesEnabled(taskFn)`:
 *   1. Navigate /admin/identity, đọc state toggle hiện tại
 *   2. Nếu OFF → bật ON, đợi update xong
 *   3. Navigate về /admin/members
 *   4. Chạy taskFn() (vd invite)
 *   5. try/finally: nếu state ban đầu là OFF → navigate /admin/identity tắt lại
 *
 * Selectors heuristic (ChatGPT có thể đổi UI):
 *   - Toggle là `button[role="switch"]` hoặc `input[type="checkbox"]`
 *   - Label text gần đó chứa "Cho phép lời mời từ miền bên ngoài" / "external"
 *   - State đọc qua `aria-checked` hoặc `.checked`
 */

import { navigateTo } from "./navigate";
import { setExternalInvites } from "./set-toggle";

const MEMBERS_PATH = "/admin/members";

/**
 * Wrapper: tạm bật external invites → chạy taskFn → LUÔN tắt OFF sau invite.
 *
 * Spec (v0.6.6, user 2026-05-20):
 *   1. Kiểm tra toggle hiện tại (read prev state).
 *   2. Nếu OFF → bật ON. Nếu đã ON → skip click, dùng nguyên.
 *   3. Chạy taskFn (invite).
 *   4. SAU INVITE (finally): LUÔN tắt OFF, KỂ CẢ user đã bật ON từ trước.
 *      Lý do: "Cho phép lời mời từ miền bên ngoài" là rủi ro bảo mật — sau
 *      mỗi invite phải về OFF để không leave workspace ở trạng thái mở. User
 *      có thể bật lại thủ công nếu cần invite tiếp.
 *
 * GUARANTEE: finally luôn chạy kể cả taskFn throw → toggle luôn về OFF.
 *
 * Nếu không tìm thấy toggle (DOM đổi, prev=null) → skip toàn bộ wrap, chạy
 * taskFn trực tiếp (không phá invite flow).
 */
export async function withExternalInvitesEnabled<T>(
  taskFn: () => Promise<T>,
): Promise<T> {
  const setResult = await setExternalInvites(true);

  if (setResult.prev === null) {
    console.warn(
      "[autogpt-external-invites] không control được toggle — chạy invite mà KHÔNG bật external invites. Nếu email ngoài domain, invite có thể fail.",
    );
    // Navigate về members trước khi chạy taskFn
    await navigateTo(
      MEMBERS_PATH,
      () => location.pathname.includes(MEMBERS_PATH),
      5_000,
    );
    return await taskFn();
  }

  console.log(
    `[autogpt-external-invites] state trước invite: ${setResult.prev ? "ON" : "OFF"}${setResult.changed ? " → đã bật ON cho invite" : " (đã ON sẵn, không click)"}`,
  );

  // Navigate về /admin/members để taskFn chạy invite. Đợi predicate:
  //   - URL đổi sang /admin/members
  //   - VÀ có ít nhất 1 element h1/main render (page content visible)
  // Tăng timeout lên 10s vì SPA cần thời gian render content sau khi đổi route
  // từ /admin/identity. Trước đây chỉ chờ URL → invite gọi findInviteOpenButton
  // ngay khi DOM chưa render → UI_ELEMENT_NOT_FOUND.
  await navigateTo(
    MEMBERS_PATH,
    () => {
      if (!location.pathname.includes(MEMBERS_PATH)) return false;
      // Page rendered khi có main content + ít nhất 1 button-like control
      const main = document.querySelector("main, [role='main']");
      const hasButtons = document.querySelectorAll("button").length > 2;
      return !!main && hasButtons;
    },
    10_000,
  );

  try {
    return await taskFn();
  } finally {
    // v0.6.6: LUÔN tắt toggle về OFF sau invite — KHÔNG restore prev nữa.
    // Trước đây (v0.6.5): chỉ restore khi `changed=true` → nếu prev đã ON
    // (user bật vĩnh viễn) thì finally bỏ qua → toggle giữ ON → vi phạm spec
    // bảo mật của user ("sau mời xong phải tắt mời ngoài"). v0.6.6 force OFF.
    console.log(
      "[autogpt-external-invites] SAU INVITE: LUÔN tắt toggle về OFF (force OFF, không restore prev)",
    );
    try {
      await setExternalInvites(false);
    } catch (e) {
      console.warn(
        "[autogpt-external-invites] force OFF FAILED — ChatGPT có thể vẫn ở trạng thái external invites = ON. Tắt thủ công nếu cần.",
        e,
      );
    }
    // Luôn navigate về /admin/members khi kết thúc invite (dù toggle có đổi
    // hay không, dù invite success/fail) — UX nhất quán cho user và để task
    // sau (SYNC_DATA, REMOVE_MEMBER, ...) khởi động ở đúng trang.
    try {
      await navigateTo(
        MEMBERS_PATH,
        () => {
          if (!location.pathname.includes(MEMBERS_PATH)) return false;
          const main = document.querySelector("main, [role='main']");
          const hasButtons = document.querySelectorAll("button").length > 2;
          return !!main && hasButtons;
        },
        10_000,
      );
    } catch (e) {
      console.warn(
        "[autogpt-external-invites] navigate về /admin/members fail",
        e,
      );
    }
  }
}
