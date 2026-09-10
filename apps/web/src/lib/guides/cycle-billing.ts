/** Bài hướng dẫn: hạn dùng của một không gian rơi vào MỘT ngày thanh toán hàng
 *  tháng của CHÍNH không gian đó — mỗi không gian một chu kỳ riêng.
 *
 *  Bài này giải thích cách tính mới cho đại lý, nên chỉ nói thứ họ nhìn thấy và
 *  quyết định được: hạn rơi ngày nào, trả bao nhiêu tiền, khi nào phải gia hạn.
 *  Không kể chuyện bên trong (mua/hạ suất, đợt gỡ chạy ra sao) — xem
 *  `routers/members/EXPIRY_RULES.md` §3.6 nếu cần bản đầy đủ cho người làm.
 *
 *  NÓI RÕ LÝ DO LÀ THEO LỊCH CỦA CHATGPT (chốt user 9/9/2026): luật khó chịu nhất
 *  — mua sát mốc phải cộng một tháng — đọc như ta bày ra để ép khách. Nói thẳng
 *  rằng tiền của mỗi suất chạy theo lịch thu tiền của ChatGPT thì đại lý hiểu và
 *  thông cảm, thay vì tưởng mình khó tính. Đây là LÝ DO KINH DOANH khách nhìn thấy
 *  trên hoá đơn, khác với cơ chế nội bộ vẫn phải giấu.
 *
 *  ⚠️ CHATGPT ĐÃ ĐỔI CHÍNH SÁCH (10/9/2026): thêm suất giữa kỳ thì hoá đơn tính
 *  giảm theo số ngày còn lại, KHÔNG còn thu trọn tháng cho suất mới nữa. Nên bước
 *  "mua sát ngày thanh toán" đừng lấy khoản trọn tháng đó ra biện minh lần nữa —
 *  lý do thật là quãng còn lại quá ngắn, bán ra thì vừa mua đã hết hạn (ngưỡng
 *  `cycle_force_extra_from_day`, EXPIRY_RULES §3.6.6).
 *
 *  BỎ BƯỚC "KHÔNG CÓ ÂN HẠN" (chốt user 10/9/2026): bước đó doạ đại lý bằng chuyện
 *  gỡ đúng 10 giờ và lấy khoản trọn tháng ra làm cớ, trong khi cớ ấy vừa hết đúng.
 *  Đợt gỡ vẫn chạy như cũ trong `EXPIRY_RULES`, chỉ là bài này thôi nói về nó —
 *  đừng thêm lại.
 *
 *  NGẮN LÀ CỐ Ý (chốt user 8/9/2026): bản đầu dài gấp ba, đủ ý nhưng không ai đọc
 *  hết. Thêm ý mới thì phải bỏ bớt ý cũ, đừng để bài dài lại.
 *
 *  PHẦN TIỀN GOM VÀO ĐÚNG HAI CHỖ (chốt user 8/9/2026): bước "Dùng bao nhiêu ngày thì trả bấy nhiêu"
 *  nói công thức, bước "Ví dụ" đưa BẢNG hai ca mua. Bản trước rải số ra bốn bước
 *  rời nhau và để cách tính ngày lẻ nằm SAU ví dụ, đọc xong vẫn không nhẩm được.
 *  Chi tiết nhỏ (nửa ngày, phạm vi áp dụng) đẩy xuống mục Lưu ý.
 *
 *  SỐ TIỀN TÍNH THEO ĐƠN GIÁ CỦA CHÍNH NGƯỜI ĐANG ĐỌC (`vars` bên dưới): mỗi đại lý
 *  một giá, in cứng một con số là bài nói sai với gần hết người xem. Chưa biết đơn
 *  giá (ví chưa trả lời) thì `fillGuideVars` bỏ luôn cả bước ví dụ — thà thiếu một
 *  bước còn hơn hiện sai tiền.
 *
 *  BƯỚC VÍ DỤ CÓ Ô GÕ ĐƠN GIÁ (`feeInput`, 8/9/2026): đại lý hay phải báo giá cho
 *  khách theo một mức khác mức của chính mình, gõ vào là cả bài lẫn bản PDF tính
 *  lại theo giá đó. Chỉ để xem, không lưu — giá bán thật vẫn nằm ở trang giá.
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
const VD_SAT_DAYS = 7; //  mua 25/8 → còn 7 ngày, sát mốc ⇒ cộng 1 tháng
/** `payment_settings.price_round_to_vnd` — bội TRĂM từ 8/9/2026. Để 1.000 như
 *  trước thì số trong bài lệch vài trăm đồng so với tổng ở bảng mời, mà đại lý
 *  đối chiếu hai chỗ đó với nhau. */
const ROUND_TO = 100;

/** Làm tròn LÊN bội `ROUND_TO`, đúng chiều của luật tiền (không bao giờ xuống). */
function lenTron(vnd: number): number {
  return Math.ceil(vnd / ROUND_TO) * ROUND_TO;
}

/** Tiền của phần ngày lẻ — khớp `payment_flow.prorated_fee`. */
function leTien(feeVnd: number, days: number): number {
  return lenTron((feeVnd * days) / VD_CYCLE_DAYS);
}

const cycleBilling: Guide = {
  id: "cycle-billing",
  vars: ({ feeVnd }): Record<string, string> => {
    if (!feeVnd || feeVnd <= 0) return {};
    return {
      donGia: formatVnd(feeVnd),
      // Giá MỘT ngày: con số để nhẩm nhanh khi khách hỏi. Tiền thật làm tròn một
      // lần ở TỔNG chứ không làm tròn từng ngày rồi nhân lên (EXPIRY_RULES §3.6.5)
      // nên nhân ngược từ số này sẽ lệch vài trăm đồng — cùng lý do dấu ≈ ở bảng
      // chi tiết phí trong trang mời.
      giaNgay: formatVnd(lenTron(feeVnd / VD_CYCLE_DAYS)),
      vdSom: formatVnd(leTien(feeVnd, VD_SOM_DAYS)),
      vdSat: formatVnd(leTien(feeVnd, VD_SAT_DAYS) + feeVnd),
    };
  },
  content: {
    vi: {
      eyebrow: "Hướng dẫn · cách tính mới",
      title: "Hạn dùng theo ngày thanh toán của không gian",
      intro:
        "Từ **8/9/2026**, mọi email trong một không gian ChatGPT cùng hết hạn vào **một ngày duy nhất trong tháng** — đúng ngày **ChatGPT thu tiền không gian đó**. Mình trả theo lịch của họ nên hạn của khách cũng đi theo lịch đó, bù lại tiền tính đúng số ngày khách dùng.",
      sections: [
        {
          steps: [
            {
              title: "Mỗi không gian có ngày thanh toán riêng",
              body: "Ngày thanh toán là ngày **ChatGPT thu tiền của chính không gian đó**, mình không dời được — mỗi không gian một ngày khác nhau. Ngày đó lặp lại hàng tháng, lúc **10 giờ sáng**, và mọi email trong cùng không gian hết hạn cùng lúc. Ai đang còn hạn cũ thì giữ nguyên hạn đó, tới lần gia hạn sau mới về chung ngày.",
            },
            {
              title: "Dùng bao nhiêu ngày thì trả bấy nhiêu",
              body: "Giá một ngày = **đơn giá tháng chia cho số ngày trong tháng**. Mua giữa tháng chỉ trả từ hôm mua tới ngày thanh toán. Gia hạn sớm thì tính tiếp từ hạn cũ, không mất ngày nào.",
            },
            {
              title: "Mua sát ngày thanh toán thì trả thêm một tháng",
              body: "ChatGPT đã đổi cách tính: thêm suất giữa kỳ thì hoá đơn **giảm theo số ngày còn lại**, nên tiền của mỗi suất chạy theo **lịch thanh toán của không gian đó**. Mua trong **tuần cuối** thì quãng còn lại quá ngắn, vừa mua đã hết hạn — nên tính **số ngày còn lại cộng một tháng**, khách dùng thẳng tới ngày thanh toán tháng sau.",
            },
            {
              title: "Ví dụ",
              body: "Đơn giá của bạn **{donGia}/tháng**, ngày thanh toán mùng 1. Tháng 8 có 31 ngày nên một ngày khoảng **{giaNgay}**.",
              feeInput: true,
              table: {
                head: ["Ngày mua", "Phải trả", "Dùng tới"],
                rows: [
                  ["10/8", "22 ngày · **{vdSom}**", "1/9"],
                  ["25/8", "7 ngày + 1 tháng · **{vdSat}**", "1/10"],
                ],
              },
            },
          ],
        },
      ],
      notes: [
        "Ngày lẻ **trên 12 tiếng tính tròn một ngày, dưới 12 tiếng tính nửa ngày** — tiền cũng chỉ một nửa.",
      ],
    },
    en: {
      eyebrow: "Guide · how billing works now",
      title: "Expiry follows the workspace billing day",
      intro:
        "From **8 Sep 2026**, every email in one ChatGPT workspace expires on **a single day each month** — the day **ChatGPT charges that workspace**. We pay on their schedule, so your customers' expiry follows it too. In return, you pay for exactly the days used.",
      sections: [
        {
          steps: [
            {
              title: "Each workspace has its own billing day",
              body: "The billing day is the day **ChatGPT charges that particular workspace**, and we cannot move it — every workspace has a different one. It repeats monthly at **10 in the morning**, and all emails in the same workspace expire together. Anyone still on an older expiry date keeps it, and only joins the shared day at their next renewal.",
            },
            {
              title: "Pay for the days you use",
              body: "The price of one day = **the monthly price divided by the number of days in the month**. Buy mid-month and you pay only from the day of purchase to the billing day. Renew early and it continues from the old expiry, so no day is lost.",
            },
            {
              title: "Buying close to the billing day costs one extra month",
              body: "ChatGPT changed how it charges: adding a seat mid-cycle is **prorated over the days left**, so every seat now follows **that workspace's billing schedule**. Buy in the **final week** and the remaining stretch is too short — the seat would expire almost as soon as it is sold — so we charge **the remaining days plus one month**, and the customer runs straight through to next month's billing day.",
            },
            {
              title: "Example",
              body: "Your price is **{donGia}/month** and the billing day is the 1st. August has 31 days, so one day costs about **{giaNgay}**.",
              feeInput: true,
              table: {
                head: ["Purchase date", "You pay", "Runs until"],
                rows: [
                  ["10 Aug", "22 days · **{vdSom}**", "1 Sep"],
                  ["25 Aug", "7 days + 1 month · **{vdSat}**", "1 Oct"],
                ],
              },
            },
          ],
        },
      ],
      notes: [
        "A part day **over 12 hours counts as a full day, under 12 hours counts as half a day** — and costs half as much.",
      ],
    },
    "zh-CN": {
      eyebrow: "使用指南 · 新的计算方式",
      title: "按工作区结算日计算到期时间",
      intro:
        "自 **2026 年 9 月 8 日**起，同一个 ChatGPT 工作区里的所有邮箱都在**每月的同一天**到期——正是 **ChatGPT 向这个工作区收费的那天**。我们跟着他们的账期走，客户的到期日也就跟着走；作为补偿，费用按客户实际使用的天数计算。",
      sections: [
        {
          steps: [
            {
              title: "每个工作区都有自己的结算日",
              body: "结算日就是 **ChatGPT 向这个工作区收费的日子**，我们改不了，每个工作区各不相同。它每月重复一次，时间是**上午 10 点**，同一个工作区里的邮箱同时到期。此前仍在有效期内的客户保持原到期日，下次续费时才并入结算日。",
            },
            {
              title: "用几天就付几天的钱",
              body: "每天单价 = **月单价 ÷ 当月天数**。月中购买只付从购买当天到结算日这几天。提前续费从原到期日接着算，一天也不会重复收。",
            },
            {
              title: "临近结算日购买要多付一个月",
              body: "ChatGPT 改了计费方式：周期中途加席位，账单**按剩余天数折算**，所以每个席位的价格都跟着**该工作区的结算日**走。在结算日前**最后一周**购买，剩下的天数太少，刚买就到期，因此按**剩余天数加一个月**计算，客户可以直接用到下个月的结算日。",
            },
            {
              title: "示例",
              body: "你的月单价是 **{donGia}**，结算日为 1 号。8 月有 31 天，所以每天大约 **{giaNgay}**。",
              feeInput: true,
              table: {
                head: ["购买日", "应付", "可用到"],
                rows: [
                  ["8月10日", "22 天 · **{vdSom}**", "9月1日"],
                  ["8月25日", "7 天 + 1 个月 · **{vdSat}**", "10月1日"],
                ],
              },
            },
          ],
        },
      ],
      notes: [
        "零头**超过 12 小时算一整天，不足 12 小时算半天**——费用也只收一半。",
      ],
    },
  },
};

export default cycleBilling;
