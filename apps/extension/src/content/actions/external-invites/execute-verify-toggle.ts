/**
 * Đọc lại công tắc "Cho phép lời mời từ miền bên ngoài" SAU KHI background đã
 * TẢI LẠI /admin/identity. Lệnh CHỈ-ĐỌC: không bấm gì, không điều hướng đi đâu.
 *
 * VÌ SAO PHẢI LÀ MỘT LỆNH RIÊNG (chốt user 3/9/2026):
 * ChatGPT thỉnh thoảng hỏng ngay cú bấm công tắc và in băng-rôn đỏ "Something
 * went wrong..." — React vẫn vẽ công tắc sang ON nên `aria-checked` khai ON, chỉ
 * có TẢI LẠI TRANG mới đọc được trạng thái ChatGPT thật sự đã lưu. Content
 * script KHÔNG tự F5 được (F5 là chết context, lệnh mất kênh — xem
 * `execute-set-toggle.ts`), nên vòng này phải là: content báo có băng-rôn →
 * background F5 → background gọi lệnh này để đọc.
 *
 * KHÔNG bấm lại công tắc ở đây, kể cả khi đọc ra OFF. Bấm lại lúc ChatGPT đang
 * hỏng là đúng cách để bị nó khoá tiếp — chỗ này chỉ đưa ra con số, còn quyết
 * định "ngưng mời một tiếng" là của backend.
 */

import type { ExecuteActionResponse } from "../../../shared/messages";
import { findIdentityErrorBanner } from "./detect-error-banner";
import { findExternalInvitesToggle } from "./finders/find-toggle";
import { navigateTo } from "./navigate";
import { readStateFresh } from "./set-toggle";

const IDENTITY_PATH = "/admin/identity";

export async function executeVerifyExternalToggle(): Promise<ExecuteActionResponse> {
  // Background vừa điều hướng thật tới /admin/identity nên thường đã đúng trang;
  // `navigateTo` ở đây chỉ để chờ công tắc render (và cứu ca ChatGPT đá về trang
  // khác). spaFirst: không rời trang, khỏi tự tay đẩy mình vào bfcache.
  const ok = await navigateTo(
    IDENTITY_PATH,
    () => !!findExternalInvitesToggle(),
    15_000,
    { spaFirst: true },
  );
  const banner = findIdentityErrorBanner();
  const state = ok ? readStateFresh() : null;
  console.log(
    `[autogpt-external-invites] đọc lại sau khi tải lại trang: state=${state}` +
      (banner ? ` — trang vẫn treo băng-rôn: "${banner}"` : ""),
  );
  return {
    ok: true,
    data: {
      // true | false | null (mất công tắc / không đọc được — KHÔNG đoán bừa).
      external_invites_enabled: state,
      // Băng-rôn còn treo sau khi tải lại ⇒ ChatGPT đang hỏng chứ không phải cú
      // bấm lẻ. Ghi kèm để thông báo cho người dùng nói đúng chuyện.
      error_banner: banner,
    },
  };
}
