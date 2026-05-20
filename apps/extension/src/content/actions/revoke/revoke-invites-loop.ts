import { sleep } from "../../human";
import { revokeInvite, type RevokeResult } from "./revoke-invite";

/**
 * Revoke nhiều invite trong loop. Đứng yên ở tab "Lời mời" và xử lý từng cái.
 * Thêm delay ngẫu nhiên 1-3s giữa các revoke để giảm pattern bot.
 */
export async function revokeInvites(emails: string[]): Promise<RevokeResult[]> {
  const results: RevokeResult[] = [];
  for (const email of emails) {
    const r = await revokeInvite(email);
    results.push(r);
    if (!r.ok) {
      console.warn(`[autogpt-revoke] FAIL ${email}: ${r.reason}`);
    }
    await sleep(1000 + Math.floor(Math.random() * 2000));
  }
  return results;
}
