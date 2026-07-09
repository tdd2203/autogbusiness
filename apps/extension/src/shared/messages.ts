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
      /** v0.8.14: cờ do BACKGROUND set ở lần gọi INVITE_MEMBER thứ 2 (sau khi
       * Phase A bật toggle external + background HARD-RELOAD /admin/members để
       * refetch org-config). true → content BỎ QUA bước bật toggle, mở dialog mời
       * ngay trên trang config đã fresh (banner 'ngoài miền' không còn). false/thiếu
       * → lần gọi đầu (Phase A): bật toggle rồi trả `awaiting_external_reload`. */
      externalReady?: boolean;
    }
  | { kind: "REMOVE_MEMBER"; taskId: string; email: string }
  | {
      /** Đặt giới hạn tín dụng/tháng cho 1 member trên trang
       * /admin/billing/manage_member_usage_limit ("Ghi đè mỗi người dùng"). Lọc
       * theo tên → mở dialog "Đặt giới hạn sử dụng tùy chỉnh" → nhập số → Lưu. */
      kind: "SET_USAGE_LIMIT";
      taskId: string;
      email: string;
      limit_credits: number;
      old_limit_credits: number | null;
    }
  | {
      /** "Đồng bộ 1 tài khoản lẻ" — tìm 1 email ở tab Lời mời rồi fallback tab
       * Người dùng để xác nhận đã tham gia chưa. Trả data.found_in ∈
       * {"pending","active","none"}. Read-only, không thao tác phá huỷ. */
      kind: "SYNC_MEMBER";
      taskId: string;
      email: string;
    }
  | {
      /** "Đồng bộ hàng loạt" — kiểm tra 1 DANH SÁCH email cùng lúc. Quét tab
       * "Lời mời đang chờ xử lý" ĐÚNG MỘT LẦN (lấy trọn set pending); email nào
       * có trong set = pending. Các email CÒN LẠI mới sang tab "Người dùng" kiểm
       * tra (thấy = active/đã tham gia, không = none). Thay cho việc fan-out N
       * task SYNC_MEMBER (mỗi task lại quét lại toàn bộ pending — thừa). Trả
       * data.results: Array<{email, found_in: "pending"|"active"|"none"}>.
       * Read-only, không thao tác phá huỷ. */
      kind: "SYNC_MEMBERS_BATCH";
      taskId: string;
      emails: string[];
    }
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
      /** Mở trang chi tiết hoá đơn (invoice.stripe.com) để đọc CHÍNH XÁC số
       * lượng seat + đơn giá + subtotal/VAT/tổng + khoảng chu kỳ dịch vụ. Thay
       * cho việc đoán số seat bằng phép chia tổng tiền. Background điều hướng tab
       * tới invoiceUrl rồi gửi kind này cho content stripe-invoice.ts. */
      kind: "STRIPE_SCRAPE_INVOICE_DETAIL";
      taskId: string;
      invoiceUrl: string;
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

/** Kết quả scrape trang chi tiết hoá đơn Stripe (STRIPE_SCRAPE_INVOICE_DETAIL).
 * Mọi field null nếu không đọc được (Stripe đổi UI) — caller đánh dấu
 * detail_scraped=false, KHÔNG đoán. Tiền là integer VND. */
export type ScrapedInvoiceDetail = {
  quantity: number | null;
  unit_price_vnd: number | null;
  subtotal_vnd: number | null;
  vat_vnd: number | null;
  total_vnd: number | null;
  period_start: string | null; // ISO date
  period_end: string | null; // ISO date
  invoice_number: string | null;
  status: "paid" | "unpaid" | "void" | "unknown" | null;
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
        // REMOVE: ô lọc tab Người dùng tìm KHÔNG ra email → coi như member không
        // còn trong business ChatGPT. Backend dùng riêng code này để mark removed
        // ở dashboard (KHÁC UI_ELEMENT_NOT_FOUND = member có nhưng menu/nút lỗi).
        | "MEMBER_NOT_IN_WORKSPACE"
        | "NOT_LOGGED_IN_CHATGPT"
        | "TIMEOUT"
        | "VERIFY_FAILED"
        | "PAGE_NOT_ADMIN"
        // DOM/UX ChatGPT thay đổi ngoài dự kiến: phần tử CẤU TRÚC bắt buộc phải
        // có (nút mở dialog mời, dropdown vai trò trên row ĐÃ tìm thấy, nút menu
        // "…", nút xác nhận xoá…) KHÔNG xuất hiện dù đang đúng trang/ngữ cảnh.
        // Fail-Fast (Hiến pháp III) thay vì đoán mò → dashboard cảnh báo riêng để
        // cập nhật selector. KHÁC UI_ELEMENT_NOT_FOUND (thao tác lỗi lẻ) và
        // MEMBER_NOT_IN_WORKSPACE (member đã rời — được phép mark removed).
        | "FAILED_UI_CHANGED"
        | "LANGUAGE_MISMATCH"
        | "CONTENT_NOT_INJECTED"
        | "CONTENT_TIMEOUT"
        | "STALE_BUILD"
        | "EXTERNAL_TOGGLE_FAILED"
        | "UNKNOWN";
      error_message: string;
    };
