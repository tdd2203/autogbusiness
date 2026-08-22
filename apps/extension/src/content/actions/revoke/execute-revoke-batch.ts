/**
 * Batch revoke handler chạy trên /admin/members tab "Lời mời đang chờ xử lý".
 * Wrap quanh revokeInvite — đảm bảo đúng tab + loop emails.
 */

import type { ExecuteActionResponse } from "../../../shared/messages";
import { sleep } from "../../human";
import { executeRemove } from "../remove";
import { ensurePendingInvitesTab } from "./pending-tab";
import { revokeInvites } from "./revoke-invites-loop";
import type { RevokeResult } from "./revoke-invite";

export async function executeRevokeInvites(
  taskId: string,
  emails: string[],
): Promise<ExecuteActionResponse> {
  if (emails.length === 0) {
    return { ok: true, data: { revoked: 0, failed: 0, results: [] } };
  }
  console.log(`[autogpt-revoke] batch: ${emails.length} emails`);

  // Về đúng tab "Lời mời đang chờ xử lý" (helper dùng chung với fallback của
  // REMOVE — xem `pending-tab.ts`).
  const switched = await ensurePendingInvitesTab();
  if (!switched) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        "Không chuyển được sang tab 'Lời mời đang chờ xử lý' để revoke: không thấy nút tab sau 12s, HOẶC click không đổi URL sang ?tab=invites sau 3 lần thử. URL hiện: " +
        location.href +
        ". Kiểm tra /admin/members đã render thanh tab chưa (có thể chưa login hoặc DOM ChatGPT đổi).",
    };
  }

  const results = await revokeInvites(emails);

  // Fallback: email KHÔNG có trên tab "Lời mời" (notInPending) thường vì người đó
  // đã CHẤP NHẬN lời mời → trở thành active member, không còn pending invite để
  // thu hồi. Chuyển sang tab "Người dùng" và xoá họ khỏi workspace (executeRemove
  // tự click tab Người dùng + lọc/lật trang + confirm + verify).
  const toRemove = results.filter((r) => r.notInPending).map((r) => r.email);
  let removedViaFallback = 0;
  if (toRemove.length > 0) {
    console.log(
      `[autogpt-revoke] fallback REMOVE cho ${toRemove.length} email không có trên tab Lời mời:`,
      toRemove,
    );
    for (const email of toRemove) {
      // `allowPendingFallback:false`: chính ta VỪA khẳng định email không có ở tab
      // Lời mời, nên đừng để executeRemove quay lại đó tra thêm lần nữa.
      const rm = await executeRemove(taskId, email, { allowPendingFallback: false });
      const idx = results.findIndex((r) => r.email === email);
      const merged: RevokeResult = rm.ok
        ? { email, ok: true, viaRemove: true }
        : {
            email,
            ok: false,
            viaRemove: true,
            reason: `Không có trên tab Lời mời; xoá khỏi tab Người dùng cũng thất bại: ${
              rm.error_message ?? rm.error_code ?? "unknown"
            }`,
          };
      if (idx >= 0) results[idx] = merged;
      else results.push(merged);
      if (rm.ok) removedViaFallback += 1;
      // Delay anti-bot giữa các thao tác destructive.
      await sleep(1000 + Math.floor(Math.random() * 2000));
    }
  }

  const revoked = results.filter((r) => r.ok && !r.viaRemove).length;
  const failed = results.filter((r) => !r.ok).length;

  // Nếu KHÔNG thu hồi/xoá được email nào mà CÓ lỗi → báo task FAILED (đừng nuốt lỗi
  // thành COMPLETED). Trước đây luôn ok:true dù revoked=0 → backend mark member
  // 'removed' oan dù lời mời vẫn còn trên ChatGPT (user 2026-07-13). Backend vẫn đọc
  // `data.results[].ok` để chỉ mark những email thực sự thành công (khi partial).
  const anySuccess = revoked + removedViaFallback > 0;
  if (!anySuccess && failed > 0) {
    const reasons = results
      .filter((r) => !r.ok)
      .map((r) => `${r.email}: ${r.reason ?? "unknown"}`)
      .join("; ");
    return {
      ok: false,
      error_code: "FAILED_UI_CHANGED",
      error_message: `Không thu hồi được lời mời nào (${failed} lỗi). ${reasons}`,
    };
  }

  return {
    ok: true,
    data: { revoked, removed: removedViaFallback, failed, results },
  };
}
