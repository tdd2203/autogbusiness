import { sleep } from "../../human";
import { revokeInvite, type RevokeResult } from "./revoke-invite";

/**
 * Ngân sách XÁC MINH cho cả batch. Task REVOKE_INVITES chỉ có 150s (xem
 * `CONTENT_TIMEOUTS` trong background/runner.ts) mà mỗi email nay phải chờ
 * ChatGPT chốt + quét lại tab Lời mời, nên phải CHIA ngân sách chứ không cho
 * mỗi email tự do 25s: 10 email × 25s là chắc chắn timeout cả task.
 */
const BATCH_VERIFY_BUDGET_MS = 110_000;
/** Kẹp ngân sách mỗi email — đủ 1-2 lần tra, không nuốt hết phần của email sau. */
const PER_EMAIL_MIN_MS = 6000;
const PER_EMAIL_MAX_MS = 25_000;

/**
 * Revoke nhiều invite trong loop. Đứng yên ở tab "Lời mời" và xử lý từng cái.
 * Thêm delay ngẫu nhiên 1-3s giữa các revoke để giảm pattern bot.
 */
export async function revokeInvites(emails: string[]): Promise<RevokeResult[]> {
  const results: RevokeResult[] = [];
  const deadline = Date.now() + BATCH_VERIFY_BUDGET_MS;
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
