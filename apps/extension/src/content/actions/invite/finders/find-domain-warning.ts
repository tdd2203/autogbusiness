/**
 * Phát hiện banner cảnh báo "email không thuộc miền đã xác minh" trong dialog Mời.
 *
 * ChatGPT validate email LIVE khi gõ: nếu có email NGOÀI domain đã verify VÀ
 * setting "Allow External Domain Invites" CHƯA có hiệu lực, dialog hiện banner đỏ
 *   "The following emails are not a part of your organization's verified domains:
 *    ... Either remove these emails, enable 'Allow External Domain Invites' ..."
 * đồng thời DISABLE nút "Send invites".
 *
 * Vì sao cần (v0.8.12, user 2026-06-19): `execute-invite.ts` bật toggle ở
 * /admin/identity và xác nhận `aria-checked=true` TRƯỚC khi mở dialog. Nhưng hiệu
 * lực của setting cần một chút thời gian để PROPAGATE sang dialog Mời — trong cửa
 * sổ đó dialog vẫn render banner + disable submit. Nếu cứ submit → click vào nút
 * disabled → verify timeout 15s → VERIFY_FAILED, hoặc tệ hơn tạo phantom "đang
 * chờ". Giải pháp: sau khi gõ email, nếu thấy banner thì ĐỢI (poll) nó biến mất
 * rồi mới submit; hết timeout vẫn còn → huỷ invite rõ ràng.
 *
 * Detection bằng text (lowercase includes) — bền với đổi cấu trúc DOM/locale hơn
 * là bám class/màu. Patterns ở `EXTERNAL_DOMAIN_WARNING_PATTERNS` (i18n-ui.ts).
 */

import { sleep } from "../../../human";
import { EXTERNAL_DOMAIN_WARNING_PATTERNS } from "../../../i18n-ui";

/** Lấy dialog còn gắn DOM — re-query nếu node truyền vào đã bị detach do re-render. */
function liveDialog(passed?: ParentNode | null): HTMLElement | null {
  if (passed && (passed as Node).isConnected) return passed as HTMLElement;
  return document.querySelector('[role="dialog"]');
}

/**
 * Trả về đoạn pattern khớp (để log) nếu dialog đang hiện banner cảnh báo
 * miền-chưa-xác-minh, hoặc null nếu không có.
 */
export function findVerifiedDomainWarning(
  dialog?: ParentNode | null,
): string | null {
  const root = liveDialog(dialog);
  if (!root) return null;
  const text = (root.textContent ?? "").toLowerCase();
  return EXTERNAL_DOMAIN_WARNING_PATTERNS.find((p) => text.includes(p)) ?? null;
}

export function hasVerifiedDomainWarning(dialog?: ParentNode | null): boolean {
  return findVerifiedDomainWarning(dialog) !== null;
}

/**
 * Poll tới khi banner cảnh báo BIẾN MẤT (= setting external-invites đã có hiệu
 * lực trong dialog) → trả `true`. Hết `timeoutMs` mà vẫn còn → `false`.
 * Trả `true` ngay nếu hiện tại đã không có banner. stepMs=400 đồng bộ với
 * `pollUntilState` của set-toggle.
 */
export async function waitForDomainWarningCleared(
  dialog: ParentNode | null,
  timeoutMs: number,
  stepMs = 400,
): Promise<boolean> {
  if (!hasVerifiedDomainWarning(dialog)) return true;
  const ticks = Math.max(1, Math.ceil(timeoutMs / stepMs));
  for (let i = 0; i < ticks; i++) {
    await sleep(stepMs);
    if (!hasVerifiedDomainWarning(dialog)) return true;
  }
  return false;
}
