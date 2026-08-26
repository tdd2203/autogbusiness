/**
 * Single source of truth cho version + changelog của extension.
 *
 * Quy tắc bump version (semver-like):
 *   - MAJOR (x.0.0): breaking change về protocol/storage hoặc đổi cấu trúc lớn
 *   - MINOR (0.x.0): thêm action mới (SYNC_BILLING, INVITE_MEMBER, ...) hoặc
 *                    thay đổi UI lớn (popup redesign, scraper rewrite)
 *   - PATCH (0.0.x): fix bug, sửa selectors, tune timing/regex
 *
 * Khi bump:
 *   1. Tăng `VERSION` ở dưới
 *   2. Prepend 1 entry mới ở đầu `CHANGELOG` (most recent first)
 *   3. Build lại extension, reload trong chrome://extensions
 *
 * Manifest tự đọc VERSION từ file này — KHÔNG cần sửa manifest.ts.
 * Popup hiển thị VERSION prominent + cho phép expand changelog.
 */

export const VERSION = "0.13.18";

export type ChangelogEntry = {
  version: string;
  date: string; // YYYY-MM-DD
  kind: "feature" | "fix" | "chore";
  summary: string;
  /** Bullet list chi tiết, hiển thị khi user expand. */
  details: string[];
};

export const KIND_COLOR: Record<ChangelogEntry["kind"], string> = {
  feature: "#10b981",
  fix: "#f59e0b",
  chore: "#6b7280",
};

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.13.18",
    date: "2026-08-26",
    kind: "fix",
    summary:
      "Mua suất xong mà đọc lại số không chắc: vẫn ghi đúng 'đã mua N suất', hết cảnh báo về 0.",
    details: [
      "Lệnh mời phải mua suất nay chạy hai lượt (0.13.15): mua xong tải lại trang rồi mới mời. Ở lượt sau, nếu số suất đọc ra không khớp nhau — bộ đếm vênh dòng tỉ lệ, rất hay gặp ngay sau một cú mua chập chờn — extension dừng lại là đúng, nhưng nó khai 'mua 0 suất'. Con số 0 đó ĐÈ mất số thật khi gửi về dashboard, nên một lệnh đã trừ tiền mua 2 suất lại hiện ra như không tiêu đồng nào.",
      "Nay mọi đường ra của lượt đọc kiểm đều mang theo đúng số suất đã mua.",
      "Chốt thời gian chờ của lệnh mời hạ 450 → 300 giây. Từ 0.13.15 lượt gọi đã cắt làm hai nên không lượt nào cần tới 450 giây nữa; mà để dài hơn thì đúng vào lúc trình duyệt tắt tiến trình nền, cái đồng hồ này chết theo trước khi kịp báo — lệnh im tới khi máy chủ dọn ở phút thứ 8, đúng ba ca hỏng sáng 26/8.",
      "Thêm 17 test khoá ba điều dính tiền của luồng mua-rồi-mời: không mua lần hai, số suất đã mua không rơi mất, tải lại trang hỏng thì dừng TRƯỚC khi mời.",
    ],
  },
  {
    version: "0.13.17",
    date: "2026-08-26",
    kind: "fix",
    summary:
      "Mua suất gặp báo lỗi 'Đã xảy ra sự cố': tải lại trang xem suất đã lên chưa, chưa lên mới mua lại.",
    details: [
      "Trước đây gặp băng-rôn đỏ này extension nằm chờ hộp đóng 2 phút rồi trả lời chung chung 'có thể đã mua'.",
      "Nay tải lại trang admin rồi đọc số suất. Đã lên đủ ⇒ xong, không bấm thêm gì.",
      "Chưa lên ⇒ đọc lại tối đa 3 lượt (ChatGPT cập nhật chậm) rồi mới mua lại ĐÚNG MỘT LẦN. Nhập nhằng ⇒ dừng, báo admin.",
      "Hộp nào ghi 'Có hiệu lực vào kỳ gia hạn sau' thì CẤM mua lại — suất hôm nay đúng ra không nhích.",
      "Nhận thêm hộp 'Xem lại thay đổi người dùng' — biến thể giao diện mới của ChatGPT.",
    ],
  },
  {
    version: "0.13.16",
    date: "2026-08-26",
    kind: "fix",
    summary:
      "Mua suất xong nhìn số 'Suất Tiêu chuẩn' in trên trang, khỏi mở lại hộp 'Quản lý số suất'.",
    details: [
      "Trang Thành viên in sẵn số đó, mà mọi thành viên đều dùng suất Tiêu chuẩn. Số tăng lên là mua thành công.",
      "Nay chờ số đó nhích lên (tối đa 15 giây) rồi mời tiếp. Đỡ một lần mở hộp — hộp kẹt là lớp phủ chặn luôn bước mời.",
      "Hộp giao dịch không chịu đóng cũng xử được: suất đã lên thì chốt là mua xong, tải lại trang rồi mời.",
      "Chỉ so suất TIÊU CHUẨN, không cộng Cao cấp. Tăng không đủ thì quay về đếm như cũ.",
    ],
  },
  {
    version: "0.13.15",
    date: "2026-08-26",
    kind: "fix",
    summary:
      "Mua suất xong không tự tải lại trang nữa — hết cảnh mời được mà lệnh báo 'quá thời gian chờ'.",
    details: [
      "Ca 26/8: ba lệnh mời kèm mua suất đều hiện 'Thất bại' dù lời mời đã đi thật.",
      "Do cả lệnh chạy trong một lượt dài 4–5 phút nên Chrome cắt ngang giữa chừng, extension cũng không báo lỗi được.",
      "Nay tách làm hai lượt ngắn: mua xong tải lại trang, rồi mời ở lượt mới.",
      "Lượt sau KHÔNG BAO GIỜ mua lần hai. Tải lại hỏng thì dừng, backend hoàn phí, suất đã mua vẫn còn.",
    ],
  },
  {
    version: "0.13.14",
    date: "2026-08-26",
    kind: "fix",
    summary:
      "Ngày gia hạn lấy đúng năm ChatGPT in trên trang.",
    details: [
      "Trước chỉ đọc ngày/tháng rồi tự suy năm theo luật 'ngày đã qua thì cộng 1 năm'.",
      "Đọc vào ngày sau khi chu kỳ khép lại là ngày gia hạn bị đẩy sang năm sau, kéo giá theo kỳ sai theo.",
      "Nay năm in trên trang luôn thắng; trang không in năm mới suy như cũ.",
    ],
  },
  {
    version: "0.13.13",
    date: "2026-08-26",
    kind: "feature",
    summary:
      "Còn dư suất thì chạy 2 lệnh mời cùng lúc; phải mua suất thì mỗi lần 1 lệnh.",
    details: [
      "Dư ít nhất 1 suất so với số cần thì hai lệnh mời chạy song song, mời nhanh gấp đôi.",
      "Có thể phải MUA thì vẫn một lệnh một lúc — hai lệnh cùng đi mua là mất tiền thật.",
      "Chạy song song mà đếm ra thiếu suất thì dừng trước khi mở hộp mời, chờ lệnh kia xong rồi chạy lại một mình.",
      "Lệnh mua suất vẫn luôn chạy một mình.",
    ],
  },
  {
    version: "0.13.12",
    date: "2026-08-26",
    kind: "fix",
    summary:
      "Đồng bộ hàng loạt: mỗi email chỉ gõ vào ô tìm kiếm một lần.",
    details: [
      "Trước gõ hai lần cho chắc, mà lần hai luôn ra kết quả cũ — 20 email phí hơn một phút.",
      "Nay gõ một lần rồi nhìn danh sách có đổi theo từ khoá không là đủ kết luận.",
      "Riêng ca danh sách đứng im (tab chạy nền) vẫn gõ lại như cũ.",
      "Ô tìm kiếm hỏng thì bỏ qua email đó chứ không báo nhầm 'chưa tham gia'.",
    ],
  },
  {
    version: "0.13.11",
    date: "2026-08-26",
    kind: "feature",
    summary:
      "ChatGPT in sẵn số suất ở tab Thành viên — đọc thẳng, khỏi mở hộp 'Quản lý suất'.",
    details: [
      "Tab Người dùng in 'Suất Tiêu chuẩn 60/62' và 'Suất Cao cấp 0/0'. TỔNG SUẤT = cộng cả hai loại.",
      "Đỡ phải mở hộp 'Quản lý suất' — chỗ hỏng nhiều nhất, có hôm 8 lệnh mời chết liên tiếp vì nó.",
      "⚠️ Hộp đó nay có hai bộ đếm, suất Cao cấp đắt gấp 12 lần. Extension chỉ bấm hàng Tiêu chuẩn; không chắc thì không bấm gì.",
      "Workspace có cả hai loại suất thì extension KHÔNG tự mua, chỉ báo để bạn mua tay đúng loại.",
      "Sửa lỗi mua thêm suất mà dashboard không tăng (GPT1: ChatGPT 152, dashboard đứng 151).",
    ],
  },
  {
    version: "0.13.10",
    date: "2026-08-24",
    kind: "chore",
    summary:
      "Tab ChatGPT do extension mở mà để không 30 phút thì tự đóng.",
    details: [
      "Tính riêng từng tab. Bản cũ dùng chung một đồng hồ nên tab thứ hai gần như không bao giờ được đóng.",
      "Ngưỡng cũ ngẫu nhiên 10–60 phút, nay chốt cứng 30 phút.",
      "Tab admin bạn tự mở không bao giờ bị đụng; đang chạy lệnh thì không đóng tab nào.",
    ],
  },
  {
    version: "0.13.9",
    date: "2026-08-24",
    kind: "fix",
    summary:
      "Mua suất xong đợi hộp giao dịch tắt hẳn rồi mới mời; bấm chậm lại trong hộp 'Quản lý suất'.",
    details: [
      "Hộp giao dịch là lớp phủ che cả trang — bấm mời lúc nó còn là bấm trượt, lệnh hỏng.",
      "Nay chờ tới 2 phút và phải thấy đóng ba nhịp liên tiếp mới tin. Hộp đóng sớm thì đi tiếp ngay.",
      "Lớp phủ còn nằm lại thì tải lại trang một lần cho sạch rồi mới mời.",
      "Bấm chậm lại trong hộp 'Quản lý suất': bấm chồng lúc giao diện đang dựng lại là trượt nút.",
    ],
  },
  {
    version: "0.13.8",
    date: "2026-08-24",
    kind: "fix",
    summary:
      "Bám nút đỏ 'Gỡ bỏ khỏi không gian làm việc' của hộp xác nhận xoá kiểu mới.",
    details: [
      "ChatGPT đổi chữ trong hộp xác nhận. Bản cũ vẫn bấm trúng nhưng chỉ nhờ nhãn dự phòng cụt 'Gỡ'.",
      "Nay ghi hẳn nhãn đầy đủ lên đầu danh sách, kèm biến thể tiếng Anh và tiếng Trung.",
      "Chỉ dò nút trong hộp đang mở — nhãn cụt trước đây có thể khớp nhầm nút ngoài trang.",
    ],
  },
  {
    version: "0.13.7",
    date: "2026-08-24",
    kind: "feature",
    summary:
      "Thiếu suất cho lời mời đang chờ thì tự mua bù sau mỗi lần đồng bộ.",
    details: [
      "Lời mời treo chưa chiếm suất, nhưng ai bấm nhận là ChatGPT cấp suất và tính tiền luôn.",
      "Mua trước để tránh hộp 'Mua suất người dùng và gửi lời mời' — hộp đó ChatGPT tự quyết số tiền.",
      "Sáu rào chắn vì đây là đường DUY NHẤT hệ thống tự tiêu tiền: tối đa 5 suất mỗi lần, cách nhau ít nhất 6 tiếng, bỏ qua lời mời treo quá 7 ngày, số suất phải đọc được rõ ràng.",
      "Thiếu suất mà không mua thì ghi nhật ký kèm lý do và email, để admin xử tay.",
    ],
  },
  {
    version: "0.13.6",
    date: "2026-08-24",
    kind: "fix",
    summary:
      "Hết cảnh lệnh mời chết oan vì 'thiếu suất' khi workspace vẫn còn chỗ.",
    details: [
      "Ca GPT1: mời lại hai lần đều chết ở bước chốt suất, chạy lại bao nhiêu lần cũng vô ích.",
      "Hai chiều đếm sai: tổng suất lấy nhầm số thấp, và số lời mời đang chờ lấy từ dashboard vốn hay thừa.",
      "Nay tổng suất luôn theo dòng tỉ lệ — số workspace đang giữ hôm nay; còn lời mời chờ thì đếm tận nơi trên ChatGPT.",
      "Không đếm được tận nơi mới quay về số dashboard: số đó đếm thừa, mà thừa thì cùng lắm mua dư.",
    ],
  },
  {
    version: "0.13.5",
    date: "2026-08-24",
    kind: "fix",
    summary:
      "Mời vào workspace đầy suất giờ mua ĐỦ: lời mời đang treo cũng cần một chỗ.",
    details: [
      "ChatGPT ghi '60/60 đã gán' mà vẫn còn 1 lời mời chưa ai nhận — ô 'đã gán' chỉ đếm người đã tham gia.",
      "Trước mời thêm 1 email chỉ mua 1 suất trong khi cần 2. Nay chỗ trống = tổng − (đã gán + lời mời chờ).",
      "Email của chính lệnh mời được trừ ra, kẻo bấm 'Mời lại' là mua thừa một suất bằng tiền thật.",
      "Hệ thống không bao giờ tự mua suất khi không có lệnh mời.",
    ],
  },
  {
    version: "0.13.4",
    date: "2026-08-24",
    kind: "feature",
    summary:
      "Chắc còn thừa chỗ thì mời thẳng, khỏi mở hộp 'Quản lý suất'. Extension dùng tối đa 2 tab, chạy 2 lệnh cùng lúc.",
    details: [
      "Sáng 24/8 có 8 lệnh mời chết liên tiếp, tất cả kẹt ở khâu đếm suất trong khi workspace vẫn thừa suất.",
      "Nay số thành viên in sẵn trên trang cộng số suất dashboard biết, nói còn dư chỗ thì mời thẳng. Mời không tiêu tiền, chỉ MUA mới cần số chắc chắn.",
      "CHẶN CUỐI: trước khi bấm gửi, đọc nhãn nút — thấy 'Mua suất người dùng và gửi lời mời' thì DỪNG, thà lệnh chết còn hơn tiêu tiền không ai duyệt.",
      "Extension tự tải lại trang thì chờ đúng trang mới tiếp quản rồi mới gửi lệnh. Trang cũ trả lời nhầm chính là ca phải hoàn 340.000đ ngày 31/7.",
      "Tab admin bạn tự mở không còn bị extension F5 hay đóng ngang.",
    ],
  },
  {
    version: "0.13.3",
    date: "2026-08-24",
    kind: "fix",
    summary:
      "Mỗi lần 'Đồng bộ từ ChatGPT' là đọc số suất thật và ghi về dashboard.",
    details: [
      "Tổng suất trên dashboard ôm số cũ suốt 11 ngày: 148 trong khi ChatGPT đang có 151.",
      "Gốc rễ: dán lại hoá đơn cũ kéo tổng suất về số ghế của kỳ hoá đơn đó. Từ nay hoá đơn chỉ nói chuyện tiền.",
      "Đồng bộ nay đọc thêm hộp 'Quản lý suất'; đọc không được thì giữ số cũ, không báo hỏng.",
      "Popup in 'Seat: x/y' cùng cách tính với dashboard: đã dùng = người dùng + lời mời đang chờ.",
    ],
  },
  {
    version: "0.13.2",
    date: "2026-08-24",
    kind: "fix",
    summary:
      "Chờ nút 'Quản lý số suất' hiện ra rồi mới kết luận workspace dùng giao diện cũ.",
    details: [
      "Nút đó hiện sau danh sách thành viên. Bản cũ hỏi đúng một lần, chưa thấy là bỏ qua bước đếm suất rồi mời mù.",
      "Đó là gốc của 2 lệnh mời hỏng ngày 22/8 mà chủ hệ thống phải hoàn tiền tay.",
      "Nay chờ tối đa 6 giây. Số liệu bước suất được ghi kèm cả khi lệnh hỏng, để lần sau tra được.",
    ],
  },
  {
    version: "0.13.1",
    date: "2026-08-23",
    kind: "fix",
    summary:
      "Ba lỗi của bước đếm suất lộ ra ở lần chạy thật đầu tiên.",
    details: [
      "Nút 'Xác nhận mua' bị khoá lúc ChatGPT còn tính tiền. Bản cũ thấy khoá là bỏ cuộc rồi báo oan 'thiếu phương thức thanh toán'. Nay chờ tới 10 giây.",
      "Bộ đếm và dòng tỉ lệ lệch nhau đúng 1 do đọc lúc trang chưa vẽ xong. Nay đọc lại cả hai cho tới khi khớp.",
      "Hai số vẫn lệch thì vẫn chặn, cố ý không đoán bừa: chặn thì chạy lại không mất đồng nào, đoán sai là tiền đã đi.",
      "Số liệu lúc lỗi được giữ lại vào kết quả task để tra ngược.",
    ],
  },
  {
    version: "0.13.0",
    date: "2026-08-22",
    kind: "feature",
    summary:
      "Mời thành viên: kiểm số suất trước, thiếu thì tự mua bù rồi mới mời.",
    details: [
      "Quy trình mới: mở 'Quản lý số suất' → đọc 'đã gán/tổng' → thiếu bao nhiêu mua bấy nhiêu → đọc lại → rồi mới mời.",
      "Vì sao mua trước: mời khi thiếu suất làm ChatGPT bật hộp 'Mua suất người dùng và gửi lời mời' — mua và mời trong một cú bấm, không biết trước hết bao nhiêu tiền.",
      "Workspace chưa có nút 'Quản lý số suất' thì bỏ qua bước này, mời y như trước.",
      "Thiếu quá 20 suất, hoặc không đọc được số suất, thì DỪNG — không mua một phần, không mời mù.",
      "Chốt ở hộp thanh toán chỉ dựa vào SỐ SUẤT, không dựa vào tiền: workspace được giảm giá nên giá niêm yết không phải giá thật.",
      "Hạn giờ lệnh mời nâng từ 3 lên 8 phút, vì mời giờ có thể kèm một lần mua.",
    ],
  },
  {
    version: "0.12.0",
    date: "2026-08-22",
    kind: "feature",
    summary:
      "Mua suất theo giao diện mới của ChatGPT: bấm thẳng trên trang Thành viên, bỏ chặng vòng qua Stripe.",
    details: [
      "ChatGPT đổi cách mua: nút 'Quản lý số suất' trên trang Thành viên → chỉnh bộ đếm → 'Tiếp tục' → 'Xác nhận mua' là trừ tiền ngay qua thẻ đã lưu. Đường cũ qua trang Thanh toán không còn.",
      "Bỏ chặng Stripe khỏi luồng mua. Giữ lại còn tai hại: sau khi đã trừ tiền, bản cũ sang tab Hoá đơn tự trả một hoá đơn KHÁC không liên quan.",
      "Đọc thêm 'Hoá đơn mới hằng tháng' để biết khoản tăng cố định mỗi tháng — 'Tổng phải trả hôm nay' chỉ là phần lẻ tới cuối chu kỳ.",
      "Đọc tiền không đoán bừa nữa: bản cũ vớ trúng dòng đơn giá nên ghi sai gấp khoảng 24 lần. Không đọc được thì báo không đọc được.",
      "Thêm chốt: không đọc được cả số suất lẫn tổng tiền thì KHÔNG bấm; hoá đơn mới thấp hơn hiện tại thì dừng, vì đó là hộp giảm suất.",
    ],
  },
  {
    version: "0.11.9",
    date: "2026-08-21",
    kind: "fix",
    summary:
      "Thu hồi lời mời: hết bấm nhầm nút 'Hủy' của hộp xác nhận.",
    details: [
      "Ca 21/8: task báo 'đã bấm nhưng lời mời còn nguyên', trong khi trên ChatGPT email đó đã biến mất — dashboard kẹt một lời mời ma.",
      "Gốc: danh sách chữ nút xác nhận có lẫn 'Hủy'. ChatGPT đổi chữ nút thật là rơi xuống khớp trúng nút Hủy.",
      "Nay tách riêng nhóm nút huỷ/đóng và loại bằng so khớp bằng nhau, nên 'Hủy lời mời' (hành động thật) vẫn nhận.",
      "Không chữ nào khớp thì lấy nút cuối có chữ mà không phải huỷ/đóng — hộp thoại luôn đặt nút hành động ở cuối.",
    ],
  },
  {
    version: "0.11.8",
    date: "2026-08-21",
    kind: "feature",
    summary:
      "Gỡ thành viên: không thấy ở tab Người dùng thì sang tab Lời mời đang chờ thu hồi.",
    details: [
      "Trước đây không lọc ra email là kết luận luôn 'đã rời workspace'. Nhưng email đó có thể đang là lời mời chờ — dashboard nói đã gỡ trong khi lời mời vẫn sống và vẫn giữ ghế.",
      "Nay tìm nốt ở tab Lời mời: thu hồi được thì xong; có mà thu hồi không ăn thì báo lỗi và giữ member để chạy lại.",
      "Phục vụ nút 'Chuyển hạn sử dụng đến' trên dashboard: luôn gửi lệnh gỡ chứ không đoán trạng thái từ dữ liệu cũ.",
    ],
  },
  {
    version: "0.11.7",
    date: "2026-08-21",
    kind: "fix",
    summary:
      "Đổi vai trò / đổi loại suất / thu hồi lời mời / đặt giới hạn: chờ ChatGPT xử lý xong rồi quét lại xác nhận.",
    details: [
      "Backend lấy 'ok' của extension làm sự thật, ghi thẳng vào dữ liệu. Action nào bấm xong ngủ vài trăm mili giây rồi báo ok là ChatGPT nuốt lệnh im lặng, dashboard lệch tới tận lần đồng bộ sau.",
      "Đổi loại suất nặng nhất: trước bấm xong là báo ok, không quét lại gì. Nay chờ hộp tắt hẳn rồi đọc lại cột loại suất 3 lần, lệch thì báo lỗi.",
      "Đổi vai trò trước đây hỏi vai trò nào cũng PASS do nhận nhầm nút. Nay đọc nhãn thật trong dòng.",
      "Thu hồi lời mời: chờ hộp tắt hẳn và lớp phủ gỡ rồi mới quét lại, thay vì đo lúc hộp còn quay.",
    ],
  },
  {
    version: "0.11.6",
    date: "2026-08-18",
    kind: "fix",
    summary:
      "Xoá / thu hồi / đổi suất: hết bấm nhầm ô vai trò — ChatGPT gỡ dấu nhận dạng khỏi nút '...'.",
    details: [
      "Sự cố 18/8: 15 lệnh xoá liên tiếp hỏng, 5 email hết hạn kẹt phải gỡ tay. Extension mở nhầm menu vai trò thay vì menu '...'.",
      "Gốc: ChatGPT gỡ hết thuộc tính nhận dạng khỏi nút '...', extension rơi xuống cách dò rộng và vớ trúng ô vai trò đứng cạnh.",
      "Nay nhận nút '...' theo hình dạng: nút mở menu mà không có chữ, lấy cái cuối dòng. Không chắc thì báo lỗi rõ chứ không đoán bừa.",
      "Sửa một chỗ, lành 7 lệnh dùng chung.",
    ],
  },
  {
    version: "0.11.5",
    date: "2026-08-13",
    kind: "fix",
    summary:
      "Xoá thành viên: bấm xong chờ hộp tắt hẳn mới đi tra, hết cảnh vừa bấm vừa gõ liên tục.",
    details: [
      "ChatGPT đổi hành vi: bấm xác nhận xong hộp không đóng ngay mà quay tới khi server trả lời.",
      "Bản cũ thấy thông báo là đi tiếp dù hộp còn mở — cú gõ tìm kiếm rơi vào lớp phủ, tra mãi không ra rồi báo lỗi dù xoá đã xong.",
      "Nay chờ hộp vắng 4 nhịp liên tiếp (tối đa 30 giây), đợi lớp phủ gỡ, rồi tra tối đa 3 lần cách nhau 3 giây.",
      "Không nới hàng rào chống xoá-giả: vẫn phải 2 vòng lọc độc lập cùng trống mới dám kết luận 'đã rời workspace'.",
    ],
  },
  {
    version: "0.11.4",
    date: "2026-08-13",
    kind: "fix",
    summary:
      "Mời xong xác minh ngay ở tab Lời mời đang chờ — thấy đủ thì bỏ hẳn vòng F5.",
    details: [
      "Hộp mời của ChatGPT phản hồi chậm, nhưng sang tab Lời mời là thấy người vừa mời ngay.",
      "Nay gửi xong sang tab đó quét luôn (tối đa 8 giây). Thấy đủ thì khỏi F5 — tiết kiệm khoảng 10 giây và 1–3 lần tải lại tab.",
      "Danh sách lời mời không bao giờ quá 1 trang nên không gõ email vào ô tìm kiếm; chỉ từ 2 trang trở lên mới gõ.",
      "Chống xác minh giả: thông báo và hộp thoại mời đều chứa chính email vừa mời, nên bộ quét loại trừ hai chỗ đó trước khi kết luận.",
    ],
  },
  {
    version: "0.11.3",
    date: "2026-08-12",
    kind: "fix",
    summary:
      "Mời thành công mà báo lỗi rồi hoàn tiền: bịt 2 lỗ hổng khiến 'không xác minh được' bị hiểu là 'mời hỏng'.",
    details: [
      "Hai ca 12/8: email vào được team thật, nhưng ví được hoàn 330.000đ và 340.000đ, kỳ đã trả bị xoá — thành ghế dùng miễn phí.",
      "Lỗ hổng 1: cơ chế 'F5 soi lại rồi mới kết luận' chỉ nhận 2 kiểu lỗi hạ tầng, bỏ sót đúng loại hay xảy ra nhất, nên chưa đi tìm bằng chứng đã kết luận hỏng.",
      "Lỗ hổng 2: kết quả vòng sau ghi đè vòng đầu, cuốn mất bằng chứng 'đã bấm Gửi' — nhánh chặn mất tiền chưa từng chạy được lần nào.",
      "Nay phân biệt rõ VÔ ĐỊNH và HỎNG: đã bấm Gửi rồi mất dấu thì F5 phân xử, chỉ báo hỏng khi quét cả hai tab đều trắng tay. Chưa bấm Gửi thì hoàn phí ngay như cũ.",
      "Backend thêm hàng rào cuối: lệnh hỏng mà extension báo đã bấm Gửi thì HOÃN phán xử 20 phút — không hoàn phí, không xoá bản ghi. Hoãn chỉ làm tiền về ví muộn, không bao giờ làm mất tiền.",
    ],
  },
  {
    version: "0.11.2",
    date: "2026-08-12",
    kind: "fix",
    summary:
      "Hết XOÁ-GIẢ: không kết luận 'email đã rời workspace' chỉ vì ô lọc chưa kịp trả kết quả.",
    details: [
      "Ca 3–12/8: 4 email bị đánh dấu đã xoá nhưng vẫn nằm trên ChatGPT và vẫn ăn ghế. Một email bị báo 'không có' lúc 08:01 rồi chính extension xoá được lúc 08:07.",
      "Gốc: đo 'ô lọc đã chạy' bằng đúng một dấu hiệu là số dòng đổi, rồi chờ 1,2 giây là chốt. Mà lúc đó danh sách vẫn đang đổ dòng, còn ô lọc thì nháy trống trước khi ra kết quả.",
      "Nay phải đủ 4 điều mới dám nói 'không có': danh sách đứng yên trước khi gõ, soi thêm 6 giây bắt dòng về trễ, xoá ô lọc thấy danh sách đầy lại, và 2 vòng lọc độc lập cùng trống.",
      "Đánh đổi: mỗi lệnh xoá tốn thêm 10–20 giây và số ca phải chạy lại sẽ tăng. Thà chậm còn hơn báo đã-xoá giả.",
    ],
  },
  {
    version: "0.11.1",
    date: "2026-08-04",
    kind: "fix",
    summary:
      "Mời xong không kết luận hỏng vội: tin thông báo 'đã gửi lời mời' của ChatGPT hơn danh sách chờ.",
    details: [
      "Trước quét 10 giây không thấy email là báo hỏng, backend hoàn phí và xoá bản ghi — trong khi lời mời có thể đã gửi thật, người nhận vẫn vào được team.",
      "Nay có thông báo xác nhận mà danh sách chưa hiện thì vẫn báo xong, để email ở diện chưa xác minh và phân xử sau bằng bằng chứng.",
      "Không có xác nhận nào mà quét sạch vẫn trắng tay thì mới báo hỏng. Ngân sách kiểm tra nới 10 lên 30 giây.",
    ],
  },
  {
    version: "0.11.0",
    date: "2026-08-04",
    kind: "feature",
    summary:
      "2 lệnh mới: Xuất dữ liệu / Xoá dữ liệu một thành viên. Quyền riêng, mặc định TẮT.",
    details: [
      "ChatGPT vừa thêm hai mục này vào menu '...'. Nút trên dashboard luôn hiện nhưng làm mờ khi chưa được cấp quyền.",
      "Quyền không bật sẵn cho tài khoản mới lẫn tài khoản đang có — chỉ admin cấp mới dùng được.",
      "Không thấy hộp thoại lẫn thông báo thì báo hỏng: đây là thao tác không hoàn tác được, không báo thành công giả.",
    ],
  },
  {
    version: "0.10.2",
    date: "2026-08-04",
    kind: "fix",
    summary:
      "Chặn cứng để lệnh xoá thành viên không bao giờ bấm nhầm 'Xoá dữ liệu'.",
    details: [
      "ChatGPT thêm 'Xuất dữ liệu' và 'Xoá dữ liệu' vào menu '...'. Xoá dữ liệu là thao tác không hoàn tác được.",
      "Rủi ro: danh sách nhãn dự phòng của lệnh xoá có chữ lỏng 'Xoá'/'Delete'. Hôm nay nhãn đúng vẫn khớp trước, nhưng ChatGPT đổi chữ một lần nữa là rơi trúng 'Xoá dữ liệu'.",
      "Nay hai mục dữ liệu bị loại ở mọi vòng chọn, và có chốt cuối: tiêu đề hộp vừa mở mà là 'Xoá dữ liệu' thì thoát ngay, không bấm xác nhận.",
    ],
  },
  {
    version: "0.10.1",
    date: "2026-08-01",
    kind: "fix",
    summary:
      "Mời thành công mà mất kết nối giữa chừng thì F5 soi lại rồi mới phân xử, không báo hỏng oan.",
    details: [
      "Ca 1/8: kênh liên lạc chết sau khi đã bấm Gửi → báo hỏng → backend hoàn phí và xoá bản ghi, trong khi người được mời vẫn nhận được lời mời.",
      "Nay lỗi kiểu vô định thì chạy vòng kiểm tra: thấy email ở tab Lời mời hoặc Người dùng ⇒ báo xong thật; không thấy thì giữ nguyên báo hỏng.",
      "Lệnh đồng bộ trả về đích danh email được thêm/gỡ để dashboard hiện rõ thay đổi.",
    ],
  },
  {
    version: "0.10.0",
    date: "2026-07-27",
    kind: "feature",
    summary:
      "Tab admin để không thì tự đóng sau 10–60 phút ngẫu nhiên.",
    details: [
      "Yêu cầu user 27/7: tab để lâu không dùng thì tự đóng, thời gian ngẫu nhiên cho giống thao tác người thật.",
      "'Không dùng' = extension không chạy lệnh và bạn cũng không mở xem tab đó.",
      "Đang chạy lệnh thì không đóng. Lệnh sau tự mở lại tab như cũ.",
    ],
  },
  {
    version: "0.9.31",
    date: "2026-07-26",
    kind: "fix",
    summary:
      "Đếm đúng số suất trên hoá đơn gia hạn có nhiều dòng cộng dồn giữa kỳ.",
    details: [
      "Bản cũ lấy tổng tiền chia đơn giá ra 54 suất — sai, vì tổng đã gồm phần cộng dồn giữa kỳ. Số thật là 46.",
      "Nay lấy thẳng dòng trọn tháng ('mỗi suất'): dòng đó có tiền đúng bằng số suất nhân đơn giá.",
      "Nhờ vậy giá mỗi suất, tổng suất và dự kiến kỳ sau đều đúng.",
    ],
  },
  {
    version: "0.9.30",
    date: "2026-07-25",
    kind: "fix",
    summary:
      "Mở chi tiết hoá đơn xong phải cuộn xuống đáy mới đọc được.",
    details: [
      "Dòng Tổng phụ, Số tiền đến hạn và chu kỳ nằm ở cuối; không cuộn thì chúng chưa được vẽ ra, đọc rỗng.",
      "Nay cuộn hết xuống rồi mới đọc, và nới hạn chờ từ 14 lên 20 giây cho hoá đơn nhiều dòng.",
    ],
  },
  {
    version: "0.9.29",
    date: "2026-07-25",
    kind: "fix",
    summary:
      "Bấm 'Xem chi tiết hóa đơn' đúng một lần — bản cũ bấm hai lần nên mở rồi đóng ngay.",
    details: [
      "Bản cũ bấm cả nút lẫn khung bao ngoài, hai cú vào cùng một chỗ nên panel mở xong đóng lại luôn.",
      "Nay bấm một lần vào đúng nút. Vòng sau thấy nút đổi thành 'Đóng chi tiết' thì không bấm nữa.",
    ],
  },
  {
    version: "0.9.28",
    date: "2026-07-25",
    kind: "fix",
    summary:
      "Không đọc được chi tiết hoá đơn vì lệch dấu: giao diện ghi 'hóa' mà extension chỉ tìm 'hoá'.",
    details: [
      "Hai chữ đó khác nhau ở vị trí dấu sắc nên không khớp — không tìm ra nút, panel không mở, mọi số đọc rỗng.",
      "Nay chỉ cần nhận diện phần đầu 'Xem chi tiết' / 'View details', khớp cả hai kiểu bỏ dấu, vẫn loại nút 'Đóng chi tiết'.",
    ],
  },
  {
    version: "0.9.27",
    date: "2026-07-25",
    kind: "fix",
    summary:
      "Mở tab hoá đơn hiện lên trước mặt để bấm được nút xem chi tiết.",
    details: [
      "Tab chạy nền không được trình duyệt vẽ ra nên cú bấm theo toạ độ trượt, panel không mở, đọc rỗng.",
      "Đọc xong đóng tab, trả lại tab đang xem. Bỏ luôn bước quét hoá đơn chu kỳ trước cho nhanh.",
    ],
  },
  {
    version: "0.9.26",
    date: "2026-07-25",
    kind: "fix",
    summary:
      "Trang Thanh toán không còn trống khi đọc chi tiết hoá đơn thất bại.",
    details: [
      "Hoá đơn gia hạn nhiều dòng cộng dồn đọc không ra số, dashboard bỏ hết mọi con số nên trang trắng.",
      "Nay tổng suất lấy từ tab Kế hoạch, tổng chi lấy từ danh sách hoá đơn — không cần chi tiết.",
      "Giá mỗi suất và dự kiến thì ước tính theo hoá đơn kỳ trước, có gắn nhãn 'ước tính'.",
    ],
  },
  {
    version: "0.9.25",
    date: "2026-07-25",
    kind: "fix",
    summary:
      "Chu kỳ thanh toán lấy chuẩn theo 'Chu kỳ hiện tại' ở tab Kế hoạch.",
    details: [
      "Trước suy từ hoá đơn mới nhất, nên đúng ngày gia hạn mà hoá đơn kỳ mới chưa lên là báo 'hết chu kỳ'.",
      "Nay lấy ngày kết thúc chu kỳ ở tab Kế hoạch làm chuẩn, hoá đơn chỉ dùng để tinh chỉnh.",
      "Chưa có hoá đơn kỳ mới thì ước tính theo chu kỳ trước nhân số suất hiện tại, gắn nhãn 'ước tính'.",
    ],
  },
  {
    version: "0.9.24",
    date: "2026-07-22",
    kind: "fix",
    summary:
      "Đồng bộ lời mời: tab Lời mời trống là kết quả hợp lệ, không phải lỗi.",
    details: [
      "Ca 22/7: hai lệnh đồng bộ lời mời đều hỏng với lỗi 'không tìm được dòng nào', trong khi dashboard đang có 14 người chờ tham gia.",
      "Gốc: chốt 'không có dòng nào là hỏng' vốn viết cho ca quét lỗi, nhưng tab Lời mời trống thật (ai cũng đã nhận) cũng ra 0 dòng. Trớ trêu, đó mới là ca cần đối chiếu nhất.",
      "Nay phân biệt 'trống thật' với 'không vào được tab', và vẫn gửi danh sách rỗng về để backend đối chiếu. Riêng tab Người dùng mà trống thì vẫn luôn là lỗi.",
    ],
  },
  {
    version: "0.9.23",
    date: "2026-07-22",
    kind: "fix",
    summary:
      "Xoá thành viên: gõ email vào ô lọc đúng một lần, không thấy là đã gỡ xong.",
    details: [
      "Ca 22/7: 16 lệnh hỏng thực ra chỉ là 6 email lặp lại mỗi giờ. Cả 6 đã rời ChatGPT thật nhưng vẫn kẹt 'đang hoạt động' và hết hạn.",
      "User chốt: nhập email một lần, chờ danh sách tải xong mà không thấy là chắc chắn đã xoá. Gõ 3 lần không làm kết quả đáng tin hơn, chỉ ăn hết thời gian lệnh.",
      "Mấu chốt không nằm ở số lần gõ mà ở chỗ danh sách có phản hồi hay không — nay đo bằng số dòng có đổi so với trước khi gõ.",
      "Danh sách không hề đổi thì báo lỗi và giữ member: thà chậm còn hơn xoá-giả.",
    ],
  },
  {
    version: "0.9.22",
    date: "2026-07-21",
    kind: "fix",
    summary:
      "Xoá thành viên hết báo thành công GIẢ: bấm xong phải thấy member biến mất mới báo xong.",
    details: [
      "Ca 21/7: dashboard ghi 'Xoá do hết hạn ✓ Thành công' nhưng member vẫn còn trên ChatGPT, rồi đồng bộ thấy còn nên hồi sinh, giờ sau xoá lại — vòng lặp xoá-giả vô hạn.",
      "Lỗi 1: định vị member bằng cách cuộn tìm, mà danh sách chỉ vẽ vài dòng gần đỉnh nên sót. Nay dùng ô lọc của ChatGPT.",
      "Lỗi 2: chỉ tin 'hộp xác nhận đóng' là xong. Nay bấm xong còn tra lại tới 45 giây, thấy biến mất mới báo xong.",
      "Backend bỏ hẳn suy luận 'không tìm thấy = đã xoá'. Gỡ 3 lần trong 7 ngày mà member vẫn quay lại thì cảnh báo để gỡ tay.",
    ],
  },
  {
    version: "0.9.21",
    date: "2026-07-21",
    kind: "fix",
    summary:
      "Đồng bộ 'chờ tham gia' không còn báo pending oan: ô lọc miss thì gõ lại.",
    details: [
      "Tab chạy nền bị Chrome bóp nhịp nên cú gõ thi thoảng bị nuốt, ô lọc không chạy, danh sách không ra dòng nào — báo 'không có' oan.",
      "Nay gõ lại tối đa 2 lần, cả hai đều miss mới kết luận không có.",
      "Chỉ giảm báo sai, không tạo báo sai chiều ngược lại: member vắng thật vẫn miss cả hai lần.",
    ],
  },
  {
    version: "0.9.20",
    date: "2026-07-15",
    kind: "fix",
    summary:
      "Báo lỗi rõ ràng khi phiên đăng nhập ChatGPT hỏng.",
    details: [
      "Phiên hỏng làm trang admin treo hoặc bị đẩy đi, nhưng thông báo cũ chỉ ghi 'quá thời gian chờ' nên phải tự đoán.",
      "Nay các lỗi kiểu đó đều kèm hướng dẫn: xoá cookie hoặc đăng xuất chatgpt.com rồi đăng nhập lại.",
      "Extension không tự đăng nhập giúp: nhập mật khẩu là việc của bạn, và tự bấm dễ bị ChatGPT chặn như bot.",
    ],
  },
  {
    version: "0.9.19",
    date: "2026-07-15",
    kind: "fix",
    summary:
      "Mời email ngoài tên miền: chờ ChatGPT chốt xong mới gửi, không bấm mù.",
    details: [
      "Trước chỉ tin dấu hiệu trên màn hình là toggle đã bật, mà server chưa kịp ghi nhận — gửi đi rồi báo lỗi 'không email nào xuất hiện'.",
      "Nay bật xong chờ 2 giây rồi đọc lại xác nhận vẫn bật, mới tải lại trang.",
      "Đợi ChatGPT kiểm tra email xong mới kết luận có lỗi hay không, thay vì đọc lúc nó chưa kịp hiện.",
      "Chỉ bấm khi nút 'Gửi lời mời' thật sự bấm được; còn khoá thì huỷ rõ ràng chứ không bấm nút chết. Email ngoài miền chậm thêm 2–3 giây, email cùng miền không ảnh hưởng.",
    ],
  },
  {
    version: "0.9.18",
    date: "2026-07-15",
    kind: "fix",
    summary:
      "Đồng bộ (kiểm tra đã tham gia) làm đơn giản lại: chỉ tìm ở tab Người dùng.",
    details: [
      "User chốt 15/7: lời mời đã xác minh ngay lúc mời, nên một email chờ tham gia chỉ có hai khả năng — có ở tab Người dùng hay không. Khỏi đối chiếu tab Lời mời.",
      "Bỏ hẳn hướng quét tab Lời mời sau nhiều lần vá không dứt điểm: sót dòng khi danh sách nạp trễ, vá cuộn lại gây cuộn quá tay.",
      "Chỉ báo hỏng khi không vào được tab Người dùng.",
    ],
  },
  {
    version: "0.9.17",
    date: "2026-07-15",
    kind: "fix",
    summary:
      "Quét danh sách hết sót dòng: cuộn cả khung con chứ không chỉ cuộn cửa sổ.",
    details: [
      "Danh sách của ChatGPT có khi nằm trong khung cuộn riêng mà cuộn cửa sổ không nhích được — chỉ gom được các dòng hiện sẵn, khoảng 2/3.",
      "Nay cuộn và đo đáy trên mọi khung. Ảnh hưởng chung tới đồng bộ đầy đủ, đồng bộ hàng loạt và bước đối chiếu sau khi mời.",
    ],
  },
  {
    version: "0.9.16",
    date: "2026-07-14",
    kind: "fix",
    summary:
      "Đồng bộ hàng loạt hết báo sai 'không thấy' cho email vẫn đang chờ.",
    details: [
      "Ca 14/7: tab Lời mời có 3 email nhưng chỉ quét được 2, email sót bị báo không thấy thay vì vẫn chờ tham gia.",
      "Gốc: đường quét tab Lời mời không có mốc tổng số nên chốt vào con số tạm thời khi ChatGPT vẽ dòng cuối hơi trễ.",
      "Nay mọi email kết luận 'không thấy' đều được tra lại đúng một lần ở tab Lời mời trước khi chốt.",
    ],
  },
  {
    version: "0.9.15",
    date: "2026-07-13",
    kind: "fix",
    summary:
      "Đồng bộ lời mời hết xoá oan email vừa tham gia.",
    details: [
      "Người nhận bấm nhận nhanh thì email rời tab Lời mời sang tab Người dùng. Bản cũ chỉ quét tab Lời mời nên coi họ là lời mời ma rồi đánh dấu đã gỡ.",
      "Nay quét xong còn thiếu email nào thì mở tab Người dùng tra nốt.",
      "Thấy ở đó thì chuyển thành đã tham gia, không đưa vào diện chưa xác minh nữa.",
    ],
  },
  {
    version: "0.9.14",
    date: "2026-07-13",
    kind: "fix",
    summary:
      "Thu hồi lời mời không thu được thì báo lỗi, không báo xong giả.",
    details: [
      "Ca 13/7: dashboard ghi 'đã thu hồi' nhưng ChatGPT vẫn còn lời mời — extension báo xong dù kết quả ghi rõ thu hồi hỏng.",
      "Nay thu hồi được 0 email mà có email hỏng thì báo lỗi kèm lý do từng email.",
      "Backend chỉ đánh dấu đã gỡ những email thật sự thành công, phần còn lại giữ nguyên và ghi nhật ký.",
      "Tối ưu: tab chỉ có 1 trang thì quét thẳng vị trí, khỏi dùng ô tìm kiếm. Phải tìm thì gõ email đầy đủ đúng một lần.",
    ],
  },
  {
    version: "0.9.13",
    date: "2026-07-12",
    kind: "fix",
    summary:
      "Xoá thành viên hết báo lỗi oan khi xoá đã thật sự thành công.",
    details: [
      "Sau khi xoá, chính ChatGPT còn trả về member vừa xoá trong vài chục giây — đọc lại danh sách không bao giờ phân biệt được 'xoá hỏng' với 'danh sách trễ'.",
      "Nay tín hiệu xác nhận là hộp xác nhận đã đóng, giống cách làm của lệnh mời.",
      "Hộp vẫn mở sau 15 giây mới báo lỗi, kèm nội dung hộp để tra.",
    ],
  },
  {
    version: "0.9.12",
    date: "2026-07-12",
    kind: "fix",
    summary:
      "Hoá đơn gia hạn có nhiều dòng: lấy đúng chu kỳ dịch vụ, không lấy nhầm dòng cộng dồn đầu tiên.",
    details: [
      "Ca GPT1 12/7: hoá đơn ghi ngày kết thúc chu kỳ là 11/7 thay vì 11/8, dashboard tưởng chu kỳ đã hết nên mọi số về '—'.",
      "Gốc: bản cũ lấy khoảng ngày ĐẦU TIÊN gặp, mà dòng cộng dồn (10/7–11/7) nằm trước dòng dịch vụ chính (11/7–11/8).",
      "Nay gom mọi khoảng ngày rồi chọn khoảng có ngày kết thúc muộn nhất — đó mới là ngày gia hạn thật.",
    ],
  },
  {
    version: "0.9.11",
    date: "2026-07-12",
    kind: "fix",
    summary:
      "Chu kỳ 31 ngày: hoá đơn gốc đầu kỳ không còn bị bỏ sót.",
    details: [
      "Bản cũ tính đầu chu kỳ bằng cách trừ 30 ngày cứng, nên với tháng 31 ngày thì hoá đơn ngày đầu rơi ra ngoài cửa sổ.",
      "Hậu quả: có hoá đơn mua thêm suất giữa kỳ là hoá đơn gốc bị loại, thiếu luôn đơn giá và tổng suất.",
      "Nay lùi đúng một tháng lịch, khớp với cách dashboard tính.",
    ],
  },
  {
    version: "0.9.10",
    date: "2026-07-10",
    kind: "fix",
    summary:
      "Đồng bộ một tài khoản không còn báo nhầm 'chờ tham gia' cho người đã tham gia.",
    details: [
      "Ca 10/7: một member nằm ở tab Người dùng nhưng bị báo 'chờ tham gia' ba lần liên tiếp.",
      "Gốc: vừa đổi tab đã quét ngay, dòng của tab trước chưa kịp biến mất nên khớp trúng dòng cũ.",
      "Nay chờ danh sách ổn định rồi mới đọc. Một trang thì quét thẳng, nhiều trang mới dùng ô tìm kiếm — áp cho cả hai tab.",
    ],
  },
  {
    version: "0.9.9",
    date: "2026-07-07",
    kind: "fix",
    summary:
      "Đọc được hoá đơn điều chỉnh suất giữa kỳ (nhiều dòng cộng/trừ, không có dòng đơn giá).",
    details: [
      "Loại hoá đơn này không có dòng 'Mỗi X đ' nên bản cũ đọc hỏng, tổng suất bị thiếu.",
      "Nay lấy số suất từ dòng 'thời gian còn lại của N suất' lớn nhất; thiếu đơn giá vẫn coi là đọc được.",
      "Tổng suất chu kỳ = số suất của hoá đơn mới nhất, không cộng dồn.",
    ],
  },
  {
    version: "0.9.8",
    date: "2026-07-06",
    kind: "fix",
    summary:
      "Bấm 'Xem chi tiết hoá đơn' đáng tin hơn với hoá đơn mua thêm suất.",
    details: [
      "Ca GPT1: chu kỳ có 3 hoá đơn nhưng chỉ hoá đơn gốc mở được, tổng suất chỉ ra 2.",
      "Nay bấm bằng chuỗi sự kiện chuột thật và chờ tới 14 giây; panel đã mở thì không bấm nữa kẻo đóng lại.",
      "Thông báo lỗi nói rõ là không thấy nút hay bấm rồi mà panel không ra số liệu.",
    ],
  },
  {
    version: "0.9.7",
    date: "2026-07-06",
    kind: "fix",
    summary:
      "Đọc được số suất dạng '164/148 người dùng đang sử dụng'.",
    details: [
      "Bản cũ chỉ nhận các chữ 'giấy phép'/'seats'/'licenses' nên workspace hiển thị 'người dùng' bị báo không đọc được gì.",
      "Nay nhận thêm dạng 'người dùng'/'thành viên'/'users' và cho phép số tới 4 chữ số.",
    ],
  },
  {
    version: "0.9.6",
    date: "2026-07-06",
    kind: "feature",
    summary:
      "Đọc chính xác số suất, đơn giá và chu kỳ từ chi tiết hoá đơn — không còn đoán.",
    details: [
      "Xác định chu kỳ từ hoá đơn mới nhất rồi chỉ mở các hoá đơn nằm trong chu kỳ đó.",
      "Tự bấm 'Xem chi tiết hoá đơn' rồi đọc Số lượng, Mỗi, Tổng phụ, VAT, Số tiền đến hạn và khoảng chu kỳ.",
      "Chống lỗi số bị nối liền nhau và nhãn nhập nhằng khi đọc.",
      "Dashboard bỏ hẳn phần đoán số suất; giá mỗi suất hiển thị đã gồm VAT.",
    ],
  },
  {
    version: "0.9.5",
    date: "2026-07-06",
    kind: "fix",
    summary:
      "Đồng bộ hàng loạt gom cả danh sách vào một lệnh, khỏi quét lại tab Lời mời cho từng email.",
    details: [
      "Trước mỗi email là một lệnh riêng, mỗi lệnh lại tải trang và cuộn hết tab Lời mời chỉ để tìm một email.",
      "Nay quét tab Lời mời đúng một lần rồi đối chiếu cả danh sách; email nào không có mới sang tab Người dùng tra.",
      "Email kết luận 'không thấy' chỉ để báo, backend không đánh dấu đã gỡ — quét sót một lần cũng không xoá oan ai.",
    ],
  },
  {
    version: "0.9.4",
    date: "2026-07-03",
    kind: "fix",
    summary:
      "Đồng bộ lần đầu chỉ ra 2 thành viên — đã sửa.",
    details: [
      "Gốc: lúc danh sách mới vẽ vài dòng thì khung cuộn riêng chưa lộ ra, extension chỉ cuộn cửa sổ nên không tải thêm dòng nào. Lần thứ hai trang đã 'nóng' nên đủ.",
      "Nay dò lại khung cuộn mỗi vòng và cuộn kiên nhẫn cho tới khi đủ số ChatGPT ghi ở đầu trang.",
      "Backend thêm lớp bảo vệ: quét được ít hơn 90% số ChatGPT báo thì BỎ QUA bước đánh dấu đã gỡ. Member quét được vẫn ghi nhận, chỉ hoãn bước xoá tới lần đồng bộ đủ.",
    ],
  },
  {
    version: "0.9.3",
    date: "2026-06-29",
    kind: "fix",
    summary:
      "Nhập email khi mời nhanh hơn khoảng 20 lần trong tab chạy nền.",
    details: [
      "Ca 29/6: bước gõ email tốn 26–37 giây cho một email 20 ký tự.",
      "Gốc: tab chạy nền bị Chrome ép mọi nhịp chờ về tối thiểu 1 giây, mà bản cũ gõ từng ký tự một — thành 1 giây mỗi ký tự.",
      "Nay điền cả email một lần như thao tác dán. Mọi ô nhập đều nhanh lên: mời email, ô lọc theo tên, ô số giới hạn.",
    ],
  },
  {
    version: "0.9.2",
    date: "2026-06-29",
    kind: "fix",
    summary:
      "Xoá thành viên hết báo lỗi oan khi mạng chậm.",
    details: [
      "ChatGPT xoá xong còn phải tải lại danh sách; mạng chậm quá 10 giây là bản cũ kết luận 'member vẫn còn' dù đã xoá xong.",
      "Nay nới hạn chờ lên 15 giây, và nếu vẫn nghi ngờ thì ép lọc lại từ server để xác nhận dứt khoát.",
      "Chỉ báo lỗi khi server VẪN trả về member đó.",
    ],
  },
  {
    version: "0.9.1",
    date: "2026-06-29",
    kind: "fix",
    summary:
      "Xoá thành viên hết tìm nhầm ở tab Lời mời rồi đánh dấu đã gỡ oan.",
    details: [
      "Ca 29/6: một member đang hoạt động bị ghi 'coi như đã rời business' vì lệnh chạy trên tab Lời mời do lệnh trước để lại.",
      "Chốt cũ chỉ kiểm tra đường dẫn có chứa '/admin/members', mà '...?tab=invites' vẫn chứa chuỗi đó nên không ăn.",
      "Nay ép tab về trang Thành viên sạch trước khi chạy, và lệnh xoá từ chối kết luận 'đã rời' khi đường dẫn còn ?tab=invites.",
    ],
  },
  {
    version: "0.9.0",
    date: "2026-06-23",
    kind: "feature",
    summary:
      "Lệnh mới: Đặt giới hạn tín dụng mỗi tháng cho thành viên.",
    details: [
      "Dashboard có thêm hành động 'Đặt giới hạn tín dụng' trong hộp Cập nhật hàng loạt — đặt mức chung cho tất cả, hoặc mức riêng từng người theo cú pháp email=số.",
      "Extension lọc theo email, bấm Thêm/Chỉnh sửa trên dòng đó, gõ số rồi Lưu.",
      "Tuyệt đối tránh nút 'Gỡ bỏ': lệnh này chỉ đặt số, không bao giờ gỡ.",
    ],
  },
  {
    version: "0.8.21",
    date: "2026-06-23",
    kind: "fix",
    summary:
      "Chạy loạt lệnh giống nhau không còn mở tab mới liên tục.",
    details: [
      "Ca xoá 30+ thành viên: mỗi lệnh mở một tab rồi đóng tab cũ, spam mở/đóng suốt.",
      "Nay còn tab admin nào thì tái dùng tab mới nhất và F5, chỉ mở tab mới khi không còn tab nào.",
      "Quá 3 tab thì vẫn tự đóng bớt cho còn 3.",
    ],
  },
  {
    version: "0.8.20",
    date: "2026-06-22",
    kind: "fix",
    summary:
      "Không tự đóng tab khi bạn đang mở nhiều tab admin.",
    details: [
      "Yêu cầu user 22/6: đang mở nhiều hơn 2 tab thì đừng đóng, chỉ tái dùng tab mới nhất và F5 trước khi dùng.",
      "Chỉ từ 4 tab trở lên mới đóng bớt tab cũ nhất cho còn 3.",
      "Chỉ đếm tab trang admin; tab chat thường không tính.",
    ],
  },
  {
    version: "0.8.19",
    date: "2026-06-21",
    kind: "chore",
    summary:
      "Bỏ thông báo nổi trên trang ChatGPT — kết quả lệnh chỉ hiện ở dashboard.",
    details: [
      "User chốt 21/6: chỉ cần báo ở dashboard cho người chạy lệnh biết.",
      "Lệnh xoá: ô lọc là nguồn sự thật. Không thấy email thì dừng, không lật trang nữa, và báo backend coi như đã rời workspace.",
      "Lỗi menu hay nút xác nhận vẫn là lỗi thật (member vẫn còn), không bị đánh dấu đã gỡ.",
    ],
  },
  {
    version: "0.8.18",
    date: "2026-06-20",
    kind: "fix",
    summary:
      "Rà soát mọi lệnh: chờ ô lọc và thanh tab vẽ xong rồi mới thao tác.",
    details: [
      "Từ bản 0.8.13 mỗi lệnh mở tab mới nên chạy ngay lúc trang vừa tải, tra một lần là trượt.",
      "Nay ô lọc 'Lọc theo tên' được chờ tới 8 giây, ảnh hưởng mọi lệnh định vị member.",
      "Bước xác minh lời mời cũng chờ thanh tab vẽ xong và kiểm tra đường dẫn đã sang tab Lời mời.",
    ],
  },
  {
    version: "0.8.17",
    date: "2026-06-20",
    kind: "feature",
    summary:
      "Mỗi lệnh chạy xong hiện thông báo nổi giữa đầu trang ChatGPT.",
    details: [
      "Xanh khi xong (tự ẩn sau 2 giây), đỏ kèm nội dung lỗi khi hỏng.",
      "Trước đây lệnh chạy âm thầm, không có phản hồi nào trên trang.",
    ],
  },
  {
    version: "0.8.16",
    date: "2026-06-20",
    kind: "fix",
    summary:
      "Đồng bộ một tài khoản hết lỗi 'không chuyển được sang tab Người dùng'.",
    details: [
      "Thực chất là kẹt ở tab Người dùng, không sang được tab Lời mời — cùng lớp lỗi đã sửa cho lệnh thu hồi.",
      "Gốc: tìm nút tab đúng một lần ngay lúc trang vừa tải, trước khi thanh tab kịp vẽ ra.",
      "Nay gom việc chờ vào chung một chỗ: lệnh nào chạm tab khác mặc định chỉ cần bật cờ chờ 12 giây, không phải tự nhớ nữa.",
    ],
  },
  {
    version: "0.8.15",
    date: "2026-06-19",
    kind: "fix",
    summary:
      "Thu hồi lời mời hết lỗi 'không tìm thấy tab Lời mời đang chờ xử lý'.",
    details: [
      "Từ bản 0.8.13 mỗi lệnh mở tab mới nên nhánh chờ cũ bị bỏ qua, extension tìm nút tab trước khi trang kịp vẽ.",
      "Nay chờ nút tab hiện ra tới 12 giây rồi mới bấm, và kiểm tra đường dẫn đã thật sự sang tab Lời mời.",
    ],
  },
  {
    version: "0.8.14",
    date: "2026-06-19",
    kind: "fix",
    summary:
      "Mời email ngoài tên miền: tải lại trang cho ChatGPT nhận setting mới rồi mới mở hộp mời.",
    details: [
      "Bật toggle xong chuyển trang theo kiểu không tải lại thì ChatGPT vẫn giữ cấu hình cũ, hộp mời cảnh báo đỏ và khoá nút Gửi — băng-rôn đó không bao giờ tự mất.",
      "Nay tách làm hai lượt: bật toggle xong trả về, background tải lại trang, rồi gọi lại lệnh mời trên trang sạch.",
      "Content tự tải lại sẽ tự cắt kênh của chính nó, nên việc tải lại bắt buộc do background làm.",
      "Email trong tên miền đã xác minh không đổi gì: mời thẳng, không bật toggle, không tải lại.",
    ],
  },
  {
    version: "0.8.13",
    date: "2026-06-19",
    kind: "fix",
    summary:
      "Mỗi lệnh mở tab admin MỚI thay vì tái dùng tab cũ.",
    details: [
      "Ca 19/6: hàng loạt lệnh mời hỏng vì quá thời gian chờ hoặc không xác minh được.",
      "Gốc: tab cũ sống lâu hay bị ChatGPT tải lại, bị đẩy đi hoặc bị lệnh khác kéo sang trang con — extension mất kết nối giữa chừng.",
      "Giữ tối đa 2 tab admin: mở tab mới thì đóng bớt tab cũ.",
    ],
  },
  {
    version: "0.8.12",
    date: "2026-06-19",
    kind: "fix",
    summary:
      "Mời email ngoài tên miền: chờ băng-rôn cảnh báo biến mất rồi mới gửi.",
    details: [
      "Bật toggle xong cần chút thời gian mới có hiệu lực sang hộp mời; trong lúc đó hộp còn cảnh báo đỏ và khoá nút Gửi.",
      "Bấm lúc đó là bấm vào nút chết, dẫn tới báo lỗi hoặc tạo lời mời ma.",
      "Nay chờ băng-rôn mất tối đa 8 giây; hết giờ vẫn còn thì huỷ rõ ràng, không gửi.",
    ],
  },
  {
    version: "0.8.11",
    date: "2026-06-19",
    kind: "fix",
    summary:
      "Đổi loại suất / đổi vai trò / xoá thành viên: ép tab về trang Thành viên trước khi tìm.",
    details: [
      "Ca 19/6: lệnh báo 'không tìm thấy email sau khi lọc và lật mọi trang' dù member đang hoạt động.",
      "Gốc: tab được tái dùng có thể đang ở trang Thanh toán, mà ba tab con Người dùng/Lời mời/Yêu cầu chỉ có trên trang Thành viên.",
      "Nay đường dẫn không có '/admin/members' thì chuyển về trước, chờ danh sách vẽ xong rồi mới chạy.",
    ],
  },
  {
    version: "0.8.10",
    date: "2026-06-19",
    kind: "fix",
    summary:
      "Bật toggle 'Cho phép lời mời ngoài tên miền' đáng tin hơn.",
    details: [
      "Ca 19/6: có lúc toggle vẫn tắt mà extension vẫn đi mời email ngoài.",
      "Toggle luôn hiện TẮT sau khi mời là cố ý — extension bật tích tắc lúc mời rồi tắt lại ngay theo quy định bảo mật.",
      "Gốc: bấm một lần, ngủ 800ms cố định rồi đọc trạng thái đúng một lần; mạng chậm là đọc trúng trạng thái cũ.",
      "Nay chờ tới khi trạng thái thật sự đổi (tối đa 4 giây), bấm lại tối đa 2 lần, và không đọc được thì báo không đọc được chứ không đoán.",
    ],
  },
  {
    version: "0.8.9",
    date: "2026-06-19",
    kind: "feature",
    summary:
      "Tái dùng tab admin mới nhất, chỉ mở tab mới khi lệnh không chạy được trên tab cũ.",
    details: [
      "Yêu cầu user 19/6: chỉ mở tab khi các lệnh không hoạt động được trên tab cũ.",
      "Quá 5 tab admin thì tự đóng bớt tab cũ, giữ 5 tab mới nhất.",
      "Việc 'mở tab mới khi lệnh hỏng' đã có sẵn: không nạp được vào tab cũ thì đóng tab hỏng và mở tab hoàn toàn mới.",
    ],
  },
  {
    version: "0.8.8",
    date: "2026-06-18",
    kind: "fix",
    summary:
      "Thu hồi lời mời tìm email bằng ô 'Search for invites' thay vì cuộn danh sách.",
    details: [
      "Ca 17/6: mời xong 27 giây sau thu hồi thì báo 'không có trên tab Lời mời', rồi tìm nhầm sang tab Người dùng và cũng hỏng.",
      "Gốc: cuộn tìm trên danh sách chỉ vẽ phần đang nhìn thấy nên sót dòng.",
      "Nay gõ email vào ô tìm kiếm cho danh sách rút còn 0–1 dòng. Chỉ khi giao diện không có ô đó mới quay về cuộn tìm.",
    ],
  },
  {
    version: "0.8.7",
    date: "2026-06-18",
    kind: "fix",
    summary:
      "Tab Lời mời có ô tìm kiếm riêng — nhận đúng ô đó.",
    details: [
      "Bản trước dùng ô 'Lọc theo tên' của tab Người dùng nên trượt hết, lại rơi về quét cả trang và lật trang.",
      "Nay nhận thêm ô 'Search for invites' (kèm bản tiếng Việt và tiếng Trung), thử ô này trước rồi mới tới ô kia.",
    ],
  },
  {
    version: "0.8.6",
    date: "2026-06-18",
    kind: "fix",
    summary:
      "Xác minh sau khi mời nhanh hơn nhiều: gõ thẳng email vào ô tìm kiếm.",
    details: [
      "Trước quét toàn bộ danh sách lời mời, cuộn hết và lật hết trang chỉ để xác nhận vài email.",
      "Nay gõ từng email cho danh sách rút còn 0–1 dòng rồi đọc ngay, không đọc email khác, không chuyển trang.",
      "Không vào được tab hoặc không thấy ô lọc thì vẫn quay về cách quét đầy đủ như cũ.",
    ],
  },
  {
    version: "0.8.5",
    date: "2026-06-18",
    kind: "fix",
    summary:
      "Mở hộp mời nhanh hơn và biết rõ bước nào chậm.",
    details: [
      "Ca 18/6: bước mở hộp mời tốn khoảng 11 giây.",
      "Bỏ cú bấm tab 'Người dùng' thừa khi nút Mời đã hiện sẵn — bấm thừa làm ChatGPT tải lại cả danh sách.",
      "Thay nhịp ngủ 800ms cố định bằng chờ hộp hiện ra, mở sớm thì đi tiếp ngay.",
      "Tách riêng mốc 'chờ hộp vẽ xong' để dashboard chỉ rõ chậm ở khâu tìm nút hay khâu ChatGPT vẽ.",
    ],
  },
  {
    version: "0.8.4",
    date: "2026-06-18",
    kind: "fix",
    summary:
      "Mọi lệnh đều có hạn giờ, không còn kẹt 'đang chạy' tới khi backend tự dọn.",
    details: [
      "Ca 18/6: mời một email ngoài tên miền kẹt 343 giây rồi mới bị dọn.",
      "Gốc: lượt gọi đầu tiên tới content không có hạn giờ. Tab bị tải lại giữa chừng là kênh chết, background chờ vô hạn.",
      "Nay mỗi loại lệnh có hạn riêng, đều nhỏ hơn ngưỡng treo của backend nên extension tự báo lỗi trước và giải phóng cho lệnh sau.",
      "Không dọn lời mời ma khi hết giờ: không chắc đã gửi hay chưa, để backend hoặc lần đồng bộ sau tự đối chiếu.",
    ],
  },
  {
    version: "0.8.3",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "Đổi loại suất: đã đúng loại rồi thì bỏ qua, không thao tác nữa.",
    details: [
      "Định vị được dòng thì đọc loại suất thật đang hiển thị; đã đúng thì xong luôn, không mở menu, không hiện hộp xác nhận thừa.",
      "Đáng tin hơn cách cũ dựa vào dữ liệu trong hệ thống, vốn có thể đã cũ.",
    ],
  },
  {
    version: "0.8.2",
    date: "2026-06-17",
    kind: "feature",
    summary:
      "Đồng bộ một tài khoản lẻ: nút 'Đồng bộ' ngay trên dòng người đang chờ.",
    details: [
      "Tìm email ở tab Lời mời, không thấy thì tìm ở tab Người dùng. Thấy ở đó nghĩa là đã tham gia, chuyển sang 'đang hoạt động'.",
      "Không thấy ở cả hai tab thì báo email không có trong workspace, và backend không đánh dấu đã gỡ — tránh xoá oan.",
      "Chỉ đọc, không thao tác gì phá huỷ. Có giới hạn chống bấm dồn.",
    ],
  },
  {
    version: "0.8.1",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "Đồng bộ workspace nhiều thành viên không còn đánh dấu đã gỡ oan.",
    details: [
      "Gốc: danh sách bị chia thành từng mẻ 200 người, mà backend đối chiếu theo từng mẻ — ai không nằm trong mẻ đó đều bị coi là đã rời.",
      "Workspace dưới 200 người chỉ có một mẻ nên đúng; lỗi chỉ lộ ra từ khi extension lật hết trang.",
      "Nay gửi từng mẻ mà KHÔNG đối chiếu, rồi một lượt cuối gửi toàn bộ email đã quét để đối chiếu đúng một lần. Quét được 0 người thì bỏ qua bước đối chiếu.",
    ],
  },
  {
    version: "0.7.16",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "Xoá thành viên: tìm mục menu và nút xác nhận bền hơn, lỗi thì in ra thứ đang thấy.",
    details: [
      "Lệnh xoá vẫn hỏng 'menu mở nhưng không có mục Remove' dù bản trước đã thêm đúng nhãn tiếng Việt.",
      "Gốc: chỉ dò đúng một kiểu mục menu, mà ChatGPT có thể vẽ mục xoá bằng kiểu khác. Nay quét rộng mọi kiểu mục trong menu.",
      "Nút xác nhận quét cả trong hộp thoại, và khớp chính xác để không dính nút 'Hủy bỏ'.",
      "Hỏng thì thông báo in luôn các mục và nút thật đang thấy — hết đoán mò.",
      "Sửa luôn lý do các bản vá trước bị test nhầm code cũ: extension không tự nhận ra đã có bản build mới nên không bao giờ tự nạp lại.",
    ],
  },
  {
    version: "0.7.15",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "Giảm thời gian chờ F5 khi xác minh lời mời xuống còn khoảng 10 giây.",
    details: [
      "Trước ngủ cố định 2,5 giây rồi thử lại theo nhịp 0/3/6 giây — tổng tới 11,5 giây kể cả khi email đã hiện sẵn.",
      "Nay thấy đủ email là trả về ngay, chưa thấy thì F5 thật luôn, lặp trong ngân sách 10 giây, tối đa 3 vòng.",
    ],
  },
  {
    version: "0.7.14",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "Xoá thành viên: thêm nhãn tiếng Việt thật là 'Loại bỏ thành viên'.",
    details: [
      "Danh sách nhãn cũ chỉ có 'Remove'/'Xoá', không có chuỗi này nên không mục nào khớp.",
      "Hộp xác nhận có tiêu đề 'Loại bỏ thành viên' nhưng nút đỏ vẫn là 'Xóa', nên phần nút không cần đổi.",
    ],
  },
  {
    version: "0.7.13",
    date: "2026-06-17",
    kind: "feature",
    summary:
      "Thu hồi lời mời tự chuyển sang xoá khi người đó đã nhận lời mời.",
    details: [
      "Email đã nhận lời mời thì rời tab Lời mời sang tab Người dùng, bản cũ tìm không thấy là báo hỏng.",
      "Nay tự sang tab Người dùng tìm và xoá họ khỏi workspace.",
    ],
  },
  {
    version: "0.7.12",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "Lệnh mời không còn kẹt 5 phút: thêm hạn giờ 60 giây cho vòng xác minh.",
    details: [
      "Ca thật: mời bình thường 28–44 giây, nhưng 3 lệnh gần nhất kẹt 339–396 giây.",
      "Gốc: vòng xác minh không có hạn giờ, quét chậm hoặc treo là background chờ tới khi backend tự dọn.",
      "Nay quá 60 giây thì coi như quét hỏng, giữ nguyên trạng thái chờ để lần đồng bộ sau đối chiếu, lệnh kết thúc ngay.",
      "Backend cũng đổi ngưỡng treo theo từng loại lệnh thay vì 5 phút cứng cho tất cả.",
    ],
  },
  {
    version: "0.7.11",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "Đọc được ngày gia hạn dạng ngày đơn, ví dụ 'gia hạn vào 11 thg 7, 2026'.",
    details: [
      "Bản cũ chỉ bắt dạng khoảng '11 thg 5 - 11 thg 6', nên một số workspace không có ngày gia hạn, dashboard hiện '—' dù đồng bộ vẫn xong.",
      "Nay bắt thêm dạng ngày đơn theo từ khoá gia hạn (Việt/Anh/Trung), vẫn ưu tiên dạng khoảng trước.",
    ],
  },
  {
    version: "0.7.10",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "Có bản build mới là tự nạp lại ngay, kể cả lúc rảnh.",
    details: [
      "Trước chỉ tự nạp lại khi đang có lệnh chờ, nên build mới lúc rảnh không được áp — lệnh đầu tiên tới có thể bị bản cũ nhận rồi chết giữa chừng.",
      "Nay hễ phát hiện build mới là nạp lại ngay. Chống lặp vô hạn giữ nguyên: mỗi build chỉ nạp lại một lần.",
    ],
  },
  {
    version: "0.7.9",
    date: "2026-06-16",
    kind: "chore",
    summary:
      "Giảm 30% thời gian chờ giữa hai lệnh: 1200ms xuống 840ms.",
    details: [
      "Đây là khoảng nghỉ tối thiểu giữa hai lệnh bất kỳ, để ChatGPT không nghi là bot.",
      "Nhịp nghỉ dài mỗi 10 lệnh giữ nguyên.",
    ],
  },
  {
    version: "0.7.8",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "Phát hiện build cũ ngay trước khi nạp, khỏi phí 23 giây cho ba bước chắc chắn hỏng.",
    details: [
      "Sau khi build lại, extension đang chạy vẫn trỏ vào file đã bị xoá — cả ba bước dự phòng đều hỏng, tốn 23 giây rồi bỏ cuộc và còn phá tab đang mở.",
      "Nay nhận ra build cũ thì bỏ qua ba bước đó, báo lỗi rõ ràng rồi tự nạp lại extension.",
      "Cho phép nạp lại 2 lần cho mỗi build thay vì 1 — Chrome đôi khi chậm áp bản mới, chặn cứng sau một lần là kẹt vĩnh viễn.",
    ],
  },
  {
    version: "0.7.7",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "Định vị member: thử lọc bằng cả email đầy đủ, và ghi nhật ký để tra khi 'không tìm thấy'.",
    details: [
      "Trước chỉ gõ phần trước @ vào ô lọc. Nay gõ phần trước @ rồi gõ tiếp email đầy đủ, giống người dùng gõ tay.",
      "Nhật ký ghi rõ: có thấy ô lọc không, còn bao nhiêu dòng sau mỗi lần lọc, có vào nhánh lật trang không và thấy ở trang mấy.",
      "Dashboard hiện tiến trình lệnh ngay trên trang Thành viên.",
    ],
  },
  {
    version: "0.7.5",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "Chỉ tự nạp lại extension khi thật sự có bản build mới.",
    details: [
      "Ca thật: extension tự bật trang chrome://extensions rồi mở thêm tab ChatGPT, lặp đi lặp lại rất khó chịu.",
      "Gốc: chốt cũ dùng mốc thời gian 15 giây, nên build cứ cũ là cứ 15 giây lại nạp lại một lần dù không có gì đổi.",
      "Nay so theo chữ ký của bản build: khác thì nạp lại đúng một lần, giống thì thôi.",
      "Và chỉ tự nạp lại khi đang có lệnh chờ; lúc rảnh thì im lặng.",
    ],
  },
  {
    version: "0.7.4",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "Extension tự nạp lại khi phát hiện đang trỏ vào file đã bị xoá sau khi build.",
    details: [
      "Gốc rễ của các lỗi 'không nạp được vào trang': Chrome không tự nạp lại extension sau khi build, nên nó giữ bản cũ trỏ vào file không còn tồn tại.",
      "Trước phải tự bấm nạp lại ở chrome://extensions, mọi lệnh hỏng cho tới lúc đó.",
      "Nay tự phát hiện và nạp lại; lần chạy kế tiếp (dưới 5 giây, hoặc tối đa 1 phút) là lệnh chạy tiếp bình thường.",
    ],
  },
  {
    version: "0.7.3",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "Đổi loại suất: lọc theo email trước khi bấm '...', giống lệnh xoá.",
    details: [
      "Danh sách 100+ người chia nhiều trang nên dòng cần đổi thường không nằm trong phần đang nhìn thấy, tìm thẳng là trượt.",
      "Nay lọc theo email cho còn một dòng rồi mới thao tác, xong thì xoá ô lọc.",
    ],
  },
  {
    version: "0.7.2",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "Đổi loại suất: mở được menu con và bấm nút xác nhận nếu có.",
    details: [
      "Menu con của ChatGPT mở theo di chuột hoặc phím mũi tên chứ không chỉ bằng cú bấm — nay thử đủ các cách.",
      "Chọn xong mà hiện hộp xác nhận thì tự bấm nút Đổi/Xác nhận.",
      "Ghi nhật ký từng bước kèm danh sách mục menu thật đang mở, để tra khi vẫn hỏng.",
    ],
  },
  {
    version: "0.7.1",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "Đọc được loại suất cả khi nó nằm trong nút bấm kèm mũi tên.",
    details: [
      "Bản cũ chỉ nhận ô có chữ đúng y hệt 'ChatGPT'/'Codex', mà giao diện thật vẽ trong nút đổi được nên có kèm mũi tên.",
      "Nay đọc chữ trực tiếp của từng ô rồi bỏ mũi tên đi mới so, vẫn không nhầm với email hay tên.",
      "Cần đồng bộ lại workspace sau khi nạp bản này để điền loại suất.",
    ],
  },
  {
    version: "0.7.0",
    date: "2026-06-15",
    kind: "feature",
    summary:
      "Lệnh mới: đổi loại suất cấp phép (ChatGPT / Codex) từ dashboard.",
    details: [
      "Chọn loại trong cột 'Giấy phép' trên dashboard là extension mở menu '...' của người đó rồi đổi. Trùng loại cũ thì bỏ qua.",
      "Lệnh đồng bộ cũng đọc thêm loại suất của từng người để dashboard hiển thị.",
    ],
  },
  {
    version: "0.6.19",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "Xoá thành viên: lật trang và cuộn như lệnh đồng bộ để không tìm sót.",
    details: [
      "Workspace đông người thì chỉ dựa vào ô lọc là sót dòng, báo không tìm thấy dù member vẫn còn — rồi backend đánh dấu đã gỡ oan.",
      "Nay thử ô lọc trước; không thấy thì xoá lọc, về trang 1 và lật từng trang.",
      "Backend bỏ hẳn việc tự chuyển lỗi 'không tìm thấy' thành 'đã gỡ'. Lệnh cứ để hỏng, đồng bộ mới là nguồn sự thật.",
    ],
  },
  {
    version: "0.6.18",
    date: "2026-06-14",
    kind: "fix",
    summary:
      "Đồng bộ bỏ tab 'Yêu cầu đang chờ xử lý'.",
    details: [
      "Theo yêu cầu user: chỉ quét tab Người dùng và tab Lời mời đang chờ.",
    ],
  },
  {
    version: "0.6.17",
    date: "2026-06-14",
    kind: "fix",
    summary:
      "Đồng bộ tab Lời mời: kiểm tra đường dẫn đã đổi tab rồi mới quét.",
    details: [
      "Ca thật: lệnh đồng bộ lời mời không đổi tab, vẫn ở tab Người dùng nên quét nhầm.",
      "Gốc: bấm xong ngủ một nhịp cố định chứ không kiểm chứng tab đã đổi. Cú bấm có khi không kích hoạt được.",
      "Nay chờ đường dẫn đổi sang ?tab=invites, chưa đổi thì bấm lại tối đa 3 lần; vẫn sai thì bỏ qua chứ không quét nhầm.",
    ],
  },
  {
    version: "0.6.16",
    date: "2026-06-14",
    kind: "fix",
    summary:
      "Mời xong mà email không có trong tab Lời mời thì gỡ khỏi dashboard, hết lời mời ma.",
    details: [
      "Trước đây backend tạo bản ghi ngay lúc bấm mời, nên email ChatGPT chưa hề nhận vẫn hiện 'đang chờ' trên dashboard.",
      "Nay xác minh xong, email nào không thấy thì gỡ bản ghi chờ đó. Quét hỏng thì giữ nguyên, tránh xoá oan.",
      "Có email ngoài tên miền thì BẮT BUỘC xác nhận toggle đã bật mới gửi; không xác nhận được thì huỷ, không gửi mù.",
    ],
  },
  {
    version: "0.6.15",
    date: "2026-06-09",
    kind: "fix",
    summary:
      "Đồng bộ lật hết mọi trang, không dừng ở trang thứ hai.",
    details: [
      "Mỗi vòng đọc lại số trang thật trên trang, có chống lặp vô hạn.",
    ],
  },
  {
    version: "0.6.14",
    date: "2026-06-09",
    kind: "fix",
    summary:
      "Đồng bộ lật từng trang khi danh sách ChatGPT có phân trang.",
    details: [
      "Trước chỉ quét trang đang mở nên dashboard thiếu member.",
      "Không có phân trang thì vẫn cuộn tới hết như cũ.",
    ],
  },
  {
    version: "0.6.13",
    date: "2026-05-21",
    kind: "chore",
    summary:
      "Mỗi lệnh có tài liệu riêng nằm cạnh code.",
    details: [
      "Gom 9 tài liệu logic về thẳng thư mục của từng lệnh, kèm một trang mục lục chung.",
      "Quy tắc mới: mỗi lần sửa lỗi phải ghi vào phần lịch sử của tài liệu tương ứng.",
      "Không đổi hành vi code.",
    ],
  },
  {
    version: "0.6.12",
    date: "2026-05-20",
    kind: "chore",
    summary:
      "Chuẩn bị tách các tệp lệnh quá lớn thành từng tệp nhỏ.",
    details: [
      "Một số tệp đã tới 800–900 dòng. Kế hoạch: mỗi lệnh một thư mục, mỗi hàm chính một tệp.",
      "Giai đoạn này chưa tách gì, chỉ đặt mốc để các bước sau có gốc so sánh.",
    ],
  },
  {
    version: "0.6.11",
    date: "2026-05-20",
    kind: "fix",
    summary:
      "Xoá thành viên: lọc theo email trước khi mở menu '...'.",
    details: [
      "Workspace trên 50 người thì dòng cần xoá có khi chưa được vẽ ra, tìm thẳng là trượt.",
      "Nay đảm bảo đang ở tab Người dùng, gõ email vào ô 'Lọc theo tên' cho còn một dòng rồi mới thao tác.",
      "Xoá xong thì xoá luôn ô lọc để lần sau mở lên thấy đủ danh sách.",
      "Không tìm được ô lọc thì vẫn quay về cách cũ, không báo hỏng ngay.",
    ],
  },
  {
    version: "0.6.10",
    date: "2026-05-20",
    kind: "chore",
    summary:
      "Bỏ nút đồng bộ giá trong popup — chỉ chạy từ dashboard.",
    details: [
      "Hai nơi cùng tạo một loại lệnh nên trùng lặp. Giữ nút 'Cập nhật giá & ngày renew' trên dashboard.",
      "Popup vẫn tự làm mới số suất khi lệnh chạy xong, dù lệnh được bấm ở đâu.",
    ],
  },
  {
    version: "0.6.7",
    date: "2026-05-20",
    kind: "fix",
    summary:
      "Lỗi 'không nạp được vào trang': báo rõ bước nào hỏng thay vì thông báo chung chung.",
    details: [
      "Trước chỉ ghi 'không nạp được sau 3 bước dự phòng', phải mở công cụ nhà phát triển mới biết vì sao.",
      "Nay thông báo lỗi kèm nhật ký từng bước có mốc thời gian: trạng thái tab ban đầu, kết quả mỗi lần thử, đường dẫn sau mỗi lần tải lại.",
      "Nghi ngờ lớn nhất là tab ChatGPT đã bị đăng xuất giữa chừng — nhật ký mới sẽ xác nhận ngay ở lần chạy thử.",
    ],
  },
  {
    version: "0.6.6",
    date: "2026-05-20",
    kind: "fix",
    summary:
      "Luôn tắt toggle 'mời ngoài tên miền' sau khi mời, và chờ danh sách ổn định trước khi F5.",
    details: [
      "Ca thật: toggle không tự tắt khi bạn đã tự bật từ trước — bản cũ chỉ khôi phục khi chính extension bật nó lên.",
      "Nay luôn tắt sau mỗi lần mời, vì đây là rủi ro bảo mật. Cần thì bạn tự bật lại.",
      "Lỗi thứ hai: F5 quá sớm cắt ngang lúc ChatGPT đang tải danh sách nên sau đó đọc trúng bản lưu tạm cũ, thiếu email.",
      "Nay chờ danh sách hiện đủ email hoặc đứng yên rồi mới F5, và nới nhịp thử lại. Mời chậm hơn 3–7 giây nhưng chính xác hơn hẳn.",
    ],
  },
  {
    version: "0.6.5",
    date: "2026-05-20",
    kind: "fix",
    summary:
      "Sửa thứ tự các bước khi mời: tắt toggle xong mới chuyển sang tab Lời mời.",
    details: [
      "Bản trước chuyển tab rồi mới tắt toggle, mà bước tắt lại kéo trang về địa chỉ không còn tham số tab — F5 xong ChatGPT mở lại tab Người dùng.",
      "Thứ tự đúng theo user: bật toggle → mời → tắt toggle → chuyển tab Lời mời → F5 → xác minh → ghi dữ liệu.",
    ],
  },
  {
    version: "0.6.4",
    date: "2026-05-20",
    kind: "fix",
    summary:
      "Xác minh sau khi mời nhanh hơn, và hết đánh dấu đã gỡ oan email vừa mời.",
    details: [
      "Ca thật: mời email a12 lúc 08:34, ba phút sau mời email khác thì a12 chưa kịp hiện trong danh sách nên bị đánh dấu đã gỡ.",
      "Gốc: bước xác minh gửi dữ liệu về kèm yêu cầu đối chiếu, mà nó chỉ biết vài email vừa mời chứ không biết gì về email khác.",
      "Nay bước này chỉ ghi nhận đúng những email trong danh sách, không đối chiếu. Backend cũng chừa ra member vừa được mời trong 10 phút.",
      "Nhanh hơn: chuyển sang tab Lời mời trước rồi mới F5, ChatGPT tải thẳng danh sách chờ — tiết kiệm 3–5 giây mỗi lần mời.",
    ],
  },
  {
    version: "0.6.3",
    date: "2026-05-20",
    kind: "fix",
    summary:
      "Thêm lại bước dự phòng cuối: đóng tab hỏng và mở tab hoàn toàn mới.",
    details: [
      "Bước này từng bị bỏ vì làm hỏng hộp mời đang mở. Nay lệnh mời đã tách làm hai lượt nên không còn vướng.",
      "Bước tải lại tab cũng nạp thêm một lần nữa cho chắc, nâng tổng thời gian chờ từ khoảng 6 lên 10 giây.",
    ],
  },
  {
    version: "0.6.2",
    date: "2026-05-20",
    kind: "fix",
    summary:
      "F5 thật trang admin sau khi gửi lời mời, ép ChatGPT tải lại danh sách từ server.",
    details: [
      "Trước chỉ bấm qua lại giữa các tab, mà ChatGPT có thể trả lại bản lưu tạm cũ.",
      "Nay tách lệnh mời làm hai lượt: lượt đầu gửi lời mời, background F5 thật rồi lượt sau mới xác minh.",
      "F5 hỏng hay xác minh hỏng thì vẫn coi là mời xong (vì đã gửi thật), chỉ nhắc bạn tự mở tab Lời mời kiểm tra.",
    ],
  },
  {
    version: "0.6.1",
    date: "2026-05-20",
    kind: "fix",
    summary:
      "Sửa lỗi mỗi cú bấm thành hai, và cho ChatGPT thêm thời gian trước khi xác minh.",
    details: [
      "Lỗi 1: mỗi cú bấm thực ra bắn hai lần nên toggle bị đổi hai lượt và lời mời bị gửi hai lần — mỗi lần đều hiện hai thông báo.",
      "Lỗi 2: bấm gửi xong xác minh ngay, mà ChatGPT cần 1–5 giây mới đưa lời mời vào danh sách chờ — thành báo hỏng oan rồi xoá bản ghi.",
      "Nay đợi thêm 2 giây rồi thử lại tối đa 3 lần, tổng khoảng 10 giây, các lần sau ép ChatGPT tải lại danh sách.",
      "Xác minh xong thì dừng lại ở tab Lời mời để bạn mở lên là thấy ngay, khỏi F5.",
    ],
  },
  {
    version: "0.6.0",
    date: "2026-05-20",
    kind: "feature",
    summary:
      "Mua suất: đi trọn chuỗi thanh toán qua Stripe và Link, trừ tiền thật bằng thẻ.",
    details: [
      "Sau khi tạo hoá đơn 'Đến hạn' trên ChatGPT, extension sang trang Hoá đơn lấy đường dẫn Stripe.",
      "Mở trang Stripe, bấm nút Link, rồi ở cửa sổ thanh toán đối chiếu số tiền trước khi bấm nút trả tiền cuối cùng.",
      "Chốt an toàn: số tiền lệch quá 50đ thì DỪNG; thấy dấu hiệu cần mã OTP hay xác minh 3DS thì KHÔNG bấm, để admin tự làm.",
    ],
  },
  {
    version: "0.5.1",
    date: "2026-05-20",
    kind: "feature",
    summary:
      "Mua suất: bấm luôn nút trả tiền cuối, kèm đối chiếu số suất trước khi bấm.",
    details: [
      "Trước đây extension dừng lại sau bước 'Tiếp tục' để admin tự xác nhận. Nay đi trọn luồng.",
      "Chốt an toàn: hộp phải nói đúng số suất đang mua, lệch thì DỪNG, không bấm trừ tiền.",
      "Đọc lại số tiền để ghi nhật ký. Hộp không đóng sau 10 giây thì có thể ChatGPT đang hỏi mã xác minh — ghi chú để admin tự hoàn tất.",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-05-20",
    kind: "feature",
    summary:
      "Lệnh mới: mua thêm suất từ dashboard, dừng trước nút thanh toán cuối.",
    details: [
      "Mở trang Thanh toán, bấm 'Quản lý giấy phép', tăng số suất đúng số cần rồi bấm 'Tiếp tục'. Admin tự xác nhận thanh toán.",
      "Giới hạn 20 suất mỗi lệnh để chống bấm nhầm, và chỉ super-admin dùng được.",
      "Đã có lệnh mua đang chờ hoặc đang chạy thì không tạo lệnh mới, tránh trừ tiền hai lần.",
    ],
  },
  {
    version: "0.4.20",
    date: "2026-05-19",
    kind: "fix",
    summary:
      "Bỏ bước dự phòng đóng tab, nới thời gian chờ hộp mời, và đồng bộ dữ liệu ngay sau khi đổi vai trò / xoá.",
    details: [
      "Bước đóng tab rồi mở lại quá mạnh tay, làm hộp mời không mở được sau đó.",
      "Chờ ô nhập email trong hộp mời nới từ 10 lên 20 giây, và hỏng thì in ra các ô đang có để tra.",
      "Backend cập nhật vai trò và trạng thái ngay khi lệnh xong, thay vì đợi tới lần đồng bộ sau.",
    ],
  },
  {
    version: "0.4.19",
    date: "2026-05-19",
    kind: "fix",
    summary:
      "Đọc được số suất khi đang dùng vượt hạn mức, ví dụ 'Đang dùng 14/13'.",
    details: [
      "Bản cũ coi 14 > 13 là vô lý nên bỏ qua, rồi vớ nhầm cặp số khác trên trang.",
      "Dùng vượt hạn là trạng thái hợp lệ — ChatGPT tính phần vượt vào hoá đơn kỳ sau.",
    ],
  },
  {
    version: "0.4.18",
    date: "2026-05-19",
    kind: "fix",
    summary:
      "Thêm bước dự phòng cuối: đóng tab hỏng, mở tab mới hoàn toàn.",
    details: [
      "Bước tải lại tab vẫn hỏng trong vài trường hợp; tab mới thì sạch 100%.",
      "Popup ẩn hẳn lỗi 'không nạp được vào trang' — đây là lỗi hạ tầng extension tự chữa, bạn không cần thấy.",
    ],
  },
  {
    version: "0.4.17",
    date: "2026-05-19",
    kind: "fix",
    summary:
      "Tự tải lại tab ChatGPT khi không nạp được vào trang, khỏi F5 tay.",
    details: [
      "Nạp lại extension tạo ra tệp mới, còn tab đang mở vẫn giữ tệp cũ nên không nhận được lệnh.",
      "Nay tự thử nạp lại, không được thì tự F5 tab rồi thử tiếp.",
    ],
  },
  {
    version: "0.4.16",
    date: "2026-05-19",
    kind: "feature",
    summary:
      "Ô chọn vai trò trên dashboard chỉ còn 2 lựa chọn; popup thêm nút làm mới số suất.",
    details: [
      "Chỉ cho đổi giữa 'Thành viên' và 'Xem dữ liệu'. Người đang là admin hay chủ sở hữu thì hiện khoá, phải thao tác trên ChatGPT.",
    ],
  },
  {
    version: "0.4.15",
    date: "2026-05-19",
    kind: "fix",
    summary:
      "Đổi vai trò hết treo: ChatGPT chuyển sang ô chọn ngay trên dòng.",
    details: [
      "Giao diện mới không còn giấu mục đổi vai trò trong menu '...', nên bản cũ tìm mãi không thấy rồi treo vô hạn.",
      "Dashboard cũng tự tải lại danh sách khi lệnh xong, khỏi F5 tay.",
    ],
  },
  {
    version: "0.4.14",
    date: "2026-05-19",
    kind: "fix",
    summary:
      "Mời mà không xác minh được email nào thì báo hỏng, không báo xong.",
    details: [
      "Trước vẫn báo xong với '0/N đã xác minh' rồi xoá sạch bản ghi — dễ hiểu nhầm.",
      "Nay báo hỏng kèm ba nguyên nhân có thể: email đã là thành viên, tên miền chưa xác minh, hoặc ChatGPT từ chối im lặng.",
      "Riêng ca quét hỏng thì vẫn báo xong, vì cú bấm gửi có thể đã thành công.",
    ],
  },
  {
    version: "0.4.13",
    date: "2026-05-19",
    kind: "fix",
    summary:
      "Dashboard chỉ hiện email ChatGPT thật sự nhận.",
    details: [
      "Backend tạo bản ghi ngay lúc bấm mời cho nhanh, nên email ChatGPT chưa nhận vẫn hiện — nay lệnh xong sẽ dọn.",
      "Quét hỏng thì giữ lại cho an toàn.",
      "Bước nạp vào trang cũng thử lại tới 3 giây thay vì hỏi đúng một lần.",
    ],
  },
  {
    version: "0.4.12",
    date: "2026-05-19",
    kind: "feature",
    summary:
      "Popup có khung 'Lệnh đang chạy' kèm thanh tiến độ.",
    details: [
      "Chỉ hiện khi có lệnh đang chạy, đang chờ, hoặc vừa xong trong 60 giây.",
      "Cập nhật mỗi 1,5 giây khi popup mở; đóng popup là ngừng, không tốn gì.",
      "Mời / xoá / thu hồi xong thì tự chạy lệnh cập nhật số suất, khỏi đợi bấm tay.",
    ],
  },
  {
    version: "0.4.11",
    date: "2026-05-19",
    kind: "fix",
    summary:
      "Sửa nhãn giao diện trên dashboard là extension nhận ngay, khỏi chờ 15 phút.",
    details: [
      "Trước phải đợi nhịp làm mới 15 phút nên cảm giác 'sửa mà không ăn'.",
      "Nay dashboard báo thẳng cho extension làm mới. Nhịp tự làm mới cũng rút từ 15 xuống 2 phút, phòng khi dashboard và extension chạy ở hai trình duyệt khác nhau.",
    ],
  },
  {
    version: "0.4.10",
    date: "2026-05-19",
    kind: "feature",
    summary:
      "Xác minh ở tab Lời mời đang chờ trước khi ghi lên dashboard.",
    details: [
      "Chỉ email thật sự xuất hiện trong danh sách chờ mới được ghi lên dashboard.",
      "Email mời rồi mà không thấy được báo riêng để admin kiểm tra tay.",
      "Quét hỏng hoàn toàn thì không ghi gì, chỉ nhắc mở tab Lời mời xem thủ công.",
    ],
  },
  {
    version: "0.4.9",
    date: "2026-05-19",
    kind: "fix",
    summary:
      "Hết lỗi không tìm thấy nút 'Mời thành viên' sau khi bật toggle.",
    details: [
      "Chuyển trang xong trang cần vài trăm mili giây tới vài giây mới vẽ nút, mà bản cũ hỏi đúng một lần.",
      "Nay chờ tới 8 giây, và bước chuyển trang cũng đợi nội dung vẽ xong mới coi là tới nơi.",
    ],
  },
  {
    version: "0.4.8",
    date: "2026-05-19",
    kind: "feature",
    summary:
      "Mời xong tự lấy danh sách lời mời chờ về dashboard rồi mới tắt toggle.",
    details: [
      "Bước lấy về là tuỳ nghi: quét hỏng thì chỉ ghi cảnh báo, lời mời vẫn tính là xong.",
      "Xong thì extension quay lại tab Người dùng cho quen thuộc.",
    ],
  },
  {
    version: "0.4.7",
    date: "2026-05-19",
    kind: "fix",
    summary:
      "Đọc email bền hơn khi ChatGPT gộp tên và email vào một chỗ, và giảm 70% thời gian chờ.",
    details: [
      "Bản cũ đòi ô chữ phải đúng y hệt một email nên trượt khi ChatGPT ghép cả tên vào.",
      "Giảm nhịp chờ 70% theo phản hồi 'extension cứ xoay mãi'.",
    ],
  },
  {
    version: "0.4.6",
    date: "2026-05-19",
    kind: "fix",
    summary:
      "Báo rõ khi ChatGPT đang dùng ngôn ngữ khác với dashboard.",
    details: [
      "Đồng bộ ra 0 dòng mà ngôn ngữ lệch thì báo lỗi kèm hướng dẫn đổi ngôn ngữ trên ChatGPT.",
      "Chuyển trang ưu tiên bấm liên kết trên thanh bên, đáng tin hơn cách đổi địa chỉ ngầm.",
    ],
  },
  {
    version: "0.4.5",
    date: "2026-05-19",
    kind: "fix",
    summary:
      "Tiến trình lệnh mời chi tiết hơn: hiện đang ở email thứ mấy trên tổng số.",
    details: [
      "Dashboard hiện email, trạng thái, bước đang chạy, số giây đã trôi, và cảnh báo nếu quá 90 giây không nhúc nhích.",
    ],
  },
  {
    version: "0.4.4",
    date: "2026-05-19",
    kind: "fix",
    summary:
      "Mời nhiều email: giao diện mới của ChatGPT cho mỗi email một ô riêng.",
    details: [
      "Bản cũ nối các email bằng xuống dòng vào một ô duy nhất — ChatGPT từ chối cả loạt.",
      "Nay gõ email đầu, bấm 'Thêm dòng', đợi ô mới hiện ra rồi gõ tiếp. Không thêm được dòng thì quay về cách dồn một ô.",
    ],
  },
  {
    version: "0.4.3",
    date: "2026-05-19",
    kind: "fix",
    summary:
      "Tìm toggle 'mời ngoài tên miền' bền hơn, và báo rõ lỗi hết ghế.",
    details: [
      "Đọc nhãn của toggle theo nhiều đường thay vì chỉ một, kèm bảng chẩn đoán in ra để tra.",
      "Chuyển trang ưu tiên bấm liên kết trên thanh bên.",
      "Lỗi hết ghế hoặc email ngoài tên miền nay được nêu rõ thay vì in nguyên đoạn chữ trong hộp thoại.",
    ],
  },
  {
    version: "0.4.2",
    date: "2026-05-19",
    kind: "fix",
    summary:
      "Chọn đúng toggle 'Cho phép lời mời ngoài tên miền', không nhầm 'Tự động tạo tài khoản'.",
    details: [
      "Bản cũ dò lên 5 cấp nên hai toggle nằm gần nhau bị nhận nhầm.",
      "Nay chỉ xét đúng khối chứa một toggle, và loại thẳng khối 'Tự động tạo tài khoản'.",
      "Nhiều nhãn cùng khớp thì chọn nhãn dài nhất, tức đặc trưng nhất.",
    ],
  },
  {
    version: "0.4.1",
    date: "2026-05-18",
    kind: "fix",
    summary:
      "Tắt toggle xong luôn quay về trang Thành viên.",
    details: [
      "Áp dụng cho cả khi mời thành công lẫn thất bại, để lệnh sau bắt đầu ở đúng trang.",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-05-18",
    kind: "feature",
    summary:
      "Thu thập nhãn giao diện: tự tạo lời mời thử khi tab Lời mời trống.",
    details: [
      "Tạo một lời mời thử, đọc nhãn menu thu hồi rồi tự thu hồi lại cho workspace sạch.",
      "Nhờ vậy phủ đủ 100% nhãn cần thu thập.",
    ],
  },
  {
    version: "0.3.2",
    date: "2026-05-18",
    kind: "fix",
    summary:
      "Thu thập nhãn: báo tiến trình sớm, hết cảnh dashboard im lặng 5–30 giây.",
    details: [
      "Báo từ lúc xếp hàng, mở tab, chờ nhịp giới hạn, trước cả khi gửi lệnh đi.",
      "Dashboard hiện trạng thái, đồng hồ đếm, và cảnh báo nếu 20 giây không có tín hiệu nào.",
    ],
  },
  {
    version: "0.3.1",
    date: "2026-05-18",
    kind: "fix",
    summary:
      "Thu thập nhãn: tiến trình theo thời gian thực, kiểm chứng chuyển trang, hạn 3 phút.",
    details: [
      "Chuyển trang không ăn thì bỏ qua trang đó thay vì treo.",
      "Không lấy được nhãn nào thì báo lỗi rõ, thường do chưa F5 hoặc giao diện đã đổi.",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-05-18",
    kind: "feature",
    summary:
      "Thu thập nhãn: tự đi qua 4 trang admin đọc 18 nhãn giao diện cho một ngôn ngữ.",
    details: [
      "Mở hộp mời, mở menu '...', đọc hộp xác nhận rồi thoát ra — không thao tác gì thật.",
      "Dashboard có nút 'Harvest VI/EN/ZH' thay cho đoạn lệnh dán tay trước đây.",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-05-18",
    kind: "feature",
    summary:
      "Hiệu chỉnh nhãn giao diện và tự chữa khi nhãn cũ không còn đúng.",
    details: [
      "Lấy bộ nhãn về định kỳ và lưu lại; lệnh ưu tiên nhãn đã thu thập, không có thì dùng nhãn mặc định.",
      "Tìm không thấy phần tử dù dữ liệu có nhãn thì tự báo về để dashboard cảnh báo nhãn đã cũ.",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-05-18",
    kind: "feature",
    summary:
      "Bản phát hành đầu tiên.",
    details: [
      "Cầu nối giữa dashboard nội bộ và trang quản trị ChatGPT Business.",
      "Các lệnh: mời, xoá, đổi vai trò, đồng bộ dữ liệu, đồng bộ thanh toán, thu hồi lời mời.",
      "Nhận lệnh theo thời gian thực, không phải hỏi ChatGPT liên tục. Đọc được cả giao diện Việt / Anh / Trung.",
    ],
  },
];
