/** Bài hướng dẫn: hạn dùng của một không gian rơi vào MỘT ngày thanh toán hàng
 *  tháng của CHÍNH không gian đó — mỗi không gian một chu kỳ riêng.
 *
 *  Bài này giải thích cách tính mới cho đại lý, nên chỉ nói thứ họ nhìn thấy và
 *  quyết định được: hạn rơi ngày nào, trả bao nhiêu tiền, khi nào phải gia hạn.
 *  Không kể chuyện bên trong (mua/hạ suất, đợt gỡ chạy ra sao) — xem
 *  `routers/members/EXPIRY_RULES.md` §3.6 nếu cần bản đầy đủ cho người làm.
 *
 *  NÓI RÕ LÝ DO LÀ THEO LỊCH CỦA CHATGPT (chốt user 9/9/2026): hai luật khó chịu
 *  nhất — mua sát mốc phải cộng một tháng, và gỡ đúng giờ không ân hạn — đọc như
 *  ta bày ra để ép khách. Sự thật là ChatGPT thu trọn tháng cho mỗi suất còn nằm
 *  trong không gian lúc hoá đơn chạy, nên nói thẳng chỗ đó thì đại lý hiểu và
 *  thông cảm, thay vì tưởng mình khó tính. Đây là LÝ DO KINH DOANH khách nhìn
 *  thấy trên hoá đơn, khác với cơ chế nội bộ vẫn phải giấu.
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
              body: "Giá một ngày = **đơn giá tháng chia cho số ngày trong tháng**. Mua giữa tháng chỉ trả từ hôm mua tới ngày thanh toán. Gia hạn sớm thì tính tiếp từ hạn cũ, không mất ngày nào. **Bảng mời hiện sẵn tổng tiền** trước khi bạn bấm gửi.",
            },
            {
              title: "Mua sát ngày thanh toán thì trả thêm một tháng",
              body: "ChatGPT thu **trọn một tháng** cho mỗi suất, kể cả suất chỉ dùng mấy ngày cuối kỳ. Nên mua trong **tuần cuối** trước ngày thanh toán thì trả **số ngày còn lại cộng một tháng**, đổi lại khách dùng thẳng tới ngày thanh toán tháng sau.",
            },
            {
              title: "Không có ân hạn",
              body: "Đúng **10 giờ sáng** ngày thanh toán là hoá đơn ChatGPT chạy: suất nào còn trong không gian lúc đó thì mình phải trả trọn tháng cho suất ấy. Nên email chưa gia hạn **bị gỡ đúng giờ**. Nhắc khách trước một hai hôm.",
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
              body: "每天单价 = **月单价 ÷ 当月天数**。月中购买只付从购买当天到结算日这几天。提前续费从原到期日接着算，一天也不会重复收。**邀请面板会先显示总金额**，你再点发送。",
            },
            {
              title: "临近结算日购买要多付一个月",
              body: "ChatGPT 对每个席位都按**整月**收费，哪怕这个席位只用了月末几天。所以在结算日前**最后一周**购买要付**剩余天数加一个月**，客户则可以直接用到下个月的结算日。",
            },
            {
              title: "没有宽限期",
              body: "结算日**上午 10 点**（越南时间）一到，ChatGPT 的账单就出：席位还留在工作区里，我们就得为它付满一个月。所以未续费的邮箱**准点被移出**。请提前一两天提醒客户。",
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
