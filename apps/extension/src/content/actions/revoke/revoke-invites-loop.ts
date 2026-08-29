import { sleep } from "../../human";
import { revokeInvite, type RevokeResult } from "./revoke-invite";

/**
 * Ngân sách XÁC MINH cho cả mẻ, TÍNH THEO SỐ EMAIL.
 *
 * Trước đây là một cục cứng 110s chia cho mọi email, kẹp trần 25s/email. Nay mỗi
 * email cần tới ~60s mới đủ vượt khoảng ChatGPT chậm cập nhật (~34s, xem
 * `verify-invite-gone.ts`), nên ngân sách phải LỚN DẦN theo số email — y như
 * trần của cả lệnh: `CONTENT_TIMEOUTS.REVOKE_INVITES` (150s) đã được nhân theo
 * số lệnh trong mẻ ở `background/runner.ts`. Giữ nguyên cục 110s mà nới trần
 * từng email thì thu hồi 5 lời mời sẽ cụt ngân sách từ email thứ ba.
 *
 * 90s/email cho phần xác minh, cộng ~20-30s thao tác mỗi email, vẫn nằm trong
 * 150s/lệnh mà trần ngoài cấp.
 */
const VERIFY_BUDGET_PER_EMAIL_MS = 90_000;
/** Kẹp ngân sách mỗi email — đủ 2 vòng hỏi, không nuốt hết phần của email sau. */
const PER_EMAIL_MIN_MS = 10_000;
const PER_EMAIL_MAX_MS = 60_000;

/**
 * Revoke nhiều invite trong loop. Đứng yên ở tab "Lời mời" và xử lý từng cái.
 * Thêm delay ngẫu nhiên 1-3s giữa các revoke để giảm pattern bot.
 */
export async function revokeInvites(emails: string[]): Promise<RevokeResult[]> {
  const results: RevokeResult[] = [];
  const deadline = Date.now() + VERIFY_BUDGET_PER_EMAIL_MS * emails.length;
  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    // Phần ngân sách còn lại chia đều cho số email còn lại (kẹp min/max).
    const share = Math.floor(
      Math.max(0, deadline - Date.now()) / Math.max(1, emails.length - i),
    );
    const budget = Math.min(
      PER_EMAIL_MAX_MS,
      Math.max(PER_EMAIL_MIN_MS, share),
    );
    const r = await revokeInvite(email, budget);
    results.push(r);
    if (!r.ok) {
      console.warn(`[autogpt-revoke] FAIL ${email}: ${r.reason}`);
    }
    await sleep(1000 + Math.floor(Math.random() * 2000));
  }
  return results;
}
