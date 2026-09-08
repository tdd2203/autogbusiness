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
 *  PHẦN TIỀN GOM VÀO ĐÚNG HAI CHỖ (chốt user 8/9/2026): bước "Tiền tính theo ngày"
 *  nói công thức, bước "Ví dụ" đưa BẢNG hai ca mua. Bản trước rải số ra bốn bước
 *  rời nhau và để cách tính ngày lẻ nằm SAU ví dụ, đọc xong vẫn không nhẩm được.
 *  Chi tiết nhỏ (nửa ngày, phạm vi áp dụng) đẩy xuống mục Lưu ý.
 *
 *  SỐ TIỀN TÍNH THEO ĐƠN GIÁ CỦA CHÍNH NGƯỜI ĐANG ĐỌC (`vars` bên dưới): mỗi đại lý
 *  một giá, in cứng một con số là bài nói sai với gần hết người xem. Chưa biết đơn
 *  giá (ví chưa trả lời) thì `fillGuideVars` bỏ luôn cả bước ví dụ — thà thiếu một
 *  bước còn hơn hiện sai tiền.
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
      title: "Hạn dùng theo ngày chốt của không gian",
      intro:
        "Từ **8/9/2026**, mọi email trong một không gian ChatGPT cùng hết hạn vào **một ngày duy nhất trong tháng** — gọi là **ngày chốt**. Tiền thì tính đúng theo số ngày khách dùng.",
      sections: [
        {
          steps: [
            {
              title: "Cả không gian hết hạn cùng một ngày",
              body: "Ngày chốt lặp lại hàng tháng, lúc **10 giờ sáng**. Ai đang còn hạn cũ thì giữ nguyên hạn đó, tới lần gia hạn sau mới về chung ngày chốt.",
            },
            {
              title: "Tiền tính theo ngày",
              body: "Giá một ngày = **đơn giá tháng chia cho số ngày của tháng đó**. Mua giữa tháng thì chỉ trả từ hôm mua tới ngày chốt. Gia hạn sớm tính tiếp từ hạn cũ nên không thu trùng ngày nào. **Tổng tiền hiện sẵn trong bảng mời** trước khi bạn bấm gửi.",
            },
            {
              title: "Mua sát ngày chốt thì trả thêm một tháng",
              body: "Quãng còn lại lúc đó quá ngắn để bán riêng. Mua trong **khoảng một tuần cuối** trước ngày chốt thì trả **số ngày còn lại cộng một tháng**, và khách dùng thẳng tới ngày chốt của tháng sau.",
            },
            {
              title: "Không có ân hạn",
              body: "Đúng **10 giờ sáng giờ Việt Nam** ngày chốt, email chưa gia hạn **bị gỡ ngay**. Nhắc khách gia hạn trước đó.",
            },
            {
              title: "Ví dụ",
              body: "Đơn giá của bạn **{donGia}/tháng**, ngày chốt mùng 1. Tháng 8 có 31 ngày nên một ngày khoảng **{giaNgay}**.",
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
        "自 **2026 年 9 月 8 日**起，同一个 ChatGPT 工作区里的所有邮箱都在**每月的同一天**到期——这一天叫**结算日**。费用则按客户实际使用的天数计算。",
      sections: [
        {
          steps: [
            {
              title: "整个工作区同一天到期",
              body: "结算日每月重复一次，时间是**上午 10 点**。此前仍在有效期内的客户保持原到期日，下次续费时才并入结算日。",
            },
            {
              title: "按天计费",
              body: "每天单价 = **月单价 ÷ 当月天数**。月中购买就只付从购买当天到结算日这一段。提前续费从原到期日接着算，不会重复收费。**邀请面板会先显示总金额**，你再点发送。",
            },
            {
              title: "临近结算日购买要多付一个月",
              body: "这时剩下的时间太短，不够单独卖。在结算日前**最后一周左右**购买，就要付**剩余天数再加一个月**，客户可以直接用到下个月的结算日。",
            },
            {
              title: "没有宽限期",
              body: "**越南时间结算日上午 10 点整**，未续费的邮箱**立即被移出**。请提前提醒客户续费。",
            },
            {
              title: "示例",
              body: "你的月单价是 **{donGia}**，结算日为 1 号。8 月有 31 天，所以每天大约 **{giaNgay}**。",
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
