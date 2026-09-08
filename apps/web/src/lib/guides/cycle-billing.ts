/** Bài hướng dẫn: hạn dùng của cả không gian rơi vào MỘT ngày chốt hàng tháng.
 *
 *  Bài này giải thích cách tính mới cho đại lý, nên chỉ nói thứ họ nhìn thấy và
 *  quyết định được: hạn rơi ngày nào, trả bao nhiêu tiền, khi nào phải gia hạn.
 *  Không kể chuyện bên trong (mua/hạ suất, đợt gỡ chạy ra sao) — xem
 *  `routers/members/EXPIRY_RULES.md` §3.6 nếu cần bản đầy đủ cho người làm.
 *
 *  Không có ảnh: đây là bài về cách tính, ảnh chụp màn hình không nói thêm được gì
 *  mà lại cũ đi mỗi lần giao diện đổi. Các con số trong phần Ví dụ là ví dụ ĐƠN
 *  GIÁ TRÒN cho dễ nhẩm, không phải giá thật của ai.
 */
import type { Guide } from "./types";

const cycleBilling: Guide = {
  id: "cycle-billing",
  content: {
    vi: {
      eyebrow: "Hướng dẫn · 4 phần",
      title: "Hạn dùng theo ngày chốt của không gian",
      intro:
        "Một số không gian đã đổi sang cách tính mới: thay vì mỗi email đếm riêng 30 ngày, **cả không gian dùng chung một ngày chốt hàng tháng** và tiền tính đúng theo số ngày khách dùng. Bốn thẻ dưới đây nói đủ những gì bạn cần biết.",
      sections: [
        {
          heading: "Ngày chốt chung cho cả không gian",
          tab: "Có gì đổi",
          steps: [
            {
              title: "Mọi email hết hạn cùng một ngày",
              body: "Không gian có một **ngày chốt** cố định hàng tháng. Hạn dùng của mọi email trong đó đều rơi đúng ngày này, vào **10 giờ sáng giờ Việt Nam**. Trước đây mỗi email đếm 30 ngày kể từ lúc mua nên ngày hết hạn của mỗi người một khác.",
            },
            {
              title: "Người đang còn hạn không mất gì",
              body: "Việc đổi cách tính **không cộng cũng không trừ ngày** của ai. Ai đang còn hạn cứ dùng hết hạn cũ. Tới lần gia hạn kế tiếp họ mới về chung ngày chốt, và chỉ trả tiền cho quãng từ hạn cũ tới ngày chốt.",
            },
            {
              title: "Bạn được lợi gì",
              body: "Cả danh sách khách của bạn có chung một mốc để nhắc, thay vì mỗi người một ngày rải rác khắp tháng. Nhắc một lượt, thu một lượt, gia hạn một lượt.",
            },
          ],
        },
        {
          heading: "Trả đúng số ngày dùng thật",
          tab: "Tính tiền",
          steps: [
            {
              title: "Tính theo ngày, không làm tròn lên tháng",
              body: "Mỗi lần bán, hệ thống đếm số ngày từ lúc khách bắt đầu dùng tới ngày chốt rồi tính tiền đúng quãng đó. Đơn giá tháng giữ nguyên như trước. Số ngày đếm tới **nửa ngày một**, nên mua buổi tối rẻ hơn mua buổi sáng cùng ngày một chút.",
            },
            {
              title: "Ô số tháng giờ đếm theo ngày chốt",
              body: "Chọn **1 tháng** là bán tới ngày chốt gần nhất. Chọn **2 tháng** là thêm một ngày chốt nữa, và cứ thế. Khách đã về chung mốc rồi thì 1 tháng đúng bằng một tháng trọn như bình thường.",
            },
            {
              title: "Gia hạn sớm không bị thu trùng",
              body: "Khách còn hạn mà bạn gia hạn trước cho chắc thì hệ thống tính từ **ngày hết hạn cũ**, không tính từ hôm bấm nút. Những ngày khách đã trả rồi không bị thu lại lần nữa.",
            },
            {
              title: "Số tiền hiện sẵn trước khi bấm",
              body: "Bảng mời hiện **tổng tiền sẽ trừ khỏi ví** trước khi bạn gửi. Số đó đã tính đủ phần ngày lẻ, cứ nhìn đó mà báo giá cho khách.",
            },
          ],
        },
        {
          heading: "Khi chỉ còn ít ngày là tới ngày chốt",
          tab: "Mua sát ngày chốt",
          steps: [
            {
              title: "Còn quá ít ngày thì tính luôn tháng sau",
              body: "Nếu từ lúc mua tới ngày chốt chỉ còn **khoảng 9 ngày trở xuống**, lần bán đó tự động gồm luôn tháng kế tiếp: khách dùng tới ngày chốt của tháng sau, và trả tiền cho mấy ngày lẻ **cộng** một tháng.",
            },
            {
              title: "Vì sao lại gộp",
              body: "Bán một gói chỉ dùng được vài ngày rồi hết thì khách vừa nhận email đã phải gia hạn ngay. Gộp sẵn tháng sau để khách dùng liền một mạch, bạn cũng khỏi thu tiền hai lần trong một tuần.",
            },
            {
              title: "Muốn tránh thì bán sớm hơn",
              body: "Càng gần ngày chốt thì phần ngày lẻ càng ngắn và số tiền lần đầu càng cao vì đã gồm cả tháng sau. Khách nào cần mua đúng một tháng thì nên chốt trước quãng đó.",
            },
          ],
        },
        {
          heading: "Ví dụ: ngày chốt mùng 1, đơn giá 300.000đ/tháng",
          tab: "Ví dụ",
          steps: [
            {
              title: "Mua ngày 10/8, chọn 1 tháng",
              body: "Còn 22 ngày tới ngày chốt ⇒ trả khoảng **213.000đ**, dùng tới **10 giờ sáng 1/9**.",
            },
            {
              title: "Mua ngày 10/8, chọn 2 tháng",
              body: "22 ngày lẻ cộng một tháng trọn ⇒ trả khoảng **513.000đ**, dùng tới **1/10**.",
            },
            {
              title: "Mua ngày 25/8 — sát ngày chốt",
              body: "Chỉ còn 7 ngày nên lần bán này gồm luôn tháng sau ⇒ trả khoảng **368.000đ**, dùng tới **1/10** chứ không phải 1/9.",
            },
            {
              title: "Gia hạn cho khách đang có hạn tới 12/9",
              body: "Bấm gia hạn ngày 1/9, hệ thống tính từ **12/9** tới ngày chốt kế ⇒ trả khoảng **190.000đ** cho 19 ngày, khách dùng liền tới **1/10**. Từ lần sau họ trả tròn một tháng như mọi người.",
            },
          ],
        },
      ],
      notes: [
        "Đúng **10 giờ sáng ngày chốt**, email chưa gia hạn bị gỡ khỏi không gian ngay, **không có ngày ân hạn**. Nhắc khách gia hạn trước hôm đó.",
        "Cách tính này chỉ áp cho không gian đã bật. Không gian còn lại vẫn tính 30 ngày cho mỗi tháng như trước.",
        "Ngày chốt đi theo kỳ thanh toán của không gian nên có thể dời khi kỳ đổi. Hạn dùng hiển thị trong bảng thành viên luôn là ngày đúng.",
      ],
    },
    "zh-CN": {
      eyebrow: "使用指南 · 4 部分",
      title: "按工作区结算日计算到期时间",
      intro:
        "部分工作区已改用新的计算方式：不再每个邮箱各自算 30 天，而是**整个工作区共用每月同一个结算日**，费用按客户实际使用的天数计算。下面四张卡片讲清你需要知道的全部内容。",
      sections: [
        {
          heading: "整个工作区共用一个结算日",
          tab: "有什么变化",
          steps: [
            {
              title: "所有邮箱在同一天到期",
              body: "工作区有一个每月固定的**结算日**。区内所有邮箱的到期时间都落在这一天的**越南时间上午 10 点**。以前每个邮箱从购买之日起各算 30 天，所以每个人的到期日都不一样。",
            },
            {
              title: "仍在有效期内的人不会有任何损失",
              body: "更改计算方式**不会增加也不会减少**任何人的天数。仍在有效期内的客户照常用到原来的到期日；等到下次续费时才并入统一的结算日，而且只需支付从原到期日到结算日这一段的费用。",
            },
            {
              title: "对你的好处",
              body: "你名下所有客户共用一个提醒时间点，不必再记住散落在整月里的一堆日期。一次提醒、一次收款、一次续费。",
            },
          ],
        },
        {
          heading: "按实际使用天数付费",
          tab: "费用怎么算",
          steps: [
            {
              title: "按天计算，不向上凑成整月",
              body: "每次售卖，系统会数出从客户开始使用到结算日之间的天数，按这段时间计费。月单价和以前一样。天数以**半天**为单位，所以同一天晚上买会比早上买便宜一点。",
            },
            {
              title: "月数选项现在按结算日计",
              body: "选 **1 个月**是卖到最近的那个结算日；选 **2 个月**就再多一个结算日，依此类推。已经并入统一结算日的客户，1 个月就是正常的一整月。",
            },
            {
              title: "提前续费不会重复收费",
              body: "客户还没到期你就先续上，系统从**原来的到期日**开始算，而不是从你点按钮那天算。客户已经付过钱的天数不会再收第二次。",
            },
            {
              title: "点之前就能看到金额",
              body: "邀请面板会在你发送前显示**将从钱包扣除的总金额**，其中已经算好零头天数，直接照着这个数字向客户报价即可。",
            },
          ],
        },
        {
          heading: "距离结算日只剩几天时",
          tab: "临近结算日购买",
          steps: [
            {
              title: "剩余天数太少就连下个月一起算",
              body: "如果从购买到结算日只剩**大约 9 天以内**，这次售卖会自动包含下一个月：客户可以用到下个月的结算日，费用是零头天数**加上**一个月。",
            },
            {
              title: "为什么要合并",
              body: "只能用几天就到期的套餐，客户刚拿到邮箱就得马上续费。提前并入下个月，客户能连续使用，你也不用一周之内收两次钱。",
            },
            {
              title: "想避开就早点卖",
              body: "越接近结算日，零头天数越短，而首次费用因为含了下个月反而越高。只想买一个月的客户，最好在这段时间之前就成交。",
            },
          ],
        },
        {
          heading: "示例：结算日为 1 号，月单价 300.000đ",
          tab: "示例",
          steps: [
            {
              title: "8 月 10 日购买，选 1 个月",
              body: "距结算日还有 22 天 ⇒ 约付 **213.000đ**，可用到 **9 月 1 日上午 10 点**。",
            },
            {
              title: "8 月 10 日购买，选 2 个月",
              body: "22 天零头加一整月 ⇒ 约付 **513.000đ**，可用到 **10 月 1 日**。",
            },
            {
              title: "8 月 25 日购买 — 临近结算日",
              body: "只剩 7 天，这次售卖会包含下个月 ⇒ 约付 **368.000đ**，可用到 **10 月 1 日**，而不是 9 月 1 日。",
            },
            {
              title: "为有效期到 9 月 12 日的客户续费",
              body: "9 月 1 日点续费，系统从 **9 月 12 日**算到下一个结算日 ⇒ 19 天约付 **190.000đ**，客户可连续用到 **10 月 1 日**。从下一次起，他们就和其他人一样按整月付费。",
            },
          ],
        },
      ],
      notes: [
        "**结算日上午 10 点整**，尚未续费的邮箱会立即被移出工作区，**没有宽限期**。请提前提醒客户续费。",
        "该计算方式只适用于已启用的工作区，其余工作区仍按每月 30 天计算。",
        "结算日跟随工作区的账单周期，周期变动时可能顺延。成员列表中显示的到期时间始终以实际为准。",
      ],
    },
  },
};

export default cycleBilling;
