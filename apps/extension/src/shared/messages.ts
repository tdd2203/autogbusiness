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
      /** Action "Mời lại" (re-invite lời mời lỗi). true → content chạy TIỀN TỐ trước
       * khi mời: (1) tìm tab Người dùng — nếu còn là thành viên → huỷ, báo vẫn trong
       * workspace; (2) thu hồi lời mời cũ ở tab Lời mời. Chỉ chạy 1 lần (khi
       * !externalReady). Xem execute-invite.ts. */
      reinvite?: boolean;
      /**
       * Số suất MỚI lệnh mời này thực sự chiếm (backend `_count_new_invite_seats`).
       * Dùng để biết cần mua bù bao nhiêu suất trước khi mời.
       *
       * KHÁC `emails.length`: email đang là thành viên active đã giữ một suất rồi,
       * đếm cả nó là mua thừa — mất tiền thật. Thiếu/không hợp lệ → rơi về
       * `emails.length` (mua thừa còn hơn mua thiếu: mua thiếu thì ChatGPT bật
       * luồng "mua kèm gửi lời mời" mà extension không kiểm soát được).
       */
      newSeatCount?: number;
      /**
       * Số suất dashboard đang biết (backend `_seat_hint`): `total` = seat_total
       * đã scrape từ trang thanh toán (CÓ THỂ CŨ), `occupied` = member chưa bị gỡ
       * (active + pending). Cộng pending là ĐẾM THỪA CÓ CHỦ Ý, không phải vì lời
       * mời chờ đang giữ suất — xem `headroomWithoutModal` (ensure-seats.ts).
       *
       * `pending` = RIÊNG lời mời đang chờ (đã loại email của chính lệnh mời
       * này). Đường ĐẾM TẬN NƠI trừ số đó khỏi chỗ trống: hộp "Quản lý suất" chỉ
       * đếm người ĐÃ tham gia, nên `tổng − đã gán` bỏ quên nợ suất của lời mời
       * treo — mời thêm 1 email ở workspace đầy suất mà còn 1 lời mời chờ thì
       * phải mua 2 suất, không phải 1.
       *
       * Dùng để BỎ QUA hẳn bước mở hộp "Quản lý suất" khi thấy chắc chắn còn thừa
       * chỗ. Thiếu/không đủ dư → mở hộp đếm tận nơi như cũ.
       */
      seatHint?: { total: number | null; occupied: number; pending?: number };
    }
  /**
   * Bật/tắt toggle "Cho phép lời mời ngoài tên miền" như một LỆNH RIÊNG.
   *
   * Background gọi lệnh này để TẮT toggle SAU KHI đã nhận kết quả mời — trước
   * đây content tự tắt trong `finally` của chính lần mời, mà bước tắt phải điều
   * hướng sang /admin/identity nên trang giữ kênh bị đẩy vào back/forward cache
   * → kết quả mời không về được → task báo hỏng dù lời mời ĐÃ đi (ca 31/7/2026,
   * hoàn 340.000đ oan). Xem `content/actions/external-invites/execute-set-toggle.ts`.
   */
  | { kind: "SET_EXTERNAL_INVITES"; taskId: string; enabled: boolean }
  | { kind: "REMOVE_MEMBER"; taskId: string; email: string }
  | {
      /** 2 mục MỚI trong menu "..." của member ĐÃ THAM GIA (ChatGPT 2026-08):
       * "Xuất dữ liệu" và "Xoá dữ liệu". Cùng luồng (lọc email → menu → dialog),
       * chỉ khác mục được chọn + nhãn nút xác nhận. "Xoá dữ liệu" là thao tác
       * KHÔNG HOÀN TÁC — xem actions/member-data/README.md. */
      kind: "EXPORT_MEMBER_DATA" | "DELETE_MEMBER_DATA";
      taskId: string;
      email: string;
    }
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
  | {
      /** Phase 2b của INVITE_MEMBER — kiểm tra các email KHÔNG thấy ở tab "Lời
       * mời" xem đã sang tab "Người dùng" (active) chưa. Người dùng chấp nhận
       * lời mời nhanh sẽ rời tab Lời mời → tránh mark 'removed' oan. Trả
       * data.active_members (ScrapedMember status="active" để upsert) +
       * data.active_emails. Read-only. */
      kind: "CHECK_ACTIVE_AFTER_INVITE";
      taskId: string;
      emails: string[];
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
        // REMOVE: đã click xoá + dialog đóng, NHƯNG poll 45s member VẪN còn trong
        // tab Người dùng → xoá chưa có hiệu lực (ChatGPT chặn/quyền/ghế). Backend
        // GIỮ member active (KHÔNG mark removed) → tránh xoá-giả; tick sau retry,
        // loop-guard chốt STUCK nếu lặp mãi (bug user 2026-07-21).
        | "REMOVE_VERIFY_FAILED"
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
        // INVITE_MEMBER: workspace không còn đủ suất trống cho lượng email sắp
        // mời, và extension KHÔNG mua bù được (vượt hạn mức 20/lần, mua thất bại,
        // hoặc mua xong đọc lại vẫn chưa thấy suất). KHÔNG mời để tránh kích hoạt
        // luồng "Mua suất người dùng và gửi lời mời" của ChatGPT (mua + gửi lời
        // mời trong một cú bấm, extension không kiểm soát được số tiền).
        // `data` kèm seat_* để dashboard hiển thị còn/thiếu bao nhiêu.
        | "NOT_ENOUGH_SEATS"
        | "UNKNOWN";
      error_message: string;
      /**
       * Dữ liệu kèm theo LỖI — chỉ dùng cho lỗi mà kết quả thật sự VÔ ĐỊNH, để
       * background biết còn phải phân xử tiếp hay không (KHÔNG phải chỗ nhồi thêm
       * thông tin gỡ lỗi; text mô tả thuộc `error_message`).
       *
       * Ca hiện có: INVITE_MEMBER `VERIFY_FAILED` sau khi ĐÃ bấm "Gửi lời mời" gắn
       * `submit_clicked: true` + `chatgpt_error_hint` — xem `invite-salvage.ts`.
       */
      data?: Record<string, unknown>;
    };

/**
 * Gợi ý khắc phục cho lỗi có dấu hiệu PHIÊN CHATGPT HỎNG/HẾT HẠN — trang admin
 * redirect/treo/không render (NOT_LOGGED_IN_CHATGPT, CONTENT_TIMEOUT,
 * CONTENT_NOT_INJECTED, PAGE_NOT_ADMIN, nav/nút Mời không hiện). Extension KHÔNG
 * tự đăng nhập lại được (nhập credential = việc của user + dễ trip bot-detection),
 * nên báo rõ để user tự xử lý thay vì đoán mò trước lỗi TIMEOUT mơ hồ.
 *
 * Bằng chứng thực tế (user 2026-07-15): phải XOÁ phiên đăng nhập chatgpt.com +
 * đăng nhập lại thì trang admin mới load bình thường, mời được.
 */
export const SESSION_RECOVERY_HINT =
  "Nếu lặp lại nhiều lần: phiên đăng nhập ChatGPT có thể đã hỏng/hết hạn khiến " +
  "trang admin không tải được. Hãy XOÁ cookie/đăng xuất chatgpt.com → ĐĂNG NHẬP " +
  "LẠI (mở chatgpt.com/admin/members kiểm tra vào được bình thường) rồi thử lệnh lại.";
