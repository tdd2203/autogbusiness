/** Bài hướng dẫn: hạn dùng của cả không gian rơi vào MỘT ngày chốt hàng tháng.
 *
 *  Bài này giải thích cách tính mới cho đại lý, nên chỉ nói thứ họ nhìn thấy và
 *  quyết định được: hạn rơi ngày nào, trả bao nhiêu tiền, khi nào phải gia hạn.
 *  Không kể chuyện bên trong (mua/hạ suất, đợt gỡ chạy ra sao) — xem
 *  `routers/members/EXPIRY_RULES.md` §3.6 nếu cần bản đầy đủ cho người làm.
 *
 *  NGẮN LÀ CỐ Ý (chốt user 8/9/2026): bản đầu dài gấp ba, đủ ý nhưng không ai đọc
 *  hết. Thêm ý mới thì phải bỏ bớt ý cũ, đừng để bài dài lại.
 *
 *  SỐ TIỀN TÍNH THEO ĐƠN GIÁ CỦA CHÍNH NGƯỜI ĐANG ĐỌC (`vars` bên dưới): mỗi đại lý
 *  một giá, in cứng một con số là bài nói sai với gần hết người xem. Chưa biết đơn
 *  giá (ví chưa trả lời) thì `fillGuideVars` bỏ luôn hai câu cần số — thà thiếu một
 *  câu còn hơn hiện sai tiền.
 *
 *  Không có ảnh: đây là bài về cách tính, ảnh chụp màn hình không nói thêm được gì
 *  mà lại cũ đi mỗi lần giao diện đổi.
 */
import { formatVnd } from "../wallet";
import type { Guide } from "./types";

/** Chu kỳ của ví dụ: 1/8 → 1/9, đúng 31 ngày. Ví dụ neo vào một tháng CỤ THỂ để
 *  con số kiểm chứng được; luật thật chia theo số ngày của từng chu kỳ. */
const VD_CYCLE_DAYS = 31;
const VD_SOM_DAYS = 22; // mua 10/8 → còn 22 ngày tới mốc
const VD_SAT_DAYS = 7; //  mua 25/8 → còn 7 ngày, đã qua ngày thứ 23 ⇒ cộng 1 tháng
const ROUND_TO = 1_000; // `payment_settings.price_round_to_vnd`

/** Tiền của phần ngày lẻ — làm tròn LÊN nghìn, khớp `payment_flow.prorated_fee`. */
function leTien(feeVnd: number, days: number): number {
  return Math.ceil((feeVnd * days) / VD_CYCLE_DAYS / ROUND_TO) * ROUND_TO;
}

const cycleBilling: Guide = {
  id: "cycle-billing",
  vars: ({ feeVnd }): Record<string, string> => {
    if (!feeVnd || feeVnd <= 0) return {};
    return {
      donGia: formatVnd(feeVnd),
      vdSom: formatVnd(leTien(feeVnd, VD_SOM_DAYS)),
      vdSat: formatVnd(leTien(feeVnd, VD_SAT_DAYS) + feeVnd),
    };
  },
  content: {
    vi: {
      eyebrow: "Hướng dẫn · cách tính mới",
      title: "Hạn dùng theo ngày chốt của không gian",
      intro:
        "Kể từ **8/9/2026**, mọi email mới mời vào workspace ChatGPT đi theo **chu kỳ thanh toán của chính workspace đó**, và tiền tính đúng theo số ngày khách dùng. Cụ thể như sau:",
      sections: [
        {
          steps: [
            {
              title: "Cùng một ngày hết hạn",
              body: "Mọi email trong không gian hết hạn vào **ngày chốt** hàng tháng, lúc **10 giờ sáng**. Ai đang còn hạn cũ trước đó giữ nguyên hạn cũ, về chung ngày chốt ở lần gia hạn sau.",
            },
            {
              title: "Trả đúng số ngày dùng",
              body: "Mua tới ngày thanh toán của workspace đó thì chỉ trả tiền cho quãng đó. Gia hạn sớm tính từ hạn cũ, không thu trùng. **Tổng tiền hiện sẵn trong bảng mời** trước khi bạn bấm gửi.",
            },
            {
              title: "Mua từ ngày thứ 23 của chu kỳ trở đi",
              body: "Lúc đó chu kỳ chỉ còn khoảng **6–9 ngày** (tuỳ tháng dài ngắn). Lần mua này trả **số ngày còn lại cộng thêm một tháng**, và khách dùng tới ngày chốt của tháng sau.",
            },
            {
              title: "Nhắc khách gia hạn trước ngày chốt",
              body: "Đúng **10 giờ sáng giờ Việt Nam** ngày chốt, email chưa gia hạn **bị gỡ ngay**, không có ân hạn.",
            },
            {
              title: "Ví dụ",
              body: "Ngày chốt mùng 1, đơn giá của bạn **{donGia}/tháng**. Mua ngày 10/8 còn 22 ngày ⇒ trả **{vdSom}**, dùng tới 1/9. Mua ngày 25/8 (ngày thứ 25 của chu kỳ) còn 7 ngày ⇒ trả **{vdSat}** gồm 7 ngày lẻ và một tháng, dùng tới 1/10.",
            },
            {
              title: "Ngày lẻ tính thế nào",
              body: "Giá một ngày = đơn giá tháng chia cho số ngày của tháng đó. Lẻ **trên 12 tiếng tính tròn một ngày, dưới 12 tiếng tính nửa ngày** — tiền cũng chỉ một nửa.",
            },
          ],
        },
      ],
      notes: [
        "Chỉ áp cho không gian đã bật cách tính này. Nơi khác vẫn tính 30 ngày cho mỗi tháng.",
      ],
    },
    "zh-CN": {
      eyebrow: "使用指南 · 新的计算方式",
      title: "按工作区结算日计算到期时间",
      intro:
        "自 **2026 年 9 月 8 日**起，新邀请进 ChatGPT 工作区的邮箱都跟随**该工作区自己的账单周期**，费用按客户实际使用的天数计算。具体如下：",
      sections: [
        {
          steps: [
            {
              title: "同一天到期",
              body: "工作区内所有邮箱都在每月的**结算日上午 10 点**到期。此前仍在有效期内的客户保持原到期日，下次续费时并入结算日。",
            },
            {
              title: "按实际天数付费",
              body: "买到该工作区的结算日，就只付这一段的钱。提前续费从原到期日算起，不会重复收费。**邀请面板会先显示总金额**，你再点发送。",
            },
            {
              title: "从周期第 23 天起购买",
              body: "此时周期只剩**大约 6–9 天**（视月份长短）。这次购买要付**剩余天数再加一个月**，客户可用到下个月的结算日。",
            },
            {
              title: "提醒客户在结算日前续费",
              body: "**越南时间结算日上午 10 点整**，未续费的邮箱**立即被移出**，没有宽限期。",
            },
            {
              title: "示例",
              body: "结算日为 1 号，你的月单价是 **{donGia}**。8 月 10 日购买，还剩 22 天 ⇒ 付 **{vdSom}**，用到 9 月 1 日。8 月 25 日购买（周期第 25 天），还剩 7 天 ⇒ 付 **{vdSat}**，即 7 天零头加一个月，用到 10 月 1 日。",
            },
            {
              title: "零头天数怎么算",
              body: "每天单价 = 月单价 ÷ 当月天数。零头**超过 12 小时算一整天，不足 12 小时算半天**——费用也只收一半。",
            },
          ],
        },
      ],
      notes: [
        "仅适用于已启用该方式的工作区，其余工作区仍按每月 30 天计算。",
      ],
    },
  },
};

export default cycleBilling;
