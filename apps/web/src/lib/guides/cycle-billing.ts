/** Bài hướng dẫn: hạn dùng của cả không gian rơi vào MỘT ngày chốt hàng tháng.
 *
 *  Bài này giải thích cách tính mới cho đại lý, nên chỉ nói thứ họ nhìn thấy và
 *  quyết định được: hạn rơi ngày nào, trả bao nhiêu tiền, khi nào phải gia hạn.
 *  Không kể chuyện bên trong (mua/hạ suất, đợt gỡ chạy ra sao) — xem
 *  `routers/members/EXPIRY_RULES.md` §3.6 nếu cần bản đầy đủ cho người làm.
 *
 *  NGẮN LÀ CỐ Ý (chốt user 8/9/2026): bản đầu dài gấp ba, đủ ý nhưng không ai đọc
 *  hết. Giữ đúng năm điều người bán cần; mọi lý do "vì sao lại thế" đã cắt bỏ.
 *  Thêm ý mới thì phải bỏ bớt ý cũ, đừng để bài dài lại.
 *
 *  Không có ảnh: đây là bài về cách tính, ảnh chụp màn hình không nói thêm được gì
 *  mà lại cũ đi mỗi lần giao diện đổi. Số trong phần ví dụ tính theo đơn giá mặc
 *  định của hệ thống (`payment_settings.invite_fee_vnd`), làm tròn như lúc bán.
 */
import type { Guide } from "./types";

const cycleBilling: Guide = {
  id: "cycle-billing",
  content: {
    vi: {
      eyebrow: "Hướng dẫn · cách tính mới",
      title: "Hạn dùng theo ngày chốt của không gian",
      intro:
        "Cách tính hạn mới: mọi email trong không gian hết hạn **cùng một ngày**, tiền tính đúng theo số ngày khách dùng.",
      sections: [
        {
          steps: [
            {
              title: "Cùng một ngày hết hạn",
              body: "Mọi email trong không gian hết hạn vào **ngày chốt** hàng tháng, lúc **10 giờ sáng**. Ai đang còn hạn giữ nguyên hạn cũ, về chung ngày chốt ở lần gia hạn sau.",
            },
            {
              title: "Trả đúng số ngày dùng",
              body: "Bán tới ngày chốt gần nhất thì chỉ trả tiền cho quãng đó. Gia hạn sớm tính từ hạn cũ, không thu trùng. **Tổng tiền hiện sẵn trong bảng mời** trước khi bạn bấm gửi.",
            },
            {
              title: "Bán sát ngày chốt thì gồm luôn tháng sau",
              body: "Còn khoảng **9 ngày trở xuống** là lần bán đó đi tới ngày chốt **tháng sau**: trả mấy ngày lẻ cộng một tháng.",
            },
            {
              title: "Nhắc khách gia hạn trước ngày chốt",
              body: "Đúng 10 giờ sáng ngày chốt, email chưa gia hạn **bị gỡ ngay**, không có ân hạn.",
            },
            {
              title: "Ví dụ",
              body: "Ngày chốt mùng 1, đơn giá 380.000đ: mua ngày 10/8 trả khoảng **270.000đ**, dùng tới 1/9. Mua ngày 25/8 (sát ngày chốt) trả khoảng **466.000đ**, dùng tới 1/10.",
            },
          ],
        },
      ],
      notes: [
        "Chỉ áp cho không gian đã bật cách tính này. Nơi khác vẫn tính 30 ngày cho mỗi tháng.",
        "Đơn giá của bạn có thể khác 380.000đ, cách tính vẫn y như vậy.",
      ],
    },
    "zh-CN": {
      eyebrow: "使用指南 · 新的计算方式",
      title: "按工作区结算日计算到期时间",
      intro:
        "新的到期计算方式：工作区内所有邮箱**在同一天到期**，费用按客户实际使用的天数计算。",
      sections: [
        {
          steps: [
            {
              title: "同一天到期",
              body: "工作区内所有邮箱都在每月的**结算日上午 10 点**（越南时间）到期。仍在有效期内的客户保持原到期日，下次续费时并入结算日。",
            },
            {
              title: "按实际天数付费",
              body: "卖到最近的结算日，就只付这一段的钱。提前续费从原到期日算起，不会重复收费。**邀请面板会先显示总金额**，你再点发送。",
            },
            {
              title: "临近结算日会含下个月",
              body: "距结算日只剩 **9 天左右以内**时，这次售卖会算到**下个月**的结算日：零头天数加一个月。",
            },
            {
              title: "提醒客户在结算日前续费",
              body: "结算日上午 10 点整，未续费的邮箱**立即被移出**，没有宽限期。",
            },
            {
              title: "示例",
              body: "结算日为 1 号、月单价 380.000đ：8 月 10 日购买约付 **270.000đ**，用到 9 月 1 日；8 月 25 日（临近结算日）约付 **466.000đ**，用到 10 月 1 日。",
            },
          ],
        },
      ],
      notes: [
        "仅适用于已启用该方式的工作区，其余工作区仍按每月 30 天计算。",
        "你的月单价可能不是 380.000đ，但计算方式完全一样。",
      ],
    },
  },
};

export default cycleBilling;
