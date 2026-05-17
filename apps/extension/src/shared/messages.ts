/**
 * Typed messages giữa background service worker và content script.
 * Background gửi: ExecuteActionRequest. Content trả: ExecuteActionResponse.
 */

export type ChatGPTRole = "owner" | "admin" | "member";

export type ExecuteActionRequest =
  | { kind: "INVITE_MEMBER"; taskId: string; email: string; role: ChatGPTRole }
  | { kind: "REMOVE_MEMBER"; taskId: string; email: string }
  | {
      kind: "CHANGE_ROLE";
      taskId: string;
      email: string;
      new_role: ChatGPTRole;
      old_role: ChatGPTRole | null;
    }
  | { kind: "SYNC_DATA"; taskId: string; includePending?: boolean }
  | { kind: "SYNC_BILLING"; taskId: string }
  | { kind: "REVOKE_INVITES"; taskId: string; emails: string[] }
  | { kind: "PING"; taskId?: string };

export type ScrapedBilling = {
  plan: string | null;
  seat_total: number | null;
  seat_used: number | null;
  billing_status: "PAID" | "UNPAID" | "UNKNOWN" | null;
  renewal_date: string | null;
};

export type ScrapedMember = {
  email: string;
  name?: string | null;
  chatgpt_role?: ChatGPTRole | null;
  status?: "active" | "pending" | "removed";
  /** ISO date string từ cột "Ngày thêm" trên ChatGPT — null nếu không scrape được. */
  joined_at?: string | null;
};

export type ExecuteActionResponse =
  | { ok: true; data?: Record<string, unknown> | { members: ScrapedMember[] } }
  | {
      ok: false;
      error_code:
        | "UI_ELEMENT_NOT_FOUND"
        | "NOT_LOGGED_IN_CHATGPT"
        | "TIMEOUT"
        | "VERIFY_FAILED"
        | "PAGE_NOT_ADMIN"
        | "UNKNOWN";
      error_message: string;
    };
