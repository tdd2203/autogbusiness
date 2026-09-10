/** Bài hướng dẫn: sáu gói ChatGPT đặt cạnh nhau, suất Business hơn ở chỗ nào.
 *
 *  Bài bán hàng cho đại lý: khách hay hỏi "sao không mua Plus cho xong", bài này
 *  là câu trả lời in ra đưa khách được. Số liệu lấy từ ba nguồn của OpenAI, đều
 *  chụp ngày 10/9/2026 (chốt user 10/9/2026): trang giá chatgpt.com tại Việt Nam
 *  (cả hai tab Individual và Business & Enterprise), bài "ChatGPT Business -
 *  Overview", và bài "GPT-5.6 and GPT-6 Pro in ChatGPT" cho phần mô hình. Giá đổi
 *  thì sửa các hằng bên dưới, chữ tự đổi theo.
 *
 *  ĐỦ SÁU GÓI (chốt user 10/9/2026): bản trước chỉ có Plus và Business, user muốn
 *  cả sáu gói trên trang giá — Free, Go, Plus, Pro, suất Business, Enterprise —
 *  để khách tự thấy mình đang ở đâu. Bảng bảy cột nên mỗi ô phải NGẮN: một dấu,
 *  một con số, vài chữ. Ý dài đẩy xuống mục Lưu ý.
 *
 *  BẢNG SO SÁNH, KHÔNG PHẢI ĐOẠN VĂN (chốt user 10/9/2026): bản đầu kể bằng bốn
 *  bước văn xuôi, user đổi sang dạng quen mắt — cột tiêu chí bên trái, các gói
 *  cạnh nhau, dò từng dòng là thấy khác chỗ nào. `layout: "compare"` cho ô xuống
 *  dòng được và tô nền cột `highlight` (cột suất Business, đứng thứ năm chứ không
 *  đứng cuối). Quá 3 cột thì khung tự chuyển sang bảng rộng, màn hẹp cuộn ngang.
 *
 *  GIÁ BUSINESS ĐÃ GỒM VAT (user chỉnh 10/9/2026): 649.000 ₫/tháng là giá trả
 *  hàng tháng, 519.000 ₫/tháng là giá khi trả trước cả năm. ĐỪNG cộng thêm 10%
 *  VAT vào nữa — bản trước làm vậy và ra con số sai.
 *
 *  CHỌN LỌC LÀ CỐ Ý: trang giá liệt kê hơn hai chục dòng, bảng chỉ giữ thứ KHÁCH
 *  DÙNG SUẤT nhìn thấy. Không kể SSO/SAML, bảng quản trị, thống kê chi tiêu, trộn
 *  loại suất, chỗ lưu dữ liệu theo vùng: đó là việc của người sở hữu không gian
 *  (tức mình), khách không thấy nên kể ra chỉ làm bảng dài. Cũng không kể khuyến
 *  mãi tháng đầu của Plus, và KHÔNG kể chuyện ai đứng ra thanh toán (chốt user
 *  10/9/2026) — bảng nói quyền lợi khách nhận được, không nói đường đi của tiền.
 *
 *  ĐIỂM HƠN THẬT NẰM Ở KHUNG CHAT: Plus không có Extra High, mô hình Pro bị khoá,
 *  và trang giá ghi rõ Plus "Limits apply" trong khi thẻ Business ghi "Unlimited
 *  subject to abuse guardrails". Suất Business Standard có 15 tin mô hình Pro mỗi
 *  tháng.
 *
 *  BA DÒNG MÔ HÌNH LẤY TỪ ẢNH CHỤP MÀN HÌNH THẬT của user (10/9/2026), không chỉ
 *  từ tài liệu — tài liệu nói theo tên nội bộ, giao diện lại nói theo thanh trượt:
 *  - Thanh "Thinking effort" ở Plus chỉ tới **Instant, Medium, High**; nấc Pro
 *    hiện ổ KHOÁ. Ở suất Business thanh chạy hết, nấc cuối là **6 Pro** mở sẵn,
 *    và có cả Extra High. Nên ô Plus ghi "Khoá", không phải gạch ngang.
 *  - Trong tab **Work**, tài khoản Plus chọn được **GPT-6 Astra Max** y như suất
 *    Business (user đối chiếu hai tài khoản). Vì vậy dòng Codex & Work KHÔNG in
 *    đậm cột Business: hai bên như nhau, khoe ở đó là nói quá.
 *  Khác biệt thật chỉ nằm trong KHUNG CHAT — đó mới là chỗ đáng in đậm.
 *
 *  BÀI CHỈ CÓ ĐÚNG MỘT BẢNG (chốt user 10/9/2026): bản trước còn bước "đặt giá
 *  cạnh nhau" rồi bước "tiết kiệm được bao nhiêu"; user bỏ cả hai. Bài in đưa
 *  khách không nên khoe giá bán, và một bảng đã nói đủ.
 *
 *  KHÔNG CÒN `vars` LẪN Ô GÕ ĐƠN GIÁ: bài hết chỗ trống `{tên}` nên không còn số
 *  nào tính theo đơn giá người đọc. Ô gõ giá đặt ở bước không dùng số thì đứng đó
 *  vô duyên (xem `feeInput` trong `types.ts`) — thêm lại số theo đơn giá thì phải
 *  thêm cả hai thứ cùng lúc.
 *
 *  Không có ảnh: bài về giá và quyền lợi, ảnh chụp trang giá cũ đi ngay lần
 *  OpenAI đổi giá.
 */
import { formatVnd } from "../wallet";
import type { Guide } from "./types";

/** Trang giá chatgpt.com tại Việt Nam, 10/9/2026 — mọi giá ĐÃ gồm VAT và đều là
 *  giá THÁNG. Business còn mức trả trước cả năm rẻ hơn, nhưng bài không hiện: cả
 *  bảng chỉ so giá tháng, xen một con số theo năm vào là hai cột lệch mốc. */
const GO_VND = 132_000;
const PLUS_VND = 522_500;
const PRO_VND = 2_849_000;
const BIZ_STANDARD_VND = 649_000;
/** ChatGPT chỉ bán Business từ 2 suất trở lên (bài Overview của OpenAI). */
const MIN_SEATS = 2;

const go = formatVnd(GO_VND);
const plus = formatVnd(PLUS_VND);
const pro = formatVnd(PRO_VND);
const bizStd = formatVnd(BIZ_STANDARD_VND);
const bizMin = formatVnd(BIZ_STANDARD_VND * MIN_SEATS);

const businessVsPlus: Guide = {
  id: "business-vs-plus",
  content: {
    vi: {
      eyebrow: "Hướng dẫn · so sánh gói",
      title: "Sáu gói ChatGPT và suất Business",
      intro:
        "ChatGPT bán sáu gói: bốn gói **cá nhân** (Free, Go, Plus, Pro), gói **Business** tính theo suất, và **Enterprise** phải liên hệ. Thứ bạn mua lẻ là **một suất Business** — cùng quyền lợi như doanh nghiệp mua cả không gian, nhưng chỉ trả một chỗ.",
      sections: [
        {
          steps: [
            {
              title: "Bảng so sánh sáu gói",
              body: "Giá theo trang chatgpt.com tại Việt Nam, mô hình theo trang trợ giúp của OpenAI, cùng ngày 10/9/2026. Mọi giá đã gồm VAT.",
              table: {
                layout: "compare",
                highlight: 5,
                head: ["Tiêu chí", "Free", "Go", "Plus", "Pro", "Suất Business", "Enterprise"],
                rows: [
                  ["Giá mỗi tháng", "0 ₫", go, plus, `từ ${pro}`, bizStd, "Liên hệ"],
                  ["Mua tối thiểu", "1", "1", "1", "1", "2 suất — qua đại lý mua lẻ **1 suất**", "Theo hợp đồng"],
                  ["Mô hình trong Chat", "GPT-5.6 Luna", "GPT-5.6 Luna", "GPT-5.6 Sol", "GPT-5.6 Sol", "**GPT-5.6 Sol**", "GPT-5.6 Sol"],
                  ["Mức suy luận trong Chat", "Instant, Think", "Instant, Think", "Instant, Medium, High", "Thêm Extra High", "**Thêm Extra High**", "Thêm Extra High"],
                  ["Mô hình Pro trong Chat", "—", "—", "Khoá", "50–200 tin/tuần", "**Mở, 15 tin/tháng**", "Do workspace đặt"],
                  ["Chat thường", "Không giới hạn", "Không giới hạn", "Có hạn mức", "Không giới hạn", "**Không giới hạn**", "Không giới hạn"],
                  ["Tạo ảnh", "Ít và chậm", "Nhiều hơn", "Nhiều, đẹp hơn", "Không giới hạn", "**Như Plus**", "Như Plus"],
                  ["Codex & Work", "Hạn chế", "Hạn chế", "Có GPT-6 Astra", "Có GPT-6 Astra, tối đa", "Có GPT-6 Astra", "Có GPT-6 Astra"],
                  ["Deep research", "Hạn chế", "Hạn chế", "Mở rộng", "Tối đa", "**Mở rộng**", "Mở rộng"],
                  ["Bộ nhớ & ngữ cảnh", "Hạn chế", "Dài hơn", "Mở rộng", "Tối đa", "**Mở rộng**", "Rộng nhất"],
                  ["Quảng cáo trong app", "Có", "Có thể có", "Không", "Không", "**Không**", "Không"],
                  ["Dữ liệu chat đem huấn luyện AI", "Mặc định có", "Mặc định có", "Mặc định có", "Mặc định có", "**Không**", "Không"],
                  ["Điều khoản", "Cá nhân", "Cá nhân", "Cá nhân", "Cá nhân", "**Doanh nghiệp**", "Doanh nghiệp"],
                ],
              },
            },
          ],
        },
      ],
      notes: [
        `ChatGPT chỉ bán Business từ 2 suất trở lên, tức ít nhất ${bizMin}/tháng — mua lẻ qua đại lý thì chỉ trả đúng suất mình dùng.`,
      ],
    },
    "zh-CN": {
      eyebrow: "使用指南 · 套餐对比",
      title: "ChatGPT 六个套餐与 Business 席位",
      intro:
        "ChatGPT 共有六个套餐：四个**个人**套餐（Free、Go、Plus、Pro）、按席位计费的 **Business**，以及需要联系销售的 **Enterprise**。你零买的是**一个 Business 席位**——权益与整间企业购买时相同，但只付一个名额的钱。",
      sections: [
        {
          steps: [
            {
              title: "六个套餐对比表",
              body: "价格取自越南地区 chatgpt.com，模型取自 OpenAI 帮助中心，均为 2026 年 9 月 10 日。所有价格均已含税。",
              table: {
                layout: "compare",
                highlight: 5,
                head: ["项目", "Free", "Go", "Plus", "Pro", "Business 席位", "Enterprise"],
                rows: [
                  ["每月价格", "0 ₫", go, plus, `${pro} 起`, bizStd, "联系销售"],
                  ["最低购买", "1", "1", "1", "1", "2 个席位——通过代理零买 **1 个席位**", "按合同"],
                  ["Chat 中的模型", "GPT-5.6 Luna", "GPT-5.6 Luna", "GPT-5.6 Sol", "GPT-5.6 Sol", "**GPT-5.6 Sol**", "GPT-5.6 Sol"],
                  ["Chat 推理档位", "Instant、Think", "Instant、Think", "Instant、Medium、High", "增加 Extra High", "**增加 Extra High**", "增加 Extra High"],
                  ["Chat 中的 Pro 模型", "—", "—", "锁定", "每周 50–200 条", "**开放，每月 15 条**", "由工作区设定"],
                  ["普通聊天", "不限量", "不限量", "有额度限制", "不限量", "**不限量**", "不限量"],
                  ["图片生成", "少且慢", "更多", "更多更精细", "不限量", "**与 Plus 相同**", "与 Plus 相同"],
                  ["Codex 与 Work", "受限", "受限", "有 GPT-6 Astra", "有 GPT-6 Astra，最高", "有 GPT-6 Astra", "有 GPT-6 Astra"],
                  ["深度研究", "受限", "受限", "扩展", "最高", "**扩展**", "扩展"],
                  ["记忆与上下文", "受限", "更长", "扩展", "最高", "**扩展**", "最大"],
                  ["应用内广告", "有", "可能有", "无", "无", "**无**", "无"],
                  ["聊天数据用于训练 AI", "默认是", "默认是", "默认是", "默认是", "**否**", "否"],
                  ["条款", "个人", "个人", "个人", "个人", "**企业**", "企业"],
                ],
              },
            },
          ],
        },
      ],
      notes: [
        `ChatGPT 的 Business 至少要买 2 个席位，即每月至少 ${bizMin}——通过代理零买则只付自己用的那一个。`,
      ],
    },
  },
};

export default businessVsPlus;
