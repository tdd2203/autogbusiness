/**
 * Batch revoke handler chạy trên /admin/members tab "Lời mời đang chờ xử lý".
 * Wrap quanh revokeInvite — đảm bảo đúng tab + loop emails.
 */

import type { ExecuteActionResponse } from "../../../shared/messages";
import { sleep } from "../../human";
import { executeRemove } from "../remove";
import {
  LOAD_BUDGET_MS as PENDING_LOAD_BUDGET_MS,
  onPendingTab,
  readPendingSnapshot,
  waitForPendingListLoaded,
} from "../invite/pending-list-loaded";
import { emailsInListRegion } from "../invite/scan-pending-page";
import { ensurePendingInvitesTab } from "./pending-tab";
import { revokeInvites } from "./revoke-invites-loop";
import type { RevokeResult } from "./revoke-invite";

export async function executeRevokeInvites(
  taskId: string,
  emails: string[],
  // `releasePaidSeatUntil`: ngày chốt chu kỳ — chỉ đường lui gỡ ở tab "Người
  // dùng" mới gặp hộp "Gỡ suất trả phí?", nên chuyển tiếp nguyên cho `executeRemove`.
  opts: { releasePaidSeatUntil?: string } = {},
): Promise<ExecuteActionResponse> {
  if (emails.length === 0) {
    return { ok: true, data: { revoked: 0, failed: 0, results: [] } };
  }
  console.log(`[autogpt-revoke] batch: ${emails.length} emails`);

  // Mốc so cho vòng chờ nạp: danh sách đang hiện TRƯỚC khi bấm sang tab. Đã đứng
  // sẵn ở tab Lời mời thì không có mốc nào (so với chính mình là tự chặn mình).
  const baseline = onPendingTab() ? new Set<string>() : emailsInListRegion();

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

  // CHỜ DANH SÁCH NẠP XONG rồi mới tra (6/9/2026). `revokeInvite` kết luận
  // `notInPending` khi không định vị được row, và ở dưới `notInPending` được đem
  // đi lùi sang tab "Người dùng" rồi chốt "đã rời workspace" — trong khi một danh
  // sách CHƯA VẼ cũng cho ra đúng hình dạng "không có row nào". Cùng cái van đã
  // dựng cho phép đếm nợ suất (`count-pending-invites.ts`) và cho fallback của
  // REMOVE: chỉ chốt khi có bằng chứng, chưa tra được thì nói thẳng là chưa tra
  // được. `UI_ELEMENT_NOT_FOUND` ⇒ backend luôn giữ member, không mark removed.
  const loadVerdict = await waitForPendingListLoaded(PENDING_LOAD_BUDGET_MS, baseline, {
    read: readPendingSnapshot,
    now: () => Date.now(),
    sleep,
  });
  if (!loadVerdict.loaded) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        `Đã vào tab "Lời mời đang chờ xử lý" nhưng danh sách chưa nạp xong sau ` +
        `${loadVerdict.waitedMs}ms (${loadVerdict.reason}) → không tra được, ` +
        `GIỮ nguyên các email này để lượt sau thử lại.`,
    };
  }

  const results = await revokeInvites(emails);

  // Fallback sang tab "Người dùng" cho HAI ca, đều có cùng một nguyên nhân: người đó
  // đã CHẤP NHẬN lời mời nên không còn gì để thu hồi.
  //   · `notInPending` — không thấy row nào trên tab "Lời mời";
  //   · `menuWithoutRevoke` — có row nhưng menu "..." KHÔNG có mục "Thu hồi lời mời"
  //     (row của tab "Người dùng" lọt vào, hoặc lời mời vừa được chấp nhận). Ca này
  //     trước 4/9/2026 rơi thẳng xuống "task FAILED" mà không lùi bước nào — 4/7 lệnh
  //     thu hồi hỏng trên production là nó.
  // `inconclusive` CỐ Ý không nằm trong danh sách này (6/9/2026): lùi sang tab
  // "Người dùng" rồi chốt "đã rời workspace" dựa trên một cú tra chưa chứng minh
  // được gì chính là đường nhả ghế oan. Email đó giữ nguyên `ok:false` để lượt
  // sau tra lại.
  const toRemove = results
    .filter((r) => !r.inconclusive && (r.notInPending || r.menuWithoutRevoke))
    .map((r) => r.email);
  let removedViaFallback = 0;
  if (toRemove.length > 0) {
    console.log(
      `[autogpt-revoke] fallback REMOVE cho ${toRemove.length} email không thu hồi được ở tab Lời mời:`,
      toRemove,
    );
    for (const email of toRemove) {
      const sawPendingRow = results.some(
        (r) => r.email === email && r.menuWithoutRevoke,
      );
      // `allowPendingFallback:false`: chính ta VỪA đứng ở tab Lời mời, đừng để
      // executeRemove quay lại đó tra thêm lần nữa (ping-pong 2 tab vô ích).
      const rm = await executeRemove(taskId, email, {
        allowPendingFallback: false,
        releasePaidSeatUntil: opts.releasePaidSeatUntil,
      });
      const idx = results.findIndex((r) => r.email === email);
      let merged: RevokeResult;
      if (rm.ok) {
        // "Không có trong tab Người dùng" = đã rời workspace — NHƯNG chỉ tin điều đó
        // khi ta cũng không thấy row nào bên tab Lời mời. Ca `menuWithoutRevoke` thì
        // ta VỪA thấy một row mang email này: hai tab cùng nói "không có" là mâu
        // thuẫn, báo thành công lúc đó chính là xoá-giả (backend mark removed trong
        // khi lời mời vẫn sống). Thà báo chưa xong để lượt sau thử lại.
        const absentOnly =
          sawPendingRow &&
          (rm.data as { absent?: boolean } | undefined)?.absent === true;
        merged = absentOnly
          ? {
              email,
              ok: false,
              viaRemove: true,
              reason:
                "Menu row trên tab Lời mời không có mục 'Thu hồi lời mời', mà tab " +
                "Người dùng cũng không thấy email này → chưa dám kết luận đã rời, " +
                "giữ nguyên để thử lại.",
            }
          : { email, ok: true, viaRemove: true };
      } else {
        merged = {
          email,
          ok: false,
          viaRemove: true,
          reason: `Không thu hồi được ở tab Lời mời; xoá khỏi tab Người dùng cũng thất bại: ${
            rm.error_message ?? rm.error_code ?? "unknown"
          }`,
        };
      }
      if (idx >= 0) results[idx] = merged;
      else results.push(merged);
      if (merged.ok) removedViaFallback += 1;
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
