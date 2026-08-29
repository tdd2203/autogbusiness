/**
 * Lệnh GỠ / THU HỒI báo lỗi kiểu VÔ ĐỊNH — phân xử bằng cách hỏi lại ChatGPT,
 * thay vì kết luận "thất bại" ngay.
 *
 * VÌ SAO (ca thật 29/8/2026, chính chuyện user báo):
 *   11:58:40  REVOKE_INVITES  hungnd.aii  → FAILED "…message channel closed…"
 *   11:59:05  REVOKE_INVITES  hungnd.aii  → COMPLETED (chạy lại tay)
 *   10:56:54  REMOVE_MEMBER   mẻ 3 email  → cả 3 FAILED, cùng một chuỗi lỗi
 * Kênh liên lạc background↔content đứt GIỮA CHỪNG (trang bị điều hướng/đóng
 * băng/huỷ context). Thao tác trên ChatGPT lúc đó ĐÃ chạy xong — ChatGPT còn hiện
 * thông báo thành công — nhưng kết quả không về được tới background, nên lệnh bị
 * ghi là thất bại. Người dùng nhìn thấy đúng cái ngược đời: *"ChatGPT báo xoá
 * xong, quay về web quản trị thì báo xoá hỏng"*.
 *
 * Lời mời (`INVITE_MEMBER`) đã có đường phân xử này từ v0.10.1 (`invite-salvage.ts`)
 * vì nó dính tới tiền. Gỡ và thu hồi thì chưa — nên mới đứng im chịu trận.
 *
 * NGUYÊN TẮC (user 29/8/2026): *"tất cả các lệnh cần phải chờ ChatGPT phản hồi mới
 * tiếp tục đánh giá lệnh đó có thành công hay không"*. Mất kênh KHÔNG phải là câu
 * trả lời của ChatGPT — nó chỉ là mất đường nghe. Nên đường đi đúng là quay lại
 * ChatGPT mà đọc: email còn ở tab "Người dùng" / "Lời mời đang chờ xử lý" không.
 *   - Vắng ở CẢ HAI tab (và cả hai tab đều đọc được) ⇒ lệnh ĐÃ có hiệu lực.
 *   - Còn thấy ở một tab               ⇒ hỏng thật, giữ nguyên lỗi gốc.
 *   - Không đọc nổi một tab nào đó     ⇒ CHƯA biết ⇒ giữ nguyên lỗi gốc (thà báo
 *     chưa xong rồi chạy lại, còn hơn đánh dấu đã gỡ mà người ta vẫn ăn ghế).
 *
 * File này chỉ chứa hàm THUẦN (có test). Phần điều khiển tab/message nằm ở
 * `runner.ts` — cùng bố cục với `invite-salvage.ts` và `merged-report.ts`.
 */

import type { ExecuteActionResponse } from "../shared/messages";

/**
 * Lỗi hạ tầng nuốt mất kết quả — kênh chết giữa lúc content đang chạy, hoặc
 * content không kịp trả lời trong hạn.
 *
 * Ba biến thể chuỗi của Chrome đã gặp thật trên production (chép nguyên văn từ
 * `queue_items.error_message`) — xem chú thích chi tiết trong `invite-salvage.ts`,
 * regex ở đây cố ý giữ y hệt để hai đường phân xử không lệch nhau.
 */
const INDETERMINATE_CHANNEL_RE =
  /message channel (?:is )?closed|message port closed|asynchronous response|back\/forward cache/i;

export type DestructiveFailureLike = {
  error_code?: string;
  error_message?: string;
};

/**
 * `true` ⇒ ĐỪNG kết luận hỏng: quay lại ChatGPT soi hai tab rồi mới phán xử.
 *
 * CỐ Ý HẸP. Chỉ nhận lỗi mà ta KHÔNG NGHE ĐƯỢC câu trả lời:
 *   - `CONTENT_TIMEOUT` / `TIMEOUT`: content chạy quá hạn, không ai biết tới đâu.
 *   - kênh message đứt: content có thể vừa bấm xong thì mất tiếng.
 *   - `CONTENT_NOT_INJECTED`: tab chết giữa chừng nên không inject lại nổi.
 * Mọi lỗi CÓ KẾT LUẬN (`REMOVE_VERIFY_FAILED` = đã tra lại và VẪN thấy,
 * `MEMBER_NOT_IN_WORKSPACE` = ô lọc chết nên không dám kết luận,
 * `UI_ELEMENT_NOT_FOUND` = chưa bấm được gì) thì giữ nguyên: chúng đã tự đi qua
 * bước hỏi ChatGPT rồi, phân xử thêm chỉ là hỏi lại cùng một câu.
 */
export function shouldSalvageDestructive(
  failure: DestructiveFailureLike,
): boolean {
  const code = failure.error_code;
  if (code === "CONTENT_TIMEOUT" || code === "TIMEOUT") return true;
  if (code === "CONTENT_NOT_INJECTED") return true;
  return INDETERMINATE_CHANNEL_RE.test(failure.error_message ?? "");
}

/** Những gì đọc được từ ChatGPT sau khi F5 và soi lại hai tab. */
export type AbsenceEvidence = {
  /** Email CÒN thấy ở tab "Lời mời đang chờ xử lý". */
  stillPending: string[];
  /** Không đọc được tab Lời mời (không vào được / scrape hỏng) → mù hoàn toàn. */
  pendingUnusable: boolean;
  /** Email CÒN thấy ở tab "Người dùng". */
  stillActive: string[];
  /** Email mà ô lọc tab "Người dùng" không kết luận nổi. */
  activeInconclusive: string[];
  /** Không vào được tab "Người dùng" → mù hoàn toàn. */
  activeUnusable: boolean;
};

export type AbsenceVerdict = {
  /** Vắng mặt ở CẢ HAI tab, cả hai đều đọc được ⇒ lệnh đã có hiệu lực. */
  gone: string[];
  /** Còn thấy ở ít nhất một tab ⇒ lệnh chưa có hiệu lực. */
  present: string[];
  /** Không đủ căn cứ (tab mù / ô lọc không kết luận) ⇒ không phán. */
  unknown: string[];
};

function lower(list: readonly string[]): Set<string> {
  return new Set(list.map((e) => e.trim().toLowerCase()).filter(Boolean));
}

/**
 * Phân loại từng email theo bằng chứng đọc được.
 *
 * Chỉ có MỘT đường vào `gone`: cả hai tab đều đọc được VÀ email không xuất hiện
 * ở tab nào VÀ ô lọc không báo "không kết luận được". Thiếu bất kỳ vế nào →
 * `unknown` (giữ lỗi gốc), không bao giờ đoán thêm.
 */
export function classifyAbsence(
  emails: readonly string[],
  ev: AbsenceEvidence,
): AbsenceVerdict {
  const pending = lower(ev.stillPending);
  const active = lower(ev.stillActive);
  const inconclusive = lower(ev.activeInconclusive);
  const verdict: AbsenceVerdict = { gone: [], present: [], unknown: [] };
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (!email) continue;
    if (pending.has(email) || active.has(email)) {
      verdict.present.push(email);
      continue;
    }
    if (ev.pendingUnusable || ev.activeUnusable || inconclusive.has(email)) {
      verdict.unknown.push(email);
      continue;
    }
    verdict.gone.push(email);
  }
  return verdict;
}

/** Câu mô tả lỗi gốc, nhét vào kết quả để tra ngược khi cần. */
function originNote(original: ExecuteActionResponse): string {
  if (original.ok) return "unknown";
  return `${original.error_code}: ${original.error_message ?? ""}`.trim();
}

/**
 * Kết quả cuối cho REVOKE_INVITES sau khi phân xử.
 *
 * Giữ ĐÚNG hình dạng `data.results[]` mà `queue/completion.py` đọc để quyết định
 * email nào được mark removed — email nào không có bằng chứng vắng mặt thì mang
 * `ok:false`, backend giữ nguyên trạng thái và lượt sau chạy lại.
 *
 * Không email nào vắng mặt → trả nguyên lỗi gốc (đừng dựng một task COMPLETED
 * rỗng, backend sẽ không hiểu chuyện gì đã xảy ra).
 */
export function buildRevokeSalvageResponse(
  emails: readonly string[],
  verdict: AbsenceVerdict,
  original: ExecuteActionResponse,
): ExecuteActionResponse {
  if (verdict.gone.length === 0) return original;
  const gone = new Set(verdict.gone);
  const results = emails
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .map((email) =>
      gone.has(email)
        ? { email, ok: true, salvaged: true }
        : {
            email,
            ok: false,
            reason:
              "Mất liên lạc với trang giữa chừng, soi lại ChatGPT vẫn thấy email " +
              "này (hoặc không đọc được danh sách) → chưa thu hồi được.",
          },
    );
  return {
    ok: true,
    data: {
      revoked: verdict.gone.length,
      failed: results.length - verdict.gone.length,
      results,
      salvaged_after_indeterminate_error: originNote(original),
    },
  };
}

/**
 * Kết quả cuối cho REMOVE_MEMBER sau khi phân xử.
 *
 * `verified:true` + `absent:true` là ĐÚNG hợp đồng bằng chứng của backend: không
 * phải "thấy row biến mất sau cú bấm", mà là "soi lại ChatGPT thì email không còn
 * trong workspace" — cùng loại bằng chứng mà `filterOnceAndResolve` phát ra khi
 * lọc tab Người dùng không ra email (xem `execute-remove.ts`).
 *
 * Mẻ gộp (nhiều email) trả `results[]` để `splitResponseForTask` chia đúng phần
 * cho từng lệnh; lệnh lẻ giữ hình dạng cũ `{email, verified, absent}`.
 */
export function buildRemoveSalvageResponse(
  emails: readonly string[],
  verdict: AbsenceVerdict,
  original: ExecuteActionResponse,
): ExecuteActionResponse {
  if (verdict.gone.length === 0) return original;
  const gone = new Set(verdict.gone);
  const list = emails.map((e) => e.trim().toLowerCase()).filter(Boolean);
  const note = originNote(original);
  if (list.length === 1) {
    return {
      ok: true,
      data: {
        email: list[0],
        verified: true,
        absent: true,
        absence_reason: "salvage_after_lost_channel",
        salvaged_after_indeterminate_error: note,
      },
    };
  }
  return {
    ok: true,
    data: {
      results: list.map((email) =>
        gone.has(email)
          ? {
              email,
              ok: true,
              verified: true,
              absent: true,
              absence_reason: "salvage_after_lost_channel",
            }
          : {
              email,
              ok: false,
              error_code: "VERIFY_FAILED",
              error_message:
                "Mất liên lạc với trang giữa chừng, soi lại ChatGPT vẫn thấy " +
                "thành viên này (hoặc không đọc được danh sách) → chưa gỡ được.",
            },
      ),
      salvaged_after_indeterminate_error: note,
    },
  };
}
