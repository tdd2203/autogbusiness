import type { ScrapedMember } from "../../../shared/messages";
import { humanClick, sleep } from "../../human";
import { reportProgress } from "../../progress";
import { executeCheckActiveAfterInvite } from "./check-active-after-invite";
import { isInviteDialogOpen } from "./invite-success-toast";
import { scanPendingForEmails } from "./scan-pending-page";

const LOG = "[autogpt-invite-landed]";

/** Trần cho lượt quét tab "Lời mời đang chờ xử lý" trong bước soi này. */
const PENDING_SCAN_MS = 8_000;

/** Chữ trên nút đóng/huỷ của hộp thoại Mời — chỉ dùng khi Escape không ăn. */
const DISMISS_TEXTS = ["Hủy", "Huỷ", "Hủy bỏ", "Huỷ bỏ", "Cancel", "Close", "取消", "关闭"];

/**
 * ĐÓNG hộp thoại Mời nếu nó còn treo.
 *
 * Bắt buộc trước khi soi 2 tab: hộp thoại Radix khoá tương tác phần trang phía
 * sau (`aria-hidden` + pointer-events), nên mọi cú bấm tab đều rơi vào lớp phủ và
 * `clickTabAndWait` sẽ báo "không đổi được tab" sau 3 lần thử.
 */
export async function dismissInviteDialog(): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!isInviteDialogOpen()) return true;
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
    );
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
    dialog?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
    );
    await sleep(400);
    if (!isInviteDialogOpen()) return true;
    // Escape không ăn (một số bản dialog chặn) → tìm nút đóng/huỷ trong hộp.
    const box = document.querySelector('[role="dialog"]');
    if (box) {
      const btn = Array.from(box.querySelectorAll<HTMLElement>("button")).find((b) => {
        const label = `${b.textContent ?? ""} ${b.getAttribute("aria-label") ?? ""}`.trim();
        return DISMISS_TEXTS.some((t) => label.includes(t));
      });
      if (btn) await humanClick(btn);
    }
    await sleep(400);
  }
  const stillOpen = isInviteDialogOpen();
  if (stillOpen) console.warn(`${LOG} hộp thoại Mời KHÔNG đóng được — vẫn thử soi tab`);
  return !stillOpen;
}

export type LandedCheck = {
  /** Email thấy ở tab "Lời mời đang chờ xử lý". */
  pending: ScrapedMember[];
  /** Email thấy ở tab "Người dùng" (người nhận bấm tham gia ngay). */
  active: ScrapedMember[];
  /** Email KHÔNG thấy ở cả hai tab (lowercase). */
  missing: string[];
  /** false = không vào được tab "Lời mời" ⇒ "không thấy" ở đây không có sức nặng. */
  pendingUsable: boolean;
  /** Email tra không ra kết luận ở tab "Người dùng" (ô lọc không phản hồi). */
  inconclusive: string[];
};

/**
 * SOI HAI TAB tìm các email vừa bấm Gửi: "Lời mời đang chờ xử lý" TRƯỚC, rồi
 * "Người dùng" (user chốt 30/8/2026).
 *
 * Dùng cho ca ChatGPT KHÔNG phản hồi trong trần chờ: "không đọc được toast" chỉ
 * chứng minh ta không biết, còn hai tab này là nơi có câu trả lời thật. Thấy ở
 * đâu cũng tính là lời mời ĐÃ đi — chỉ khi cả hai tab đều trắng mới được coi là
 * chưa đi và mời lại.
 *
 * KHÔNG throw. Để trang ở tab "Người dùng" khi có bước tra tab đó (tiện cho việc
 * mở lại hộp Mời ngay sau).
 */
export async function checkInviteLanded(
  taskId: string,
  emails: string[],
): Promise<LandedCheck> {
  const wanted = emails.map((e) => e.trim().toLowerCase());
  await dismissInviteDialog();

  await reportProgress(
    taskId,
    {
      phase: "no-reply-check",
      message: `ChatGPT chưa xác nhận — soi tab "Lời mời đang chờ xử lý" tìm ${wanted.length} email...`,
      current: 0,
      total: wanted.length,
    },
    true,
  );

  const scan = await scanPendingForEmails(wanted, PENDING_SCAN_MS);
  const pending = scan.usable ? scan.matched : [];
  let missing = scan.usable ? scan.missing : [...wanted];
  console.log(
    `${LOG} tab Lời mời: thấy ${pending.length}/${wanted.length}` +
      (scan.usable ? "" : " (KHÔNG vào được tab)"),
  );

  const active: ScrapedMember[] = [];
  const inconclusive: string[] = [];
  if (missing.length > 0) {
    await reportProgress(
      taskId,
      {
        phase: "no-reply-check",
        message: `Còn ${missing.length} email chưa thấy ở tab Lời mời — tìm tiếp ở tab "Người dùng"...`,
        current: pending.length,
        total: wanted.length,
      },
      true,
    );
    const res = await executeCheckActiveAfterInvite(taskId, missing);
    if (res.ok) {
      const data = (res.data ?? {}) as {
        active_members?: ScrapedMember[];
        active_emails?: string[];
        inconclusive_emails?: string[];
      };
      active.push(...(data.active_members ?? []));
      inconclusive.push(...(data.inconclusive_emails ?? []));
      const found = new Set((data.active_emails ?? []).map((e) => e.toLowerCase()));
      missing = missing.filter((e) => !found.has(e));
      console.log(`${LOG} tab Người dùng: thấy ${found.size}/${missing.length + found.size}`);
    } else {
      console.warn(`${LOG} không vào được tab Người dùng — giữ nguyên danh sách chưa thấy`);
    }
  }

  return { pending, active, missing, pendingUsable: scan.usable, inconclusive };
}
