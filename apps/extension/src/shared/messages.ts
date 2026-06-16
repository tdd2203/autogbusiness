/**
 * Typed messages giữa background service worker và content script.
 * Background gửi: ExecuteActionRequest. Content trả: ExecuteActionResponse.
 */

export type ChatGPTRole = "owner" | "admin" | "member" | "analytics_viewer";

/** Loại suất cấp phép trên ChatGPT admin (cột "Loại suất cấp phép"). */
export type LicenseType = "ChatGPT" | "Codex";

/** Phạm vi đồng bộ member từ ChatGPT admin. */
export type SyncScope = "members" | "invites" | "both";

export type ExecuteActionRequest =
  | {
      kind: "INVITE_MEMBER";
      taskId: string;
      emails: string[];
      role: ChatGPTRole;
      /** Tên miền đã xác minh của workspace (vd "ndaigroup.org"). Nếu MỌI email
       * thuộc domain này → KHÔNG cần bật toggle "mời ngoài tên miền". null/thiếu
       * → coi như chưa cấu hình, vẫn bật toggle cho an toàn. */
      verifiedDomain?: string | null;
    }
  | { kind: "REMOVE_MEMBER"; taskId: string; email: string }
  | {
      kind: "CHANGE_ROLE";
      taskId: string;
      email: string;
      new_role: ChatGPTRole;
      old_role: ChatGPTRole | null;
    }
  | {
      kind: "CHANGE_LICENSE_TYPE";
      taskId: string;
      email: string;
      new_license_type: LicenseType;
      old_license_type: LicenseType | null;
    }
  | {
      kind: "SYNC_DATA";
      taskId: string;
      /** Phạm vi đồng bộ: 'members' (chỉ Người dùng) | 'invites' (chỉ Lời mời +
       * Yêu cầu chờ) | 'both' (cả hai). Mặc định 'both'. */
      scope?: SyncScope;
      /** @deprecated giữ tương thích cũ — true ≈ 'both', false ≈ 'members'. */
      includePending?: boolean;
      /** Dashboard locale ('vi' | 'en' | 'zh') — extension dùng để check ChatGPT
       * locale, surface lỗi rõ ràng nếu mismatch. Null = không check. */
      expectedLocale?: "vi" | "en" | "zh" | null;
    }
  | { kind: "SYNC_BILLING"; taskId: string }
  | { kind: "REVOKE_INVITES"; taskId: string; emails: string[] }
  | { kind: "HARVEST_LABELS"; taskId: string; locale: "vi" | "en" | "zh" }
  | {
      kind: "PURCHASE_SEAT";
      taskId: string;
      quantity: number;
      /** Skip Phase 1+2 (modal mở slot) → nhảy thẳng tới tab Hóa đơn + payment
       * chain. Dùng khi invoice 'Đến hạn' đã tồn tại từ trước (vd task v0.5.1
       * tạo invoice nhưng chưa thanh toán → retry thanh toán). */
      skipToPayment?: boolean;
    }
  | {
      kind: "STRIPE_CLICK_LINK";
      taskId: string;
      /** Số tiền expected (đọc từ ChatGPT modal #2), best-effort verify Stripe page. */
      expectedAmountText?: string | null;
    }
  | {
      kind: "LINK_CONFIRM_PAYMENT";
      taskId: string;
      /** Số tiền expected để sanity check trước khi click "Thanh toán". */
      expectedAmountText: string;
    }
  | {
      /** Phase 2 của INVITE_MEMBER sau khi background F5 tab → content fresh.
       * Chỉ scrape pending list để verify email vừa mời có xuất hiện không.
       * Không submit lại invite. */
      kind: "VERIFY_PENDING_INVITE";
      taskId: string;
      emails: string[];
      role: ChatGPTRole;
    }
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
  /** "ChatGPT" | "Codex" từ cột "Loại suất cấp phép" — null nếu không scrape được. */
  license_type?: LicenseType | null;
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
        | "LANGUAGE_MISMATCH"
        | "CONTENT_NOT_INJECTED"
        | "STALE_BUILD"
        | "EXTERNAL_TOGGLE_FAILED"
        | "UNKNOWN";
      error_message: string;
    };
