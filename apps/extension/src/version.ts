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

export const VERSION = "0.13.4";

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
    version: "0.13.4",
    date: "2026-08-24",
    kind: "feature",
    summary:
      "Bớt phải mở hộp 'Quản lý suất' — đã chắc còn thừa chỗ thì mời thẳng. Và extension chỉ dùng tối đa 2 tab của riêng nó, chạy được 2 lệnh cùng lúc.",
    details: [
      "Sáng 24/8 có 8 lệnh mời chết liên tiếp mà không lệnh nào tới được bước mời — tất cả kẹt ở khâu đếm suất, trong khi workspace vẫn thừa suất: 4 lần hộp 'Quản lý suất' bấm rồi không mở, 4 lần bộ đếm (150) và dòng tỉ lệ (151) nói hai số khác nhau.",
      "Đường tắt: số thành viên đã in sẵn trên trang ('146 thành viên'), dashboard thì biết tổng suất và số lời mời đang chờ. Hai số đó nói còn dư chỗ (dư hơn số cần ít nhất 1 suất) thì mời thẳng, không đụng vào hộp.",
      "Bộ đếm lệch dòng tỉ lệ không còn giết cả lệnh mời: lấy số THẤP HƠN rồi đi tiếp — đủ suất thì cứ mời, vì mời không tiêu tiền. Chỉ cấm MUA theo số chưa chắc.",
      "Bấm 'Quản lý số suất' mà hộp không mở thì bấm lại một lần nữa rồi mới bỏ cuộc. Mua bù xong cũng không mở lại hộp để đếm nữa — bộ đếm của chính hộp mua đã nói tổng mới.",
      "Tab: extension đánh dấu tab của mình, tối đa 2 tab nên 2 lệnh chạy được cùng lúc. Tab admin bạn tự mở KHÔNG còn bị extension F5 hay đóng ngang. Tab đã mở sẵn thì F5 làm mới trước khi chạy; tab vừa mở thì thôi.",
      "Riêng lệnh mời và mua suất vẫn chạy lần lượt: hai lệnh mời chồng nhau cùng thấy 'còn 1 suất trống' sẽ làm ChatGPT bật hộp 'Mua suất người dùng và gửi lời mời' — mua và mời trong một cú bấm, không biết trước hết bao nhiêu tiền.",
    ],
  },
  {
    version: "0.13.3",
    date: "2026-08-24",
    kind: "fix",
    summary:
      "Tổng suất trên dashboard ôm số cũ 11 ngày (148 trong khi ChatGPT đang có 151). Nay mỗi lần 'Đồng bộ từ ChatGPT' là đọc luôn hộp 'Quản lý suất' và ghi số thật về.",
    details: [
      "Gốc rễ nằm ở dashboard: dán lại hoá đơn cũ (để đủ báo cáo tài chính) kéo tổng suất về số ghế của kỳ hoá đơn đó — ngày 13/8 ba lần dán liên tiếp đẩy GPT1 từ 151 xuống 2, rồi 102, rồi 148 và đứng đó. Từ nay hoá đơn chỉ nói chuyện tiền, không được sửa số suất.",
      "Lệnh 'Đồng bộ từ ChatGPT' giờ đọc thêm hộp 'Quản lý suất' ngay khi vừa quét xong tab Người dùng (đang đứng sẵn ở đó). Đọc không được thì thôi, giữ số cũ — không bao giờ vì việc này mà báo sync hỏng.",
      "Số gửi về dashboard lấy theo DÒNG TỈ LỆ ('147/151 đã gán' → 151), tức số suất workspace ĐANG giữ. Bộ đếm '[−] 150 [+]' thấp hơn khi có lượt gỡ hẹn hiệu lực kỳ sau — số đó vẫn dùng để quyết định mua thêm (thà thiếu hơn thừa), nhưng hiển thị lên dashboard thì thành sai thực tế.",
      "Lần mời đi ĐƯỜNG TẮT (không mở hộp vì đã chắc còn thừa chỗ) không còn được tính là 'đã đọc số': số nó gửi về chính là số dashboard vừa gửi xuống, ghi lại là vòng tròn — số cũ tự xác nhận chính nó và không bao giờ tươi lại.",
      "Popup extension in 'Seat: x/y' theo cùng cách tính với dashboard: đã dùng = người dùng + lời mời đang chờ (lời mời chờ vẫn đang giữ suất).",
    ],
  },
  {
    version: "0.13.2",
    date: "2026-08-24",
    kind: "fix",
    summary:
      "Chốt suất im lặng bỏ qua vì trang chưa render kịp → mời mù khi workspace hết suất. Đây là gốc của 2 lệnh mời hỏng ngày 22/8 mà chủ hệ thống phải hoàn tiền tay.",
    details: [
      "Nút 'Quản lý số suất' là component render SAU danh sách thành viên. Bản trước hỏi ĐÚNG MỘT LẦN ngay lúc vừa tới trang: chưa thấy là kết luận 'workspace chưa được bật UI mới' rồi BỎ QUA chốt suất và mời thẳng. Ca thật 22/8 18:03 và 18:20 (workspace hết sạch 60 suất): mời mù → ChatGPT bật hộp 'mua kèm gửi lời mời' → 15s không có toast → VERIFY_FAILED. Đúng cái hộp mà cả thiết kế đếm-suất-trước sinh ra để tránh.",
      "Dấu vân tay của cuộc đua: hai lệnh 'Mời lại' 14 phút sau, trong CÙNG workspace đó, lại đếm suất chuẩn — vì tiền tố thu hồi lời mời đã kịp làm trang render xong.",
      "Nay CHỜ nút xuất hiện tối đa 6s rồi mới dám kết luận 'workspace UI cũ'. Dò bằng finder im lặng để không spam báo lệch nhãn về dashboard; hết giờ mới hỏi lại một lần qua đường có báo.",
      "Số liệu bước suất (seat_total/seat_free/seat_needed) giờ đính kèm CẢ ca mời hỏng. Hai task 22/8 chỉ để lại `{submit_clicked:true}` trong DB nên phải suy ngược từ hành vi mới đoán ra chốt suất đã bị bỏ qua — lần sau nhìn thẳng vào result là biết.",
    ],
  },
  {
    version: "0.13.1",
    date: "2026-08-23",
    kind: "fix",
    summary:
      "Ba lỗi lộ ra ở lần chạy thật đầu tiên của bước đếm suất: nút xác nhận bị hỏi quá sớm, đua render làm lệch số suất rồi chặn cả lệnh mời, và số liệu lỗi bị vứt nên không tra được gì.",
    details: [
      "Nút 'Xác nhận mua' bị KHOÁ trong lúc ChatGPT còn tính tiền, mở khoá khi tính xong. Bản trước hỏi ngay lúc hộp vừa mở, thấy khoá là bỏ cuộc → 2 task mời liền (22/8 18:17 và 18:28) FAILED với lời nhắn 'thiếu phương thức thanh toán' OAN, trong khi thẻ vẫn có sẵn. Nay CHỜ mở khoá tối đa 10s, y như đã làm với nút 'Tiếp tục'.",
      "Ca 23/8 09:49 (bộ đếm 150 vs dòng tỉ lệ 151 → chặn cả lệnh mời) đã được chữa ở nhánh khác và gộp vào đây: căn nguyên là ĐUA RENDER — code cũ chờ dòng tỉ lệ tới 8s (biết nó render chậm) nhưng đọc bộ đếm ngay dòng kế, không chờ, nên chụp trúng trị số quá độ. Nay đọc lại CẢ HAI cho tới khi khớp (tối đa 2,5s). Lệch đúng 1 đơn vị là chữ ký của kiểu đua này.",
      "Chốt chặn khi hai nguồn lệch được GIỮ NGUYÊN, cố ý không nới thành 'đoán số nhỏ hơn rồi chạy tiếp'. Chặn thì task mời FAILED, admin chạy lại, KHÔNG mất đồng nào; còn đoán sai là mua một suất không cần và tiền đã đi, không lấy lại được. Căn nguyên đã xử thì chốt này gần như không còn cửa nổ.",
      "Số liệu đính kèm lỗi giờ được GIỮ vào result. Trước đây chỉ giữ khi submit_clicked=true nên mọi task FAILED vì bước đếm suất đều có cột result NULL — có seat_total/seat_free/seat_needed trong tay mà không tra được, phải đoán từ mỗi câu error_message.",
      "Không đọc được dòng '<đã gán>/<tổng> đã gán' thì kèm luôn 300 ký tự đầu nội dung hộp vào thông báo lỗi, để lần sau ChatGPT đổi hiển thị là biết ngay đổi thành gì.",
    ],
  },
  {
    version: "0.13.0",
    date: "2026-08-22",
    kind: "feature",
    summary:
      "Mời thành viên: việc ĐẦU TIÊN là kiểm tra số suất còn trống, thiếu thì tự mua bù rồi mới mời — hết cảnh ChatGPT bật hộp 'mua suất kèm gửi lời mời' mà mình không kiểm soát được tiền.",
    details: [
      "Quy trình mới của MỜI THÀNH VIÊN: mở 'Quản lý số suất' → đọc 'đã gán/tổng' (vd 52/53 → còn trống 1) → so với số email sắp mời → thiếu bao nhiêu thì bấm '+' đúng bấy nhiêu, 'Tiếp tục', 'Xác nhận mua' → ĐỌC LẠI số suất để chắc đã vào → rồi mới mở hộp thoại mời như cũ.",
      "Vì sao phải mua TRƯỚC: mời khi thiếu suất sẽ làm ChatGPT bật hộp 'Xem lại giao dịch mua' riêng với nút 'Mua suất người dùng và gửi lời mời' — mua suất VÀ gửi lời mời trong MỘT cú bấm. Extension không biết trước nó mua mấy suất, hết bao nhiêu tiền, nên chủ động làm cho hộp đó KHÔNG BAO GIỜ xuất hiện.",
      "Workspace CHƯA được ChatGPT bật UI mới (không có nút 'Quản lý số suất' cạnh 'Mời thành viên') → BỎ QUA hoàn toàn bước này, mời y như trước. User quan sát 22/8: workspace 47 thành viên có nút, workspace 145 thành viên không có.",
      "Đọc số suất là thao tác CHỈ-ĐỌC: mở hộp, đọc, đóng bằng 'Quay lại'/Esc. Không bao giờ chạm nút 'Tiếp tục' ở bước kiểm tra.",
      "Bước kiểm tra chạy SAU tiền tố 'Mời lại' (thu hồi lời mời cũ) vì thu hồi TRẢ LẠI suất — đếm trước khi thu hồi sẽ ra thiếu và đi mua thừa. Và chỉ chạy ở lần gọi thứ nhất, không lặp lại sau vòng hard-reload của toggle mời-ngoài-miền.",
      "Thiếu quá 20 suất → DỪNG, không mua một phần: mua 20 khi cần 25 thì vẫn không mời đủ, tiền mất mà việc không xong. Mã lỗi mới NOT_ENOUGH_SEATS kèm số liệu còn/thiếu.",
      "Không đọc được số suất (có UI mới nhưng ChatGPT đổi cách hiển thị) → DỪNG, không mời mù. Mời mù chính là thứ kích hoạt hộp mua-kèm-mời.",
      "Bấm '+' theo kiểu BÁM THEO CON SỐ thay vì đếm đủ N lần: mỗi vòng đọc bộ đếm, thiếu thì bấm '+', LỠ VƯỢT thì bấm '−' kéo xuống, lặp tới khi bộ đếm bằng đúng 'số hiện có + số cần mua'. Bấm nhanh, không nghỉ. Nhờ vậy cú bấm nhân đôi (ChatGPT/React bắn 2 sự kiện) tự sửa ngay tại chỗ bằng một cú '−', thay vì làm hỏng cả lượt như bản trước.",
      "Chỉ khi tự sửa không nổi mới LÀM LẠI: đóng hộp 'Quản lý suất', mở lại (bộ đếm trở về số thật của workspace) rồi bấm lại, tối đa 3 lượt. An toàn tuyệt đối về tiền vì chưa hề bấm 'Tiếp tục' — chưa có giao dịch nào tồn tại. Kích hoạt khi: bấm mãi không về đúng số (trần qty×3+6 lần), bấm mà số không đổi (đụng hạn mức ChatGPT), vượt số mà không tìm ra nút '−', hoặc thẻ tóm tắt nói số khác.",
      "🔒 Loại hẳn các nút MANG CHỮ ('Tiếp tục', 'Quay lại', 'Xác nhận mua', nút đóng…) khỏi ứng viên bộ đếm. Trước đây chỉ nút '+' được bấm nên nhận nhầm chỉ làm hỏng thao tác; nay luồng bấm cả '−' nên nhận nhầm 'Tiếp tục' sẽ nhảy thẳng sang hộp thanh toán. Bộ đếm chỉ nhận nút icon (chữ rỗng hoặc đúng 1-2 ký tự).",
      "Nút 'Tiếp tục' còn khoá sau khi bộ đếm đã lên cũng chuyển sang LÀM LẠI, và bỏ hẳn câu đổ cho 'thiếu phương thức thanh toán' trong mọi thông báo lỗi — workspace luôn có sẵn thẻ nên đoán vậy là chỉ dẫn sai người đọc.",
      "Chốt chặn ở hộp thanh toán giờ CHỈ dựa trên SỐ SUẤT, không dựa vào tiền: số suất hộp khai phải bằng số cần mua, và số ghế trước/sau phải chênh đúng bấy nhiêu. Bỏ chốt 'hoá đơn tháng mới không được thấp hơn hiện tại' vì chốt số ghế đã bao trọn ca đó (giảm suất thì chênh ra số âm). Tiền vẫn được đọc để ghi audit nhưng đọc không ra cũng không chặn — user đối soát theo hoá đơn ngân hàng.",
      "Mua xong ĐỌC LẠI ĐÚNG MỘT LẦN (chờ 3s cho ChatGPT kịp cập nhật rồi đọc): luồng mua báo ok chỉ nghĩa là 'đã bấm Xác nhận mua và hộp đóng', chưa chắc suất đã cộng xong, nên vẫn phải xác nhận bằng mắt — nhưng mở/đóng hộp nhiều lượt vừa chậm vừa thêm cơ hội hộp bị kẹt. Nếu lần đọc đó VẪN thiếu thì TẢI LẠI TRANG một lần rồi đọc lại (trang có thể còn giữ số cũ trong bộ nhớ React); đủ rồi thì mời tiếp như thường.",
      "Tải lại trang ở đây là điều hướng SPA sang /admin/billing rồi quay lại /admin/members, KHÔNG phải F5. F5 thật sẽ huỷ content script giữa chừng → task chết với CONTENT_TIMEOUT trong khi tiền đã trừ xong.",
      "Chạy lại task không mua trùng: mỗi lần chạy đều đo suất thật trước, lần trước đã mua thì thấy đủ và bỏ qua bước mua.",
      "⏱️ Nâng hạn giờ INVITE_MEMBER từ 3 phút lên 8 phút (cả extension lẫn backend) — mời giờ có thể kèm một lần mua. Giữ 3 phút sẽ cắt task GIỮA LÚC thanh toán: tiền đã trừ mà task báo treo.",
      "Thêm 2 chốt cho luồng mua (phát hiện từ ảnh user): hộp 'Quản lý suất' tự in thẻ 'Thêm N suất Tiêu chuẩn' sau khi bấm '+' → đối chiếu N với số cần mua NGAY, trước khi sang bước thanh toán; và hộp thanh toán in số ghế trước/sau (53 ghế → 55 ghế) → hiệu hai số phải bằng đúng số suất mua.",
      "Sửa lỗi đua: hộp 'Xem lại giao dịch mua' hiện ra TRƯỚC, số tiền ChatGPT tính xong điền vào SAU vài giây. Bản trước đọc ngay lúc hộp vừa mở sẽ ra rỗng → chốt 'không đọc được số liệu' nổ oan dù UI bình thường. Nay chờ tới khi số liệu thật sự có mặt (tối đa 15s).",
      "💰 GIÁ NIÊM YẾT KHÔNG PHẢI GIÁ THẬT: workspace được giảm giá. Hộp ghi '+ 1.298.000 đ/tháng' (2 × 649.000) nhưng hoá đơn đi từ 13.806.500 lên 14.327.500 = +521.000 (2 × 260.500). Đối chiếu 2 ảnh: lấy giá sau giảm thì tỷ lệ prorate của cả 2 workspace đều ~9,3%, lấy giá niêm yết thì ra 3,8% và lệch nhau. Code TUYỆT ĐỐI không đọc dòng đơn giá vào đâu, và không đặt chốt kiểu 'mức tăng phải bằng đơn giá × số suất' — chốt đó sẽ chặn oan mọi lần mua có giảm giá.",
      "💸 KHÔNG con số nào trong hộp thanh toán là CHI PHÍ THẬT: 2 dòng hoá đơn hằng tháng ghi rõ '+ thuế' nên là số TRƯỚC THUẾ, còn phí ngân hàng/phí quy đổi ngoại tệ thì ChatGPT không hiển thị ở đâu cả. Chỉ 'Tổng phải trả hôm nay' là đã cộng thuế (48.027 + 4.803 = 52.830). Vì vậy các trường tiền hằng tháng mang hậu tố _pretax (cố ý, để sau này không ai tưởng đó là số cuối), và payload kèm câu amounts_basis nói rõ số nào gồm gì. Chi phí thật chốt theo hoá đơn ngân hàng — sẽ cập nhật sau.",
      "🐞 Soát lại phát hiện bẫy: nhãn dự phòng lỏng /theo tỷ lệ/ khớp trúng PHỤ ĐỀ modal ('Các suất mới được tính phí THEO TỶ LỆ đến chu kỳ thanh toán tiếp theo'), rồi cụm tiền gần nhất phía sau lại đúng là dòng ĐƠN GIÁ NIÊM YẾT → đọc ra 1.298.000 thay vì phần prorate. Bản trước thoát chỉ vì cửa sổ quét 90 ký tự cắt đúng giữa '1.298.000' và chữ 'đ' — phụ đề ngắn đi vài chữ là dính. Đã bỏ hết nhãn lỏng, chỉ nhận nhãn đầy đủ, kèm test tái hiện.",
      "🐞 Soát lại phát hiện lỗi thứ hai: tiền và số ghế của một dòng hoá đơn được dò ĐỘC LẬP, mỗi vế có danh sách nhãn dự phòng riêng → có thể lấy tiền của dòng này ghép với số ghế của dòng khác, rồi đem so với số suất đang mua. Nay cả hai đọc từ CÙNG một nhãn đã khớp; dòng nào không có ghế thì để trống chứ không mượn của dòng khác.",
      "Modal 'Quản lý suất' không đóng lại được sau bước đọc → DỪNG hẳn task mời. Lớp phủ của nó chặn mọi click phía sau (bấm mua trượt, mở hộp mời cũng trượt), trước đây chỉ ghi cảnh báo rồi đi tiếp nên sẽ fail lung tung ở bước sau.",
      "Đọc thêm dòng 'Thuế bán hàng (10,001%)' thành sales_tax_text/_vnd/_percent để về sau đối soát hoá đơn cho dễ. Có test kiểm chứng tạm tính + thuế = tổng hôm nay, tức 3 dòng được đọc đúng dòng chứ không lệch.",
      "Số suất cần mua lấy từ backend (`new_seat_count` = `_count_new_invite_seats`) chứ không đếm bừa theo số email: email đang là thành viên ACTIVE đã giữ một suất rồi, đếm cả vào là đi mua thừa — mất tiền thật. Backend cũ chưa gửi thì rơi về số email; chiều rơi về này là cố ý vì mua THỪA còn hơn mua THIẾU (mua thiếu là ChatGPT bật luồng 'mua kèm gửi lời mời' không kiểm soát được).",
      "Kết quả task mời ghi thêm seat_total / seat_assigned / seat_free / seat_needed / seat_purchased + toàn bộ số liệu tiền của lần mua, để dashboard cập nhật số suất từ con số THẬT của ChatGPT thay vì scrape trang Thanh toán (vốn hay cũ/lệch).",
    ],
  },
  {
    version: "0.12.0",
    date: "2026-08-22",
    kind: "feature",
    summary:
      "Mua suất: đi theo UI MỚI của ChatGPT (nút 'Quản lý số suất' ngay trên trang Thành viên) — bỏ hẳn chặng vòng qua Stripe/Link, và đọc luôn khoản tăng CỐ ĐỊNH hằng tháng chứ không chỉ tiền trả hôm nay.",
    details: [
      "ChatGPT đổi UI mua suất (quan sát 22/8/2026): nút 'Quản lý số suất' nằm cạnh '+ Mời thành viên' trên /admin/members → modal 'Quản lý suất' (bộ đếm [−] 47 [+]) → 'Tiếp tục' → modal 'Xem lại giao dịch mua' → 'Xác nhận mua' là TRỪ TIỀN THẬT NGAY qua thẻ đã lưu. Đường cũ (/admin/billing?tab=plan → 'Quản lý giấy phép' → 'Thêm người dùng') không còn.",
      "Hỏng ngay từ bước đầu: danh sách nhãn nút không có 'Quản lý số suất', mà so khớp là 'chứa chuỗi' nên nhãn cũ 'Quản lý suất' KHÔNG đỡ được ('số' chen vào giữa) → task trượt ngay bước 1. Đã thêm nhãn mới lên đầu, giữ nhãn cũ phía dưới cho workspace chưa được bật UI mới.",
      "🔴 BỎ chặng Stripe + Link khỏi luồng mua: UI mới trừ tiền thẳng trong modal, không tạo hoá đơn 'Đến hạn' để đi trả sau. Giữ lại chặng đó còn TAI HẠI — sau khi đã trừ tiền, code cũ sẽ sang tab Hoá đơn tìm 'hoá đơn chưa thanh toán đầu tiên' rồi tự trả nó, tức trả nhầm một hoá đơn KHÁC không liên quan tới task.",
      "Quyền truy cập invoice.stripe.com + checkout.link.com trong manifest GIỮ NGUYÊN (không gỡ): chế độ skip_to_payment vẫn cần để dọn nốt hoá đơn 'Đến hạn' tồn đọng từ các lần mua theo UI cũ. Gỡ bây giờ là mất luôn đường trả những hoá đơn đó.",
      "Đọc tiền viết lại: UI mới ghi 'Tổng phải trả hôm nay' với 'đ' đứng SAU số (27.168 đ), UI cũ ghi 'Tổng đến hạn hôm nay' với 'đ' đứng TRƯỚC. Bản cũ còn có fallback 'lấy cụm tiền đầu tiên gặp trong text' → vớ trúng đơn giá '649.000 đ/tháng' và ghi audit sai ~24 lần số tiền thật. Nay không đoán bừa nữa: không đọc được thì báo không đọc được.",
      "MỚI: đọc cả 'Hóa đơn hằng tháng hiện tại' (12.243.500 đ) và 'Hóa đơn mới hằng tháng' (12.504.000 đ) để ra mức tăng CỐ ĐỊNH mỗi tháng (260.500 đ/suất). Đây mới là khoản tiền lớn — 'Tổng phải trả hôm nay' chỉ là phần lẻ prorate tới cuối chu kỳ.",
      "Số prorate ĐỔI theo từng lần mở modal (user chụp 3 lần: 27.311đ / 27.191đ / 27.168đ vì tính theo số giây còn lại của chu kỳ) → toàn bộ số liệu tiền được đọc MỘT LẦN ngay trước khi bấm xác nhận, không cache, và KHÔNG lấy chênh lệch giữa các lần đọc làm dấu hiệu bất thường (lệch là bình thường, chặn theo kiểu đó là chặn oan mọi lần mua).",
      "Chốt an toàn tiền giữ nguyên (cap 20 suất/task, số suất trong modal phải khớp task, scrape tiền để ghi audit, dedup ở backend) và thêm 2 chốt: (a) modal không đọc được CẢ số suất LẪN tổng tiền thì KHÔNG bấm — nút cuối trừ tiền ngay, thà dừng còn hơn bấm mù; (b) hoá đơn hằng tháng mới THẤP HƠN hiện tại thì dừng, vì đó là modal giảm suất chứ không phải mua thêm.",
      "Sanity check số suất chỉ khớp dòng NÓI VỀ PHẦN THÊM ('Thêm 1 suất Tiêu chuẩn'), không khớp '47 ghế' / '48 ghế' in cạnh đó — bắt nhầm 2 số này là báo lệch oan, hoặc tệ hơn là PASS nhầm khi số ghế tình cờ trùng.",
      "Bộ đếm suất đọc được cả khi con số KHÔNG nằm trong <input> (modal mới hiển thị 47 như text giữa 2 nút): chọn con số nằm GIỮA nút '−' và nút '+' nên không vớ nhầm mẩu '47' của dòng '47 người dùng · 46/47 đã gán' ngay dưới — vớ nhầm chỗ đó thì bấm '+' mãi không thấy số đổi, fail oan.",
      "Mỗi lần bấm '+' chờ tới khi số THỰC SỰ nhích thay vì ngủ 400ms+600ms cố định; nhảy 2 đơn vị (click double-fire) hoặc số giảm (bấm trúng '−') là DỪNG ngay thay vì đi tiếp rồi mua sai số suất.",
      "Nút 'Tiếp tục' bị ChatGPT khoá cho tới khi số suất đổi → nay chờ mở khoá tới 5s rồi mới kết luận bị chặn, thay vì thấy khoá là fail luôn.",
      "RANH GIỚI: luồng MỜI THÀNH VIÊN cũng có modal tên 'Xem lại giao dịch mua' nhưng nút cuối là 'Mua suất người dùng và gửi lời mời' — luồng này CHỦ ĐỘNG bỏ qua dialog nào có nút đó, để không bấm nhầm sang mua-kèm-gửi-lời-mời. Không đụng vào code luồng mời.",
    ],
  },
  {
    version: "0.11.9",
    date: "2026-08-21",
    kind: "fix",
    summary:
      "Thu hồi lời mời: hết bấm nhầm nút 'Hủy' của hộp thoại xác nhận — lời mời còn nguyên mà dashboard báo lỗi lạc đề.",
    details: [
      "Ca vaominh11@gmail.com 21/8/2026: task báo FAILED 'đã click revoke nhưng row vẫn còn', trong khi tab 'Lời mời đang chờ xử lý' trên ChatGPT KHÔNG còn email đó → DB kẹt 1 lời mời ma.",
      "Gốc rễ: danh sách chữ nút XÁC NHẬN có lẫn sẵn 'Hủy'/'Cancel'/'取消', mà code duyệt theo THỨ TỰ và khớp kiểu CHỨA CHUỖI. ChatGPT chỉ cần đổi chữ nút xác nhận là mấy chữ đầu trượt hết, rơi xuống 'Hủy' → khớp đúng nút HUỶ → bấm huỷ → lời mời còn nguyên.",
      "Tách DIALOG_DISMISS_TEXTS (Hủy/Đóng/Quay lại/Cancel/Close/取消/关闭…) khỏi REVOKE_CONFIRM_TEXTS; nút huỷ/đóng bị loại bằng so khớp BẰNG NHAU nên 'Hủy lời mời' (hành động thật) vẫn được nhận.",
      "Không chữ nào khớp (ChatGPT đổi nhãn) → lấy NÚT CUỐI có chữ mà không phải huỷ/đóng, vì hộp thoại luôn đặt nút hành động ở cuối — thà bấm đúng nút hành động còn hơn đứng im rồi để lời mời còn nguyên.",
      "Chờ hộp thoại xác nhận theo RENDER (tối đa 3s) thay cho sleep(800) cứng: dialog hiện chậm hơn 800ms từng bị coi là 'luồng không có dialog' → bỏ luôn bước xác nhận.",
      "Cùng hằng số này được HARVEST_LABELS dùng lại, nên trước đây còn có nguy cơ harvest nhầm nhãn nút 'Hủy' rồi lưu vào ui_labels.confirm_revoke_button — nay hết.",
    ],
  },
  {
    version: "0.11.8",
    date: "2026-08-21",
    kind: "feature",
    summary:
      "Gỡ thành viên: không thấy ở tab 'Người dùng' thì tự sang tab 'Lời mời đang chờ xử lý' thu hồi — phục vụ nút mới 'Chuyển hạn sử dụng đến'.",
    details: [
      "Trước đây REMOVE_MEMBER lọc không ra email ở tab 'Người dùng' là kết luận luôn 'đã rời workspace' → backend mark removed. Nhưng email đó có thể đang là LỜI MỜI CHỜ (mời rồi chưa bấm nhận) ⇒ dashboard nói đã gỡ trong khi lời mời VẪN sống trên ChatGPT, ghế vẫn bị giữ.",
      "Nay nhánh 'absent' sang tab 'Lời mời đang chờ xử lý' và thu hồi: không có ở cả 2 tab ⇒ đã rời thật (ok như cũ); có và thu hồi được ⇒ ok + via_revoke; có nhưng thu hồi không ăn ⇒ REMOVE_VERIFY_FAILED (giữ member, retry) thay vì báo gỡ giả.",
      "Định vị trong tab Lời mời theo đúng luật đã chốt: dưới 1 trang thì quét thẳng vị trí, nhiều trang mới gõ ô 'Search for invites'; và vẫn chờ ChatGPT chốt + quét lại xác nhận (v0.11.7).",
      "Chống ping-pong: executeRevokeInvites gọi ngược executeRemove với allowPendingFallback:false — nó vừa khẳng định email không có ở tab Lời mời rồi.",
      "MỚI revoke/pending-tab.ts (ensurePendingInvitesTab) — dùng chung cho cả 2 đường vào, thay đoạn điều hướng chép tay trong execute-revoke-batch.",
      "Phục vụ nút mới 'Chuyển hạn sử dụng đến' trên dashboard: backend LUÔN enqueue REMOVE_MEMBER cho email cho hạn, không phải đoán status từ DB (DB có thể lệch khi member vừa bấm nhận lời mời mà chưa kịp sync).",
    ],
  },
  {
    version: "0.11.7",
    date: "2026-08-21",
    kind: "fix",
    summary:
      "Đổi vai trò / đổi giấy phép / thu hồi lời mời / đặt giới hạn: bắt buộc CHỜ ChatGPT xử lý xong rồi quét lại xác nhận — hết báo thành công giả làm dashboard lệch ChatGPT.",
    details: [
      "Gốc rễ: backend lấy ok:true của extension làm sự thật và ghi thẳng vào DB (chatgpt_role / license_type / usage_limit_credits). Action nào bấm xong ngủ vài trăm ms rồi báo ok là ChatGPT nuốt lệnh im lặng → DB nói một đằng, ChatGPT một nẻo tới tận lần đồng bộ sau.",
      "CHANGE_LICENSE_TYPE (nặng nhất): trước đây click xong sleep 500ms + 600-1200ms rồi return ok:true, KHÔNG quét lại gì cả. Nay chờ dialog tắt hẳn → lọc lại row 3 lần (cách 2.5s) → đọc cột 'Loại suất cấp phép'; lệch ⇒ VERIFY_FAILED.",
      "CHANGE_ROLE: verify cũ là 'best-effort' — không khớp vẫn ok:true, mà findRowRoleDropdown lại có fallback 'bất kỳ nút có aria-haspopup' nên hỏi role nào cũng PASS. Nay đọc NHÃN THẬT bằng findRoleInRow (map ngược ROLE_LABELS + ui_labels), sai ⇒ VERIFY_FAILED.",
      "REVOKE_INVITES: trước đây bấm confirm xong đo 'row biến mất trong 5s' ngay lúc dialog CÒN QUAY. Nay chờ dialog vắng 4 nhịp liên tiếp (trần 30s) + lớp phủ Radix gỡ, rồi quét lại bằng chính locatePendingRow (1 trang → quét vị trí, nhiều trang → ô Search for invites), tối đa 3 lần cách 3s.",
      "REVOKE batch chia ngân sách xác minh: 110s cho cả batch, mỗi email được phần còn lại / số email còn lại, kẹp [6s, 25s] — task chỉ có 150s nên không cho email đầu ăn hết giờ của email sau.",
      "SET_USAGE_LIMIT: sau khi dialog đóng, chờ lớp phủ gỡ rồi lọc lại row — nút phải chuyển sang 'Chỉnh sửa' (đã có ghi đè). Trang không hiện số credits trên row nên không xác minh được đúng con số; SYNC vẫn là chốt cuối.",
      "Nhịp chờ tách ra content/actions/dialog-commit.ts dùng chung (lấy nguyên từ REMOVE v0.11.5) — sửa nhịp chờ thì sửa một chỗ, không chế lại trong từng action.",
    ],
  },
  {
    version: "0.11.6",
    date: "2026-08-18",
    kind: "fix",
    summary:
      "Xoá/thu hồi/đổi ghế: hết bấm nhầm dropdown vai trò — ChatGPT gỡ data-testid khỏi nút '...' nên extension lấy trúng ô 'Thành viên ⌄' đứng cạnh.",
    details: [
      "Sự cố 18/8/2026: 15 task xoá liên tiếp FAILED_UI_CHANGED với đúng một lỗi 'Menu mở nhưng không có item xoá THÀNH VIÊN. Item thấy: [Member, Analytics Viewer, Admin, Owner]' — 4 item đó là menu VAI TRÒ, tức extension mở nhầm nút. 5 email hết hạn kẹt MEMBER_REMOVE_STUCK phải gỡ tay.",
      "Gốc: ChatGPT gỡ cả `data-testid=\"member-menu-button\"` lẫn `aria-label` khỏi nút '...' (nút vẫn hiện y nguyên trên UI). Hai selector định danh cùng trượt → rơi xuống fallback `button[aria-haspopup=\"menu\"]`, mà dropdown vai trò cũng mang đúng attribute đó và đứng TRƯỚC '...' trong DOM → querySelector trả về dropdown vai trò.",
      "Sửa: `findRowMenuButton` nhận diện '...' theo HÌNH DẠNG thay vì attribute — button mở popup menu và KHÔNG có chữ (kebab chỉ có icon; mọi dropdown trong row đều có nhãn chữ). Lấy nút icon CUỐI row. Bỏ hẳn fallback rộng khỏi `SELECTORS.memberRowMenu`.",
      "Nhiều button popup mà cái nào cũng có chữ → trả null (action fail rõ ràng) thay vì đoán bừa rồi bấm nhầm.",
      "Sửa một chỗ, lành 7 action dùng chung `findRowMenuButton`: REMOVE_MEMBER, REVOKE_INVITES, CHANGE_LICENSE_TYPE, member-data, harvest-labels (+2 probe). Đổi vai trò cũng hết hỏng vì `findRowRoleDropdown` loại trừ theo kết quả của hàm này.",
      "Thêm `member-row.test.ts` khoá lại regression: dựng đúng row 18/8/2026 (dropdown vai trò trước, kebab rỗng chữ sau) và đòi chọn ra kebab.",
    ],
  },
  {
    version: "0.11.5",
    date: "2026-08-13",
    kind: "fix",
    summary:
      "Xoá thành viên: bấm 'Xóa' xong phải chờ dialog TẮT HẲN mới đi tra ô lọc — hết cảnh vừa bấm vừa gõ tìm kiếm liên tục khi ChatGPT còn đang quay spinner.",
    details: [
      "Yêu cầu user 2026-08-13 (kèm ảnh dialog 'Remove member' với nút 'Delete' đang quay): ChatGPT đã đổi hành vi — bấm xác nhận xong dialog KHÔNG đóng ngay mà giữ spinner tới khi server trả lời. Phải chờ dialog tắt hẳn rồi mới tìm kiếm, không được tìm liên tục.",
      "TRƯỚC: tín hiệu 'ChatGPT đã nhận lệnh' là `toast ?? (dialog đóng ? body : null)` chờ tối đa 15s. Toast đứng TRƯỚC trong biểu thức nên chỉ cần toast hiện là đi tiếp — dù dialog CÒN mở và lớp phủ modal vẫn phủ kín trang. Ngay sau đó vòng xác minh gõ email vào ô lọc mỗi 1,5s: event `input` rơi vào lớp phủ, query lọc không chạy → toàn `inconclusive` → gõ lại → gõ lại, đốt sạch 60s ngân sách rồi trả REMOVE_VERIFY_FAILED dù xoá đã thành công.",
      "SAU (content/actions/remove/execute-remove.ts): bỏ hẳn nhánh toast. `waitForConfirmDialogClosed(30s)` poll 300ms và đòi 4 nhịp LIÊN TIẾP không thấy `[role=dialog]`/`[role=alertdialog]` mới coi là tắt hẳn (chống 'chớp tắt' giữa 2 lần render). Hạn 15s → 30s cho vừa nhịp spinner mới.",
      "Sau khi dialog rời DOM còn `waitForModalLockGone(5s)`: Radix để lại lớp phủ + `pointer-events:none`/`data-scroll-locked` trên body thêm một nhịp. Lớp phủ lì quá 5s thì vẫn đi tiếp (best-effort) — thà tra sớm một nhịp còn hơn bỏ luôn phần xác minh.",
      "Vòng xác minh giãn ra: nghỉ 2s cho ChatGPT refetch list, rồi tra TỐI ĐA 3 lần, cách nhau 3s (trước: lặp liên tục cách 1,5s tới khi hết 60s). Mỗi lần `filterOnceAndResolve` vốn đã tự gõ 2 vòng lọc độc lập + positive control (~15-25s) nên gõ dồn chỉ khiến Chrome nuốt event chứ không sớm ra kết quả. Trần 60s giữ nguyên để không phá ngân sách 150s của task.",
      "KHÔNG nới chỗ nào của hàng rào chống xoá-giả: vẫn phải 2 vòng lọc độc lập cùng trống + ô lọc chứng minh còn sống mới kết luận 'đã rời workspace'; dialog quá 30s không tắt vẫn là VERIFY_FAILED (nay ghi rõ 'nút xác nhận vẫn đang quay' hay 'dialog đứng im' để soi OTP/2FA); tra hết 3 lần mà member vẫn còn thì vẫn REMOVE_VERIFY_FAILED, giữ member active để tick sau thử lại.",
    ],
  },
  {
    version: "0.11.4",
    date: "2026-08-13",
    kind: "fix",
    summary:
      "Mời xong xác minh NGAY tại tab 'Lời mời đang chờ xử lý' — thấy đủ email thì bỏ hẳn vòng F5 (~10s). Chỉ khi danh sách có từ 2 trang trở lên mới gõ email vào ô tìm kiếm.",
    details: [
      "Yêu cầu user 2026-08-13: dialog mời của ChatGPT phản hồi chậm, NHƯNG vừa chuyển sang tab 'Lời mời đang chờ xử lý' là thấy người vừa mời ngay. Vậy nên: gửi lời mời xong → sang tab Lời mời → QUÉT thành viên; không thấy mới F5 rồi quét lại. Danh sách lời mời không bao giờ quá 1 trang nên KHÔNG gõ email vào ô tìm kiếm, chỉ khi thật sự ≥ 2 trang mới gõ.",
      "TRƯỚC: Phase 1 chuyển tab xong chỉ đợi DOM 'đứng yên' (waitForPendingListStable) rồi trả về cho background F5 — vòng verify LUÔN chạy dù email đã hiện sẵn trước mắt: 1-3 lần reload tab + ngân sách ~10s cho mọi lệnh mời. Phase 2 lại mở đầu bằng cách gõ từng email vào ô tìm kiếm (~1s/email) kể cả khi danh sách chỉ 1 trang.",
      "SAU (content/actions/invite/scan-pending-page.ts — MỚI): `scanPendingForEmails(emails, timeout)` vào tab Lời mời, poll DOM 400ms/nhịp, trả về NGAY khi thấy đủ email; danh sách đã render và đứng yên 4 nhịp (sau tối thiểu 3s) mà vẫn thiếu thì dừng sớm, nhường việc cho F5. Ô tìm kiếm chỉ dùng khi `findPaginationState()` báo ≥ 2 trang, và chỉ cho các email còn thiếu.",
      "Phase 1 (execute-invite.ts) quét tối đa 8s: THẤY ĐỦ ⇒ bỏ `awaiting_reload_verify` và trả thẳng verified_emails + pending_members ⇒ runner đi luôn tới reportToBackend, không F5 lần nào. CÒN THIẾU ⇒ giữ nguyên đường cũ (runner F5 + Phase 2 quét lại tối đa 5s/vòng).",
      "CHỐNG XÁC MINH GIẢ: toast 'Đã gửi lời mời tới a@b.com' và dialog mời đều CHỨA chính email vừa mời. Bộ quét loại trừ subtree [role=dialog]/[role=status]/[role=alert]/toast trước khi kết luận 'email đã có trong danh sách' — nếu không sẽ bỏ qua F5 dựa trên đúng cái toast, đúng kiểu nhầm dẫn tới mời hỏng mà báo thành công.",
      "verify-pending-via-filter.ts đổi tên thành search-pending-by-email.ts, thu lại còn đúng phần gõ ô tìm kiếm (`searchPendingForEmails`, giả định đã ở tab Lời mời) và nay là nhánh phụ ≥2 trang thay vì đường chính. wait-for-pending-list-stable.ts bị xoá — vòng poll của bộ quét đã bao trọn vai trò 'đợi list render xong'.",
      "KHÔNG đụng tới phần phán xử tiền bạc: verified/unverified/verify_scrape_failed + submit_evidence vẫn nguyên nghĩa, decideInviteOutcome và cơ chế salvage (Phase 1 chết vô định → F5 phân xử) giữ y như v0.11.3. Thay đổi ở đây chỉ là 'tìm bằng chứng sớm hơn và rẻ hơn'.",
    ],
  },
  {
    version: "0.11.3",
    date: "2026-08-12",
    kind: "fix",
    summary:
      "Mời THÀNH CÔNG mà báo lỗi + hoàn tiền: bịt 2 lỗ hổng khiến 'không xác minh được' bị hiểu là 'mời hỏng'. Email vẫn vào được team nhưng ví được hoàn phí và kỳ đã trả bị xoá → ghế dùng miễn phí.",
    details: [
      "Bug (production 12/8/2026, 2 ca do user báo): CA 1 (19:30:51 → FAILED 19:31:20, hoàn 330.000đ) và CA 2 (20:13:29 → FAILED 20:15:11, hoàn 340.000đ). Cả hai mang mã VERIFY_FAILED. 10 ngày trước đó 33 lệnh mời đều COMPLETED ⇒ không phải UI ChatGPT đổi, mà là 2 lỗ hổng nằm sẵn trong chính cơ chế 'không thấy ≠ không gửi' của v0.11.1.",
      "LỖ HỔNG 1 (runner.ts, CA 1): SALVAGE 'đừng kết luận hỏng vội, F5 soi tab Lời mời/Người dùng' của v0.10.1 CHỈ nhận 2 kiểu lỗi hạ tầng — CONTENT_TIMEOUT và 'message channel closed' — nên bỏ sót đúng loại hay xảy ra nhất: đã bấm 'Gửi lời mời' rồi chờ 15s không đọc được toast lẫn dialog-đóng ⇒ VERIFY_FAILED. Task này báo FAILED khi vòng F5 CHƯA HỀ CHẠY (result NULL trong DB), tức chưa đi tìm bằng chứng nào đã kết luận hỏng.",
      "LỖ HỔNG 2 (runner.ts, CA 2): `response = verifyResp` (Phase 2) GHI ĐÈ data của Phase 1, mà data Phase 2 không có `submit_evidence` → decideInviteOutcome luôn đọc 'unknown' ⇒ nhánh 'trusted-toast' — thứ v0.11.1 viết ra CHÍNH ĐỂ chặn mất tiền — chưa từng chạy được lần nào. Bằng chứng: result của task ghi submit_evidence='unknown', outcome_reason='total-miss'.",
      "HẬU QUẢ (giống nhau cả 2 ca): backend hiểu FAILED = mời hỏng → hoàn phí + `void_refunded_invite_periods` xoá sạch kỳ đã trả. CA 1 còn kẹt trạng thái 'chờ tham gia' với hạn NULL (bộ lọc xoá phantom cần joined_at IS NULL, mà invite.py đã đặt joined_at = lúc mời) nên dashboard hiện 'Vô hạn' — ghế dùng MIỄN PHÍ vô thời hạn; CA 2 bị mark 'removed' nên biến mất khỏi danh sách gia hạn.",
      "FIX 1 — background/invite-salvage.ts (MỚI, 6 test): ranh giới 'VÔ ĐỊNH' ≠ 'HỎNG'. Đã bấm Gửi rồi mất dấu (VERIFY_FAILED + submit_clicked, CONTENT_TIMEOUT, channel closed) ⇒ F5 phân xử, chỉ báo COMPLETED khi THẤY email ở tab Lời mời/Người dùng. CHƯA bấm Gửi (EXTERNAL_TOGGLE_FAILED, UI_ELEMENT_NOT_FOUND, FAILED_UI_CHANGED, PAGE_NOT_ADMIN, NOT_LOGGED_IN) ⇒ biết chắc mời không đi, hoàn phí vẫn ĐÚNG. Chính ChatGPT báo lỗi trong dialog (email trùng / không hợp lệ / hết ghế) ⇒ bằng chứng DƯƠNG là không đi, giữ FAILED.",
      "FIX 2 — content/execute-invite-inner.ts gắn `data: { submit_clicked: true, chatgpt_error_hint }` vào chính response VERIFY_FAILED (shared/messages.ts cho phép response lỗi mang data cho ĐÚNG loại lỗi vô định này) để background biết cú click đã xảy ra thật, không phải suy từ text lỗi.",
      "FIX 3 — runner.ts bơm lại submit_evidence của Phase 1 vào data Phase 2 trước khi quyết định ⇒ nhánh 'trusted-toast' sống lại: ChatGPT đã báo 'đã gửi lời mời' mà tab Lời mời index trễ thì task ra COMPLETED + email ở diện chưa xác minh, backend hoãn 10 phút rồi resolver 20 phút mới chốt bằng bằng chứng (thay vì hoàn phí sau 100 giây).",
      "FIX 4 — BACKEND (hàng rào cuối, vì extension vẫn có thể bó tay khi ChatGPT index chậm hơn cả vòng F5): task FAILED mà extension báo kèm `result.submit_clicked` ⇒ `defer_unverified_invite` HOÃN phán xử — KHÔNG hoàn phí, KHÔNG xoá bản ghi, KHÔNG void kỳ — chỉ ghi 'Chờ xác minh' + enqueue mẻ đồng bộ ĐI XEM tab Người dùng ngay. Quá 20 phút vẫn không ai thấy email thì resolver mới chốt hỏng + hoàn phí. Nhờ vậy đường FAILED và đường COMPLETED-chưa-xác-minh nay đối xứng: tiền chỉ chuyển khi CÓ bằng chứng.",
      "FIX 5 — BACKEND: hoàn phí thì void kỳ bằng cách đặt hạn dùng = HẾT HẠN NGAY, không phải NULL. NULL nghĩa là 'vô thời hạn' (EXPIRY_RULES §5) nên bản ghi sống sót vừa thoát lượt quét gỡ email hết hạn, vừa hiện 'Vô hạn' trên dashboard — đúng cách 1 trong 2 ca thành ghế miễn phí vĩnh viễn mà không có tín hiệu nào.",
      "FIX 6 — BACKEND, bịt nốt ca extension CHẾT HẲN sau khi bấm Gửi (service worker bị kill / tab đóng → không có báo cáo nào để mang bằng chứng về): task treo quá 3 phút giờ cũng HOÃN phán xử thay vì hoàn phí ngay. Trước đây đây là lớp cuối còn 'đoán': đoán sai một lần là một ghế dùng miễn phí vĩnh viễn. Hoãn không bao giờ làm MẤT tiền, chỉ làm tiền về ví muộn hơn — nên đổi lấy sự an toàn là đúng.",
      "KHÔNG nới lỏng chỗ nào khác: quét được cả 2 tab mà trắng tay VÀ không có xác nhận nào từ ChatGPT thì vẫn FAILED + hoàn phí như cũ; lỗi TRƯỚC khi bấm Gửi (không bật được toggle mời-ngoài-miền, không tìm thấy nút…) vẫn hoàn phí NGAY — giam tiền đại lý khi biết chắc lời mời không đi cũng là sai. Đánh đổi: ca lỗi-sau-khi-click nay chậm thêm ~10-30s (vòng F5), và nếu thật sự hỏng thì tiền về ví sau ~20 phút thay vì ~1-3 phút.",
    ],
  },
  {
    version: "0.11.2",
    date: "2026-08-12",
    kind: "fix",
    summary:
      "Hết XOÁ-GIẢ: không còn kết luận 'email đã rời workspace' chỉ vì ô lọc chưa kịp trả kết quả. Email hết hạn bị báo đã xoá nhưng vẫn nằm trên ChatGPT (vẫn ăn ghế) — im lặng nhiều ngày tới lần đồng bộ sau.",
    details: [
      "Bug (production 03→12/8/2026): 4 email bị đánh dấu removed bằng bằng chứng 'absent_confirmed' (không click xoá lần nào), nhưng thực tế VẪN còn trên ChatGPT. Bằng chứng dứt điểm: một email bị báo 'absent' lúc 08:01 rồi chính extension tìm thấy và click xoá được lúc 08:07 cùng buổi. Dashboard giấu email 'removed' khỏi danh sách gia hạn → mù hoàn toàn tới khi có người bấm đồng bộ (lần trước đó cách 11 ngày).",
      "ROOT CAUSE (member-filter.ts filterOnceAndResolve): đo 'ô lọc đã chạy query' bằng ĐÚNG MỘT dấu hiệu — số row khác lúc chưa lọc — rồi chờ 1.2s là chốt. Cả hai vế đều thủng: (a) mỗi lệnh mở TAB MỚI /admin/members nên lúc lấy mốc `rows_before` list còn đang đổ row → số row TỰ TĂNG, không liên quan gì tới query lọc; (b) lọc của ChatGPT là server-side, list nháy trống rồi mới đổ row khớp → 1.2s quá ngắn nên bắt trọn khoảng nháy đó.",
      "FIX: chỉ trả 'absent' khi hội đủ — (1) list phải ĐỨNG YÊN (3 lần đếm liên tiếp bằng nhau) trước khi gõ, không đứng yên trong 8s ⇒ 'inconclusive'; (2) sau khi list phản hồi mà chưa thấy row thì soi tiếp 6s để bắt row về TRỄ; (3) POSITIVE CONTROL — clear ô lọc, list PHẢI đầy lại, không đầy lại ⇒ 'inconclusive' (ô lọc không điều khiển được list); (4) phải 2 VÒNG lọc độc lập cùng trống. Đây đúng là hợp đồng mà backend vẫn ghi trong completion.py nhưng bản cũ chưa hề thực thi.",
      "Vòng xác minh SAU KHI CLICK: 45s → 60s (mỗi lần tra giờ tốn hơn vì 2 vòng), bỏ chờ 'list đứng yên' (list vừa bị chính cú click làm đổi) nhưng vẫn giữ 2 vòng — false-absent ở đây cũng là xoá-giả.",
      "Đánh đổi: mỗi lệnh xoá tốn thêm ~10-20s và số ca 'inconclusive' (FAILED, giữ member, tick sau thử lại) sẽ tăng. Chấp nhận: thà chậm/thử lại còn hơn báo đã-xoá GIẢ.",
      "6 test hồi quy (member-filter.test.ts) dựng lại đúng các kiểu 'list nói dối': row về trễ 4s, list còn đang stream, ô lọc bị nuốt event, ô lọc chết giữa chừng.",
      "BACKEND kèm theo: đồng bộ thấy lại email vừa bị mark removed bằng 'absent_confirmed' ⇒ ghi MEMBER_REMOVE_FAKE_DETECTED (nhật ký + thẻ chi tiết member) kèm số giờ đã mù, thay vì trôi qua im lặng như trước.",
    ],
  },
  {
    version: "0.11.1",
    date: "2026-08-04",
    kind: "fix",
    summary:
      "Mời xong không kết luận hỏng vội nữa: tin thông báo 'đã gửi lời mời' của ChatGPT hơn việc email đã kịp hiện trong danh sách chờ hay chưa. Ngân sách kiểm tra 10s → 30s.",
    details: [
      "Bug: quét tab 'Lời mời đang chờ xử lý' trong 10 giây mà không thấy email nào ⇒ báo FAILED. Backend hiểu FAILED = mời hỏng → hoàn phí + xoá bản ghi, trong khi lời mời có thể ĐÃ gửi thật (người nhận vẫn vào được team) → email dùng miễn phí, sổ sách sai.",
      "Phạm vi thực tế (đã kiểm chứng trên production): 19/77 ca lỗi mang mã VERIFY_FAILED nhưng ca gần nhất là 13/7, trong khi hệ thống bắt đầu thu phí 15/7 — nên CHƯA ca nào làm mất tiền. Đây là vá phòng ngừa cho giai đoạn đã có thu phí, không phải sửa thiệt hại đang xảy ra.",
      "content/execute-invite-inner.ts phân biệt 2 mức bằng chứng: 'toast' (đọc được chữ xác nhận theo INVITE_SUCCESS_TOAST_PATTERNS — vi/en/zh) và 'dialog_closed' (chỉ thấy hộp thoại đóng). Trước đây gộp làm một.",
      "background/invite-outcome.ts (MỚI, có test): có toast xác nhận mà danh sách chưa hiện ⇒ KHÔNG báo hỏng và KHÔNG dọn phantom — trả COMPLETED + để email ở diện chưa xác minh, backend hoãn 10 phút rồi resolver 20 phút phân xử bằng bằng chứng. Không có xác nhận nào + quét sạch mà trắng tay ⇒ vẫn FAILED như cũ.",
      "KHÔNG chèn nhịp nghỉ cố định quanh F5 (đã cân nhắc rồi bỏ — user 2026-08-04): mời trót lọt là ca gần như luôn xảy ra, bắt mỗi lệnh chờ thêm 6 giây để phòng một rủi ro hiếm là đắt. Chỉ nới trần ngân sách để ca CHẬM có thêm cơ hội, ca nhanh không mất gì.",
    ],
  },
  {
    version: "0.11.0",
    date: "2026-08-04",
    kind: "feature",
    summary:
      "2 action MỚI: Xuất dữ liệu / Xoá dữ liệu 1 thành viên (2 mục ChatGPT vừa thêm vào menu '...'). Quyền riêng, mặc định TẮT với mọi tài khoản phụ — chỉ admin dùng được.",
    details: [
      "Yêu cầu user 2026-08-04: làm luôn 2 action, nút mặc định LÀM MỜ, quyền tắt sẵn khi tạo tài khoản mới lẫn tài khoản hiện có, chỉ admin dùng.",
      "EXTENSION: actions/member-data/ (execute-member-data.ts) — lọc email ở tab Người dùng → mở menu '...' → chọn ĐÚNG mục theo kind (loại trừ chéo với mục kia + 'Loại bỏ thành viên') → chốt tiêu đề dialog → bấm xác nhận → verify dialog đóng. Không thấy dialog lẫn toast ⇒ FAILED (không báo thành công giả cho thao tác không hoàn tác).",
      "menu-guard.ts chuyển từ actions/remove/ lên actions/ (dùng chung REMOVE + 2 action mới): thêm pickDataMenuItemIndex + isDataTextOfKind, 26 test.",
      "RUNNER: taskToRequest 2 kind mới, CONTENT_TIMEOUTS 150s, thêm vào MEMBER_LIST_TASKS (ép tab về /admin/members sạch) và DRY_RUN_BLOCKED_TYPES.",
      "BACKEND: quyền MEMBER_EXPORT_DATA / MEMBER_DELETE_DATA (GRANTABLE nhưng KHÔNG default, KHÔNG backfill), QueueType EXPORT_MEMBER_DATA / DELETE_MEMBER_DATA, endpoint POST /members/{id}/export-data | delete-data (chỉ member active, idempotent theo task đang mở), ngưỡng treo 3 phút.",
      "WEB: 2 mục trong menu '⋯' của member đang hoạt động — luôn hiện nhưng LÀM MỜ khi chưa được cấp quyền; 'Xoá dữ liệu' là mục danger có xác nhận riêng.",
    ],
  },
  {
    version: "0.10.2",
    date: "2026-08-04",
    kind: "fix",
    summary:
      "ChatGPT thêm 'Xuất dữ liệu' + 'Xoá dữ liệu' vào menu '...' của member ĐÃ THAM GIA. Chặn cứng để REMOVE_MEMBER không bao giờ click nhầm 'Xoá dữ liệu' (xoá sạch dữ liệu member, không hoàn tác).",
    details: [
      "User report 2026-08-04 (ảnh UI vi + en): menu row member đã tham gia giờ có 3 mục — Xuất dữ liệu / Xoá dữ liệu / Loại bỏ thành viên (Export data / Delete data / Remove member).",
      "Rủi ro: TEXT_FALLBACKS.removeMenuItem chứa nhãn lỏng 'Xoá', 'Xóa', 'Delete', '删除'. Hôm nay nhãn đúng ('Loại bỏ thành viên') vẫn khớp trước nên chưa sai, nhưng ChatGPT đổi chữ 1 lần nữa (đã đổi ở v0.4.4, v0.7.14) là fallback rơi trúng 'Xoá dữ liệu' — dialog đó cũng có nút đỏ 'Xóa' nên confirm bấm luôn.",
      "menu-guard.ts (mới, thuần hàm + test): deny-list nhãn 'Xuất/Xoá dữ liệu' cho cả 3 locale; chọn item theo 2 vòng — khớp CHÍNH XÁC trước, substring sau; item dữ liệu bị loại ở mọi vòng.",
      "execute-remove.ts: lọc cả label DB `menu_remove_member` (harvest nhầm → reportLabelMismatch + bỏ qua), lọc cả kết quả selector CSS, và CHỐT CHẶN CUỐI — tiêu đề dialog vừa mở phải KHÔNG phải 'Xoá dữ liệu', nếu nhầm thì ESC + FAILED_UI_CHANGED thay vì bấm xác nhận.",
      "harvest-labels: không bao giờ ghi item 'Xuất/Xoá dữ liệu' vào `menu_remove_member` (harvest có click thử item để đọc dialog → ghi nhầm là hỏng vĩnh viễn).",
      "Không đổi hành vi khi UI bình thường: menu 3 mục vẫn chọn đúng 'Loại bỏ thành viên'/'Remove member'/'移除成员' (19 test).",
    ],
  },
  {
    version: "0.10.1",
    date: "2026-08-01",
    kind: "fix",
    summary:
      "SALVAGE verify cho INVITE: mất kết nối content giữa chừng (kết quả vô định) → F5 + kiểm tra tab Lời mời/Người dùng để phân xử, KHÔNG báo FAILED oan. Sync trả đích danh email được thêm/gỡ để dashboard pop-up thay đổi.",
    details: [
      "Bug user 2026-08-01: mời THÀNH CÔNG nhưng báo thất bại — kênh message chết ('message channel closed') sau khi content đã click Send → runner báo FAILED → backend hoàn phí + xoá phantom, nhưng người được mời vẫn nhận lời mời → sync auto-create member 'chưa thanh toán' (mất phí oan).",
      "Fix: lỗi VÔ ĐỊNH (channel closed / CONTENT_TIMEOUT) với INVITE_MEMBER → chạy chính vòng verify Phase 2 (F5 + VERIFY_PENDING_INVITE + CHECK_ACTIVE_AFTER_INVITE) để phân xử: thấy ≥1 email → COMPLETED thật (đánh dấu salvaged_after_indeterminate_error); không thấy / verify lỗi → giữ nguyên FAILED gốc → hoàn phí như cũ.",
      "SYNC_DATA result thêm created_emails/removed_emails (backend cap 50/list) → TaskCompletionBanner liệt kê '➕ email ChatGPT có mà hệ thống chưa có' và '➖ email hệ thống có mà ChatGPT không còn'.",
    ],
  },
  {
    version: "0.10.0",
    date: "2026-07-27",
    kind: "feature",
    summary:
      "Tự động ĐÓNG tab chatgpt.com/admin khi không dùng đến sau một khoảng NGẪU NHIÊN (~10 phút → ~1 tiếng). Không đóng khi đang chạy task hoặc user đang mở/xem tab đó.",
    details: [
      "Yêu cầu USER 2026-07-27: tab admin để lâu không dùng thì tự đóng, thời gian random không cố định (hợp triết lý 'thao tác như người dùng thật').",
      "Alarm ~1 phút/lần quét tab admin; mỗi phiên idle bốc 1 ngưỡng random trong [10, 60] phút.",
      "'Không dùng' = extension không chạy task (markAdminActivity) VÀ user không xem tab (tab.active=false, tab.lastAccessed cũ).",
      "Đang chạy task (runnerBusy) → KHÔNG đóng, tránh cắt ngang. Task kế tiếp tự mở lại tab admin như cũ.",
      "File mới: src/background/idle-close.ts; wire vào background/index.ts (alarm) + runner.ts (đánh dấu hoạt động).",
    ],
  },
  {
    version: "0.9.31",
    date: "2026-07-26",
    kind: "fix",
    summary:
      "Đếm ĐÚNG số seat trên hoá đơn gia hạn nhiều proration: lấy dòng '(per seat)' trọn tháng (46) thay vì subtotal÷đơn_giá (54 — sai vì subtotal gồm proration). Nhờ đó giá/seat, tổng seat, dự kiến kỳ sau đều đúng.",
    details: [
      "USER cung cấp toàn bộ chi tiết hoá đơn 0025 + giải thích cơ chế prorated billing: seat thật = 46 (dòng '(per seat)'), đơn giá 260.500, tiền gia hạn kỳ sau = 46×260.500 = 11.983.000 (KHÔNG phải 15.607.218 = đã gồm 2.205.380 proration kỳ trước).",
      "invoice-detail.ts: thêm parseFullMonthSeat — dòng '(per seat)' trọn tháng có line-total = seat×đơn giá; Stripe nối 'Số lượng 46'+'11.983.000' → tách sao cho phần còn lại = seat×đơn giá → chỉ dòng chính khớp (proration không khớp). parseQuantity ưu tiên cách này trước subtotal÷đơn_giá.",
      "Test regression theo đúng text hoá đơn 0025: seat=46 (không phải 54), đơn giá 260.500, subtotal 14.188.380, tổng 15.607.218, chu kỳ 25/7→25/8.",
      "Hệ quả: web (kể cả bản đang deploy) đọc quantity=46 → Tổng seat 46, giá/seat 286.550, dự kiến 46×286.550 — đúng, không cần deploy lại web.",
    ],
  },
  {
    version: "0.9.30",
    date: "2026-07-25",
    kind: "fix",
    summary:
      "Sau khi mở panel chi tiết hoá đơn → CUỘN xuống đáy để render toàn bộ (dòng Tổng phụ / Số tiền đến hạn / 'Mỗi' / chu kỳ nằm ở CUỐI, không cuộn thì chưa vào DOM → đọc rỗng).",
    details: [
      "USER: đã mở được panel chi tiết; cần cuộn tab đó đến cuối để lấy toàn bộ hoá đơn.",
      "stripe-invoice.ts: thêm scrollDetailPanelToBottom — cuộn mọi container cuộn được xuống đáy theo từng bước (kích hoạt lazy render). Gọi trong vòng poll sau khi mở panel, trước khi scrape. Tăng deadline 14s → 20s cho hoá đơn nhiều dòng.",
    ],
  },
  {
    version: "0.9.29",
    date: "2026-07-25",
    kind: "fix",
    summary:
      "Bấm 'Xem chi tiết hóa đơn' chỉ 1 LẦN (bản cũ bấm cả nút lẫn ancestor = 2 lần → mở rồi ĐÓNG ngay → panel không hiện). Thêm log chẩn đoán nút.",
    details: [
      "USER REPORT 2026-07-25: đã tìm ra nút nhưng panel chi tiết bên phải vẫn không hiện khi extension bấm.",
      "ROOT CAUSE: openInvoiceDetailPanel bấm `clickable` (ancestor a/button/[class*=link]) RỒI bấm cả `toggle` → 2 lần bấm cùng 1 handler toggle → mở panel xong ĐÓNG ngay → luôn ở trạng thái đóng → no_detail.",
      "FIX: chỉ bấm 1 LẦN đúng vào nút (span text) — React nhận qua bubbling nên đủ. Vòng lặp sau thấy nút đổi thành 'Đóng chi tiết' → không bấm lại → panel giữ mở.",
      "Thêm log DIAG: khi vẫn fail, in ra text các nút chứa 'chi tiết' + số iframe + độ dài body — để chẩn đoán chính xác nếu còn vướng.",
    ],
  },
  {
    version: "0.9.28",
    date: "2026-07-25",
    kind: "fix",
    summary:
      "GỐC RỄ của lỗi không đọc được chi tiết hoá đơn: nút UI là 'Xem chi tiết hóa đơn' (dấu trên 'o') nhưng regex chỉ khớp 'hoá' (dấu trên 'a') → không tìm ra nút → panel không mở → no_detail. Nay khớp cả 2 kiểu bỏ dấu.",
    details: [
      "USER REPORT 2026-07-25: 'sửa mãi vẫn lỗi' — trang Thanh toán vẫn trống dù đã mở tab foreground.",
      "ROOT CAUSE: DETAIL_TOGGLE_RE dùng `ho[áà]` (khớp 'hoá' — dấu sắc trên 'a'), nhưng Stripe UI hiển thị 'Xem chi tiết hóa đơn' ('hóa' — dấu sắc trên 'o', ký tự Unicode khác). Regex trượt → findDetailToggle trả null → panel không mở → mọi parser đọc rỗng → no_detail. Deterministic, không phải do timing/layout.",
      "FIX: tách hàm isDetailToggleText sang invoice-detail.ts (thuần, test được). Nhận diện nút CHỈ cần bắt đầu bằng 'Xem chi tiết' / 'View details' — khớp cả 'hoá'/'hóa', vẫn LOẠI nút 'Đóng chi tiết' (bắt đầu bằng 'Đóng').",
      "LƯU Ý: web dashboard cần deploy lại để Tổng seat lấy từ tab Kế hoạch (46) — nếu chưa deploy, web cũ hiển thị seat theo hoá đơn (proration nên lệch).",
    ],
  },
  {
    version: "0.9.27",
    date: "2026-07-25",
    kind: "fix",
    summary:
      "Đọc chi tiết hoá đơn: mở tab Stripe HIỆN LÊN (foreground) để nút 'Xem chi tiết hoá đơn' bấm mở được panel (tab nền không vẽ layout → bấm trượt → đọc rỗng). Gỡ quét hoá đơn chu kỳ trước (thừa, chậm).",
    details: [
      "USER REPORT 2026-07-25: sync xong trang Thanh toán vẫn trống + phiên bản trước còn quét cả hoá đơn chu kỳ trước làm chậm.",
      "payment-chain.ts (scrapeInvoiceDetailInTab): mở tab hoá đơn Stripe active:true (foreground). Tab nền không được trình duyệt vẽ layout → getBoundingClientRect=0 → cú bấm 'Xem chi tiết hoá đơn' bằng toạ độ trượt → panel không mở → đọc rỗng (no_detail). Foreground: panel mở chắc + người dùng xem được từng bước; đọc xong đóng tab, focus trả về.",
      "runner.ts: gỡ bước mở thêm hoá đơn chu kỳ TRƯỚC làm giá tham chiếu (chỉ đọc hoá đơn trong chu kỳ hiện tại — nhanh, đúng phạm vi).",
    ],
  },
  {
    version: "0.9.26",
    date: "2026-07-25",
    kind: "fix",
    summary:
      "Trang Thanh toán không còn trống khi hoá đơn gia hạn (nhiều dòng proration) đọc chi tiết fail. Tổng seat lấy từ tab Kế hoạch, tổng chi lấy từ list hoá đơn — không cần chi tiết. Giá/seat ước tính từ hoá đơn kỳ trước.",
    details: [
      "USER REPORT 2026-07-25: sau khi sync thành công (plan/seat 46/46 PAID) trang Thanh toán vẫn trống — do hoá đơn gia hạn 25/7 nhiều dòng proration đọc chi tiết Stripe không ra số, web rơi vào no_detail và bỏ hết mọi số.",
      "web billing-math.ts: KHÔNG còn bỏ hết khi thiếu đơn giá. Tổng seat = số seat tab Kế hoạch (seatCount, '46/46'); Tổng chi chu kỳ = Σ số tiền hoá đơn trong kỳ (từ list). Giá/seat + dự kiến: điền từ hoá đơn kỳ TRƯỚC còn đơn giá (ước tính, badge 'ước tính'); nếu không có thì để '—' nhưng seats + tổng chi vẫn hiện.",
      "web: Tổng seat ưu tiên số tab Kế hoạch (chuẩn, không lệch bởi proration) thay vì quantity hoá đơn (subtotal÷đơn_giá của hoá đơn proration bị sai, vd 54 thay vì 46).",
      "runner.ts: nếu không hoá đơn nào trong chu kỳ cho được đơn giá → mở thêm hoá đơn kỳ TRƯỚC gần nhất (gia hạn đơn giản, đọc chắc) làm giá tham chiếu cho web ước tính.",
    ],
  },
  {
    version: "0.9.25",
    date: "2026-07-25",
    kind: "fix",
    summary:
      "Chu kỳ billing lấy CHUẨN theo 'Current cycle' tab Kế hoạch (không còn suy nhầm từ hoá đơn mới nhất). Đúng ngày renew mà hoá đơn chu kỳ mới chưa lên → không còn báo 'cycle_ended', mà ước tính giá theo chu kỳ trước × số seat hiện tại.",
    details: [
      "USER REPORT 2026-07-25: logic đọc invoice sai khi cập nhật giá & ngày renew — cần đọc 'Current cycle' ở tab Kế hoạch TRƯỚC làm chuẩn, rồi mới đối chiếu hoá đơn vào cửa sổ chu kỳ đó.",
      "runner.ts (enrichInvoicesWithDetails): biên chu kỳ lấy từ billing.renewal_date (ngày kết thúc 'Current cycle') = [renewal − 1 tháng lịch, renewal). renewal_date GIỮ theo tab Kế hoạch, KHÔNG để period_end hoá đơn kỳ trước ghi đè (bug cũ khiến đúng ngày 25 khoá nhầm chu kỳ trước → web báo cycle_ended).",
      "billing.ts: parseRenewalDateVi nay parse thêm dải ngày TIẾNG ANH ('Current cycle: Jul 25 - Aug 25') — trước chỉ VI/ZH → trang Kế hoạch tiếng Anh cho renewal=null.",
      "web billing-math.ts: chu kỳ chuẩn = workspaceRenewalIso (tab Kế hoạch) ưu tiên; period hoá đơn chỉ tinh chỉnh cycle_start / dự phòng. Đúng ngày renew chưa có hoá đơn → note 'estimated': giá/seat + dự kiến ước tính theo hoá đơn gốc chu kỳ TRƯỚC × số seat hiện tại. Panel hiện badge 'ước tính'.",
    ],
  },
  {
    version: "0.9.24",
    date: "2026-07-22",
    kind: "fix",
    summary:
      "\"Lời mời chờ xử lý\" hết lỗi UI_ELEMENT_NOT_FOUND khi tab Lời mời TRỐNG — tab trống là kết quả hợp lệ, không phải lỗi. Nay vẫn gửi reconcile để backend đối chiếu với danh sách chờ tham gia của dashboard.",
    details: [
      "USER REPORT 2026-07-22: 'lệnh đồng bộ lời mời mới nhất lỗi, không sử dụng được — nguyên nhân là nó không đối chiếu email của trang quản trị và tab lời mời chờ xử lý'. Bằng chứng DB: 2 task SYNC_DATA scope=invites gần nhất (09:35, 09:53) đều FAILED `UI_ELEMENT_NOT_FOUND: Không tìm được row member nào (tab1=false, ~10s)`. Dashboard đang có 14 member 'pending'.",
      "ROOT CAUSE 1 (execute-sync.ts): guard `members.length === 0 → FAILED` viết cho ca scrape HỎNG, nhưng với scope=invites thì tab Lời mời TRỐNG (mọi lời mời đã được nhận) cũng ra 0 row → task chết ngay, backend không nhận được gì. Trớ trêu: ĐÂY MỚI LÀ CA CẦN ĐỐI CHIẾU NHẤT — 14 pending trên dashboard mà tab Lời mời trống ⇒ cả 14 đều đáng nghi đã tham gia. Thêm cờ `invitesTabFound` (URL đã đổi sang ?tab=invites) để phân biệt 'tab rỗng THẬT' với 'không vào được tab': rỗng-thật ⇒ ok, không-vào-được ⇒ vẫn FAILED như cũ. Scope có 'active' thì 0 row VẪN luôn là lỗi (tab Người dùng rỗng = scrape hỏng, reconcile theo đó sẽ xoá oan cả team).",
      "ROOT CAUSE 2 (runner.ts): bước reconcile bị gate `if (members.length > 0)` nên kể cả action trả ok với danh sách rỗng thì cũng KHÔNG gọi bulk-upsert → không có `reconcile_emails` tường minh → backend không biết tab Lời mời rỗng thật hay scrape hỏng. Thêm ngoại lệ `invitesTabEmptyButValid` (scope=invites + invites_tab_ok) → gửi reconcile với danh sách RỖNG TƯỜNG MINH.",
      "AN TOÀN: reconcile scope=['pending'] KHÔNG được phép mark removed (removal_scopes bỏ 'pending' khi thiếu 'active' — reconcile.py), nên đường đi mới chỉ dẫn tới TRA THÊM chứ không tới xoá. Kể cả khi scrape tab Lời mời sót row, hậu quả xấu nhất là tra thừa vài email ở tab Người dùng → không thấy → giữ pending.",
      "Kèm theo: action trả thêm `invites_tab_ok`/`active_tab_ok`; error_message ghi cả `invitesTab=` (trước chỉ có `tab1=` là cờ tab NGƯỜI DÙNG, luôn false ở scope=invites nên vô dụng cho chẩn đoán); runner log số email lệch + id task tra tab Người dùng.",
      "File: content/actions/sync/execute-sync.ts, background/runner.ts, shared/api.ts, version.ts.",
    ],
  },
  {
    version: "0.9.23",
    date: "2026-07-22",
    kind: "fix",
    summary:
      "XOÁ THÀNH VIÊN: gõ TOÀN BỘ email vào ô lọc ĐÚNG 1 LẦN, chờ list load xong — không thấy = ĐÃ GỠ XONG (thành công). Hết cảnh báo thất bại rồi retry mỗi giờ tới khi STUCK, và bỏ luôn kiểu gõ đi gõ lại 2-3 lần vô ích.",
    details: [
      "USER REPORT 2026-07-22 (1): 'đã xoá thành công + tìm kiếm không thấy email ở tab Người dùng thì nó phải thành công'. Bằng chứng DB: hôm đó 4 OK / 16 FAILED, nhưng 16 lỗi chỉ là 6 email lặp — mỗi email lần 1 REMOVE_VERIFY_FAILED/CONTENT_TIMEOUT (xoá ĐÃ có hiệu lực, verify 45s hụt), các lần sau MEMBER_NOT_IN_WORKSPACE mỗi giờ → không lần nào được mark removed → loop-guard chốt MEMBER_REMOVE_STUCK. 6 member đã rời ChatGPT thật vẫn kẹt 'active' + hết hạn.",
      "USER REPORT 2026-07-22 (2): 'chỉ cần nhập toàn bộ email vào ô tìm kiếm 1 lần rồi chờ nó load thành công mà không thấy là chắc chắn bị xoá rồi; hiện đang tìm kiếm tới 3 lần không cần thiết'. Đúng: gõ thêm KHÔNG làm kết quả đáng tin hơn, chỉ ăn ngân sách 150s/task (đã có 3 ca CONTENT_TIMEOUT trong ngày).",
      "ROOT CAUSE: `filterAndFindRow` trả `null` cho HAI tình huống khác hẳn nhau mà caller không phân biệt được — (a) ô lọc chạy thật, ChatGPT trả 0 row (ĐÁNG TIN) và (b) ô lọc không có / query bị Chrome throttle nuốt nên fetch chưa từng chạy, list đứng im (VÔ NGHĨA). Vì (b) từng gây xoá-giả tháng 6-7 nên 4891f5c chặn CẢ HAI → (a) thành thiệt hại phụ. Mấu chốt KHÔNG nằm ở số lần gõ mà ở chỗ list có PHẢN HỒI query hay không.",
      "FIX (member-filter.ts): thay `filterAndFindRow` (2 lần gõ) bằng `filterOnceAndResolve` cho REMOVE — (1) đảm bảo ô lọc trống rồi đếm `rows_before`; (2) gõ TOÀN BỘ email ĐÚNG 1 LẦN; (3) chờ tới 12s một trong hai dấu hiệu list đã chạy query: row khớp hiện ra ⇒ 'found', hoặc SỐ ROW ĐỔI khác `rows_before` ⇒ query đã chạy → chờ ổn định 1.2s, soi lại lần chót (bắt ca render trễ) → vẫn trống ⇒ 'absent'; (4) hết 12s mà list KHÔNG hề đổi ⇒ 'inconclusive'. Chính 'số row đổi' là bằng chứng 'đã load xong' mà trước đây thiếu.",
      "FIX (execute-remove.ts): 'absent' ⇒ ok:true + data.verified=true + data.absent=true (COMPLETED, mark removed). 'inconclusive' ⇒ MEMBER_NOT_IN_WORKSPACE FAILED, giữ member (thà chậm còn hơn xoá-giả). Vòng verify 45s sau khi click cũng đổi sang `filterOnceAndResolve` → 1 lần gõ/nhịp thay vì 2, và không còn coi 'list không phản hồi' là đã xoá.",
      "BACKEND (completion.py): `data.absent===true` là đường thứ HAI để set removal_verified (đường 1 vẫn là tìm-thấy→click→poll biến mất). Audit MEMBER_REMOVED_SYNCED ghi thêm `removal_evidence` = absent_confirmed | clicked_and_verified để hậu kiểm. `MEMBER_NOT_IN_WORKSPACE` trơ trọi (ext cũ) vẫn KHÔNG được mark removed.",
      "GHI CHÚ: `filterAndFindRow` (2 lần gõ) GIỮ NGUYÊN cho các action khác qua `locateMemberRow` (sync-member, change-role, change-license) — chúng chỉ cần 'tìm thấy', false-negative ở đó không gây mất dữ liệu, và cơ chế gõ-lại là fix riêng của v0.9.21 cho sync.",
      "File: content/actions/remove/member-filter.ts, execute-remove.ts, api/routers/queue/completion.py, version.ts.",
    ],
  },
  {
    version: "0.9.22",
    date: "2026-07-21",
    kind: "fix",
    summary:
      "XOÁ THÀNH VIÊN hết 'báo thành công GIẢ': (1) định vị member bằng ô lọc server-side thay vì scroll-scan (hết sót row trên list ảo hoá → hết MEMBER_NOT_IN_WORKSPACE oan); (2) sau khi click xoá phải POLL xác minh member THỰC SỰ biến mất khỏi tab Người dùng mới báo COMPLETED — dialog đóng thôi CHƯA đủ.",
    details: [
      "USER REPORT 2026-07-21: member 'Xoá do hết hạn ✓ Thành công' trên dashboard nhưng VẪN còn trong workspace ChatGPT. Bằng chứng DB: 2 task REMOVE_MEMBER đều COMPLETED giả — 16/7 qua MEMBER_NOT_IN_WORKSPACE (ô lọc sót), 21/7 qua ok:true (dialog đóng, xong trong 5s) — rồi đồng bộ thấy member còn → hồi sinh active → giờ sau xoá lại → VÒNG LẶP xoá-giả vô hạn.",
      "ROOT CAUSE 1 (locate-member.ts): REMOVE dùng locateMemberRow(pageThrough:false); tab Người dùng là list VIRTUALIZED không phân trang → rơi nhánh scroll-scan chỉ thấy vài row gần đỉnh → SÓT member vẫn hiện diện → null → MEMBER_NOT_IN_WORKSPACE → mark removed oan. FIX: đổi sang preferFilter:true (ô 'Lọc theo tên' server-side, đáng tin bất kể virtualized).",
      "ROOT CAUSE 2 (execute-remove.ts): bản 2026-07-12 gỡ verify vì check quá sớm (ChatGPT eventual-consistent, list còn hiện member ~34s sau DELETE thật) → chỉ còn tin 'dialog confirm đóng' = COMPLETED. Nhưng dialog đóng KHÔNG bảo đảm xoá có hiệu lực. FIX: sau khi dialog đóng, POLL tới 45s bằng ô lọc (clear+gõ lại → fetch mới) — row biến mất → verified:true; tới 45s vẫn còn → REMOVE_VERIFY_FAILED (ok:false, GIỮ member, không mark removed).",
      "BACKEND đi kèm (completion.py): REMOVE_MEMBER chỉ mark removed khi có BẰNG CHỨNG DƯƠNG result.data.verified===true (tìm-thấy→xoá→poll thấy biến mất); thiếu → MEMBER_REMOVE_UNVERIFIED, giữ active. BỎ HẲN auto-convert MEMBER_NOT_IN_WORKSPACE→removed (tái diễn 06:29 cùng ngày: ext cũ scroll-scan sót → mark removed giả) — 'không tìm thấy' KHÔNG còn suy ra 'đã xoá'; vắng mặt để ĐỒNG BỘ đầy đủ (expected_total) chốt. main.py loop-guard: gỡ ≥3 lần/7 ngày mà member vẫn quay lại → MEMBER_REMOVE_STUCK cảnh báo gỡ tay. SYNC promote xoá luôn stale removed_at.",
      "AN TOÀN: mọi đánh đổi nghiêng về 'thà giữ member còn hơn báo xoá GIẢ'. Present+expired → ext tìm thấy → xoá xác minh → removed. Absent+expired → task gỡ FAILED (not found) → đồng bộ đầy đủ mark removed. Verify ~45s nằm trong ngân sách 150s.",
      "File: content/actions/remove/execute-remove.ts, shared/messages.ts (+REMOVE_VERIFY_FAILED), version.ts.",
    ],
  },
  {
    version: "0.9.21",
    date: "2026-07-21",
    kind: "fix",
    summary:
      "Đồng bộ 'chờ tham gia' không còn báo pending OAN: filterAndFindRow thử lại (gõ lại) khi ô lọc tab Người dùng miss row — trước đây member đã tham gia thật nhưng sync vẫn giữ pending, phải sync đi sync lại nhiều lần mới bắt được.",
    details: [
      "USER REPORT 2026-07-21: đồng bộ tab 'chờ tham gia' nhiều lần, member đã tham gia thật ở ChatGPT nhưng trang quản trị vẫn giữ pending, dữ liệu không đổi.",
      "ROOT CAUSE (bằng chứng DB): cùng batch SYNC_MEMBERS_BATCH chạy lại sau ~90s ra 'active' cho đúng các email lần trước trả 'pending' → backend promote + UI refresh ĐỀU ĐÚNG; lỗi là extension false-negative. Tab admin chạy NỀN (active:false) → Chrome throttle timer ~1000ms → chuỗi event `input` khi gõ ô 'Lọc theo tên' thi thoảng bị nuốt/gộp → fetch lọc server-side không kích hoạt → list không hiện row → báo 'không có' oan. Đã chờ ~4.7s vẫn miss ⇒ chờ lâu hơn vô ích, phải GÕ LẠI.",
      "FIX (member-filter.ts filterAndFindRow): thử tối đa 2 lần — mỗi lần clearMemberFilter + gõ lại email + chờ (600ms debounce) + waitFor(findMemberRow, 3000ms); chỉ kết luận null (không có row) sau khi cả 2 lần đều miss. Bao trọn mọi luồng dùng ô lọc: sync-member/sync-members-batch (pending→active), remove, invite-verify, change-role/license.",
      "AN TOÀN: retry chỉ GIẢM false-negative, không tạo false-positive — member thật sự vắng vẫn miss cả 2 lần → pending; không có nhánh mark-removed nào ăn theo. Chi phí xấu nhất ~2× thời gian/email (bounded), còn BATCH_BUDGET_MS backstop.",
    ],
  },
  {
    version: "0.9.20",
    date: "2026-07-15",
    kind: "fix",
    summary:
      "Báo lỗi RÕ RÀNG khi phiên ChatGPT hỏng/hết hạn: các lỗi 'trang admin không tải được' (NOT_LOGGED_IN_CHATGPT, CONTENT_TIMEOUT, CONTENT_NOT_INJECTED, PAGE_NOT_ADMIN, không tìm nút Mời) nay kèm gợi ý 'xoá cookie/đăng xuất chatgpt.com → đăng nhập lại rồi thử lại' thay vì thông báo TIMEOUT mơ hồ.",
    details: [
      "USER INSIGHT 2026-07-15: lời mời cứ lỗi (TIMEOUT/NOT_LOGGED_IN/VERIFY_FAILED) là do PHIÊN đăng nhập chatgpt.com hỏng → trang /admin/members redirect/treo, phải TỰ xoá phiên + đăng nhập lại mới load bình thường. Đây là vấn đề môi trường (OpenAI-side), không phải bug logic — nhưng thông báo cũ mơ hồ nên user phải tự đoán.",
      "FIX: thêm hằng SESSION_RECOVERY_HINT (shared/messages.ts) + gắn vào các error_message có dấu hiệu phiên hỏng: runner NOT_LOGGED_IN_CHATGPT (×2), CONTENT_TIMEOUT (Phase 1 + external Phase A'), CONTENT_NOT_INJECTED; invite PAGE_NOT_ADMIN + 'không tìm nút Mời sau 20s'.",
      "KHÔNG tự đăng nhập giúp: extension KHÔNG nhập credential / KHÔNG tự click 'đăng nhập bằng Google' (nhập mật khẩu = việc của user + dễ trip bot-detection của Google/ChatGPT làm hỏng thêm). Chỉ hướng dẫn user tự làm.",
      "File: shared/messages.ts (+SESSION_RECOVERY_HINT), background/runner.ts, content/actions/invite/{execute-invite,execute-invite-inner}.ts, version.ts.",
    ],
  },
  {
    version: "0.9.19",
    date: "2026-07-15",
    kind: "fix",
    summary:
      "MỜI EMAIL NGOÀI TÊN MIỀN 'làm chậm mà chắc': hết lỗi VERIFY_FAILED do bật toggle 'Cho phép lời mời ngoài tên miền' xong submit MÙ khi setting chưa kịp có hiệu lực server-side. Chờ server chốt toggle + chờ ChatGPT validate email + CHỈ submit khi nút 'Gửi lời mời' thật sự bấm được.",
    details: [
      "USER REPORT 2026-07-15: 'lại lỗi ở bước bật tắt cho phép lời mời bên ngoài' → task INVITE_MEMBER FAILED VERIFY_FAILED ('đã submit nhưng không email nào xuất hiện trong tab Lời mời — có thể toggle mời ngoài chưa bật').",
      "GỐC RỄ: chuỗi bật-toggle chỉ tin TÍN HIỆU CLIENT (aria-checked, banner-text vắng mặt) vốn chạy TRƯỚC khi ChatGPT commit setting server-side. (1) setExternalInvites(true) trả về ngay khi DOM aria-checked=true → background HARD-RELOAD /admin/members refetch org-config có thể chạy TRƯỚC khi server chốt → config vẫn external=OFF. (2) execute-invite-inner check banner NGAY sau setRole → banner validate bất đồng bộ chưa render → 'không banner' oan → submit. (3) findInviteSubmitButton trả cả nút ĐANG DISABLED → click nút chết = no-op → verify 15s → VERIFY_FAILED.",
      "FIX 1 (set-toggle.ts): sau khi confirm toggle=ON, settleServerCommit() chờ 2s + đọc lại DOM xác nhận vẫn ON TRƯỚC khi trả về (Phase A) → hard-reload refetch config chắc chắn thấy external=ON. Tăng retry click 2→3, poll xác nhận 4s→6s, double-check 250ms→600ms.",
      "FIX 2 (execute-invite-inner.ts bước 5.5): đợi 1.5s cho ChatGPT validate email vừa gõ TRƯỚC khi kết luận có/không banner; poll banner biến mất 8s→15s; banner clear rồi chờ thêm 1s cho React enable nút Send.",
      "FIX 3 (execute-invite-inner.ts bước 6): CHỜ nút 'Gửi lời mời' thực sự ENABLE (poll 6s, kiểm disabled/aria-disabled/data-disabled) rồi mới click; còn disabled → EXTERNAL_TOGGLE_FAILED (huỷ rõ ràng, KHÔNG click nút chết → tránh lời mời ảo + VERIFY_FAILED oan).",
      "Đánh đổi: mỗi lời mời chậm thêm ~1.5s (validate settle) + email ngoài miền thêm ~2-3s (server settle + chờ enable) — trong ngân sách 150s extension / 180s backend, đổi lấy độ tin cậy. Email cùng miền không bị ảnh hưởng (nút enable sẵn → poll trả ngay).",
      "File: content/actions/external-invites/set-toggle.ts, content/actions/invite/execute-invite-inner.ts, external-invites/README.md, version.ts.",
    ],
  },
  {
    version: "0.9.18",
    date: "2026-07-15",
    kind: "fix",
    summary:
      "ĐỒNG BỘ (kiểm tra đã tham gia) viết lại theo logic ĐƠN GIẢN: KHÔNG quét tab 'Lời mời đang chờ xử lý' nữa. Chỉ vào tab 'Người dùng' tìm từng email — thấy = đã tham gia (active), không thấy = chưa tham gia (pending). Hết sót row / báo sai do scrape list virtualized.",
    details: [
      "USER DECISION 2026-07-15: lời mời đã xác minh thành công ngay lúc mời (invite → check lời mời → verify), nên 1 email 'chờ tham gia' chỉ có 2 khả năng — đã tham gia (có ở tab Người dùng) hoặc chưa (không có). KHÔNG cần đối chiếu tab Lời mời.",
      "Trước đó nhiều lần vá scrape tab Lời mời (đếm-số-lượng thiếu mốc expectedTotal → sót row khi list nạp/virtualized trễ; vá cuộn mọi-khung lại gây over-scroll nested → 2/3 rồi 1/3). Không dứt điểm → bỏ hẳn hướng scrape pending.",
      "FIX (execute-sync-members-batch.ts + execute-sync-member.ts): vào tab 'Người dùng' 1 lần → locateMemberRow(pageThrough=false) từng email (ô search là nguồn sự thật). Thấy → found_in='active'; không thấy → 'pending'. Bỏ khái niệm 'none' + mọi thao tác tab Lời mời. ok:false chỉ khi không vào được tab Người dùng.",
      "REVERT: hoàn tác thay đổi cuộn mọi-khung ở scrape-current-tab.ts (v0.9.17) — khôi phục hành vi window-only cũ cho full-sync/map-lời-mời (không còn bị ảnh hưởng).",
      "Backend completion.py không đổi: vốn chỉ xử lý found_in 'active'/'pending' (active→set active+joined_at; pending→giữ, chạm last_synced_at), bỏ qua phần khác — logic mới không phát sinh 'none'.",
      "File: content/actions/sync-member/{execute-sync-members-batch,execute-sync-member}.ts, content/actions/sync/scrape-current-tab.ts (revert), README.md, version.ts.",
    ],
  },
  {
    version: "0.9.17",
    date: "2026-07-15",
    kind: "fix",
    summary:
      "SCRAPE tab (dùng chung cho 'Đồng bộ lời mời' + 'Đồng bộ hàng loạt kiểm tra đã tham gia' + full-sync) hết sót row: vòng gom chính giờ cuộn MỌI khung (window + div cuộn nội bộ), không chỉ window. Trước đây list nằm trong div cuộn riêng (modal/virtualized) không được nhích → chỉ gom được các row hiển thị ban đầu (~2/3).",
    details: [
      "USER REPORT 2026-07-14→15: 'Đồng bộ (kiểm tra đã tham gia)' + 'Đồng bộ lời mời' đều chỉ ra 2/3 email pending. Email sót → phân loại 'none' → backend bỏ qua → kết quả 'dừng ở 2'.",
      "GỐC RỄ (scrape-current-tab.ts): `collectRowsByScrolling` — vòng gom row CHÍNH — chỉ dùng `window.scrollTo/scrollBy` + đo đáy bằng `document.body.scrollHeight`. Nhưng list ChatGPT có khi cuộn bằng DIV CON (overflow riêng, modal/virtualized) mà window KHÔNG nhích được → vòng gom kẹt ở tập row render ban đầu, các row cuối không bao giờ vào viewport để scrape. `scrollUntilAllLoaded` đã xử lý đúng qua `findScrollContainers()` nhưng vòng gom chính bị bỏ sót — biến thể chưa vá hết của bug lịch sử 'đồng bộ lần 1 chỉ ra 2 member'.",
      "FIX: thêm `scrollAllContainersToTop` / `scrollAllContainersBy` / `allContainersAtBottom` — cuộn & đo đáy trên MỌI khung (window + div overflow). Vòng gom chính giờ nhích được div cuộn nội bộ → render & scrape hết row. Ảnh hưởng chung: full-sync members/invites, batch kiểm tra đã tham gia, map lời mời sau invite (đều dùng scrapeCurrentTab).",
      "Kèm theo (v0.9.16, giữ nguyên): batch có lưới an toàn bước 4 — email kết luận 'none' được tra lại 1 lần ở tab Lời mời bằng locatePendingRow trước khi chốt (phòng khi vẫn còn sót).",
      "File: content/actions/sync/scrape-current-tab.ts, content/actions/sync-member/execute-sync-members-batch.ts, version.ts.",
    ],
  },
  {
    version: "0.9.16",
    date: "2026-07-14",
    kind: "fix",
    summary:
      "ĐỒNG BỘ HÀNG LOẠT (kiểm tra đã tham gia) hết báo sai 'không thấy' cho email vẫn đang pending: lượt quét tab Lời mời trước đây có thể sót row (list nạp/virtualized trễ) khiến email pending bị coi là 'none'. Giờ mọi email kết luận 'none' được kiểm tra lại chính xác 1 lần ở tab Lời mời trước khi chốt.",
    details: [
      "USER REPORT 2026-07-14: tab Lời mời có 3 email nhưng đồng bộ hàng loạt chỉ quét được 2 rồi ngưng — email sót bị báo 'không thấy' thay vì vẫn 'chờ tham gia'.",
      "GỐC RỄ: executeSyncMembersBatch bước 1 quét tab Lời mời đếm-theo-số-lượng qua scrapeCurrentTab, nhưng đường status='pending' KHÔNG có mốc expectedTotal (chỉ tab active đọc header count). Không mốc → waitForCountStable (stablePolls=2, 600ms) chốt vào số tạm thời + scroll patience thấp (3 tick ~1s) → nếu ChatGPT nạp/render row cuối trễ vài trăm ms thì scrape dừng ở tập con (2/3). Email sót rơi vào 'remaining' → tab Người dùng không thấy (vì vẫn pending) → gán 'none' oan. Cùng lớp bug lịch sử 'đồng bộ lần 1 chỉ ra 2 member' (đã fix cho tab active bằng mốc header, bỏ sót đường pending).",
      "FIX (execute-sync-members-batch.ts) — thêm bước 4 lưới an toàn: mọi email kết luận 'none' (tập rủi ro, nhỏ) quay lại tab Lời mời tra ĐÚNG 1 email bằng locatePendingRow (ô search / scroll-scan cuộn tới khi gặp đúng row) — bắt được row mà lượt quét đếm-số-lượng bỏ sót. Thấy → nâng 'none'→'pending'. Bounded bởi BATCH_BUDGET_MS.",
      "An toàn: backend completion vốn KHÔNG mark removed cho 'none' nên đây thuần sửa hiển thị/phân loại; không đụng scrape-current-tab dùng chung (active/full-sync/invite-mapping).",
      "File: content/actions/sync-member/execute-sync-members-batch.ts, version.ts.",
    ],
  },
  {
    version: "0.9.15",
    date: "2026-07-13",
    kind: "fix",
    summary:
      "ĐỒNG BỘ LỜI MỜI hết xoá oan email đã tham gia: sau khi mời, email 'biến mất' khỏi tab Lời mời giờ được kiểm tra ở tab Người dùng trước khi mark 'removed'. Người dùng chấp nhận lời mời nhanh (rời tab Lời mời, sang tab Người dùng) sẽ được nhận diện active thay vì bị coi là phantom.",
    details: [
      "USER REPORT 2026-07-13: khi đồng bộ lời mời, email đã mời biến mất khỏi tab Lời mời không được kiểm tra xem đã sang tab Người dùng chưa → lỗi ở lần đồng bộ mới nhất (email đã tham gia bị xoá oan / task FAILED).",
      "GỐC RỄ: executeVerifyPendingInvite CHỈ quét tab Lời mời. Mọi email không thấy = unverified → runner gọi reconcile-after-invite → backend mark Member pending → 'removed'. Không hề đối chiếu tab Người dùng (pattern đúng đã có ở execute-sync-members-batch bước 3 nhưng luồng verify-after-invite không dùng).",
      "FIX extension: thêm action CHECK_ACTIVE_AFTER_INVITE (check-active-after-invite.ts) — sau vòng F5 verify, nếu còn email unverified (scrape OK) thì mở tab Người dùng, locateMemberRow(pageThrough=false) từng email; thấy → scrape thành ScrapedMember status='active'. Chạy MỘT lần, ngoài vòng F5 (không làm chậm reload).",
      "FIX runner (runner.ts): reclassify trước reportToBackend — email active loại khỏi unverified_emails (reconcile KHÔNG mark removed), thêm vào verified_emails + gộp vào pending_members để bulk-upsert đúng status active (backend guard chỉ chặn chiều active→pending nên pending→active promote OK; isFullSync=false nên không reconcile).",
      "File: content/actions/invite/{check-active-after-invite,index}.ts, content/index.ts, shared/messages.ts, background/runner.ts, version.ts.",
    ],
  },
  {
    version: "0.9.14",
    date: "2026-07-13",
    kind: "fix",
    summary:
      "THU HỒI lời mời hết cảnh 'đã thu hồi nhưng thực tế chưa': khi extension KHÔNG thu hồi được (vd menu ChatGPT không có mục 'Thu hồi lời mời') thì báo FAILED thay vì COMPLETED giả → dashboard KHÔNG mark 'removed' oan. Ngoài ra, tab Người dùng / Lời mời chỉ 1 TRANG thì quét vị trí trực tiếp, KHÔNG dùng ô search.",
    details: [
      "USER REPORT 2026-07-13: hellowda2@gmail.com hiện 'đã thu hồi' trên dashboard nhưng ChatGPT vẫn còn lời mời pending. Result task: {revoked:0, failed:1, reason:'Menu mở nhưng không có item \"Thu hồi lời mời\"'} — nhưng vẫn COMPLETED.",
      "GỐC RỄ: execute-revoke-batch LUÔN trả ok:true miễn vào được tab Lời mời (kể cả revoked=0, failed>0). Backend completion khi thấy REVOKE_INVITES COMPLETED mark MÙ toàn bộ email trong payload = removed, không đọc result.data.results.",
      "FIX extension (execute-revoke-batch.ts): revoked+removed==0 && failed>0 → trả ok:false FAILED_UI_CHANGED (kèm lý do từng email) để lỗi hiện lên cho admin.",
      "FIX backend (completion.py): REVOKE_INVITES COMPLETED chỉ mark removed những email THỰC SỰ ok=true trong result.data.results (+ audit MEMBER_INVITE_REVOKED + Invite→revoked); email fail giữ pending + log MEMBER_INVITE_REVOKE_FAILED. Extension cũ không trả results → không mark (an toàn).",
      "TỐI ƯU locate (user 2026-07-13): revoke (locate-pending-row) + remove/change-role/sync-member (locate-member) — nếu findPaginationState()==null (chỉ 1 trang) thì scrollScanForRow quét thẳng vị trí, bỏ ô search/lọc (tránh lỗi row sau lọc render menu thiếu). Nhiều trang mới search.",
      "SEARCH gõ 1 LẦN (user 2026-07-13): khi phải search (nhiều trang) gõ CHÍNH XÁC email đầy đủ 1 lần, BỎ bước gõ local-part trước rồi full email (tra 2 lần, tốn thời gian). Áp cho revoke, remove/lọc-theo-tên, set-usage-limit, verify-pending lời mời.",
      "File: content/actions/revoke/{execute-revoke-batch,locate-pending-row}.ts, content/actions/remove/{locate-member,member-filter}.ts, content/actions/set-usage-limit/execute-set-usage-limit.ts, content/actions/invite/verify-pending-via-filter.ts, version.ts; API routers/queue/completion.py.",
    ],
  },
  {
    version: "0.9.13",
    date: "2026-07-12",
    kind: "fix",
    summary:
      "XOÁ thành viên hết báo VERIFY_FAILED OAN khi xoá THẬT SỰ đã thành công: đổi tín hiệu verify cuối từ 'row biến mất khỏi list' (không tin cậy — backend ChatGPT eventual-consistent, list vẫn trả member vừa xoá vài chục giây) sang 'dialog xác nhận ĐÓNG = ChatGPT đã nhận lệnh destructive' (giống verify của INVITE).",
    details: [
      "USER REPORT 2026-07-12 (kèm ảnh): task 'Xoá thành viên' nhathuy.france@gmail.com lần đầu (19:32:32) → FAILED 'VERIFY_FAILED: Member vẫn còn trong danh sách sau khi confirm Remove' — nhưng thực tế ChatGPT ĐÃ xoá thành công; retry 34s sau (19:33:06) lọc không thấy → MEMBER_NOT_IN_WORKSPACE → COMPLETED (mark removed).",
      "GỐC RỄ: bản vá v0.9.2 (reverifyRemovedViaFilter) giả định lọc lại từ SERVER là nguồn sự thật không trễ — SAI. Sau DELETE, chính backend ChatGPT eventual-consistent: query lọc server-side MỚI VẪN trả member vừa xoá trong vài chục giây → waitFor thấy row 'tái xuất' trong 5s → kết luận nhầm chưa xoá. Đọc lại list KHÔNG BAO GIỜ phân biệt được 'xoá lỗi, member còn' với 'xoá xong nhưng list trễ'.",
      "FIX (execute-remove.ts): bỏ hẳn verify theo list (waitFor row biến mất + reverifyRemovedViaFilter). Verify mới = chờ dialog xác nhận ĐÓNG (confirmDialogOpen()=false) hoặc toast thành công trong 15s → COMPLETED; chỉ VERIFY_FAILED khi dialog VẪN mở sau 15s (OTP/2FA/lỗi thật sự chặn xoá), kèm text dialog để debug. Tín hiệu tại THỜI ĐIỂM thao tác, không dính độ trễ backend.",
      "File: content/actions/remove/execute-remove.ts, version.ts.",
    ],
  },
  {
    version: "0.9.12",
    date: "2026-07-12",
    kind: "fix",
    summary:
      "Hoá đơn GIA HẠN kèm điều chỉnh seat (proration): đọc ĐÚNG chu kỳ dịch vụ = khoảng ngày có END MUỘN NHẤT (vd 11/7→11/8), không còn lấy nhầm dòng proration đầu (10/7-11/7). Trước đây period_end sai = ngày đầu chu kỳ → dashboard tưởng 'chu kỳ đã kết thúc', mọi số về '—'.",
    details: [
      "USER REPORT 2026-07-12: workspace GPT1 sau gia hạn 11/7 — hoá đơn 0005 (52.549.578đ, 183 seat) đọc được quantity nhưng period_end lưu = 11/7 (đáng lẽ 11/8) → billing-math ra note=cycle_ended, renewal 11/7, tổng seat/chi đều '—'.",
      "GỐC RỄ: parsePeriod dùng text.match() → LẤY KHOẢNG NGÀY ĐẦU TIÊN. Hoá đơn có proration ghi '10 THÁNG 7 - 11 THÁNG 7' TRƯỚC dòng dịch vụ chính '11 THÁNG 7 - 11 THÁNG 8' → nuốt nhầm end=11/7.",
      "FIX: parseAllPeriods() dùng matchAll gom MỌI khoảng (VI/EN/ZH); parsePeriod chọn khoảng có period_end MUỘN NHẤT = ngày renew thật. Test: invoice-detail.test.ts (hoá đơn 0005).",
      "File: content/scrapers/invoice-detail.ts, version.ts.",
    ],
  },
  {
    version: "0.9.11",
    date: "2026-07-12",
    kind: "fix",
    summary:
      "Chu kỳ dài 31 ngày (vd 11/7→11/8): hoá đơn GỐC chu kỳ (ngày đầu, vd 11/7) không còn bị bỏ sót khi đọc chi tiết. Trước đây cửa sổ chu kỳ = renewal − 30 ngày cứng nên với tháng 31 ngày, ngày đầu rơi ra ngoài → hoá đơn add-seat giữa kỳ khiến base bị loại → thiếu đơn giá/tổng seat.",
    details: [
      "GỐC RỄ: enrichInvoicesWithDetails tính cycleStart = cycleEnd − 30×DAY_MS. Chu kỳ 11/7→11/8 (31 ngày): renewal=11/8 → cycleStart=12/7 → hoá đơn base 11/7 (t<cycleStart) bị lọc khỏi tập mở chi tiết khi có hoá đơn mới hơn quyết định period_end.",
      "FIX: cycleStartMs() lùi ĐÚNG 1 THÁNG LỊCH (Date.UTC(y, m−1, d)) thay vì trừ 30 ngày — khớp cycleStartFromRenewal ở web billing-math. Gỡ hằng số BILLING_CYCLE_DAYS/DAY_MS không còn dùng.",
      "File: background/runner.ts, version.ts.",
    ],
  },
  {
    version: "0.9.10",
    date: "2026-07-10",
    kind: "fix",
    summary:
      "SYNC_MEMBER (Đồng bộ 1 tài khoản) không còn báo nhầm 'pending' cho member đã active. Trước khi quét mỗi tab giờ CHỜ list ổn định (tránh đọc row còn sót của tab trước); list 1 trang → quét trực tiếp, nhiều trang → dùng ô search — áp cho cả tab Lời mời lẫn Người dùng.",
    details: [
      "USER REPORT 2026-07-10: nguyenthuhientho@gmail.com nằm ở tab Người dùng (đã chấp nhận lời mời) nhưng SYNC_MEMBER trả found_in='pending' 3 lần liên tiếp → member kẹt trạng thái pending trên dashboard.",
      "GỐC RỄ: Bước 1 quét tab Lời mời bằng scrollScanForRow NGAY sau khi đổi tab; React chưa unmount kịp row của tab Người dùng → findMemberRow (match substring) trúng row active còn sót → return 'pending' sai.",
      "FIX: thêm locateInCurrentTab() — (0) waitForCountStable chờ list render & ổn định trước khi đọc; (1) list gọn 1 trang → scrollScanForRow trực tiếp KHÔNG dùng search; (2) nhiều trang → ô search (pending: locatePendingRow, active: locateMemberRow). Dùng cho CẢ 2 tab.",
      "File: content/actions/sync-member/execute-sync-member.ts.",
    ],
  },
  {
    version: "0.9.9",
    date: "2026-07-07",
    kind: "fix",
    summary:
      "Đọc được hoá đơn TRUE-UP (điều chỉnh seat giữa kỳ, prorated, nhiều dòng +/−, không có 'Mỗi'). Số seat = 'Remaining time on N ×' lớn nhất. Tổng seat chu kỳ = seat hiện tại (hoá đơn mới nhất), KHÔNG cộng dồn.",
    details: [
      "USER REPORT: hoá đơn add-seat/true-up (vd 0003) có 4 dòng proration (Remaining/Unused time on N ×), không có dòng 'Mỗi X đ' → parser cũ fail → detail_scraped=false → tổng seat thiếu.",
      "FIX parser: parseSeatsFromTrueUp lấy N lớn nhất ở 'Remaining time on N ×' (số seat mới sau true-up); isDetailUsable chỉ cần quantity (đơn giá null vẫn hợp lệ). runner merge khi có quantity.",
      "FIX web billing-math: totalSeats = quantity hoá đơn MỚI NHẤT trong chu kỳ (seat hiện tại, khớp tab Kế hoạch); base giá/seat chỉ lấy từ hoá đơn CÓ đơn giá (loại true-up).",
      "File: content/scrapers/invoice-detail.ts, background/runner.ts, web billing-math.ts.",
    ],
  },
  {
    version: "0.9.8",
    date: "2026-07-06",
    kind: "fix",
    summary:
      "Click 'Xem chi tiết hoá đơn' đáng tin hơn cho các hoá đơn add-seat (số tiền lớn/render chậm) — dùng chuỗi sự kiện chuột thật + chờ tới 14s + log per-invoice. Trước đây một số hoá đơn trong chu kỳ không mở được panel → detail_scraped=false → tổng seat thiếu.",
    details: [
      "USER REPORT GPT1: chu kỳ có 3 hoá đơn nhưng chỉ hoá đơn base (11/6) đọc được; 2 hoá đơn add-seat (12/6, 22/6) detail_scraped=false → TỔNG SEAT chỉ = 2.",
      "FIX: openInvoiceDetailPanel dùng humanClickStripe (pointerdown/up+mousedown/up+click) thay .click(); poll 14s; chỉ click khi toggle 'Xem chi tiết' còn hiện (panel mở → text 'Đóng chi tiết' → dừng click, tránh toggle tắt).",
      "Log chẩn đoán: '[autogpt-stripe] scrape-detail v0.9.8 ... toggleSeen=.. clicks=.. usable=..' + error_message nêu rõ toggle KHÔNG thấy hay click rồi mà panel không ra số liệu.",
      "File: content/stripe-invoice.ts.",
    ],
  },
  {
    version: "0.9.7",
    date: "2026-07-06",
    kind: "fix",
    summary:
      "Sync billing đọc được seat ratio dạng '164/148 người dùng đang sử dụng' (UI ChatGPT Business tiếng Việt). Trước đây regex chỉ nhận 'giấy phép/seats/licenses' → workspace hiển thị 'người dùng' bị fail 'không scrape được gì'.",
    details: [
      "USER REPORT 2026-07-06: workspace 164/148 seat, sync báo 'Không scrape được gì từ /admin/billing — cả seat ratio lẫn invoices list đều trống'.",
      "FIX: SEAT_RATIO_PATTERNS thêm mẫu '(\\d)/(\\d) người dùng|thành viên' (ratio đứng trước keyword) + 'users?' cho EN; nới \\d{1,3}→\\d{1,4}.",
      "File: content/scrapers/billing.ts.",
    ],
  },
  {
    version: "0.9.6",
    date: "2026-07-06",
    kind: "feature",
    summary:
      "Cập nhật giá & ngày renew: đọc CHÍNH XÁC số lượng seat + đơn giá + chu kỳ từ chi tiết hoá đơn Stripe (không còn đoán). Xác định chu kỳ từ hoá đơn mới nhất rồi chỉ đọc hoá đơn trong chu kỳ đó. Giá/seat hiển thị GỒM VAT.",
    details: [
      "SYNC_BILLING: mở hoá đơn Paid mới nhất → đọc period_end = ngày renew → chỉ mở tiếp các hoá đơn có ngày trong [cycle_start, renewal). Bỏ qua hoá đơn ngoài chu kỳ.",
      "Scraper stripe-invoice: tự click 'Xem chi tiết hoá đơn' (kể cả khi là span/div), đọc Số lượng/Mỗi/Tổng phụ/VAT/Số tiền đến hạn/khoảng chu kỳ.",
      "Parser chống lỗi textContent nối số ('Số lượng 35'+'9.117.500' → suy quantity = subtotal÷unit), nhãn nhập nhằng ('per'/'thuế'), số hoá đơn nuốt 'Ngày'.",
      "Web: bỏ đoán seat (inferSlotsPurchased/range 200-400k). Giá/seat gồm VAT = total÷quantity; tổng seat = Σ quantity hoá đơn Paid trong chu kỳ.",
      "File: content/scrapers/invoice-detail.ts (mới), stripe-invoice.ts, scrapers/billing.ts, background/{runner.ts,payment-chain.ts}, shared/{messages.ts,api.ts}; API schemas.py, routers/workspaces/billing.py; web billing-math.ts, WorkspaceBillingPanel.tsx.",
    ],
  },
  {
    version: "0.9.5",
    date: "2026-07-06",
    kind: "fix",
    summary:
      "Đồng bộ HÀNG LOẠT (chọn nhiều pending → 'Cập nhật hàng loạt' → Đồng bộ) không còn quay về tab 'Lời mời đang chờ xử lý' quét lại cho TỪNG email. Nay gom cả danh sách vào 1 task: quét tab Lời mời ĐÚNG 1 lần → đối chiếu → email nào không có mới sang tab 'Người dùng' xác minh 'đã tham gia'.",
    details: [
      "USER REPORT 2026-07-06: 'sau khi quét toàn bộ email trong trang đó nếu dưới 1 trang, đối chiếu với list email đồng bộ, không khớp thì check trong Người dùng là được; hiện tại nó cứ quay về Lời mời đang chờ xử lý để thu thập tiếp chả để làm gì cả'.",
      "ROOT CAUSE: 'đồng bộ hàng loạt' (bulkSyncMembers) trước đây fan-out MỖI email = 1 task SYNC_MEMBER. Mỗi task lại F5 tab + vào tab 'Lời mời' cuộn lại TOÀN BỘ list chỉ để tìm 1 email → chọn N email = N lần quét lại pending (thừa).",
      "FIX: thêm action SYNC_MEMBERS_BATCH. Extension vào tab 'Lời mời đang chờ xử lý' quét trọn 1 lần (scrapeCurrentTab tự lật trang nếu >1 trang) → build pendingSet → đối chiếu cả danh sách; email không khớp → sang tab 'Người dùng' lọc từng email (không lật hết trang). found_in: pending | active (đã tham gia) | none.",
      "AN TOÀN: found_in='none' CHỈ để báo — backend completion KHÔNG mark removed (một lần quét sót chỉ làm KHÔNG promote, không xoá oan). 'pending' ưu tiên hơn 'none'.",
      "Web: bulkSyncMembers gọi 1 POST /sync-members-batch (thay Promise.allSettled fan-out /sync-member). Backend: endpoint trigger_sync_members_batch (dedup 1 mẻ/workspace) + completion reconcile theo result.data.results + STUCK_THRESHOLD 6'.",
      "File đổi: extension shared/messages.ts, shared/types.ts, content/actions/sync-member/{execute-sync-members-batch.ts,index.ts}, content/index.ts, background/runner.ts, version.ts; API schemas.py, routers/workspaces/triggers.py, routers/queue/{completion.py,execution.py}; web hooks/useMemberMutations.ts.",
    ],
  },
  {
    version: "0.9.4",
    date: "2026-07-03",
    kind: "fix",
    summary:
      "Sync lần 1 chỉ ra ~2 member (lần 2 mới đủ) — FIX. Nguyên nhân: khi list mới render vài row, khung cuộn nội bộ chưa lộ ra nên chỉ cuộn window (không nhích list) → không tải thêm. Nay re-scan khung cuộn mỗi vòng + cuộn kiên nhẫn tới đủ mốc header ChatGPT. Kèm lớp bảo vệ backend: sync THIẾU sẽ KHÔNG mark-removed oan (giữ dữ liệu lịch sử).",
    details: [
      "USER REPORT 2026-07-03: 'ChatGPT Pro, đồng bộ lần 1 chỉ có 2 thành viên (lỗi), lần 2 mới có đủ'.",
      "ROOT CAUSE (scrape-current-tab.ts): scrollUntilAllLoaded scan khung cuộn MỘT LẦN lúc mới vào. Cold-start list mới render vài row → chưa tràn → div cuộn nội bộ chưa lộ (scrollHeight ≈ clientHeight) → chỉ còn `window` trong danh sách container. Danh sách member ChatGPT cuộn bằng div nội bộ chứ không phải window → window.scrollTo không tải thêm row → kẹt ở ~2 row; vòng scrape thoát sớm vì window 'atBottom' (list ngắn). Lần 2 trang đã 'nóng' (React/dữ liệu cache) → khung cuộn đã tràn → phát hiện được → đủ.",
      "FIX 1 (scrape): findScrollContainers() re-scan MỖI vòng lặp (ngưỡng +20px thay vì +100px) → bắt được div cuộn ngay khi vài row đầu tải xong. scrollUntilAllLoaded + collectRowsByScrolling nhận `expectedTotal` (header count) → cuộn kiên nhẫn (8 tick không tăng mới bỏ) tới khi ĐỦ mốc, không dừng sớm; kèm escape tránh treo vô hạn.",
      "FIX 2 (backend guard — chống phá dữ liệu): executeSync forward `expected_total` (header ChatGPT) → bulk-upsert. reconcile.py: nếu số active scrape < 90% expected_total → BỎ QUA mark-removed (log audit MEMBER_RECONCILE_SKIPPED, trả reconcile_skipped=true). Phân biệt 'admin xoá thật còn ít' (header cũng giảm → không skip). Fallback khi thiếu header: roster ≥10 mà sync còn ≤2 → skip. Member đã scrape VẪN được upsert; chỉ hoãn bước xoá tới lần sync đủ.",
      "File đổi: extension scrape-current-tab.ts, execute-sync.ts, shared/api.ts, background/runner.ts, version.ts; API schemas.py, routers/members/reconcile.py.",
    ],
  },
  {
    version: "0.9.3",
    date: "2026-06-29",
    kind: "fix",
    summary:
      "Nhập email khi mời thành viên NHANH HƠN ~20× trong tab nền: bỏ gõ từng ký tự (mỗi ký tự kèm setTimeout) → set value 1 lần như thao tác dán. Tab admin chạy active:false (nền) bị Chrome throttle setTimeout về ~1000ms nên gõ từng ký tự = ~1s/ký tự (1 email ~26-31s); nay còn dưới 1s.",
    details: [
      "USER REPORT 2026-06-29 (kèm 2 ảnh dashboard): phase 'typing-email' của task mời thành viên tốn 26s và 37s — bất thường vì email chỉ ~20 ký tự.",
      "CHẨN ĐOÁN (đo trực tiếp progress.history trong DB): typing_s ≈ 1.0 × số_ký_tự + ~7 (vd 18 ký tự→25s, 24 ký tự→31s); per-char ~1.3s khi chậm vs ~0.07s khi nhanh. Phase opening-dialog cũng phồng 6-7s (vs 1.4-2s khi nhanh) — CÙNG nguyên nhân. Con số 1000ms/ký tự = đúng mức Chrome CLAMP setTimeout cho tab nền (background timer throttling).",
      "ROOT CAUSE: runner mở/reuse tab admin với `active:false` (KHÔNG focus — đúng UX user muốn). Tab không visible → Chrome throttle MỌI setTimeout về tối thiểu ~1000ms. `humanType` cũ gõ từng ký tự với `await sleep(8-22ms)` giữa các ký tự → mỗi sleep hoá ~1s → nhập email = ~N giây. randomDelay/microDelay/waitFor poll cũng bị clamp 1s (→ +7s hằng số + opening-dialog 6-7s). Giảm DELAY_MULTIPLIER (0.30→0.18 trước đây) KHÔNG cứu được vì clamp là 1000ms bất kể giá trị yêu cầu.",
      "FIX (human.ts humanType): bỏ vòng lặp gõ từng ký tự + sleep. Set value đầy đủ 1 LẦN qua native setter (như người dùng DÁN email) + dispatch 1 chuỗi event đại diện (keydown/keypress/input/keyup ký tự cuối + change). Không còn setTimeout trong lúc gõ → không phụ thuộc throttle. Ảnh hưởng MỌI input gõ qua humanType (mời email, ô 'Lọc theo tên' của remove/sync/revoke, số giới hạn usage) → tất cả nhanh lên trong tab nền.",
      "CÒN LẠI (không trong phạm vi fix này): opening-dialog ~6-7s + vài randomDelay/humanClick vẫn bị throttle ~1s/lần khi tab nền (nhưng nhỏ và không scale theo độ dài email). Muốn triệt để phải giảm số lần setTimeout hoặc chạy tab foreground (đánh đổi UX).",
      "File đổi: apps/extension/src/content/human.ts, version.ts. Docs: content/human.md.",
    ],
  },
  {
    version: "0.9.2",
    date: "2026-06-29",
    kind: "fix",
    summary:
      "XOÁ thành viên hết báo VERIFY_FAILED OAN khi xoá thật sự đã thành công: ChatGPT xoá qua server round-trip + refetch, mạng chậm có thể >10s nên verify cũ (timeout 10s, theo dõi list optimistic) kết luận 'Member vẫn còn' dù đã xoá xong. Nay nới timeout 15s + nếu vẫn nghi ngờ thì LỌC LẠI TỪ SERVER (gõ lại email) để xác nhận dứt khoát.",
    details: [
      "USER REPORT 2026-06-29 (kèm ảnh): task 'Xoá thành viên' retoot@rkngov.com → FAILED 'VERIFY_FAILED: Member vẫn còn trong danh sách sau khi confirm Remove' — nhưng thực tế ChatGPT đã xoá thành công; verify chưa chờ xoá xong đã kết luận lỗi.",
      "ROOT CAUSE: sau khi click confirm 'Xóa', ChatGPT gửi request xoá rồi REFETCH list (không phải optimistic update tức thì). Verify cũ chỉ waitFor row biến mất khỏi list ĐANG LỌC trong 10s; mạng/ChatGPT chậm → row (stale) còn hiển thị >10s dù server đã xoá xong → waitFor timeout → VERIFY_FAILED oan. Member thật sự đã bị xoá (lần F5/sync sau xác nhận).",
      "FIX (execute-remove.ts): (1) nới timeout verify 10s→15s. (2) Thêm reverifyRemovedViaFilter: khi path nhanh timeout, ÉP ChatGPT lọc lại từ SERVER (clearMemberFilter + gõ lại local-part email) rồi đợi 5s — nếu row KHÔNG xuất hiện trở lại = server đã xoá thật → verifyOk=true (COMPLETED). Server filter là nguồn sự thật, loại trừ DOM stale của list optimistic. Chỉ trả VERIFY_FAILED khi server VẪN trả member (xoá thật bại, vd OTP/2FA challenge).",
      "Không nới mù timeout quá lớn (tránh chậm khi xoá thất bại thật) — dùng truy vấn lại server làm tín hiệu dứt khoát thay vì chờ lâu hơn.",
      "File đổi: apps/extension/src/content/actions/remove/execute-remove.ts, version.ts. Docs: remove/README.md.",
    ],
  },
  {
    version: "0.9.1",
    date: "2026-06-29",
    kind: "fix",
    summary:
      "XOÁ thành viên hết lỗi tìm nhầm ở tab 'Lời mời' rồi đánh dấu removed OAN: khi tab admin còn ?tab=invites do action trước để lại, REMOVE/CHANGE_ROLE/CHANGE_LICENSE_TYPE bị reload thẳng vào tab Lời mời → lọc không thấy member active. Nay background ép tab về /admin/members sạch (tab Người dùng) trước khi chạy, + REMOVE từ chối kết luận 'đã rời business' khi URL còn ?tab=invites/requests.",
    details: [
      "USER REPORT 2026-06-29 (kèm ảnh): task 'Xoá thành viên' nguyenthuhientho@gmail.com COMPLETED nhưng ghi chú 'Ô lọc ChatGPT không thấy email trong tab Người dùng → coi như đã rời business, đánh dấu removed' — thực tế member đang active, action lại tìm ở tab 'Lời mời' chứ không phải 'Người dùng'.",
      "ROOT CAUSE: v0.8.21 ensureAdminTab TÁI DÙNG tab admin + chrome.tabs.reload() reload NGUYÊN URL. Nếu action trước (SYNC_MEMBER tìm thấy ở pending / REVOKE / SYNC invites) để tab ở chatgpt.com/admin/members?tab=invites thì REMOVE reuse lại reload thẳng vào tab Lời mội. Guard MEMBER_LIST_TASKS trong runOnce chỉ ép navigate khi URL KHÔNG chứa '/admin/members' — nhưng '...?tab=invites' VẪN chứa chuỗi đó nên guard không kích hoạt. REMOVE dùng ô lọc làm nguồn sự thật (pageThrough:false): lọc tab Lời mời không thấy member active → trả MEMBER_NOT_IN_WORKSPACE → backend mark removed OAN.",
      "FIX 1 (runner.ts MEMBER_LIST_TASKS guard): ép navigate về CHATGPT_ADMIN_URL sạch khi (a) tab không ở /admin/members HOẶC (b) URL còn ?tab=invites/?tab=requests (regex). Navigate URL sạch luôn rớt về sub-tab Người dùng → 3 action REMOVE/CHANGE_ROLE/CHANGE_LICENSE_TYPE luôn bắt đầu đúng tab.",
      "FIX 2 (execute-remove.ts — chống mark-removed oan, 2 lớp): (a) clickTabAndWait('Người dùng') thêm waitForButtonMs=12000 (render-wait thanh tab như sync-member/revoke) để click về Người dùng đáng tin; (b) TRƯỚC khi trả MEMBER_NOT_IN_WORKSPACE, nếu location.search còn ?tab=invites/requests thì trả UI_ELEMENT_NOT_FOUND (FAILED, member CÒN) thay vì mark removed — URL là nguồn sự thật của tab đang xem.",
      "FIX 3 (change-license-type, change-role): thêm waitForButtonMs=12000 cho clickTabAndWait('Người dùng'). CHANGE_ROLE TRƯỚC ĐÂY KHÔNG chuyển tab gì cả → thêm hẳn bước clickTabAndWait về tab Người dùng (cùng class bug — lọc nhầm tab Lời mời khi tab còn ?tab=invites).",
      "File đổi: apps/extension/src/background/runner.ts, content/actions/remove/execute-remove.ts, content/actions/change-license-type/execute-change-license-type.ts, content/actions/change-role/execute-change-role.ts, version.ts. Docs: remove/README.md.",
    ],
  },
  {
    version: "0.9.0",
    date: "2026-06-23",
    kind: "feature",
    summary:
      "Action MỚI: SET_USAGE_LIMIT — đặt giới hạn tín dụng/tháng cho thành viên trên trang /admin/billing/manage_member_usage_limit ('Ghi đè mỗi người dùng'). Dashboard có thêm hành động 'Đặt giới hạn tín dụng' trong modal Cập nhật hàng loạt (mức chung cho tất cả, hoặc mức riêng từng người qua cú pháp email=số).",
    details: [
      "USER REQUEST 2026-06-23: làm chức năng cho phép admin/sub-admin tuỳ chỉnh giới hạn tín dụng của thành viên (bulk). Trang ChatGPT: mỗi row có nút 'Thêm' (chưa đặt) / 'Chỉnh sửa' (đã đặt) → dialog 'Đặt giới hạn sử dụng tùy chỉnh' (ô số + Lưu + Gỡ bỏ + ×). Có ô 'Lọc theo tên'; phân trang nhiều trang → lọc theo tên cho nhanh.",
      "EXTENSION: action mới content/actions/set-usage-limit/ (execute + finders + README). Flow: lọc theo email (KHÔNG lật trang, dùng ô lọc làm nguồn sự thật như REMOVE) → click nút Thêm/Chỉnh sửa trên row → dialog → gõ SỐ vào ô input → click 'Lưu'. TUYỆT ĐỐI tránh nút 'Gỡ bỏ' (chỉ ĐẶT số, không gỡ — theo chốt với user).",
      "RUNNER: thêm kind SET_USAGE_LIMIT vào taskToRequest + CONTENT_TIMEOUTS(150s); nhánh navigation MỚI điều hướng tab tới /admin/billing/manage_member_usage_limit (KHÁC /admin/members) trước khi dispatch.",
      "BACKEND: cột members.usage_limit_credits (migration 0020), QueueType SET_USAGE_LIMIT, endpoint POST /members/bulk-set-usage-limit (1 task/member, quyền MEMBER_REMOVE + visibility filter), sync DB khi task COMPLETED. WEB: action 'set-usage-limit' trong BulkRemoveModal (mức chung + cú pháp email=số cho mức riêng, cột 'Giới hạn hiện tại → mới').",
      "i18n đa ngôn ngữ (vi/en/zh) cho nút Thêm/Chỉnh sửa/Lưu/Gỡ bỏ trong TEXT_FALLBACKS.",
    ],
  },
  {
    version: "0.8.21",
    date: "2026-06-23",
    kind: "fix",
    summary:
      "Không mở tab mới liên tục khi chạy batch nhiều lệnh giống nhau (vd xoá 30+ thành viên): ensureAdminTab giờ TÁI DÙNG tab admin mới nhất + F5 cho MỌI action khi đã có ≥1 tab, chỉ mở tab mới khi không còn tab admin nào. Backstop: >3 tab vẫn tự đóng tab cũ cho còn 3.",
    details: [
      "USER REQUEST 2026-06-23: 'khi đang thực hiện lệnh xoá nó liên tục mở các tab mới để xoá, không cần thiết phải làm vậy với 1 lệnh giống nhau'. Mỗi REMOVE_MEMBER = 1 task = 1 runOnce → ensureAdminTab; rule cũ ≤2 tab LUÔN mở tab /admin/members mới + đóng tab cũ → batch 30+ lệnh xoá spam mở/đóng tab liên tục.",
      "FIX (background/runner.ts ensureAdminTab): bỏ nhánh '≤2 tab → mở tab mới mỗi action' và hằng ADMIN_TAB_MAX. Logic mới: (1) >ADMIN_TAB_HARD_MAX(3) → prune đóng tab cũ cho còn 3; (2) còn ≥1 tab → TÁI DÙNG tab mới nhất + F5 (reload nếu ở /admin/members, nav về /admin/members nếu sub-page khác) + verify /admin — KHÔNG mở mới/đóng; (3) chỉ khi 0 tab mới chrome.tabs.create tab mới.",
      "An toàn: tab tái dùng vẫn đi qua ensureContentInjected (inject + 3-step fallback) ở caller; F5 cho DOM/server-state sạch tương đương tab mới (chính là lý do nhánh >2 tab từ v0.8.20 đã reuse+F5 ổn định). Không còn drift context như v0.8.13 (vì v0.8.13 né tab cũ là do KHÔNG F5).",
      "File đổi: apps/extension/src/background/runner.ts (ensureAdminTab, bỏ ADMIN_TAB_MAX), runner.md, version.ts.",
    ],
  },
  {
    version: "0.8.20",
    date: "2026-06-22",
    kind: "fix",
    summary:
      "KHÔNG tự đóng tab khi user đang mở nhiều tab admin ChatGPT: >2 tab → tái dùng tab MỚI NHẤT + F5 (không mở tab mới, không đóng tab nào) thay vì luôn mở tab mới. Chỉ tự đóng khi vượt quá 3 tab (≥4) → đóng tab cũ nhất cho còn 3. ≤2 tab giữ rule cũ (mở tab mới, tổng ≤2).",
    details: [
      "USER REQUEST 2026-06-22: 'không tự động đóng nếu nhiều hơn 2 tab chatgpt đang bật' + làm rõ: khi >2 tab thì tái dùng tab mới nhất nhưng PHẢI F5 trước khi dùng; nếu >3 tab thì mới tự đóng. Phạm vi đếm: chỉ tab /admin/* (CHATGPT_TAB_MATCH), tab chat thường không tính.",
      "BỐI CẢNH: từ v0.8.13 ensureAdminTab LUÔN mở tab /admin/members mới mỗi action + đóng tab cũ giữ tổng ≤2 (ADMIN_TAB_MAX). Khi user chủ động mở nhiều tab admin, rule này đóng nhầm tab user / spam tab.",
      "FIX (background/runner.ts ensureAdminTab): thêm ADMIN_TAB_HARD_MAX=3. (1) >3 tab → pruneStaleAdminTabs đóng tab cũ nhất cho còn 3. (2) còn >ADMIN_TAB_MAX(2) tab → TÁI DÙNG tab mới nhất: nếu đang ở /admin/members thì chrome.tabs.reload (F5 thật), nếu ở sub-page khác thì chrome.tabs.update về /admin/members (= 1 load mới); đợi load + verify /admin → KHÔNG mở tab mới, KHÔNG đóng tab. (3) ≤2 tab → rule cũ: prune giữ (ADMIN_TAB_MAX-1) + mở tab mới.",
      "Tab tái dùng vẫn đi qua ensureContentInjected ở caller (inject content script + 3-step fallback) nên ổn định như tab mới; F5 đảm bảo DOM/server-state sạch (lý do v0.8.13 né tab cũ là vì KHÔNG F5 → drift context).",
      "File đổi: apps/extension/src/background/runner.ts (ensureAdminTab, ADMIN_TAB_HARD_MAX), version.ts.",
    ],
  },
  {
    version: "0.8.19",
    date: "2026-06-21",
    kind: "chore",
    summary:
      "Bỏ toast kết quả trên trang chatgpt.com (revert v0.8.17): thông báo lệnh chỉ hiển thị ở web app. REMOVE: chỉ dùng ô lọc — không thấy email thì DỪNG (không lật trang) + báo backend coi như đã rời business → mark removed ở dashboard luôn.",
    details: [
      "USER REQUEST 2026-06-21: 'chỉ cần thông báo các lệnh ở web app để người thực thi biết thôi' → gỡ toast ChatGPT, web app vẫn báo qua recent-tasks (độc lập, không đổi).",
      "FIX 1: xoá content/toast.ts + gỡ notifyActionResult/ACTION_SUCCESS_LABEL/showActionToast khỏi content/index.ts. Content script giờ chỉ dispatch + trả ExecuteActionResponse về background, không vẽ DOM toast nữa.",
      "FIX 2 (REMOVE): 'nếu email không tìm thấy ở Người dùng khi search thì không lật trang nữa'. locateMemberRow thêm opts.pageThrough; execute-remove gọi {pageThrough:false} → ô lọc là nguồn sự thật, không ra row thì DỪNG ngay (không clear-filter + lật MAX_PAGINATION_PAGES + scroll-scan).",
      "FIX 3 (REMOVE → auto-removed): 'tìm không thấy tức là không có trong business → xoá luôn ở webapp'. execute-remove trả error_code RIÊNG MEMBER_NOT_IN_WORKSPACE (thêm vào messages.ts) khi ô lọc không thấy. Backend completion.py convert FAILED→COMPLETED + mark Member.removed. KHÁC UI_ELEMENT_NOT_FOUND (menu/nút confirm lỗi = member CÓ → vẫn FAILED, không xoá). An toàn vì ô lọc server-side không sót như scroll-scan (lý do hành vi này từng bị bỏ).",
      "GIỮ NGUYÊN: change-role / change-license-type / sync-member vẫn dùng locateMemberRow mặc định (pageThrough=true) — lật trang như cũ. scrollScanForRow (revoke tab Lời mời) không đổi.",
      "File đổi: content/index.ts, content/actions/remove/{locate-member,execute-remove}.ts, shared/messages.ts, version.ts; XOÁ content/toast.ts. API: routers/queue/completion.py(+md), tests/test_bulk_remove.py.",
    ],
  },
  {
    version: "0.8.18",
    date: "2026-06-20",
    kind: "fix",
    summary:
      "Rà soát toàn bộ action: bịt nốt cùng lớp regression v0.8.13 (tab mới → DOM chưa render). Xoá/đổi vai trò/đổi license + xác minh lời mời nay CHỜ ô lọc / thanh tab render xong rồi mới thao tác, thay vì tra 1 lần khi trang vừa load.",
    details: [
      "BỐI CẢNH: từ v0.8.13 mỗi action mở tab /admin/members MỚI → content chạy NGAY khi trang vừa load. Đã fix render-wait cho REVOKE (v0.8.15) + SYNC_MEMBER/full-sync (v0.8.16); rà soát phần còn lại tìm cùng lỗi.",
      "FIX 1 (member-filter.ts: filterAndFindRow) — ô lọc 'Lọc theo tên' trước đây tra 1 lần ngay; null trên tab mới → fast-path bị bỏ qua oan, rớt xuống scroll-scan chậm/ồn. Giờ POLL chờ ô lọc render tới 8s rồi mới fallback. Ảnh hưởng MỌI action định vị member: REMOVE, CHANGE_ROLE, CHANGE_LICENSE_TYPE, SYNC_MEMBER (nhánh tab Người dùng).",
      "FIX 2 (verify-pending-via-filter.ts: VERIFY_PENDING_INVITE) — thêm waitForButtonMs=12000 + verifyTabParam='tab=invites' cho clickTabAndWait (trước đây chỉ click + sleep, không chờ render, không verify URL) → đồng bộ cơ chế với sync-member/revoke; nếu đã ở ?tab=invites (sau F5 từ flow invite) vẫn trả true ngay, không bounce tab.",
      "ĐÃ RÀ, KHÔNG ĐỔI: INVITE (chuyển tab ở CUỐI flow sau submit, trang đã render + có stable-render poll), SYNC_DATA full (đã hoist render-wait thanh tab ở v0.8.16), SYNC_BILLING / PURCHASE_SEAT (trang /admin/billing có render-delay + waitFor riêng).",
      "File đổi: content/actions/remove/member-filter.ts, content/actions/invite/verify-pending-via-filter.ts, version.ts.",
    ],
  },
  {
    version: "0.8.17",
    date: "2026-06-20",
    kind: "feature",
    summary:
      "Mỗi action chạy xong hiện toast NỔI CHÍNH GIỮA TRÊN ĐẦU trang chatgpt.com: xanh '✓ Đã ...' khi thành công (tự ẩn sau 2s), đỏ kèm nội dung lỗi khi thất bại. Trước đây action chạy âm thầm, không báo gì trên trang.",
    details: [
      "USER REPORT 2026-06-20: 'các action khi thực hiện thành công đều không báo thành công' — action chạy trong content script trên chatgpt.com nhưng không có phản hồi trực quan tại trang.",
      "FIX: thêm content/toast.ts — inject 1 phần tử thuần JS (style inline, z-index tối đa, không bị CSS ChatGPT đè), fade-in rồi auto-ẩn (success 2s, error 5s để kịp đọc). Wrap try/catch nên không bao giờ làm vỡ flow action.",
      "WIRING: content/index.ts gọi notifyActionResult(msg, result) sau dispatch — ok=true → xanh 'Đã <action>'; batch ok=true nhưng có item failed → đỏ '... nhưng N mục thất bại'; ok=false hoặc throw → đỏ kèm error_message. PING không hiện.",
      "PHỤ: toast đỏ này cũng hiển thị NGAY lỗi revoke (REVOKE_INVITES) trên trang để chẩn đoán — user báo 'lệnh thu hồi lời mời lỗi' nhưng chưa có text lỗi cụ thể; giờ lỗi sẽ hiện rõ tại chỗ.",
      "File đổi: content/toast.ts (mới), content/index.ts, version.ts. Docs: content/toast.md, docs/UI_Responsive/Success_Toast_Top_Center.md.",
    ],
  },
  {
    version: "0.8.16",
    date: "2026-06-20",
    kind: "fix",
    summary:
      "Đồng bộ 1 tài khoản lẻ ở tab 'Chờ tham gia' hết lỗi 'Không chuyển được sang tab Người dùng' (cứ kẹt ở tab Người dùng, không sang được Lời mời): đợi thanh tab render xong (poll 12s) rồi mới chuyển tab. Cùng lớp regression v0.8.13 như revoke (v0.8.15); fix luôn full-sync.",
    details: [
      "USER REPORT 2026-06-20: 'lại tiếp tục lỗi ở chức năng đồng bộ trong chờ tham gia' — SYNC_MEMBER FAILED UI_ELEMENT_NOT_FOUND 'Không chuyển được sang tab Người dùng để xác minh'; thực tế là CỨ kẹt ở tab Người dùng, KHÔNG sang được tab 'Lời mời đang chờ xử lý'.",
      "ROOT CAUSE: execute-sync-member.ts gọi thẳng clickTabAndWait('tab_pending_invites',...) ngay sau check /admin. Từ v0.8.13 mỗi action mở tab /admin/members MỚI → content chạy NGAY khi trang vừa load, findControlByKey (đồng bộ, tra 1 lần) chạy TRƯỚC khi React render thanh tab → null → clickTabAndWait trả false ngay → onPending=false → rớt xuống bước fallback tab Người dùng cũng chưa render → false → UI_ELEMENT_NOT_FOUND. Đúng regression đã fix cho revoke ở v0.8.15 nhưng sync-member bị bỏ sót.",
      "FIX (gom render-wait vào clickTabAndWait): thêm tham số `waitForButtonMs` (mặc định 0 = giữ hành vi cũ cho remove/change-role/change-license) — nếu >0 và chưa thấy nút tab thì POLL chờ render tới timeout rồi mới bỏ cuộc. Mọi caller chạm tab non-default chỉ cần truyền waitForButtonMs=12000, KHỎI tự nhớ waitFor thủ công → không thể quên render-wait lần nữa (footgun đã cắn revoke v0.8.15 + sync-member). sync-member + revoke nay dùng chung 1 cơ chế, bỏ block waitFor lặp.",
      "FIX kèm (execute-sync.ts / full-sync): hoist vòng poll 'tab render' RA NGOÀI nhánh navigate để chạy CẢ khi đã ở sẵn /admin/members (case tab mới v0.8.13) — trước đây chỉ chờ render khi phải navigate → full-sync cũng dính cùng bug khi chạm tab Lời mời.",
      "Tab 'Lời mời đang chờ xử lý' vốn đã QUÉT TRỰC TIẾP (scrollScanForRow), KHÔNG dùng ô search/filter — 1 trang là tìm thấy ngay ở vòng đầu (đúng yêu cầu user 'chỉ 1 trang thì quét luôn').",
      "File đổi: content/actions/sync/click-tab-and-wait.ts (tham số waitForButtonMs), content/actions/sync-member/execute-sync-member.ts, content/actions/revoke/execute-revoke-batch.ts (dọn waitFor lặp), content/actions/sync/execute-sync.ts, version.ts. Docs: Sync_Single_Account.md, Sync_Workspace_Data.md.",
    ],
  },
  {
    version: "0.8.15",
    date: "2026-06-19",
    kind: "fix",
    summary:
      "Thu hồi lời mời hết lỗi 'Không tìm thấy tab Lời mời đang chờ xử lý': đợi thanh tab render xong (poll 12s) rồi mới tìm + click, thay vì tra cứu 1 lần ngay khi trang vừa load. Regression của v0.8.13 (mỗi action mở tab /admin/members mới).",
    details: [
      "USER REPORT 2026-06-19: 'lệnh thu hồi đang bị lỗi ở chờ tham gia' — REVOKE_INVITES FAILED UI_ELEMENT_NOT_FOUND 'Không tìm thấy tab Lời mời đang chờ xử lý để revoke'.",
      "ROOT CAUSE: execute-revoke-batch.ts chỉ navigate + sleep 1500ms khi CHƯA ở /admin/members, rồi gọi findControlByKey (đồng bộ, tra 1 lần) để tìm tab 'Lời mời'. Từ v0.8.13 mỗi action mở tab /admin/members MỚI → content chạy NGAY khi trang vừa load + đã ở /admin/members → nhánh sleep bị skip → findControlByKey chạy TRƯỚC khi React render xong thanh tab (Người dùng/Lời mời/Yêu cầu) → null → fail. Invite không dính vì nó chuyển sang tab Lời mời SAU khi đã mở dialog + submit (trang đã render lâu).",
      "FIX (execute-revoke-batch.ts): (1) ĐỢI nút tab render bằng waitFor(findControlByKey, 12s, poll 300ms) — render-aware thay vì sleep cố định; (2) click bằng clickTabAndWait(...,'tab=invites') verify URL chuyển sang ?tab=invites + retry 3 lần (dùng chung cơ chế với sync/invite, không kẹt ở tab Người dùng do humanClick không trigger React onClick).",
      "File đổi: content/actions/revoke/execute-revoke-batch.ts, version.ts. Docs: revoke/README.md.",
    ],
  },
  {
    version: "0.8.14",
    date: "2026-06-19",
    kind: "fix",
    summary:
      "Mời email NGOÀI tên miền hết lỗi 'Dialog vẫn cảnh báo email ngoài miền đã xác minh': sau khi bật toggle 'Cho phép lời mời ngoài tên miền', background HARD-RELOAD trang admin để ChatGPT refetch org-config (external=ON) RỒI mới mở dialog mời. Đảm bảo 100% setting đã có hiệu lực trước khi mời.",
    details: [
      "USER REPORT 2026-06-19: mời email ngoài domain LUÔN fail EXTERNAL_TOGGLE_FAILED — 'Dialog vẫn cảnh báo email ngoài miền đã xác minh sau khi bật Cho phép lời mời ngoài tên miền... Setting có thể chưa kịp có hiệu lực'. Poll 8s (v0.8.12) không bao giờ clear được banner.",
      "ROOT CAUSE: navigateTo() dùng SPA-navigation (click <a> sidebar / pushState). Sau khi setExternalInvites bật toggle ON ở /admin/identity rồi SPA-nav về /admin/members, ChatGPT KHÔNG refetch org-config/verified-domains (React Query cache) → dialog Mời validate email theo config CŨ (external=OFF lúc tab load) → hiện banner đỏ 'not part of verified domains' + DISABLE nút Send invites. Banner KHÔNG TỰ clear vì không có gì refetch config trong SPA → poll vô ích → fail. Tab mới sạch (v0.8.13) còn làm chắc chắn config lúc load = OFF.",
      "FIX (v0.8.14): tách INVITE_MEMBER ngoài-domain thành 2 lần gọi giống cơ chế F5 verify Phase 2. PHASE A (execute-invite.ts): bật toggle ON + confirm (aria-checked) rồi TRẢ NGAY data.awaiting_external_reload=true (KHÔNG mở dialog). Background (runner.ts): chrome.tabs.update(/admin/members) HARD-RELOAD full để refetch org-config với external=ON, đợi load + re-inject, rồi gọi lại INVITE_MEMBER với externalReady=true. PHASE A' (execute-invite.ts): trang đã fresh → mở dialog mời (banner không còn) → submit → finally tắt toggle OFF (spec bảo mật) → awaiting_reload_verify → F5 verify Phase 2 như cũ.",
      "Content tự reload sẽ chết context content-script → CONTENT_TIMEOUT, nên reload BẮT BUỘC do background điều phối. Step 5.5 banner-check (v0.8.12) giữ làm safety-net cuối: sau hard-reload nếu banner VẪN còn (toggle thật sự không có hiệu lực) → fail trung thực thay vì tạo phantom.",
      "Email TRONG domain xác minh: không đổi — vẫn mời thẳng, không bật toggle, không reload (nhanh).",
      "File đổi: shared/messages.ts (thêm externalReady), content/index.ts, content/actions/invite/execute-invite.ts, background/runner.ts, version.ts. Docs: invite/README.md, external-invites/README.md.",
    ],
  },
  {
    version: "0.8.13",
    date: "2026-06-19",
    kind: "fix",
    summary:
      "Mời thành viên hết CONTENT_TIMEOUT / VERIFY_FAILED do tái dùng tab cũ: đổi quy tắc tab — LUÔN mở tab /admin/members MỚI cho MỖI action thay vì tái sử dụng tab cũ (tab cũ hay bị reload/redirect/drift mất context content script). Giữ tối đa 2 tab admin: trước khi mở tab mới tự đóng tab cũ dư.",
    details: [
      "USER REPORT 2026-06-19: hàng loạt 'Mời thành viên' FAILED — CONTENT_TIMEOUT ('Content script không trả kết quả cho INVITE_MEMBER trong 150s, có thể tab ChatGPT bị reload/redirect giữa chừng') và VERIFY_FAILED ('Đã submit email + F5 verify nhưng KHÔNG email nào xuất hiện trong tab Lời mời đang chờ').",
      "ROOT CAUSE: v0.8.9 đổi ensureAdminTab sang TÁI SỬ DỤNG tab /admin/* mới nhất. Tab cũ này đã sống lâu, hay bị ChatGPT hard-reload / redirect auth / bị action khác kéo sang sub-page → content script mất context giữa chừng → sendResponse không bao giờ gọi (CONTENT_TIMEOUT) hoặc pending list scrape sai trang (VERIFY_FAILED).",
      "FIX (runner.ts ensureAdminTab): theo yêu cầu user — LUÔN chrome.tabs.create tab MỚI /admin/members (background, active:false) cho MỖI action; không tái dùng tab cũ. ADMIN_TAB_MAX hạ 5→2; pruneStaleAdminTabs nhận tham số keep, trước khi mở tab mới đóng bớt tab CŨ nhất để chỉ giữ (ADMIN_TAB_MAX-1)=1 tab → tổng ≤2 (0 tab→mở 1; 1 tab→giữ+mở=2; nhiều hơn→đóng tab cũ rồi mở 1).",
      "Trong 1 action, Phase 1 (submit) + F5 verify Phase 2 vẫn dùng CHUNG tab vừa mở — 'tab mới mỗi action', không phải mỗi phase. Guard navigate-về-/admin/members cho REMOVE/CHANGE_ROLE/CHANGE_LICENSE_TYPE giữ làm safety-net (giờ thường no-op vì tab mới đã đúng trang).",
      "File đổi: apps/extension/src/background/runner.ts (ensureAdminTab, pruneStaleAdminTabs, ADMIN_TAB_MAX), runner.md, version.ts.",
    ],
  },
  {
    version: "0.8.12",
    date: "2026-06-19",
    kind: "fix",
    summary:
      "Mời email ngoài domain: sau khi gõ email, KIỂM TRA LẠI banner đỏ 'email không thuộc miền đã xác minh' trong dialog. Bật toggle 'mời ngoài tên miền' cần chút thời gian để có hiệu lực sang dialog — extension đợi banner biến mất rồi mới submit, thay vì submit mù vào nút disabled (timeout 15s) hoặc tạo lời mời ảo.",
    details: [
      "USER REPORT 2026-06-19: khi bật 'cho phép ngoài domain đã xác minh' cần một chút thời gian để load; nếu lúc mời tới đoạn nhập email mà dialog vẫn quét ra cảnh báo (ảnh: 'The following emails are not a part of your organization's verified domains') thì cần kiểm tra lại trước khi submit.",
      "ROOT CAUSE: execute-invite.ts bật toggle ở /admin/identity và xác nhận aria-checked=true TRƯỚC khi mở dialog (set-toggle.ts confirmed). Nhưng hiệu lực của setting cần thời gian PROPAGATE sang dialog Mời — trong cửa sổ đó dialog vẫn render banner đỏ + DISABLE nút 'Send invites'. Submit lúc này = click nút disabled → verify timeout 15s → VERIFY_FAILED, hoặc tệ hơn phantom 'đang chờ'.",
      "FIX (execute-invite-inner.ts bước 5.5): sau khi gõ email + set role, nếu phát hiện banner (hasVerifiedDomainWarning) thì POLL tới khi banner biến mất (waitForDomainWarningCleared, tối đa 8s, step 400ms) rồi mới submit. Hết 8s vẫn còn → return EXTERNAL_TOGGLE_FAILED (không submit) để tránh phantom; user thử lại sau vài giây khi setting đã có hiệu lực.",
      "Detection bằng text (lowercase includes) qua EXTERNAL_DOMAIN_WARNING_PATTERNS (i18n-ui.ts, đa ngôn ngữ en/vi/zh) — bền với đổi DOM/locale. Khác EXTERNAL_INVITE_LABEL_PATTERNS (label toggle trên /admin/identity).",
      "File mới: apps/extension/src/content/actions/invite/finders/find-domain-warning.ts. File đổi: execute-invite-inner.ts, i18n-ui.ts, version.ts. Docs: invite/README.md + external-invites/README.md.",
    ],
  },
  {
    version: "0.8.11",
    date: "2026-06-19",
    kind: "fix",
    summary:
      "Đổi loại giấy phép / đổi vai trò / xoá thành viên hết lỗi 'Không tìm thấy <email> sau khi lọc + lật mọi trang' dù member đang active: ép tab về /admin/members trước khi tìm. Regression của v0.8.9 (tái dùng tab admin mới nhất) — tab có thể đang ở /admin/billing nên không có list Người dùng để tìm.",
    details: [
      "USER REPORT 2026-06-19: 'khi ấn vào button đổi seat type bị lỗi không chuyển sang thành viên để tìm thành viên đó và đổi'. Queue: CHANGE_LICENSE_TYPE (tamnm@ibcgroup.vn, c1khaithai-px@hanoiedu.vn) FAILED UI_ELEMENT_NOT_FOUND 'Không tìm thấy ... sau khi lọc + lật mọi trang' — dù 2 member này đang active trong DB. Cùng action COMPLETED bình thường lúc 04:56 rồi bắt đầu fail từ 08:00+.",
      "ROOT CAUSE: v0.8.9 (cùng ngày) đổi ensureAdminTab sang TÁI SỬ DỤNG tab /admin/* mới nhất thay vì luôn mở /admin/members. executeChangeLicenseType chỉ check pathname.includes('/admin') (qua với MỌI sub-page) rồi dựa vào clickTabAndWait('Người dùng') để vào list. Nhưng 3 sub-tab Người dùng/Lời mời/Yêu cầu CHỈ tồn tại TRÊN /admin/members. Khi tab bị 1 task khác (billing/purchase/identity) kéo sang /admin/billing..., nút 'Người dùng' không có → clickTabAndWait no-op (action bỏ qua return value) → locateMemberRow quét nhầm trang → null → UI_ELEMENT_NOT_FOUND. Vì thế lúc tab tình cờ ở /admin/members thì chạy được (04:56), lúc tab drift sang billing thì fail (08:00+).",
      "FIX (runner.ts runOnce): trước khi gửi action cho các task thao tác trên list Người dùng (REMOVE_MEMBER, CHANGE_ROLE, CHANGE_LICENSE_TYPE), nếu tab.url KHÔNG chứa '/admin/members' thì chrome.tabs.update navigate về CHATGPT_ADMIN_URL + waitForTabComplete + sleep 1.5s cho list render. Đảm bảo action luôn bắt đầu đúng trên trang members bất kể tab đang ở sub-page nào.",
      "File đổi: apps/extension/src/background/runner.ts, version.ts. Docs: apps/extension/src/content/actions/change-license-type/README.md (lịch sử + đóng góc tồn đọng tab-drift), runner.md.",
    ],
  },
  {
    version: "0.8.10",
    date: "2026-06-19",
    kind: "fix",
    summary:
      "Bật toggle 'Cho phép lời mời ngoài tên miền' đáng tin hơn khi mời email ngoài domain: poll chờ ChatGPT lưu thay vì sleep cứng, double-check khi tưởng đã ON, retry click, không đoán bừa state. Mục tiêu user: toggle LUÔN OFF, chỉ bật khi mời email ngoài rồi tắt lại — và lúc bật phải chắc ăn (không mời khi toggle thật vẫn OFF).",
    details: [
      "USER REPORT 2026-06-19: 'nhiều khi bật chế độ cho phép mời ngoài bị lỗi ... nhiều khi tôi thấy nó vẫn bị tắt mà vẫn đi mời thành viên ngoài vào' (vd avkpoint@outlook.com bị mời theo lệnh lỗi).",
      "LÀM RÕ: việc toggle LUÔN hiện OFF sau khi mời là CỐ Ý (spec bảo mật v0.6.6 — force OFF sau mỗi invite). Email ngoài domain được mời vì extension tự bật ON tích tắc rồi tắt. Hệ thống KHÔNG có policy cấm mời ngoài; mọi email ngoài verified_domain đều được auto-bật-toggle. User xác nhận hành vi đúng = 'luôn tắt, khi mời ngoài thì bật lên' → giữ thiết kế, chỉ làm khâu BẬT đáng tin.",
      "ROOT CAUSE khâu bật không ổn định (set-toggle.ts): (a) click 1 lần + sleep(800) cứng + đọc state 1 lần → mạng/PATCH chậm thì verify đọc state cũ → confirmed=false oan → EXTERNAL_TOGGLE_FAILED (mời ngoài fail vô cớ). (b) getToggleState fallback trả false thầm lặng khi không đọc được aria → quyết định sai. (c) early-return khi prev===target tin tưởng 1 lần đọc DOM (có thể bắt nhầm switch / transient) → bỏ qua click → mời khi toggle thật OFF.",
      "FIX (set-toggle.ts): getToggleState trả boolean|null (không đoán bừa); khi prev===target thì đọc lại lần 2 (double-check) mới SKIP; khi click thì POLL state tới khi == target (tối đa 4s) thay vì sleep cứng; retry click tối đa 2 lần. Confirmed chỉ true khi state CUỐI thực sự == target → execute-invite.ts vẫn chặn submit nếu !confirmed (không phantom).",
      "File đổi: apps/extension/src/content/actions/external-invites/set-toggle.ts, version.ts. Docs: external-invites/README.md (đóng tồn đọng #4 sleep cứng, #5 fallback false), Invite_Member.md changelog.",
    ],
  },
  {
    version: "0.8.9",
    date: "2026-06-19",
    kind: "feature",
    summary:
      "Quản lý tab chatgpt.com/admin theo quy tắc user: CHỈ mở tab mới khi action không chạy được trên tab cũ; bình thường tái sử dụng tab mới nhất; khi >5 tab trùng thì tự đóng bớt tab cũ, giữ 5 tab mới nhất.",
    details: [
      "USER REQUEST 2026-06-19: ban đầu 'luôn mở tab mới mỗi action; >3 tab dùng tab mới nhất; >5 tab tự đóng' → sau đó chỉnh lại: 'chỉ mở tab khi các action không hoạt động trên tab cũ'.",
      "ensureAdminTab (apps/extension/src/background/runner.ts) viết lại: (1) queryAdminTabs() lấy tất cả tab /admin/* sắp xếp cũ→mới theo tab.id; (2) >ADMIN_TAB_MAX(5) → pruneStaleAdminTabs đóng các tab cũ nhất, giữ 5 tab mới nhất; (3) còn ≥1 tab → TÁI SỬ DỤNG tab MỚI NHẤT, không mở thêm; (4) 0 tab → chrome.tabs.create tab mới (background, active:false) tới /admin/members rồi verify còn ở /admin.",
      "'Mở tab mới khi action fail' đã do ensureContentInjected Step 3 NUCLEAR đảm nhiệm: content script không inject được trên tab cũ → tabs.remove tab hỏng + tabs.create tab mới hoàn toàn. ensureAdminTab không cần tự đẻ tab mỗi action nữa.",
      "Dùng tab.id làm proxy 'mới nhất' (Chrome cấp id tăng dần theo thời điểm tạo).",
      "Bỏ findAdminTab() cũ (trả tab[0]) và hằng ADMIN_TAB_REUSE_THRESHOLD (không còn dùng). File đổi: background/runner.ts, runner.md, version.ts.",
    ],
  },
  {
    version: "0.8.8",
    date: "2026-06-18",
    kind: "fix",
    summary:
      "Thu hồi lời mời (REVOKE) tìm email bằng ô 'Search for invites' trên tab Lời mời thay vì cuộn list (dễ miss). Trước đây revoke miss row → kết luận nhầm 'không có trên tab Lời mời' → fallback nhầm sang tab Người dùng (REMOVE) → fail dù email đang là pending invite.",
    details: [
      "USER REPORT + bằng chứng queue (2026-06-17): INVITE_MEMBER oewi@gmail.com COMPLETED lúc 18:07:38; REVOKE_INVITES cùng email 27s sau (18:08:05) trả 'Không có trên tab Lời mời; xoá khỏi tab Người dùng cũng thất bại: Không tìm thấy ... sau khi duyệt hết mọi trang'. Email rõ ràng đang là pending invite nhưng revoke không thấy.",
      "ROOT CAUSE: revokeInvite dùng scrollScanForRow (cuộn list virtualized) để định vị row trên tab Lời mời. List virtualized / phân trang → row ngoài viewport chưa render → miss → trả notInPending=true → executeRevokeInvites fallback sang executeRemove (tab Người dùng) → không có ở đó (vì đang pending) → fail.",
      "FIX: thêm locatePendingRow(email) — gõ email vào ô 'Search for invites' (SELECTORS.pendingSearchInput, thêm ở v0.8.7) → list rút còn 0-1 row → findMemberRow đọc ngay. Đây mới là cách đúng & chính xác. Chỉ fallback scroll-scan khi UI KHÔNG có ô search.",
      "Giữ nguyên fallback REMOVE sang tab Người dùng cho case THẬT (người đã chấp nhận lời mời → thành active member) — chỉ kích hoạt khi ô search xác nhận email không còn trong pending.",
      "File mới: apps/extension/src/content/actions/revoke/locate-pending-row.ts. File đổi: revoke-invite.ts, version.ts. Docs: apps/extension/src/content/actions/revoke/README.md.",
    ],
  },
  {
    version: "0.8.7",
    date: "2026-06-18",
    kind: "fix",
    summary:
      "Vá fast-path verify (0.8.6) KHÔNG hoạt động: tab 'Lời mời đang chờ xử lý' có ô 'Search for invites' RIÊNG (placeholder khác + thường là input[type=text]) nên selector cũ trượt → vẫn rơi về scrape cả trang + lật trang. Thêm SELECTORS.pendingSearchInput match đúng ô search lời mời.",
    details: [
      "USER REPORT (2026-06-18): sau khi mời thành công + F5 render xong, extension VẪN không gõ vào ô tìm kiếm ('Search for invites') mà quét cả trang rồi lật sang trang khác.",
      "ROOT CAUSE: v0.8.6 dùng SELECTORS.memberFilterInput (ô 'Lọc theo tên'/'Filter by name' của tab Người dùng). Tab Lời mời có ô search KHÁC: placeholder 'Search for invites', và là input[type=text] chứ không phải type=search → cả 8 selector trượt → findPendingFilterInput()=null → verifyPendingViaFilter trả null → fallback scrapePendingInvitesAfterInvite (scrape full + lật trang) đúng như user thấy.",
      "FIX: thêm SELECTORS.pendingSearchInput match placeholder/aria-label đa ngôn ngữ ('Search for invites'/'Tìm kiếm lời mời'/'搜索邀请' + bắt rộng Search/Tìm/搜索). findPendingFilterInput() thử pendingSearchInput TRƯỚC rồi mới fallback memberFilterInput.",
      "File đổi: apps/extension/src/content/selectors.ts (+pendingSearchInput), apps/extension/src/content/actions/invite/verify-pending-via-filter.ts, version.ts.",
    ],
  },
  {
    version: "0.8.6",
    date: "2026-06-18",
    kind: "fix",
    summary:
      "Verify sau khi mời (bước F5 tab 'Lời mời đang chờ xử lý') nhanh hơn NHIỀU lần: dùng ô 'Lọc theo tên' gõ thẳng từng email vừa mời thay vì scrape TOÀN BỘ list (scroll hết + lật hết trang). Không đọc email khác, không chuyển trang — y như fast-path đã dùng cho REMOVE/CHANGE_ROLE.",
    details: [
      "USER REPORT (2026-06-18): 'khi mời thành viên thành công đến bước F5 load tại trang lời mời đang chờ xử lý không cần đọc toàn bộ email hay chuyển trang. Khi render thành công thì search email sẽ nhanh hơn rất nhiều lần. Làm tương tự các chức năng tìm kiếm tương tự.'",
      "TRƯỚC: executeVerifyPendingInvite gọi scrapePendingInvitesAfterInvite → scrapeCurrentTab cuộn hết list + lật hết MỌI trang (hard cap 60s) chỉ để xác nhận vài email. Pending list dài = chậm vô ích.",
      "FIX: thêm verifyPendingViaFilter(emails) — tab 'Lời mời' dùng CHUNG ô search input[type=search] (SELECTORS.memberFilterInput) như tab 'Người dùng'. Gõ từng email (local-part rồi full email) → list rút còn 0-1 row → scrapeAllRows đọc ngay → clear filter. Mirror fast-path filterAndFindRow của REMOVE.",
      "Fallback an toàn: không vào được tab / không thấy ô lọc → trả null → executeVerifyPendingInvite tự dùng lại scrape full như cũ. Email lọc chưa thấy = unverified → giữ nguyên cơ chế F5 retry (needs_reload_retry) sẵn có.",
      "File mới: apps/extension/src/content/actions/invite/verify-pending-via-filter.ts. File đổi: execute-verify-pending.ts, version.ts. Docs: apps/extension/src/content/actions/invite/README.md.",
    ],
  },
  {
    version: "0.8.5",
    date: "2026-06-18",
    kind: "fix",
    summary:
      "Mời thành viên mở dialog NHANH hơn + chẩn đoán rõ bước nào chậm. Bỏ click tab 'Người dùng' thừa khi nút Mời đã hiện sẵn (click thừa làm ChatGPT re-fetch cả danh sách member → trễ), thay sleep 800ms cố định bằng poll dialog (mở sớm đi tiếp ngay), tách phase 'waiting-dialog' để dashboard tách bạch thời gian tìm/click nút mở vs thời gian dialog render.",
    details: [
      "USER REPORT (2026-06-18): 'time mở dialog tốn rất nhiều thời gian' (phase opening-dialog ~11s).",
      "PHÂN TÍCH: phase 'opening-dialog' gộp nhiều bước: (1) click tab 'Người dùng' (kể cả khi đã ở đúng tab) → ChatGPT re-fetch + re-render list vài giây; (2) waitFor nút Mời render (tới 8s sau navigate); (3) sleep 800ms CỐ ĐỊNH + có thể click lần 2; (4) waitFor dialog + ô email render (tới 20s). Không tách phase nên không biết bước nào chậm.",
      "FIX 1 (bỏ click thừa): chỉ click tab 'Người dùng' khi findInviteOpenButton() CHƯA thấy nút Mời. Nếu nút đã hiện = đang đúng tab → bỏ qua click (tránh ChatGPT re-fetch danh sách ngay trước khi mở dialog).",
      "FIX 2 (poll thay sleep): sau click nút Mở, poll dialog xuất hiện mỗi 150ms (tối đa 1000ms) thay vì sleep 800ms cứng → dialog mở ~150-400ms thì đi tiếp ngay (tiết kiệm ~400-650ms). Hết 1s chưa thấy mới retry click.",
      "FIX 3 (telemetry): thêm phase 'waiting-dialog' ngay trước waitFor ô email → PhaseBreakdown tách 'opening-dialog' (tìm+click nút) khỏi 'waiting-dialog' (dialog+ô email render) → lần sau nhìn breakdown biết chính xác bước nào tốn thời gian (ChatGPT render chậm vs extension chờ thừa).",
      "File đổi: apps/extension/src/content/actions/invite/execute-invite-inner.ts, version.ts. Docs: apps/extension/src/content/actions/invite/README.md.",
    ],
  },
  {
    version: "0.8.4",
    date: "2026-06-18",
    kind: "fix",
    summary:
      "Mời thành viên (và mọi task) không còn kẹt IN_PROGRESS tới khi auto-cleanup: thêm hard-timeout cho PHASE 1 (gửi lệnh tới content script). Trước đây chỉ Phase 2 (verify sau F5) có timeout; Phase 1 thì KHÔNG → khi tab ChatGPT bị reload/redirect giữa chừng (vd mời email NGOÀI tên miền phải navigate qua /admin/identity bật toggle) làm chết context content script, background chờ vô hạn → task kẹt 3-5 phút rồi báo TIMEOUT.",
    details: [
      "USER REPORT (2026-06-18): mời 'hil@gmail.com' (ngoài domain xác minh 'ndaigroup.org') → task IN_PROGRESS 343s rồi auto-cleanup TIMEOUT 'extension không trả kết quả'.",
      "ROOT CAUSE: runOnce gọi `await sendToContent(tab.id, request)` (Phase 1) KHÔNG bọc timeout. chrome.tabs.sendMessage không có timeout sẵn. Email ngoài domain đi nhánh setExternalInvites → navigateTo('/admin/identity') ↔ '/admin/members' nhiều lần; nếu ChatGPT hard-reload / redirect auth ở giữa, content script context bị huỷ TRƯỚC khi executeInvite return → onMessage listener không bao giờ gọi sendResponse → background await treo vĩnh viễn → task kẹt tới backend lazy-cleanup (STUCK_THRESHOLDS invite=3 phút; hiện 343s do cleanup chạy lazy lúc pick task kế).",
      "Phase 2 (VERIFY_PENDING_INVITE) đã được bọc withTimeout từ v0.7.12, nhưng Phase 1 bị bỏ sót — đây là lỗ hổng còn lại của cùng class bug.",
      "FIX (runner.ts): bọc Phase 1 sendToContent trong withTimeout theo từng loại task (CONTENT_TIMEOUTS): UI ops (invite/remove/role/license/revoke) 150s, sync_member/billing 210s, sync_data/harvest 330s, purchase 450s, default 270s. Mỗi cap LỚN hơn thời gian chạy hợp lệ tối đa của content nhưng NHỎ hơn ngưỡng treo backend ~30s → extension tự fail TRƯỚC, báo error_code mới CONTENT_TIMEOUT rõ ràng + giải phóng service worker + task kế chạy ngay.",
      "KHÔNG dọn phantom khi timeout: không chắc invite đã submit hay chưa (content có thể đã gửi trước khi context chết) → để task FAILED → backend completion.py phantom cleanup (Case 1 xoá record của task) hoặc SYNC_DATA định kỳ tự reconcile. Tránh xoá nhầm member đã mời thật.",
      "File đổi: apps/extension/src/background/runner.ts (CONTENT_TIMEOUTS + bọc Phase 1), apps/extension/src/shared/messages.ts (+error_code CONTENT_TIMEOUT), version.ts. Docs: apps/extension/src/content/actions/invite/README.md.",
    ],
  },
  {
    version: "0.8.3",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "Đổi loại giấy phép (CHANGE_LICENSE_TYPE): khi tìm thấy email mà license type thật trên ChatGPT đã ĐÚNG target rồi thì bỏ qua, không thao tác đổi nữa.",
    details: [
      "Sau khi định vị row (lọc theo email + lật trang), đọc license type hiện tại trên DOM bằng findLicenseTypeInRow; nếu đã = target → clearMemberFilter + trả ok:true, skipped:'already' (KHÔNG mở menu '...' / không đổi / không hiện dialog xác nhận thừa).",
      "Tin cậy hơn skip cũ dựa trên oldLicenseType từ DB (có thể stale) vì đọc giá trị thật đang hiển thị. Backend completion vẫn set Member.license_type=target (idempotent) nên DB & UI luôn khớp.",
      "File: content/actions/change-license-type/execute-change-license-type.ts.",
    ],
  },
  {
    version: "0.8.2",
    date: "2026-06-17",
    kind: "feature",
    summary:
      "Đồng bộ 1 tài khoản lẻ (SYNC_MEMBER): nút 'Đồng bộ' per-row ở member đang chờ → tìm email ở tab Lời mời, không thấy thì fallback tab Người dùng; thấy ở Người dùng nghĩa là đã tham gia → chuyển trạng thái 'đang hoạt động'; không thấy cả 2 tab → báo email không tồn tại trong workspace. Read-only, không thao tác phá huỷ.",
    details: [
      "Action mới content/actions/sync-member: scroll-scan tab Lời mời (tái dùng scrollScanForRow) → fallback locateMemberRow tab Người dùng.",
      "Trả data.found_in ∈ {pending, active, none}; backend completion set status='active' khi 'active', KHÔNG mark removed khi 'none' (tránh xoá oan).",
      "Backend: POST /sync-member (chống-spam >2 lần/60s → cooldown 5 phút) + rate-limit full-sync 1 lần/ngày cho admin phụ + GET /sync-quota để web ẩn/hiện nút.",
    ],
  },
  {
    version: "0.8.1",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "SYNC_DATA số lượng lớn: fix 'cập nhật hàng loạt không hoạt động' — phần lớn member bị mark 'removed' oan sau khi đồng bộ workspace nhiều member (>200).",
    details: [
      "ROOT CAUSE: runner SYNC_DATA chia members thành chunk 200 rồi gọi bulk-upsert nhiều lần, MỖI chunk kèm scrapedStatuses → backend reconcile theo từng chunk: incoming_emails chỉ là 200 email của chunk đó → mọi member khác (email NOT IN chunk) bị mark 'removed'. Sync ≤200 (1 chunk) đúng, nên bug chỉ hiện sau v0.6.15 (lật hết trang phân trang → list lớn).",
      "FIX extension (runner.ts + api.ts): upsert từng chunk với isFullSync:false (KHÔNG reconcile), rồi 1 request cuối (members rỗng) truyền reconcileEmails = TẤT CẢ email đã scrape + reconcilePendingEmails + scrapedStatuses → backend reconcile/rogue 1 lần trên toàn bộ. Scrape rỗng (0 member) → skip reconcile, tránh xoá oan cả team.",
      "FIX backend (schemas.py + members/reconcile.py): MemberBulkUpsert thêm reconcile_emails/reconcile_pending_emails; reconcile dùng các list này làm tập 'đã scrape' (fallback body.members khi None). Test: tests/test_bulk_upsert_chunked_reconcile.py.",
    ],
  },
  {
    version: "0.7.16",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "XOÁ thành viên: tìm item menu + nút xác nhận BỀN hơn — quét rộng role (menuitem/menuitemradio/option/button trong [role=menu]) thay vì chỉ [role=menuitem], nút xác nhận quét cả [role=dialog]/[role=alertdialog]. Khi fail thì error_message in luôn các item/nút THẬT đang thấy để pinpoint. Fix tiếp 'Menu mở nhưng không có item Remove' dù v0.7.14 đã thêm nhãn 'Loại bỏ thành viên'.",
    details: [
      "USER REPORT: sau v0.7.14 (thêm nhãn 'Loại bỏ thành viên') task REMOVE_MEMBER VẪN fail 'UI_ELEMENT_NOT_FOUND: Menu mở nhưng không có item Remove' (saptv2019, nguyenthihieuhp82, caothuy031025, dthh110483...). User mô tả đúng flow: ấn 'Loại bỏ thành viên' → popup → ấn nút đỏ 'Xóa' (bỏ qua 'Hủy bỏ').",
      "ROOT CAUSE: execute-remove dò item bằng queryByText('[role=menuitem]', t) — CHỈ quét role=menuitem. ChatGPT (Radix UI) render item xoá có thể là menuitemradio/option/button trong [role=menu], KHÔNG phải menuitem thuần → dù nhãn 'Loại bỏ thành viên' đã có trong fallback vẫn không có element nào khớp selector → waitFor 5s timeout. (change-license-type đã quét rộng role nên không dính lỗi này.)",
      "FIX 1 (menu item): openMenuItems() quét '[role=menu] [role=menuitem], [role=menu] [role=menuitemradio], [role=menu] [role=option], [role=menu] button, [role=menuitem], [role=menuitemradio], [role=option]'. findMenuItemByText match substring sau normalize trên TẤT CẢ phần tử đó.",
      "FIX 2 (confirm button): findConfirmRemoveButton quét '[role=dialog] button, [role=alertdialog] button, button', match CHÍNH XÁC hoặc startsWith nhãn ('Xóa'/'Remove'/…) để KHÔNG dính nút 'Hủy bỏ'.",
      "FIX 3 (diagnostic): fail item → error_message in JSON các item menu thật (rỗng = menu không mở = lỗi nút '...'; có item = sai text/role). Fail confirm → in các nút trong dialog. Hết đoán mò.",
      "FIX 4 (🔴 SELF-HEAL CHẾT — vì sao các bản fix trước test nhầm code cũ): isExtensionStale() chỉ phát hiện build mới qua 404 của file content-script CŨ. Nhưng vite.config để emptyOutDir:false (giữ file cũ) → file cũ không bao giờ 404 → isExtensionStale luôn false → extension KHÔNG BAO GIỜ tự reload sau npm run build → mỗi bản fix phải reload tay, user test nhầm code cũ nhiều vòng. FIX: isExtensionStale đọc thêm manifest.json TRÊN ĐĨA (cache:no-store) và so content_scripts với manifest trong RAM — khác = build mới = reload. Guard sig/count cũ chống loop nguyên vẹn.",
      "File đổi: apps/extension/src/content/actions/remove/execute-remove.ts, apps/extension/src/background/runner.ts (isExtensionStale 2 tầng), version.ts. Docs: actions/remove/README.md, docs/Extension_Runtime/Self_Heal_Stale_Build.md.",
    ],
  },
  {
    version: "0.7.15",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "Giảm thời gian chờ F5 khi verify lời mời đang chờ xử lý xuống ~10s. Phase 2 không còn ngủ cố định 2.5s + retry [0,3s,6s] (tổng ~11.5s); thay bằng: render xong → kiểm tra → nếu chưa thấy email thì F5 reload THẬT ngay, lặp trong ngân sách 10s.",
    details: [
      "USER REQUEST (2026-06-17): 'giảm thời gian chờ F5 lúc verify pending xuống còn 10s — chuyển sang tab Lời mời, render xong mà không thấy email cần tìm thì F5 reload luôn.'",
      "TRƯỚC: execute-verify-pending ngủ cố định sleep(2500) rồi vòng retry nội bộ delays [0,3000,6000]ms (bounce tab Người dùng để ép re-fetch) → ngay cả khi email đã hiện vẫn tốn 2.5s; case index chậm tốn tới ~11.5s.",
      "SAU (content): bỏ sleep cố định + vòng retry. waitForPendingListStable(emails, 4000) trả NGAY khi đủ email hiện trong DOM (fast path sub-second), scrape 1 lần, rồi báo needs_reload_retry nếu còn email chưa thấy. KHÔNG bounce tab (bounce serve React Query cache stale).",
      "SAU (background runner): bọc F5+verify trong vòng lặp ngân sách VERIFY_BUDGET_MS=10s, tối đa MAX_VERIFY_RELOADS=3 vòng. Mỗi vòng = chrome.tabs.reload (F5 THẬT, ép re-fetch từ server) + re-inject + VERIFY_PENDING_INVITE. Dừng sớm khi đủ email / scrape fail / hết budget. waitForTabComplete per-round 20s→15s.",
      "File đổi: apps/extension/src/content/actions/invite/execute-verify-pending.ts, apps/extension/src/background/runner.ts, version.ts. Docs: apps/extension/src/content/actions/invite/README.md.",
    ],
  },
  {
    version: "0.7.14",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "XOÁ thành viên hết fail 'Menu mở nhưng không có item Remove': bổ sung nhãn tiếng Việt thật của ChatGPT — item menu là 'Loại bỏ thành viên' (không phải 'Xoá ...'). Thêm 'Loại bỏ thành viên' / 'Loại bỏ' vào TEXT_FALLBACKS.removeMenuItem + confirmRemoveButton.",
    details: [
      "USER REPORT: task REMOVE_MEMBER (saptv2019@gmail.com) FAILED 'UI_ELEMENT_NOT_FOUND: Menu mở nhưng không có item Remove.' User chỉ rõ: nếu UI tiếng Việt thì text là 'Loại bỏ thành viên'.",
      "ROOT CAUSE: TEXT_FALLBACKS.removeMenuItem CHỈ có 'Remove'/'Remove member'/'Xoá'/'Xóa'/'Xoá khỏi workspace' — KHÔNG có 'Loại bỏ thành viên'. queryByText match theo substring sau normalize; không nhãn nào là substring của 'loại bỏ thành viên' → waitFor 5s không thấy item → fail. (README cũ đã liệt kê 'Loại bỏ thành viên' nhưng code thực tế chưa từng có chuỗi này — doc lệch code.)",
      "FIX: thêm 'Loại bỏ thành viên' + 'Loại bỏ' vào TEXT_FALLBACKS.removeMenuItem (đặt trước các biến thể 'Xoá').",
      "Dialog xác nhận: tiêu đề là 'Loại bỏ thành viên' nhưng nút đỏ xác nhận là 'Xóa' (nút huỷ 'Hủy bỏ') → confirmRemoveButton KHÔNG cần đổi, 'Xóa'/'Xoá' đã phủ sẵn (queryByText chỉ quét <button> nên tiêu đề dialog không match nhầm).",
      "File đổi: apps/extension/src/content/i18n-ui.ts, version.ts. Docs: apps/extension/src/content/actions/remove/README.md.",
    ],
  },
  {
    version: "0.7.13",
    date: "2026-06-17",
    kind: "feature",
    summary:
      "Thu hồi (REVOKE_INVITES) tự fallback sang XOÁ: nếu email cần thu hồi KHÔNG còn trên tab 'Lời mời đang chờ xử lý' (thường vì người đó đã chấp nhận lời mời → thành member active), extension tự chuyển sang tab 'Người dùng', tìm và xoá họ khỏi workspace thay vì báo fail.",
    details: [
      "USER REPORT: 'khi đang chờ tham gia cũng chưa có hành động thu hồi; nếu ấn thu hồi mà search email không có thì cần chuyển sang tab người dùng, tìm và xoá người dùng đó khỏi workspace'.",
      "ROOT CAUSE: revokeInvite chỉ tìm row trên tab 'Lời mời'. Khi invite đã được chấp nhận, email rời tab pending → 'Row không tìm thấy' → fail, không có hành động tiếp.",
      "FIX: revoke-invite.ts gắn cờ notInPending khi scroll-scan hết list mà không thấy row. execute-revoke-batch.ts sau vòng revoke gom các email notInPending, gọi executeRemove (tự click tab 'Người dùng' + lọc/lật trang + confirm + verify) để xoá khỏi workspace. Kết quả gắn viaRemove=true.",
      "Backend KHÔNG đổi: completion.py đã mark mọi email trong payload REVOKE_INVITES (pending|active) thành 'removed' khi task COMPLETED → cả invite thu hồi lẫn member bị xoá fallback đều đồng bộ đúng.",
      "File đổi: apps/extension/src/content/actions/revoke/revoke-invite.ts, execute-revoke-batch.ts, version.ts. Docs: apps/extension/src/content/actions/revoke/README.md.",
    ],
  },
  {
    version: "0.7.12",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "INVITE không còn kẹt 5 phút: thêm hard-timeout 60s cho vòng VERIFY Phase 2 (trước đây KHÔNG có timeout → content treo = SW chờ vô hạn → task IN_PROGRESS tới lazy-cleanup backend 5 phút). Vượt 60s → coi verify scrape failed (giữ pending, SYNC_DATA reconcile sau) → task COMPLETED ngay.",
    details: [
      "USER REPORT: 'mời đang lỗi, 1 mời đến tận 5 phút'. Dữ liệu thật: invite COMPLETED bình thường ~28-44s, nhưng 3 invite gần nhất kẹt 339-396s — 2 cái TIMEOUT (kẹt phase 'submit-done', SW không trả kết quả) + 1 VERIFY_FAILED chạy thật 396s.",
      "ROOT CAUSE: chrome.tabs.sendMessage(VERIFY_PENDING_INVITE) ở runner Phase 2 KHÔNG bọc timeout. Verify scrape chậm/treo (ChatGPT index pending 1-5s, retry [0,3000,6000] + nhiều pass scrape, cap nội bộ 60s/scrape) → round-trip có thể kéo vài phút hoặc treo tới khi SW chết → backend lazy-cleanup mới dọn (STUCK_THRESHOLD).",
      "FIX: helper withTimeout() bọc verify round-trip, cap VERIFY_ROUNDTRIP_TIMEOUT_MS=60s. Vượt → reject → rơi vào catch sẵn có → response verify_scrape_failed=true → reportToBackend mark COMPLETED (KHÔNG dọn phantom vì scrape coi như fail, giữ record pending). 60s < ngưỡng treo invite backend (3 phút) nên SW còn sống luôn tự kết thúc trước, không bị TIMEOUT oan.",
      "BACKEND đi kèm: execution.py STUCK_THRESHOLD 5 phút cứng → per-type (invite/remove/role/revoke 3 phút, sync_billing 4, sync_data/harvest 6, purchase 8) — task UI chết được dọn nhanh, task dài không bị auto-fail oan (tồn đọng #4 execution.md).",
      "File đổi: apps/extension/src/background/runner.ts (withTimeout + bọc verify), version.ts. Backend: apps/api/app/routers/queue/execution.py. Docs: docs/Workspace_Management/Invite_Member.md, execution.md.",
    ],
  },
  {
    version: "0.7.11",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "Scrape ngày renew thêm fallback dạng ĐƠN (vd 'gia hạn vào 11 thg 7, 2026' / 'Renews on Jul 11, 2026'). Trước đây chỉ bắt dạng KHOẢNG '11 thg 5 - 11 thg 6' → 1 số plan renewal về null → dashboard giá '—' dù sync OK.",
    details: [
      "USER REPORT: workspace synced OK, 8 hoá đơn paid, nhưng 'Giá 1 slot hôm nay' + 'Giá full month' + 'Ngày renew' đều '—' vì renewal_date = null.",
      "ROOT CAUSE: parseRenewalDateVi chỉ match VI_MONTH_RE / ZH_MONTH_RE (dạng khoảng X - Y). Plan hiển thị renew dạng ngày đơn không khớp → null → computeTodayPerSlotPrice thoát sớm note 'no_renewal_date'.",
      "FIX: thêm parseRenewalSingleDate — neo theo từ khoá (gia hạn|renew|next billing/payment|续订|下次…) rồi bắt 1 ngày đơn (vi/en/zh, year optional, suy năm = tương lai gần nhất) trong cửa sổ ~80 ký tự. Range vẫn ưu tiên trước.",
      "DIAGNOSTIC: logBillingDiagnostic khi renewal=null giờ dump renewal_context (text quanh từ khoá) + date_tokens → nếu vẫn miss, 1 dòng SW console là đủ hoàn thiện regex.",
      "File đổi: apps/extension/src/content/scrapers/billing.ts, .../sync-billing/log-diagnostic.ts, version.ts.",
    ],
  },
  {
    version: "0.7.10",
    date: "2026-06-17",
    kind: "fix",
    summary:
      "Self-heal stale build reload NGAY khi rebuild, KỂ CẢ lúc rảnh (bỏ gate pending>0). Mỗi `npm run build` tự áp build mới trong ≤1 phút mà không cần reload tay chrome://extensions.",
    details: [
      "USER REPORT: sau khi rebuild extension, task SYNC_BILLING bị TIMEOUT 5 phút (IN_PROGRESS 301s) — SW stale claim task rồi bị reload/kill giữa chừng → backend không ai báo → lazy-cleanup auto-fail.",
      "ROOT CAUSE: gate v0.7.5 `countPendingTasks() > 0` mới self-heal → lúc rảnh build stale KHÔNG tự reload; task PENDING đầu tiên tới có thể bị SW stale claim trước khi heal → mồ côi → TIMEOUT.",
      "FIX: bỏ gate pending>0 trong selfHealIfStale + doRunUntilIdle — hễ isExtensionStale() = true thì reloadForStaleBuild() ngay, kể cả lúc rảnh. Chống loop GIỮ NGUYÊN bằng sig-dedup (MAX_RELOADS_PER_SIG lần/build): mỗi build = 1 sig mới = reload 1 lần.",
      "TRADEOFF: có thể thoáng bật chrome://extensions + mở lại tab ChatGPT lúc rảnh sau mỗi build — chấp nhận để 'update tự áp dụng'. Khi đang dev nên dùng `npm run dev` (CRXJS HMR) — file dev-server luôn tồn tại nên không bị coi là stale, self-heal không xen vào.",
      "File đổi: apps/extension/src/background/runner.ts (bỏ countPendingTasks gate), version.ts. Docs: docs/Extension_Runtime/Self_Heal_Stale_Build.md.",
    ],
  },
  {
    version: "0.7.9",
    date: "2026-06-16",
    kind: "chore",
    summary:
      "Giảm 30% thời gian chờ giữa 2 task: betweenTasksMs 1200→840ms. Throughput tăng ~30% khi chạy nhiều task liên tiếp (invite/role/remove…).",
    details: [
      "RATE_LIMIT.betweenTasksMs: 1200 → 840 (-30%). Đây là min delay giữa 2 task BẤT KỲ trong runner (applyRateLimit), chống ChatGPT nghi bot. Lịch sử: 5000→2000→1200→840.",
      "batchSize (10) + batchPause (6–12s mỗi 10 task) GIỮ NGUYÊN — chỉ giảm nhịp chờ giữa từng task.",
      "Lưu ý: 3 setting workspace rate_limit_invite_ms/role_ms/remove_ms trong UI Settings hiện KHÔNG được code execute đọc (dead config) — tốc độ thực tế do RATE_LIMIT này quyết định, không phải 3 số đó.",
    ],
  },
  {
    version: "0.7.8",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "STALE_BUILD: phát hiện build cũ NGAY trước khi inject → bỏ 3 step executeScript chắc-chắn-fail (~23s + phá tab) → mark task FAILED rõ ràng rồi tự reload extension. Guard count-based cho thêm 1 lần reload khi Chrome chậm nạp build (hết kẹt CONTENT_NOT_INJECTED vĩnh viễn)",
    details: [
      "USER REPORT: task fail CONTENT_NOT_INJECTED, diag 'Could not load file: assets/index.ts-loader-CycUqvAL.js' — cả 3 step fallback (executeScript / reload tab / recreate tab) đều THREW 'Could not load file', tốn ~23s rồi give up. Kèm theo: toggle 'mời ngoài tên miền' không tự bật — thực ra là HỆ QUẢ (content script chưa hề inject thì executeInvite/setExternalInvites không chạy), KHÔNG phải bug riêng.",
      "ROOT CAUSE 1 (3 step vô ích): manifest đang chạy trỏ file content-script đã bị xoá khỏi đĩa (rebuild đổi hash, Chrome chưa reload). Cả 3 step trong ensureContentInjected đều dùng chrome.scripting.executeScript({files}) với CHÍNH file đã mất → luôn THREW 'Could not load file'. 3 step chỉ reload TAB, không bao giờ reload EXTENSION → về bản chất không thể chữa stale build, chỉ phí thời gian + phá tab user (Step 3 NUCLEAR).",
      "ROOT CAUSE 2 (self-heal kẹt): guard v0.7.5 chặn CỨNG sau đúng 1 reload/sig (lastSig===sig → không reload nữa). Nếu chrome.runtime.reload() lần đầu KHÔNG kéo được build mới vào (Chrome chậm áp dụng unpacked build) → manifest kẹt hash cũ → sig không đổi → guard chặn vĩnh viễn → mọi task fail tới khi reload tay. Guard nhầm 'đã reload 1 lần' = 'build hỏng' trong khi đĩa có build tốt.",
      "FIX 1 (ensureContentInjected): sau initial ping fail → check isExtensionStale() NGAY. Nếu stale → bỏ qua hẳn 3 step executeScript (chắc chắn fail), return {stale:true}. Tiết kiệm ~23s + không phá tab user.",
      "FIX 2 (sendToContent + runOnce): stale → error_code MỚI 'STALE_BUILD' (tách khỏi CONTENT_NOT_INJECTED). runOnce reportToBackend mark task FAILED (immediate, KHÔNG kẹt 5 phút chờ lazy-cleanup TIMEOUT) RỒI mới reloadForStaleBuild() → SW restart, task kế chạy bình thường không cần user reload tay.",
      "FIX 3 (reloadForStaleBuild + guard count-based): tách logic reload ra hàm riêng dùng chung cho selfHealIfStale (đầu drain) + runOnce. Thay guard 'chặn cứng sau 1 lần' bằng đếm STALE_RELOAD_COUNT_KEY: cho phép tối đa MAX_RELOADS_PER_SIG=2 reload/sig rồi mới bỏ cuộc → Chrome chậm nạp build vẫn được thử lại 1 lần, nhưng build hỏng thật vẫn bound (không loop vô hạn). sig đổi → count reset.",
      "File đổi: background/runner.ts (reloadForStaleBuild + STALE_RELOAD_COUNT_KEY/MAX_RELOADS_PER_SIG + stale short-circuit trong ensureContentInjected + map STALE_BUILD trong sendToContent + trigger reload trong runOnce), shared/messages.ts (+error_code STALE_BUILD).",
    ],
  },
  {
    version: "0.7.7",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "Định vị member khi đổi giấy phép/xoá: thử lọc cả full email + log [autogpt-locate] để debug 'không tìm thấy email'",
    details: [
      "USER: sau khi nạp bản mới, đổi seat hết lỗi inject (self-heal v0.7.4+) nhưng báo UI_ELEMENT_NOT_FOUND 'Không tìm thấy <email> sau khi lọc + lật mọi trang'.",
      "filterAndFindRow (dùng chung REMOVE + CHANGE_LICENSE_TYPE): trước chỉ gõ local-part vào ô lọc. Giờ thử local-part RỒI full email (giống user gõ tay) — humanType tự clear nên gọi lại an toàn.",
      "Thêm log [autogpt-locate]: ô lọc tìm thấy chưa (+placeholder), số row hiển thị sau mỗi lần lọc, thấy/không thấy row, vào nhánh lật trang + thấy ở trang mấy → đọc console biết chính xác bước nào trượt.",
      "Web: hiển thị tiến trình task (đổi giấy phép/xoá/đổi vai trò) ngay trên trang Thành viên dashboard.",
      "File đổi: remove/member-filter.ts, remove/locate-member.ts; web Members.tsx.",
    ],
  },
  {
    version: "0.7.5",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "SELF-HEAL chỉ pop chrome://extensions khi extension THỰC SỰ có build mới (guard theo chữ ký build) + chỉ khi có task PENDING — hết cảnh tự reload + mở tab ChatGPT lặp lại lúc rảnh",
    details: [
      "USER REPORT: extension đang chạy trên tab ChatGPT của user, rồi tự bật chrome://extensions, xong tự mở thêm 1 tab ChatGPT khác — lặp lại rất khó chịu. Yêu cầu: chỉ pop chrome://extensions khi extension thực sự có thay đổi.",
      "ROOT CAUSE: self-heal (v0.7.4) chạy ở đầu doRunUntilIdle nên kích hoạt ở MỌI nhịp drain (poll 5s SSE + alarm 1 phút) kể cả lúc rảnh. Guard cũ dùng TIMESTAMP 15s: nếu build cứ stale thì cứ mỗi 15s lại chrome.runtime.reload() → Chrome bật chrome://extensions + SW boot lại mở tab ChatGPT → pop lặp vô hạn dù build KHÔNG đổi gì thêm.",
      "FIX 1 — guard theo CHỮ KÝ BUILD (manifestBuildSig: danh sách file content-script kèm hash trong manifest). Thay STALE_RELOAD_KEY (timestamp) bằng STALE_RELOAD_SIG_KEY (sig). Chỉ chrome.runtime.reload() khi sig KHÁC sig đã reload lần trước = đĩa có build MỚI thật sự → pop ĐÚNG 1 LẦN cho mỗi build. Nếu vẫn stale với cùng sig (Chrome chưa nạp / build hỏng) → log lỗi, KHÔNG reload lại → hết loop pop.",
      "FIX 2 — gate bằng countPendingTasks() trong doRunUntilIdle: chỉ self-heal khi isExtensionStale() VÀ có ≥1 task PENDING. Rảnh (0 task) thì im lặng, không pop, không mở tab thừa. isExtensionStale() (fetch file local) check trước nên case bình thường không tốn request mạng.",
      "Giữ nguyên khả năng tự phục hồi: build stale + có task chờ → vẫn tự reload đúng như v0.7.4 (không quay lại bug CONTENT_NOT_INJECTED), nhưng giờ tối đa 1 pop cho mỗi build mới.",
      "File đổi: background/runner.ts (manifestBuildSig + guard sig trong selfHealIfStale + import countPendingTasks + gate trong doRunUntilIdle).",
    ],
  },
  {
    version: "0.7.4",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "SELF-HEAL: SW tự chrome.runtime.reload() khi phát hiện manifest trỏ file đã bị xoá (rebuild) — KHÔNG còn phải reload tay ở chrome://extensions, fix gốc CONTENT_NOT_INJECTED",
    details: [
      "USER REPORT: task CHANGE_LICENSE_TYPE fail CONTENT_NOT_INJECTED, diag: 'Could not load file: assets/index.ts-loader-D8UHvaps.js'. Manifest SW đang chạy trỏ hash CŨ (D8UHvaps) trong khi đĩa đã rebuild ra hash MỚI (CCL10K53) + file cũ bị xoá → cả auto-injection lẫn 3 step executeScript fallback đều 'Could not load file'.",
      "ROOT CAUSE (mọi lần vá trước — v0.4.17/0.4.18/0.6.3/0.6.7 — đều xử lý phần ngọn): sau `vite build` Chrome KHÔNG tự reload extension unpacked → service worker giữ manifest cũ trong RAM, trỏ tới file content-script đã bị xoá. Mọi task fail tới khi user bấm reload ở chrome://extensions.",
      "FIX (runner.ts): thêm isExtensionStale() — fetch từng file js mà manifest tham chiếu qua chrome.runtime.getURL; file 404 = stale build. selfHealIfStale() gọi chrome.runtime.reload() để Chrome đọc lại manifest+file MỚI từ đĩa (extension unpacked), tự sửa hash. Guard 15s (timestamp trong chrome.storage.local, sống sót qua reload) chống loop nếu build thật sự thiếu file.",
      "Đặt ở ĐẦU doRunUntilIdle — 1 điểm chặn duy nhất mà mọi đường drain (SSE task-available, SSE poll 5s, alarm backup 1 phút, popup run-pending, boot SW) đều đi qua, và chạy TRƯỚC pickNextTask nên không task nào bị claim rồi bỏ dở khi SW restart.",
      "KẾT QUẢ: sau khi rebuild extension, lần drain kế tiếp (≤5s nếu SSE connected, ≤1 phút qua alarm) SW tự reload → task chạy tiếp tự động. KHÔNG cần thao tác chrome://extensions thủ công nữa.",
      "File đổi: background/runner.ts (isExtensionStale + selfHealIfStale + chèn vào doRunUntilIdle).",
    ],
  },
  {
    version: "0.7.3",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "Đổi giấy phép: LỌC THEO TÊN bằng email trước khi bấm '...' (như REMOVE) — fix không đổi được trên list 100+ member phân trang",
    details: [
      "USER chỉ rõ thao tác: tab Người dùng → 'Lọc theo tên' → nhập email → bấm '...' → 'Thay đổi loại giấy phép' → ChatGPT/Codex.",
      "ROOT CAUSE: v0.7.0–0.7.2 gọi findMemberRow(email) thẳng trên DOM. List 108 member phân trang (5 trang × 25 row ảo) → row cần đổi thường KHÔNG nằm trong viewport → findMemberRow null → task FAILED, ChatGPT không đổi gì.",
      "FIX: executeChangeLicenseType tái dùng locateMemberRow + clearMemberFilter của REMOVE: clickTabAndWait('tab_active_members') → lọc theo email (zoom còn 1 row) → bấm '...' → chọn ChatGPT/Codex → clear filter. Giữ log [autogpt-license] + dump menu + xử lý submenu + dialog xác nhận của v0.7.2.",
      "File đổi: change-license-type/execute-change-license-type.ts (import locate-member + member-filter từ ../remove, clickTabAndWait từ ../sync).",
    ],
  },
  {
    version: "0.7.2",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "CHANGE_LICENSE_TYPE: log chi tiết + dump menu items + xử lý submenu (hover/pointer/ArrowRight) + dialog xác nhận — debug 'đổi giấy phép không ăn'",
    details: [
      "USER REPORT: scrape license đã OK nhưng đổi giấy phép không tác động lên ChatGPT (UI đang English).",
      "execute-change-license-type viết lại: console.log từng bước (prefix [autogpt-license]) + dumpOpenMenus() in text mọi menu item đang mở → biết chính xác menu '...' chứa gì.",
      "openSubmenu(): mở submenu 'Change license type' bằng nhiều cách — pointerover/pointerenter/mouseover/mousemove + focus + phím ArrowRight + click (Radix Menu.Sub mở theo pointer/keyboard, không chỉ click).",
      "findConfirmButton(): nếu ChatGPT bật dialog xác nhận sau khi chọn → tự click nút Change/Confirm/Switch/Đổi/Xác nhận.",
      "Nếu vẫn fail: error_message hướng dẫn xem console [autogpt-license] để lấy danh sách menu items thật.",
      "File đổi: change-license-type/execute-change-license-type.ts.",
    ],
  },
  {
    version: "0.7.1",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "Scrape license_type mạnh hơn — bắt được cả khi 'ChatGPT/Codex' nằm trong nút/dropdown (kèm mũi tên), không chỉ text thuần",
    details: [
      "USER REPORT: dashboard cột 'Giấy phép' trống dù tab Người dùng trên ChatGPT có hiển thị loại giấy phép.",
      "Nguyên nhân: findLicenseTypeInRow v0.7.0 chỉ match element LÁ có text ĐÚNG y hệt 'ChatGPT'/'Codex'. UI thật render trong button/dropdown (đổi được) nên text kèm mũi tên '▾' hoặc icon → không phải lá hoặc không bằng đúng chuỗi → trượt.",
      "Fix: duyệt mọi element, lấy DIRECT TEXT (bỏ text của element con để cô lập nhãn 1 cell), strip caret ▼▾▿⌄⇣ rồi so khớp 'chatgpt'/'codex'. Vẫn tránh false-positive từ email/tên vì direct text của ô email là cả địa chỉ.",
      "Thêm console.warn tối đa 3 row đầu khi không tìm thấy (in row.text rút gọn) để debug DOM nếu vẫn trượt.",
      "Cần SYNC lại workspace sau khi load bản này để điền license_type.",
      "File đổi: row-extractors/license-type.ts.",
    ],
  },
  {
    version: "0.7.0",
    date: "2026-06-15",
    kind: "feature",
    summary:
      "CHANGE_LICENSE_TYPE — đổi loại suất cấp phép (ChatGPT/Codex) của member từ dashboard + scrape license_type khi SYNC",
    details: [
      "USER REQUEST 2026-06-15 (kèm ảnh menu '...' /admin/members): mỗi member có 'Loại suất cấp phép' = ChatGPT | Codex, đổi qua menu '...' → 'Thay đổi loại giấy phép' → ChatGPT/Codex. Cần đưa thông tin này vào dashboard + cho đổi.",
      "Action mới CHANGE_LICENSE_TYPE (mirror CHANGE_ROLE): dashboard (super-admin) chọn ChatGPT/Codex trong dropdown cột 'Giấy phép' → PATCH /workspaces/{id}/members/{mid}/license-type → QueueItem CHANGE_LICENSE_TYPE → SSE → extension thực thi.",
      "execute-change-license-type.ts: findMemberRow(email) → click nút '...' → tìm option ChatGPT/Codex (mở submenu 'Thay đổi loại giấy phép' nếu cần) → click. Bỏ qua nếu old==new.",
      "SYNC_DATA giờ scrape thêm license_type mỗi row (row-extractors/license-type.ts: tìm element lá có text đúng 'ChatGPT'/'Codex', tránh false-positive từ email/tên). bulk-upsert lưu Member.license_type.",
      "Backend: Member.license_type (migration 0014), MemberOut/MemberUpsert + LicenseType schema, queue.update_task sync license_type khi task COMPLETED. Permission tái dùng MEMBER_CHANGE_ROLE.",
      "File đổi: ext messages.ts, i18n-ui.ts, scrape-all-rows.ts, runner.ts, content/index.ts, api.ts, change-license-type/*; api models.py, schemas.py, routers/members.py, routers/queue.py, alembic 0014; web types.ts, Members.tsx, i18n vi/zh-CN.",
    ],
  },
  {
    version: "0.6.19",
    date: "2026-06-15",
    kind: "fix",
    summary:
      "REMOVE member: lật trang + scroll như SYNC để không tìm sót trong list dài (hết kick 'ảo')",
    details: [
      "Bug: trên workspace đông member (list phân trang/virtualized), executeRemove chỉ dựa ô lọc → tìm sót row → báo UI_ELEMENT_NOT_FOUND dù member vẫn còn → backend reconcile nhầm thành 'đã removed' (kick ảo, member thực tế vẫn trong workspace).",
      "locate-member.ts mới: thử ô lọc trước, không thấy thì clear lọc + về trang 1 + lật từng trang + scroll-scan (tái dùng pagination.ts của SYNC) tới khi thấy row hoặc hết trang.",
      "Backend (queue.py): BỎ auto-reconcile UI_ELEMENT_NOT_FOUND→COMPLETED cho REMOVE_MEMBER — không tự đánh dấu removed nữa; task để FAILED, SYNC là nguồn chân lý.",
    ],
  },
  {
    version: "0.6.18",
    date: "2026-06-14",
    kind: "fix",
    summary:
      "Sync bỏ tab 'Yêu cầu đang chờ xử lý' — members=tab Người dùng, invites=tab Lời mời, both=cả 2",
    details: [
      "User yêu cầu: không quét tab 'Yêu cầu đang chờ xử lý' nữa.",
      "execute-sync.ts: bỏ block scrape tab_pending_requests. scope 'invites' giờ CHỈ quét tab 'Lời mời đang chờ xử lý'; 'members' chỉ tab 'Người dùng'; 'both' = cả 2 tab đó.",
    ],
  },
  {
    version: "0.6.17",
    date: "2026-06-14",
    kind: "fix",
    summary:
      "Sync 'Lời mời': verify URL ?tab=invites đã đổi tab mới scrape (hết bug vẫn ở tab Người dùng)",
    details: [
      "User report: đồng bộ 'Lời mời đang chờ xử lý' KHÔNG đổi tab, vẫn ở tab Người dùng → scrape nhầm.",
      "Nguyên nhân: clickTabAndWait chỉ humanClick rồi sleep cố định, KHÔNG kiểm chứng tab đã đổi. humanClick đôi khi không trigger React onClick / match nhầm element → tab không đổi nhưng code vẫn proceed scrape DOM hiện tại.",
      "Fix: clickTabAndWait thêm tham số verifyTabParam. Với tab Lời mời truyền 'tab=invites' → sau click POLL location.search tới khi khớp (tab thực sự đổi); chưa khớp thì RETRY click (tối đa 3 lần); hết retry vẫn sai → return false → execute-sync BỎ QUA, KHÔNG scrape nhầm tab Người dùng.",
      "Tab Người dùng / Yêu cầu giữ hành vi cũ (không truyền verifyTabParam) để không đổi behavior ngoài phạm vi bug.",
      "File đổi: click-tab-and-wait.ts, execute-sync.ts.",
    ],
  },
  {
    version: "0.6.16",
    date: "2026-06-14",
    kind: "fix",
    summary:
      "Verify invite: email KHÔNG có trong tab 'Lời mời' bị GỠ khỏi dashboard (hết phantom 'đang chờ') + bắt buộc bật toggle ngoài-domain mới mời",
    details: [
      "BUG 1 (phantom 'đã add'): sau invite, verify scrape tab 'Lời mời đang chờ xử lý'. Trước đây email KHÔNG xuất hiện trong pending vẫn giữ Member status=pending (backend tạo lúc bấm mời) → dashboard hiển thị 'đang chờ' dù ChatGPT chưa nhận. FIX: runner gọi endpoint mới POST /members/reconcile-after-invite với danh sách unverified → backend mark các Member pending đó = 'removed' (chỉ pending, KHÔNG đụng active). Nếu scrape pending FAIL thì giữ nguyên (tránh xoá oan).",
      "execute-verify-pending.ts không còn early-return ok:false khi 0 verified — luôn trả verified/unverified cho runner. Runner quyết định: 0 verified + scrape OK → task FAILED (VERIFY_FAILED) SAU khi đã dọn phantom; có verified → COMPLETED.",
      "BUG 2 (toggle ngoài-domain): khi có email ngoài domain xác minh, BẮT BUỘC bật toggle 'Cho phép lời mời ngoài tên miền' và XÁC NHẬN state=ON trước khi mời. setExternalInvites() trả thêm `confirmed`. Nếu không xác nhận được ON (không thấy toggle / click không ăn) → execute-invite return FAIL EXTERNAL_TOGGLE_FAILED, KHÔNG submit (tránh ChatGPT từ chối silently → phantom). Sau invite vẫn force OFF như cũ.",
      "EXTERNAL_TOGGLE_FAILED cũng kích hoạt reconcile dọn phantom (vì chưa hề submit invite).",
      "File đổi: api/routers/members.py (+reconcile-after-invite), api/schemas.py (InviteVerifyReconcileIn), ext set-toggle.ts (confirmed), execute-invite.ts (fail-on-toggle + force OFF), execute-verify-pending.ts (luôn ok:true), runner.ts (reconcile + status), shared/api.ts (reconcileAfterInvite).",
    ],
  },
  {
    version: "0.6.15",
    date: "2026-06-09",
    kind: "fix",
    summary: "Pagination sync: lật hết mọi trang (3/5, 10/10…), không cố định 2 trang",
    details: [
      "Loop while hasMorePages() — mỗi vòng đọc lại indicator N/M từ DOM (total có thể > 2).",
      "goToFirstPage() guard tăng tới 200 — kể cả user đang ở trang cuối.",
      "visitedPages Set chống loop; waitForPageAdvance(from) thay vì hard-code page+1.",
    ],
  },
  {
    version: "0.6.14",
    date: "2026-06-09",
    kind: "fix",
    summary: "SYNC_DATA lật từng trang khi ChatGPT admin members có phân trang (vd 1/2)",
    details: [
      "Symptom: danh sách Người dùng ChatGPT > ~1 trang (pagination '1 / 2') nhưng extension chỉ scrape trang hiện tại → dashboard thiếu member.",
      "Fix: pagination.ts detect indicator N/M + nút prev/next, goToFirstPage() rồi scrape + clickNextPage() lần lượt tới hết.",
      "Fallback: nếu không có pagination → giữ scroll-until-loaded như cũ (virtualized list 1 trang dài).",
    ],
  },
  {
    version: "0.6.13",
    date: "2026-05-21",
    kind: "chore",
    summary: "Mỗi action có README.md riêng kèm code — AI mở folder action là đọc được logic + history; user sửa dễ",
    details: [
      "Move 9 file Logic_<action>.md từ docs/Extension_Refactor/ (gitignored) vào apps/extension/src/content/actions/<action>/README.md (tracked trong source tree).",
      "Mục đích: (1) AI khi navigate vào folder action thấy README ngay → context đầy đủ về logic/flow/history mà không phải tìm doc folder riêng; (2) user sửa doc cạnh code, không phải nhảy file xa.",
      "Thêm apps/extension/src/content/actions/README.md làm index 9 actions + quy tắc code structure pattern cho người mới.",
      "Path trong README đã fix relative để link đúng từ vị trí mới: refs tới ../human.ts, ../../../shared/, ../<other-action>/README.md, ../../../../../web/src/... và ../../../../../api/app/...",
      "QUY TẮC MỚI: mỗi action PHẢI có README.md kế bên code, mỗi bug fix PHẢI append entry vào section 'Lịch sử sửa lỗi' của README tương ứng — không chỉ JSDoc trong code.",
      "KHÔNG đổi behavior code — chỉ thêm 10 file .md.",
    ],
  },
  {
    version: "0.6.12",
    date: "2026-05-20",
    kind: "chore",
    summary: "Refactor (Pha 0): chuẩn bị tách action mỗi hàm 1 file riêng — chưa đổi behavior",
    details: [
      "Tạo branch refactor/extension-actions-split để chia nhỏ các file actions/*.ts đang quá fat (invite 802 dòng, purchase-seat 894 dòng, harvest-labels 738 dòng, sync 648 dòng).",
      "Kế hoạch chi tiết tại docs/Extension_Refactor/Plan_Split_Actions_Per_File.md (gitignored, local-only).",
      "Mục tiêu: mỗi action thành 1 folder, mỗi hàm public 1 file riêng, helper theo concern (finders/, pages/, modal1/, modal2/, row-extractors/). Tổng ~58 file mới thay cho 10 file fat.",
      "QUY TẮC PHA REFACTOR: PURE FILE-SPLIT, KHÔNG đổi logic/behavior. JSDoc copy nguyên si để giữ context lịch sử (v0.6.4 vì sao bỏ scrapedStatuses, v0.6.6 vì sao force OFF, ...).",
      "Public API contract giữ nguyên qua barrel index.ts mỗi folder — content/index.ts dispatcher chỉ đổi 1 import (./actions/revoke-invites-batch → ./actions/revoke).",
      "9 pha tiếp theo (1 commit/pha): change-role+revoke → external-invites → remove+sync-billing → sync → invite → purchase-seat → harvest-labels → smoke test.",
      "Pha 0 này CHƯA tách file nào — chỉ bump version + ghi entry CHANGELOG để các pha sau có baseline rõ ràng.",
    ],
  },
  {
    version: "0.6.11",
    date: "2026-05-20",
    kind: "fix",
    summary: "REMOVE_MEMBER: search qua ô 'Lọc theo tên' trước khi mở menu '...' → 'Loại bỏ thành viên' — fix miss row khi list dài",
    details: [
      "USER REQUEST 2026-05-20 (kèm ảnh ChatGPT /admin/members tab Người dùng): 'khi thực hiện xóa bất kì user nào thì tìm kiếm người dùng xong rồi thực hiện xóa loại bỏ thành viên'. Ảnh tham chiếu thứ 2 cho thấy menu '...' mở ra hiển thị 'Thay đổi loại giấy phép' + 'Loại bỏ thành viên' (đỏ).",
      "ROOT CAUSE: executeRemove cũ chỉ gọi findMemberRow(email) trên DOM hiện tại. Khi workspace > 50 member, row cần xoá có thể chưa scroll vào viewport (ChatGPT virtualize list) → trả null → UI_ELEMENT_NOT_FOUND. User phải tự cuộn tới row trước khi extension chạy được.",
      "FIX (remove.ts executeRemove): thêm 2 bước trước flow cũ:",
      "  1. clickTabAndWait('tab_active_members') — đảm bảo đang ở tab Người dùng (REMOVE chỉ làm được trên active list, không phải tab Lời mời/Yêu cầu). Best-effort, không fail nếu tab button không có.",
      "  2. filterAndFindRow(email) — type local-part email (phần trước '@') vào input 'Lọc theo tên' → đợi ChatGPT debounce filter (~600ms) → waitFor row khớp tới 4s. Filter zoom thẳng vào 1 row duy nhất, KHÔNG cần scroll.",
      "Sau khi xoá xong verify (member biến mất khỏi list đã filter), CLEAR filter input để list về full state (user mở tab admin lên thấy toàn bộ member, không bị stuck ở state filter '@yaakovajax0054' chẳng hạn).",
      "Selector mới `SELECTORS.memberFilterInput`: input[type='search'] + placeholder/aria-label 'Lọc'/'Filter'/'筛选'/'过滤' (vi/en/zh). Fallback theo placeholder attribute vì ChatGPT chưa có data-testid trên input này.",
      "Tại sao type local-part chứ không full email: ChatGPT filter match trên cả tên + email; dùng prefix 'yaakovajax0054' đủ unique mà tránh case input có maxlength giới hạn ký tự đặc biệt ('@' / '.').",
      "Fallback (nếu không tìm được filter input — vd UI mới đổi): rơi về scroll-find cũ (findMemberRow trực tiếp). KHÔNG hard-fail vì có thể workspace nhỏ < 10 member thì filter không xuất hiện.",
      "File đã đổi: selectors.ts (thêm memberFilterInput), remove.ts (filterAndFindRow + clearMemberFilter + tab navigate).",
    ],
  },
  {
    version: "0.6.10",
    date: "2026-05-20",
    kind: "chore",
    summary: "Bỏ nút ↻ sync billing trong popup — dashboard 'Cập nhật giá & ngày renew' là single source of truth, popup tự refresh khi task xong",
    details: [
      "USER REQUEST 2026-05-20: 'bỏ cái mũi tên sync billing đi, từ giờ chạy ở dashboard lệnh cập nhật giá thì cũng update cả extension luôn'.",
      "Bối cảnh: popup có 2 chỗ trigger SYNC_BILLING — (a) nút ↻ bên cạnh 'Plan/Seat' trong popup (thêm ở v0.4.16), (b) nút 'Cập nhật giá & ngày renew' trong dashboard (WorkspaceLayout). Cả 2 đều tạo cùng QueueItem type=SYNC_BILLING → trùng UX.",
      "Decision: xoá nút popup, giữ nút dashboard. Popup ĐÃ có sẵn auto-refresh useEffect (v0.4.16, App.tsx:74-101) detect khi SYNC_BILLING terminal COMPLETED → re-fetch whoami → popup hiển thị seat mới. Logic này hoạt động bất kể task được trigger từ đâu (popup hay dashboard) — chỉ cần xoá nút popup, không cần đổi logic auto-refresh.",
      "FILES đã xoá:",
      "  • popup/App.tsx: nút ↻ + state `syncingBilling` + handler `onSyncBilling` + import `triggerSyncBilling`",
      "  • shared/api.ts: hàm `triggerSyncBilling` (chỉ popup dùng)",
      "  • i18n vi.json + zh-CN.json: key `popup.syncBillingTooltip` (chỉ popup dùng)",
      "  • Backend queue.py: endpoint POST /api/v1/queue/sync-billing (chỉ extension dùng)",
      "Flow MỚI: user click 'Cập nhật giá & ngày renew' trên dashboard → POST /workspaces/{id}/sync-billing → task PENDING → SSE → extension scrape → task COMPLETED → DB update + popup polling fetchActiveTask 1.5s → thấy recent_completed.type=SYNC_BILLING → re-fetch whoami → popup hiển thị seat mới (≤ 2-3s sau khi task xong).",
      "Không có functional regression: nếu popup ĐÓNG khi task chạy, lần mở sau verify(config) trên mount sẽ fetch whoami → seat mới tự xuất hiện.",
    ],
  },
  {
    version: "0.6.7",
    date: "2026-05-20",
    kind: "fix",
    summary: "CONTENT_NOT_INJECTED: propagate diag step-by-step vào error_message — dashboard hiển thị thẳng step nào fail",
    details: [
      "USER REPORT: liên tục 5+ task fail với CONTENT_NOT_INJECTED (INVITE/SYNC_DATA/REVOKE_INVITES). Error message generic: 'Tab chatgpt.com/admin không thể inject content script sau 3 bước fallback' — KHÔNG nói step nào fail, vì sao fail. User mù → phải mở chrome://extensions/ → Service Worker → DevTools mới biết.",
      "ROOT CAUSE visibility: ensureContentInjected chỉ console.warn từng step nội bộ, không truyền lý do ra ngoài. 3 step thử inject (executeScript / tabs.reload / tabs.remove+create) đều có thể fail vì nhiều lý do khác nhau (tab redirect khỏi /admin, executeScript permission, ping timeout, ChatGPT logout giữa chừng, ...) — message generic không phân biệt được.",
      "FIX (runner.ts ensureContentInjected): thêm array `diag: string[]` collect 1 dòng mỗi event (ping attempt, executeScript resolve/throw, tabs.reload result, tab URL sau mỗi bước). Mỗi dòng có prefix `+{elapsed}ms` để thấy timing. Return type đổi `{ok, tabId}` → `{ok, tabId, diag}`. KHÔNG đổi logic 3 step.",
      "FIX (sendToContent): khi !ready.ok → append `\\n\\nChi tiết từng bước:\\n{diag.join('\\n')}` vào error_message. Dashboard hiển thị toàn bộ trace — biết ngay step nào fail.",
      "Diag bao gồm: tab state snapshot ban đầu (url + status), kết quả mỗi executeScript (resolved / THREW + message), URL sau mỗi tabs.reload + tabs.create, ping retry count cụ thể, abort reasons.",
      "Ví dụ output mới (FAILED task): 'Cách khắc phục: (1) F5 tab, (2) reload extension, (3) cùng browser+login. Chi tiết: +0ms tab 123 state: status=complete url=https://chatgpt.com/auth/login | +15ms initial ping fail | +20ms ⚠ tab URL không chứa /admin — có thể đã logout/redirect | ...'",
      "Hành động đề xuất user (sau khi update): chạy 1 task SYNC_DATA test, nếu vẫn fail thì copy diag vào issue — sẽ biết chính xác problem để fix dứt điểm (vs guess như 5 lần trước).",
      "Khả năng cao root cause hiện tại: ChatGPT tab đã logout giữa chừng (session expired) → tab.url=/auth/login → 3 step đều redirect → all fail. Diag mới sẽ confirm trong 1 task test.",
    ],
  },
  {
    version: "0.6.6",
    date: "2026-05-20",
    kind: "fix",
    summary: "FORCE tắt toggle external invites sau invite (không restore prev) + Phase 1 đợi DOM list pending stable trước F5 + Phase 2 retry tăng cường",
    details: [
      "USER REPORT v0.6.5: (a) sau invite, toggle 'Cho phép lời mời ngoài tên miền' không tự tắt. (b) Email trong tab 'Lời mời đang chờ xử lý' load thiếu trên dashboard so với ChatGPT thật.",
      "ROOT CAUSE (a): withExternalInvitesEnabled finally chỉ restore khi setResult.changed=true (= extension đã click bật ON). Nếu user manually bật ON từ trước → prev=ON, changed=false → finally SKIP restore → toggle giữ ON. Vi phạm spec user 'sau mời xong phải tắt mời ngoài'.",
      "FIX 1 (external-invites.ts): LUÔN force OFF sau invite (kể cả prev đã ON). Spec mới: 'Cho phép lời mời ngoài' là rủi ro bảo mật — sau mỗi invite extension phải tắt OFF, user có thể bật lại thủ công nếu cần. Bỏ điều kiện 'if changed' trong finally.",
      "ROOT CAUSE (b): Phase 1 click tab 'Lời mời đang chờ xử lý' (v0.6.5) với postClickWait 1500ms, sau đó return ngay → background F5. ChatGPT React Query fetch pending list mất 2-5s; nếu F5 ngắt giữa fetch → sau F5 có thể serve cache cũ → Phase 2 scrape miss email vừa mời.",
      "FIX 2 (invite.ts executeInvite): Sau clickTabAndWait (tăng 1500→3000ms), thêm waitForPendingListStable(emails, 8s) — poll DOM email-text-node count tới khi: (i) tất cả email vừa mời xuất hiện, HOẶC (ii) count stable 2 tick liên tiếp. Đảm bảo F5 chạy ở state DOM ổn định.",
      "FIX 3 (invite.ts executeVerifyPendingInvite): Tăng initial sleep sau F5 từ 800ms → 2500ms (Phase 2 chờ DOM render xong). Retry chain [0, 2500] (v0.6.5) → [0, 3000, 6000] (v0.6.6) — 3 attempt với gap dài hơn, xử lý case ChatGPT backend index pending list chậm.",
      "Tradeoff: invite ~3-7s chậm hơn v0.6.5 nhưng độ chính xác cao hơn nhiều. User 'load thiếu' > user 'chậm'.",
      "File đã đổi: external-invites.ts (force OFF), invite.ts (waitForPendingListStable + sleep + retry).",
    ],
  },
  {
    version: "0.6.5",
    date: "2026-05-20",
    kind: "fix",
    summary: "Fix thứ tự bước trong invite flow: TẮT toggle external invites TRƯỚC khi chuyển tab 'Lời mời'",
    details: [
      "v0.6.4 thêm clickTabAndWait('tab_pending_invites') vào CUỐI executeInviteInner — SAI THỨ TỰ. Trình tự thực tế khi đó: bật toggle → invite → click tab Lời mời (URL có ?tab=invites) → finally của withExternalInvitesEnabled navigate /admin/identity tắt toggle → navigate /admin/members (URL MẤT ?tab=invites) → F5 ở URL không có tab param → ChatGPT load tab 'Người dùng' default thay vì 'Lời mời' → Phase 2 phải tự click lại tab. Vô hiệu hoá tối ưu v0.6.4.",
      "User correct (2026-05-20): 'bật mời ngoài → mời thành viên → tắt mời ngoài → chuyển tab lời chờ xử lý → F5 → verify → ghi DB'. Trình tự đúng: restore toggle PHẢI chạy TRƯỚC khi chuyển tab Lời mời.",
      "Fix: Move clickTabAndWait('tab_pending_invites') từ cuối executeInviteInner ra scope ngoài của executeInvite, đặt SAU withExternalInvitesEnabled return (= sau khi finally đã restore toggle + navigate /admin/members). URL khi runner F5 sẽ chính xác /admin/members?tab=invites → ChatGPT load thẳng pending list.",
      "executeInviteInner giờ CHỈ làm submit invite + return awaiting_reload_verify=true (single responsibility). Tab management là concern của executeInvite (scope ngoài).",
      "Sequence chính xác (v0.6.5):",
      "  1. withExternalInvitesEnabled: nav /admin/identity → check state → nếu OFF thì bật ON (lưu prev) → nav /admin/members",
      "  2. executeInviteInner: open dialog → type email → set role → submit → wait toast/dialog close → return",
      "  3. withExternalInvitesEnabled finally: nếu prev=false thì nav /admin/identity tắt OFF → nav /admin/members",
      "  4. (NEW v0.6.5) clickTabAndWait('tab_pending_invites') → URL = /admin/members?tab=invites",
      "  5. Runner F5 → ChatGPT load pending list từ server vào view",
      "  6. Phase 2 executeVerifyPendingInvite scrape → verified emails",
      "  7. Runner bulk-upsert (isFullSync=false) → DB → dashboard hiển thị",
      "File đã đổi: invite.ts (executeInvite + executeInviteInner refactor).",
    ],
  },
  {
    version: "0.6.4",
    date: "2026-05-20",
    kind: "fix",
    summary: "Verify pending nhanh hơn (chuyển tab 'Lời mời' TRƯỚC F5) + fix bug a12 bị mark removed oan do bulk-upsert reconcile",
    details: [
      "BUG (a12 'biến mất'): User invite a12 (08:34) → ChatGPT nhận thật. Sau invite g12 (08:37) extension verify scrape tab 'Lời mời' tại 08:38 chỉ thấy g12 (a12 chưa được ChatGPT index về client) → bulk-upsert với scraped_statuses=['pending'] → backend reconcile mark a12=removed oan. Phantom cleanup INVITE_MEMBER vẫn đúng (verify_scrape_failed=true → giữ); lỗi nằm ở bulk-upsert dùng chung endpoint cho cả full sync + verify after invite.",
      "FIX 1 — Extension (runner.ts INVITE_MEMBER reportToBackend): thêm option isFullSync=false vào bulkUpsertMembers, bỏ scrapedStatuses. Backend nhận is_full_sync=false → CHỈ upsert email trong payload, KHÔNG reconcile. Verify chỉ là 'confirm những email này đang pending', không nói gì về email khác.",
      "FIX 2 — Backend (members.py bulk_upsert_members) defense-in-depth: reconcile WHERE NOT (invited_by_user_id IS NOT NULL AND created_at > NOW() - INTERVAL '10 minutes'). Nếu extension lỡ gửi is_full_sync=true sau khi vừa invite, member mới vẫn an toàn.",
      "UX SPEEDUP — Approach của user 2026-05-20: 'sau khi mời xong chuyển sang tab Lời mời đang xử lý, chờ load rồi reload trang là thấy toàn bộ'. Phase 1 (invite.ts executeInviteInner) cuối: thêm clickTabAndWait('tab_pending_invites', ..., 1500) NGAY trước khi return awaiting_reload_verify=true → URL = /admin/members?tab=invites khi runner F5 → ChatGPT load thẳng pending list từ server vào view (không cần navigate phụ).",
      "Phase 2 (executeVerifyPendingInvite) simplify: initial sleep 1500ms → 800ms (DOM đã ở đúng tab), retry chain [0, 3000, 5000] → [0, 2500] (data tươi hơn sau F5 đúng URL). Tiết kiệm ~3-5s mỗi invite.",
      "Lợi ích kép: nhanh hơn + né được race của bug a12 (scrape data từ server response của F5 thay vì DOM stale của tab cũ).",
      "File đã đổi: invite.ts (Phase 1+2), sync.ts (export clickTabAndWait), api.ts (bulkUpsertMembers thêm isFullSync), runner.ts (INVITE_MEMBER no-reconcile), members.py (reconcile skip recent invite).",
    ],
  },
  {
    version: "0.6.3",
    date: "2026-05-20",
    kind: "fix",
    summary: "Re-thêm Step 3 NUCLEAR (recreate tab) + Step 2 inject thêm lần 2 — fix CONTENT_NOT_INJECTED hiếm gặp",
    details: [
      "User report: invite tamnm@ibcgroup.vn FAILED với CONTENT_NOT_INJECTED dù tab ChatGPT đang ở /admin và đã login. v0.4.20 bỏ Step 3 NUCLEAR vì gây regression INVITE (tab recreate phá dialog state). Sau v0.6.2 invite đã tách thành Phase 1 (submit) + Phase 2 (F5 + verify), regression cũ không còn áp dụng → an toàn re-thêm Step 3.",
      "Step 3 NUCLEAR mới: chrome.tabs.remove tab cũ → chrome.tabs.create tab mới hoàn toàn (URL = /admin/members) → waitForTabComplete 20s → chrome.scripting.executeScript explicit phòng auto-inject lỗi → 5 retry ping (800/1200/1500/2000/2000ms). sendToContent đã có sẵn logic dùng tabId mới nếu Step 3 đổi tab.",
      "Step 2 strengthen: sau khi chrome.tabs.reload + tab load complete, GỌI THÊM chrome.scripting.executeScript một lần nữa (belt-and-suspenders). Manifest auto-inject ở document_idle thường ok nhưng đôi khi CRXJS loader fail do CSP/timing — executeScript explicit là backup. Cộng thêm 2 retry delay (2000ms x2) nâng tổng wait sau reload từ ~5.8s → ~9.8s.",
      "Sửa error message CONTENT_NOT_INJECTED: text cũ nói 'sau 3 bước fallback' nhưng v0.4.20 chỉ còn 2 bước → vô lý. Giờ code có thật 3 bước, text đúng sự thật.",
    ],
  },
  {
    version: "0.6.2",
    date: "2026-05-20",
    kind: "fix",
    summary: "F5 thật trang admin sau khi submit invite — ép ChatGPT load lại pending list từ server (không dùng cache stale)",
    details: [
      "Tách INVITE_MEMBER thành 2 phase: Phase 1 (content) chỉ submit invite + verify toast/dialog đóng → return ok=true với awaiting_reload_verify=true. Phase 2 do background orchestrate: chrome.tabs.reload(tab) hard F5 → wait tab complete → ensureContentInjected re-inject → gửi VERIFY_PENDING_INVITE message mới → content's new instance scrape pending list (đã load fresh từ server) → return verify result.",
      "Trước v0.6.2: dù click 'forceReload' bounce tab nhưng ChatGPT React Query có thể serve cache stale (cache key dựa workspace, không invalidate khi click tab). Sau v0.6.2: chrome.tabs.reload là F5 thật ở level browser → toàn bộ JS context destroy + reload → React Query cache cũng bị xoá → fetch fresh từ /api/.../invites.",
      "Message protocol mới: VERIFY_PENDING_INVITE { taskId, emails, role } — dùng riêng cho Phase 2, không submit lại invite. Content dispatcher [content/index.ts](apps/extension/src/content/index.ts) route → executeVerifyPendingInvite trong invite.ts.",
      "Runner [background/runner.ts](apps/extension/src/background/runner.ts) detect response.data.awaiting_reload_verify=true → vào branch F5+verify. Nếu F5 fail / inject fail / verify message throw → fallback ok=true với verify_scrape_failed=true (user-facing: 'mở tab Lời mời thủ công để check'), KHÔNG fail invite (vì submit đã OK).",
      "Phase 'f5-verify' mới trong reportRunnerProgress → dashboard banner show 'Submit invite OK — F5 trang admin để ChatGPT load lại pending list...' giữa submit và verify.",
      "Retry trong Phase 2 vẫn giữ (3 attempts với delay 0/3/5s) — phòng ChatGPT backend chậm index invite vừa POST. Tổng thời gian Phase 2 tối đa ~25s (F5 ~3-5s + 3 attempts ~10-15s + final navigate ~2s).",
    ],
  },
  {
    version: "0.6.1",
    date: "2026-05-20",
    kind: "fix",
    summary: "Fix humanClick double-fire (2 toast ChatGPT/click toggle 2 lần) + verify pending: delay 2s + retry 3 lần đến ~10s tổng",
    details: [
      "BUG #1 (DOUBLE-CLICK): [humanClick](apps/extension/src/content/human.ts) trước v0.6.1 dispatch synthetic MouseEvent('click') RỒI gọi LUÔN el.click() native → mỗi 'click' thực ra fire 2 lần. Hậu quả: (a) toggle 'Cho phép lời mời từ miền bên ngoài' click 1 lần → ChatGPT nhận 2 toggle event → 2 toast 'Đã cập nhật'; (b) submit invite click 1 lần → ChatGPT submit 2 lần → 2 toast 'Đã gửi lời mời'. Sau v0.6.1: chỉ gọi el.click() native (Radix/React onClick đều catch được); dispatch synthetic chỉ làm FALLBACK khi el.click không tồn tại hoặc throw.",
      "BUG #2 (VERIFY QUÁ NHANH → false-negative VERIFY_FAILED): sau khi submit invite + toast OK, code v0.6.0 click ngay tab 'Lời mời đang chờ xử lý' + chờ 1.5s rồi scrape. ChatGPT backend cần 1-5s để invite mới xuất hiện trong pending list → scrape thấy 0 email vừa mời → strict v0.4.14 trả VERIFY_FAILED → phantom cleanup xoá record dashboard, NHƯNG thực tế ChatGPT đã nhận invite OK.",
      "FIX BUG #2: sau khi xác nhận toast/dialog đóng, đợi thêm 2s rồi mới gọi scrapePendingInvitesAfterInvite. Nếu attempt đầu KHÔNG verify được hết list email vừa mời → retry tới 3 lần (sleep 0s, 2.5s, 4s giữa các attempt), TỔNG ~10s. Mỗi retry > attempt #1 dùng forceReload=true: bounce qua tab 'Người dùng' rồi click lại 'Lời mời' → ép ChatGPT re-mount component + re-fetch pending list (fix luôn cache stale).",
      "scrapePendingInvitesAfterInvite mới có param forceReload: false → click tab 'Lời mời' trực tiếp (như cũ); true → click 'Người dùng' 800ms trước, rồi click 'Lời mời' với postClickWait 2.5s. Dùng riêng cho retry attempts để cache không che mắt.",
      "Progress message mới khi retry: 'Pending list chưa có N email — đợi ChatGPT cập nhật (retry K/3)...' → dashboard banner show ngay user biết extension đang đợi (không phải treo).",
      "BUG #3 (F5 thấy email trong tab Lời mời ChatGPT): trước v0.6.1 sau verify xong extension click lại tab 'Người dùng' để idle ở trang quen thuộc. Hậu quả: user mở tab admin lên + click 'Lời mời' → ChatGPT re-mount component + có thể serve từ React Query cache stale → KHÔNG thấy email vừa mời, phải F5. Fix: extension giờ DỪNG TẠI tab 'Lời mời đang chờ xử lý' sau verify cuối cùng — DOM đã render data tươi (extension vừa scrape) nên user mở browser tab admin lên là thấy ngay. Task sau (REMOVE/CHANGE_ROLE) tự click tab 'Người dùng' qua findControlByKey, không lệ thuộc end-state.",
    ],
  },
  {
    version: "0.6.0",
    date: "2026-05-20",
    kind: "feature",
    summary: "PURCHASE_SEAT full payment chain — mở rộng cross-origin tới Stripe + Link checkout, charge thật qua thẻ Mastercard",
    details: [
      "Phase 1+2 (chatgpt.com modal): giữ nguyên v0.5.1 — Quản lý giấy phép → +qty → Tiếp tục → Thêm người dùng (tạo invoice 'Đến hạn').",
      "Phase 2.5 (NEW): sau khi modal #2 đóng + có chargeAmount, content script navigate /admin/billing?tab=invoices, tìm row 'Đến hạn' (regex vi/en/zh), extract Stripe URL từ anchor 'Xem', gửi background.",
      "Phase 3 (NEW): background orchestrator [payment-chain.ts](apps/extension/src/background/payment-chain.ts) mở Stripe invoice URL ở tab mới, đợi load + content/stripe-invoice.ts ready, gửi STRIPE_CLICK_LINK → click button 'Link' (xanh có last4 thẻ).",
      "Phase 4 (NEW): background đợi popup checkout.link.com mở (window mới do Stripe spawn), inject content/link-checkout.ts, gửi LINK_CONFIRM_PAYMENT với expectedAmountText → content verify số tiền popup match (tolerance ±50đ) → click 'Thanh toán {amount}' (FINAL CHARGE thẻ).",
      "Manifest: thêm 2 content_scripts cho invoice.stripe.com + checkout.link.com, 2 host_permissions tương ứng.",
      "Safety guards: (1) Sanity check số tiền popup vs expected từ ChatGPT modal — mismatch > 50đ → STOP với VERIFY_FAILED; (2) Detect text 'OTP/3DS/xác minh' trong Link popup TRƯỚC click → trả otp_detected=true, KHÔNG click submit; (3) Sau click 'Thanh toán', monitor 15s: dismissed (success) / otp_after (Link mở 3DS step) / timeout (admin verify).",
      "Task.result mở rộng: stripe_invoice_url, payment_chain_started/stage/ok, payment_chain_stripe (Link button info + amount visible), payment_chain_link (popup amount + clicked + outcome). Audit log đầy đủ chain.",
      "Cross-origin orchestration: background SW dùng chrome.tabs.onCreated/onUpdated để theo dõi Stripe tab → Link popup. Mỗi stage có timeout riêng (Stripe 15s tab open + 12s content ready; Link 12s popup open + 12s content ready).",
    ],
  },
  {
    version: "0.5.1",
    date: "2026-05-20",
    kind: "feature",
    summary: "PURCHASE_SEAT step 2: extension click luôn 'Thêm người dùng' (final charge) sau 'Tiếp tục' — kèm sanity check qty + scrape charge amount",
    details: [
      "Update flow PURCHASE_SEAT: sau khi click 'Tiếp tục' ở modal #1 ('Xem xét'), extension đợi modal #2 ('Quản lý chỗ ngồi') xuất hiện rồi click 'Thêm người dùng' để CHARGE TIỀN THẬT qua Stripe payment method đã lưu trên ChatGPT.",
      "Trước v0.5.1 extension DỪNG sau 'Tiếp tục' (admin tự confirm). Sau v0.5.1 tự động click luôn — flow trọn vẹn nhưng RỦI RO TIỀN nếu task tạo nhầm. Mitigation đã có: hard cap qty=20/task, dedup PENDING/IN_PROGRESS, audit log, sanity check.",
      "SANITY CHECK #1 (qty match): modal #2 phải nói đúng '{qty} suất bổ sung' / '{qty} additional seat'. Nếu modal nói số khác (seat đã đổi giữa chừng do task khác chạy) → STOP với VERIFY_FAILED, KHÔNG click charge.",
      "SCRAPE charge amount: extension đọc 'Tổng đến hạn hôm nay' (vd đ2080.24) vào task.result.charge_amount_text để admin trace + audit. Best-effort, không bắt buộc.",
      "After click 'Thêm người dùng': đợi modal đóng (data-state=closed / removed) tới 10s. Nếu modal vẫn mở → có thể ChatGPT mở 3D Secure / OTP popup, task vẫn COMPLETED ok=true nhưng note ghi 'admin hoàn tất xác minh thủ công'.",
      "Task result mở rộng: thêm `confirm_charge_clicked: bool`, `charge_modal_dismissed: bool`, `charge_amount_text: string|null` ngoài 4 field cũ.",
      "i18n: thêm control_key `billingAddUserButton` (Thêm người dùng / Add user / 添加用户) — VI/EN/ZH (12 variants total).",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-05-20",
    kind: "feature",
    summary: "PURCHASE_SEAT — extension tự mua thêm seat (+N) trên /admin/billing, dừng trước nút payment cuối",
    details: [
      "Action PURCHASE_SEAT mới: dashboard POST /api/v1/workspaces/{id}/purchase-seat {quantity:1..20} → backend tạo QueueItem type=PURCHASE_SEAT → SSE → extension execute.",
      "Flow extension (apps/extension/src/content/actions/purchase-seat.ts): (1) navigate /admin/billing?tab=plan; (2) click 'Quản lý giấy phép' để mở modal 'Xem xét'; (3) đọc input 'Người dùng' giá trị hiện tại N; (4) click nút '+' đúng quantity lần với verify sau mỗi click; (5) click 'Tiếp tục'. DỪNG. Admin tự xác nhận thanh toán cuối trên ChatGPT — extension KHÔNG bao giờ tự confirm payment (an toàn về tiền bạc).",
      "Permission BILLING_PAY (super-admin only) gate endpoint backend. Dedup: nếu workspace đã có PURCHASE_SEAT PENDING/IN_PROGRESS → trả task cũ thay vì double-charge.",
      "Hard cap 20 seat/task để chống fat-finger overcharge (mirror schemas.PURCHASE_SEAT_MAX_PER_TASK). Audit log PURCHASE_SEAT_QUEUED cho mọi lần trigger.",
      "i18n: thêm 3 control_key billingManageLicenses / billingContinueButton / billingIncrementButton (vi/en/zh) vào TEXT_FALLBACKS — harvester /admin/billing có thể quét.",
      "Backend: schemas.PurchaseSeatIn + endpoint POST /workspaces/{id}/purchase-seat + queue._TYPE_TO_PERMISSION['PURCHASE_SEAT']=BILLING_PAY.",
    ],
  },
  {
    version: "0.4.20",
    date: "2026-05-19",
    kind: "fix",
    summary: "Bỏ Step 3 NUCLEAR (regression INVITE) + tăng waitFor dialog 20s + DOM diagnostic + DB sync CHANGE_ROLE/REMOVE",
    details: [
      "REGRESSION FIX: bỏ Step 3 NUCLEAR (tabs.remove + tabs.create) trong ensureContentInjected — quá aggressive, đóng tab user khi không cần, gây dialog Invite không mở được sau khi tab vừa recreate. Step 1 (executeScript) + Step 2 (tabs.reload) đã cover 99% case.",
      "Invite waitFor dialog email input: 10s → 20s. Sau v0.4.17 auto-reload, SPA cần thời gian rehydrate + dialog animate open. 10s đôi khi không đủ.",
      "Invite DOM diagnostic: khi waitFor timeout → dump dialog innerHTML + list tất cả input/textarea trong dialog vào console (prefix '[autogpt-invite] DIAGNOSTIC'). Error message kèm input summary để dashboard banner show ngay (vd: 'Inputs: INPUT[type=text,name=email_0,ph=Enter email address]').",
      "Backend update_task: thêm DB sync sau CHANGE_ROLE COMPLETED → Member.chatgpt_role = new_role. Trước v0.4.20 extension đổi role trên ChatGPT thành công nhưng DB không update → dashboard hiển thị role cũ tới khi SYNC_DATA chạy.",
      "Backend update_task: thêm DB sync sau REMOVE_MEMBER COMPLETED → Member.status = 'removed'. Cùng lý do.",
    ],
  },
  {
    version: "0.4.19",
    date: "2026-05-19",
    kind: "fix",
    summary: "Billing scraper: cho phép case 'Đang dùng 14/13' (over-limit) — bỏ rule used<=total",
    details: [
      "BUG: trong parseSeatRatio có check `used <= total` → khi ChatGPT hiển thị 'Đang dùng 14/13 giấy phép' (admin invite vượt quota), pattern match được nhưng bị reject vì 14 > 13 → scraper bỏ qua → loop tới pattern khác → pick nhầm ratio từ vùng khác trên page (vd '11/12' từ invoice/plan info). Dashboard hiển thị 11/12 trong khi thực tế là 14/13.",
      "Fix: BỎ check `used <= total`. Over-limit là state hợp lệ trên ChatGPT (admin được phép invite vượt seat — sẽ tính tiền phụ vào hóa đơn kế tiếp). Chỉ giữ rule total<=999 và used<=999 (sanity check).",
      "Bonus: thêm keyword 'đang dùng' vào pattern đầu (priority cao hơn 'sử dụng' generic) + 'đang sử dụng' + zh 已使用. Match trực tiếp text ChatGPT vi 'Đang dùng 14/13'.",
    ],
  },
  {
    version: "0.4.18",
    date: "2026-05-19",
    kind: "fix",
    summary: "Step 3 NUCLEAR (recreate tab) + ẨN HOÀN TOÀN banner CONTENT_NOT_INJECTED khỏi popup",
    details: [
      "v0.4.17 thêm auto-reload (Step 2) nhưng vẫn fail cho 1 số case (CSP / dirty state / extension hot-swap). Bổ sung Step 3 NUCLEAR: chrome.tabs.remove tab cũ + chrome.tabs.create tab mới hoàn toàn → wait load → retry ping. Tab mới fresh state 100% — fix mọi case còn lại trừ ChatGPT chưa login.",
      "ensureContentInjected giờ trả về `{ok, tabId}` thay vì boolean — sendToContent dùng tabId MỚI (nếu Step 3 đổi) để gửi message, tránh gửi vào tab đã đóng.",
      "Popup ActiveTaskPanel: ẨN HOÀN TOÀN error CONTENT_NOT_INJECTED và NOT_LOGGED_IN_CHATGPT khỏi recent_completed banner. Đây là lỗi infrastructure được background tự recovery — user KHÔNG cần thấy/thao tác.",
      "Cũng bỏ luôn nút manual 'Mở/F5 tab ChatGPT Admin' — tất cả automatic.",
      "Total fallback time vẫn ~30s nhưng 99% case xong dưới 5s (Step 1). Step 2 ~10s. Step 3 ~15s. Sau Step 3 mà vẫn fail = ChatGPT chưa login (NOT_LOGGED_IN_CHATGPT) — case này extension không thể fix tự động.",
    ],
  },
  {
    version: "0.4.17",
    date: "2026-05-19",
    kind: "fix",
    summary: "AUTO-RELOAD tab ChatGPT khi gặp CONTENT_NOT_INJECTED — không cần user F5 thủ công",
    details: [
      "BUG cũ: reload extension trong chrome://extensions/ tạo manifest mới với file hash mới, nhưng tab ChatGPT đang load vẫn giữ content script CŨ → background SW gửi message → tab cũ không nhận → CONTENT_NOT_INJECTED → task FAILED → user thấy 'liên tục lỗi'.",
      "Sau v0.4.17 [ensureContentInjected] (apps/extension/src/background/runner.ts) có 2 step fallback hoàn toàn TỰ ĐỘNG: (1) chrome.scripting.executeScript inject loader rồi retry ping ~3s; (2) NẾU step 1 thất bại → chrome.tabs.reload (auto F5) → wait tab status='complete' (timeout 15s) → retry ping ~5s để content script đã được manifest auto-inject ở document_idle. Tổng cap ~25s nhưng 99% xong trong ~5s.",
      "User KHÔNG cần thao tác F5 thủ công nữa. Popup vẫn show fallback hint + nút 'Mở/F5 tab ChatGPT Admin' phòng case auto-reload cũng thất bại (vd: ChatGPT chưa login → redirect /auth/login).",
      "i18n 2 string mới: popup.contentNotInjectedHint + popup.openOrReloadAdminTab (vi + zh).",
    ],
  },
  {
    version: "0.4.16",
    date: "2026-05-19",
    kind: "feature",
    summary: "Role dropdown chỉ 2 lựa chọn (member + analytics_viewer); popup có nút ↻ refresh seat",
    details: [
      "Dashboard Members.tsx role dropdown CHỈ hiển thị 'Thành viên' + 'Xem dữ liệu' (analytics_viewer). Member đã là admin/owner KHÔNG cho đổi qua dashboard — hiển thị label với icon 🔒 và tooltip 'thao tác trên ChatGPT'.",
      "Schema mở rộng: ChatGPTRole + DASHBOARD_ALLOWED_ROLES. Backend [schemas.py](apps/api/app/schemas.py) thêm 'analytics_viewer' vào Literal. Extension [messages.ts](apps/extension/src/shared/messages.ts) + [i18n-ui.ts](apps/extension/src/content/i18n-ui.ts) thêm ROLE_LABELS + ROLE_KEYWORDS cho analytics_viewer (vi: 'Trình xem dữ liệu phân tích', en: 'Analytics viewer', zh: '分析查看器').",
      "Popup thêm nút ↻ bên cạnh 'Plan: business · Seat: N/M' → click gọi POST /api/v1/queue/sync-billing (extension auth) → backend dedup task → publish SSE → extension fastpoll pick → scrape /admin/billing → DB cập nhật. Popup tự re-fetch whoami sau 6s.",
      "Backend endpoint mới [queue.py /sync-billing](apps/api/app/routers/queue.py) — extension-facing, dùng X-API-KEY thay vì admin session, dedup nếu đã có PENDING/IN_PROGRESS.",
      "i18n 4 string: popup.syncBillingTooltip (vi/zh), member.roleAnalyticsViewer + member.roleEditOnChatGPT (vi/zh). member.roleOwner/Admin/Member đổi từ tiếng Anh sang i18n đúng.",
    ],
  },
  {
    version: "0.4.15",
    date: "2026-05-19",
    kind: "fix",
    summary: "Fix CHANGE_ROLE treo IN_PROGRESS (UI 2026 inline dropdown) + dashboard tự reload member list không cần F5",
    details: [
      "Fix CHANGE_ROLE (extension): UI ChatGPT 2026 đổi role qua dropdown INLINE trên row ('Thành viên ▼' trực tiếp trong cột Vai trò) — KHÔNG còn ẩn trong '...' menu như UI cũ. Code v0.4.14 vẫn dùng flow cũ → click '...' → tìm 'Change role' item → không có → treo IN_PROGRESS vĩnh viễn. Sau v0.4.15: tìm inline dropdown theo text role hiện tại + label match, click → menu mở → click target role option.",
      "Helper mới `findRowRoleDropdown(row, currentRole?)` trong member-row.ts — multi-strategy: (1) match text role label (Thành viên / Member / 成员); (2) fallback aria-haspopup=menu/listbox (loại trừ seat type 'ChatGPT'/'Codex').",
      "Dispatcher index.ts pass `old_role` từ task payload → helper lọc dropdown theo role hiện tại chính xác hơn.",
      "Fix dashboard auto-reload (apps/web/Members.tsx): trước v0.4.15 query `members` chỉ refetch lúc mount + window focus, dẫn tới sau khi extension xong task (CHANGE_ROLE/REMOVE/INVITE) list không update → user phải F5. Sau v0.4.15: useEffect watch `recentTasks` (đã poll 2s); khi phát hiện task `INVITE_MEMBER/REMOVE_MEMBER/CHANGE_ROLE/REVOKE_INVITES/SYNC_DATA` mới chuyển sang COMPLETED/FAILED → invalidateQueries(['members']) → list refresh tự động trong <2s.",
    ],
  },
  {
    version: "0.4.14",
    date: "2026-05-19",
    kind: "fix",
    summary: "Strict invite: 0 email verified trong pending tab → return FAILED (không phải COMPLETED)",
    details: [
      "Trước v0.4.14: extension click submit thành công + toast OK → verify pending tab. Nếu tab pending KHÔNG có email nào trong list invite → vẫn return ok=true với verified_count=0. Task COMPLETED nhưng tất cả records bị xoá. Banner hiển thị 'Đã verify 0/N' dễ gây nhầm lẫn.",
      "Sau v0.4.14: nếu scrape pending OK và verified_count=0 → return `{ok:false, error_code:'VERIFY_FAILED'}` với message giải thích 3 nguyên nhân khả dĩ (email đã active, domain không verify, ChatGPT từ chối silent). Task FAILED visibility. Phantom cleanup vẫn chạy trong backend update_task FAILED handler.",
      "Logic strict này KHÔNG áp dụng khi verify_scrape_failed=true — vẫn return ok=true vì click submit có thể đã thành công ở ChatGPT nhưng extension không scrape được tab Lời mời để verify.",
    ],
  },
  {
    version: "0.4.13",
    date: "2026-05-19",
    kind: "fix",
    summary: "Phantom email: dashboard chỉ hiện email ChatGPT thực sự nhận; content script inject retry tới 3s",
    details: [
      "Fix A — phantom email (backend): bulk_invite vẫn tạo Member+Invite up-front (optimistic UI) nhưng update_task PATCH có handler MỚI xoá phantom: (1) FAILED → xoá toàn bộ records của queue task; (2) COMPLETED với unverified_emails → xoá chỉ những email đó; (3) verify_scrape_failed=true → giữ lại (an toàn). Chỉ xoá Member status='pending' + joined_at IS NULL (không xoá nhầm record đã active).",
      "Fix B — content script inject retry: trước v0.4.13 chỉ wait 300ms rồi ping 1 lần. CRXJS loader pattern cần thời gian dynamic import (500ms-2s) → false-negative thường xuyên. Giờ retry 5 lần với delay [250,500,700,800,800] (~3s tổng), success ngay khi ping được. Error code đổi từ 'UNKNOWN' → 'CONTENT_NOT_INJECTED' rõ ràng hơn.",
      "Kết hợp: nếu Fix B vẫn fail (3s vẫn không inject), Fix A đảm bảo dashboard tự xoá phantom email — không bao giờ thấy email mà ChatGPT chưa nhận trong list.",
    ],
  },
  {
    version: "0.4.12",
    date: "2026-05-19",
    kind: "feature",
    summary: "Popup: panel 'Task đang chạy' + progress bar; auto SYNC_BILLING sau invite để seat đúng",
    details: [
      "Popup overhaul: BỎ nút 'Không có task chờ' + dòng tip 'Khi tạo task ở dashboard...' (gây confusion). Thay bằng `ActiveTaskPanel` — chỉ hiện khi có task đang chạy / chờ / vừa xong.",
      "Component `ActiveTaskPanel` 3 trạng thái: (1) IN_PROGRESS hiển thị badge 'ĐANG CHẠY' + task type + progress message + thanh % + elapsed_sec; (2) PENDING > 0 hiển thị '{n} task chờ pick' gray; (3) recent COMPLETED/FAILED trong 60s gần đây hiển thị ✓/✗ badge + status.",
      "Poll mỗi 1.5s khi popup mở (useEffect cleanup khi đóng) — UI cập nhật real-time. Khi popup ẩn → ngừng poll → không tốn API quota.",
      "Backend endpoint mới `GET /api/v1/queue/active` trả {in_progress, pending_count, recent_completed} — gọn cho 1 lần fetch popup.",
      "Auto chain `SYNC_BILLING` sau INVITE_MEMBER/REMOVE_MEMBER/REVOKE_INVITES COMPLETED → workspace.seat_used cập nhật đúng ngay sau invite, không phải đợi user bấm 'Cập nhật giá & ngày renew'. Dedup: chỉ enqueue nếu chưa có SYNC_BILLING PENDING/IN_PROGRESS.",
      "Fix bug user thấy: popup hiển thị 'Seat: 11/12' trong khi ChatGPT thực tế 14/13 — DB stale vì SYNC_BILLING chưa chạy sau loạt invite. Giờ tự chạy.",
    ],
  },
  {
    version: "0.4.11",
    date: "2026-05-19",
    kind: "fix",
    summary: "UI Labels: dashboard sửa DB → extension refresh bundle ngay (không phải chờ 15 phút)",
    details: [
      "BUG cũ: admin sửa 1 row UI label qua Settings → DB update OK nhưng extension vẫn dùng label cũ tới 15 phút sau (chrome.alarms tick mới refresh bundle). Tạo cảm giác 'sửa DB không hoạt động'.",
      "Fix 1 — push-based: dashboard sau khi save/clear-stale/harvest done → post message {source:'autogpt-dashboard', type:'refresh-labels'} qua dashboard-bridge → background SW gọi refreshLabelBundle() → fetch /ui-labels/bundle mới → chrome.storage.local cập nhật → content script reload cache. Thời gian: <500ms.",
      "Fix 2 — defensive pull: REFRESH_INTERVAL_MIN giảm 15 → 2 phút. Phòng trường hợp extension chạy ở browser KHÁC dashboard (vd MoreLogin chứa extension, Edge chứa dashboard) → bridge không tồn tại → message bị drop, alarm 2 phút fallback.",
      "Helper mới `requestExtensionRefreshLabels()` trong [useExtensionTrigger.ts](apps/web/src/hooks/useExtensionTrigger.ts) — best-effort, không throw, không await. Gọi trong UiLabelsManager onSuccess của 3 mutation (save bulk, clear stale, harvest complete).",
      "Bridge protocol thêm 1 cặp message: dashboard→bridge 'refresh-labels' và bridge→dashboard 'refresh-labels-result' (payload {ok,error}).",
    ],
  },
  {
    version: "0.4.10",
    date: "2026-05-19",
    kind: "feature",
    summary: "Verify invite ở tab Lời mời đang chờ xử lý TRƯỚC khi update dashboard",
    details: [
      "Quy trình mới sau invite verify success: scrape tab 'Lời mời đang chờ xử lý' → tính giao của (email vừa mời) ∩ (email scrape được) = verified_emails. Chỉ verified emails mới được bulk-upsert lên dashboard.",
      "Unverified emails (mời nhưng KHÔNG xuất hiện trong pending — vd ChatGPT từ chối thầm, email đã active sẵn, đã removed bị block) được report tách riêng vào task.result.unverified_emails → admin biết để check thủ công.",
      "Task result mới include: `verified_count`, `unverified_count`, `unverified_emails[]`, `verify_scrape_failed`. TaskCompletionBanner dashboard hiển thị message rõ hơn: 'Đã verify X/Y email' hoặc 'Chỉ verify được X, KHÔNG verified: ...'.",
      "Edge case: scrape pending FAIL toàn bộ (DOM lạ, locale mismatch, timeout 60s) → `verify_scrape_failed=true`, KHÔNG update dashboard records, banner hiển thị 'mở tab Lời mời thủ công để check'. Task vẫn COMPLETED vì ChatGPT đã nhận click invite.",
      "i18n: 3 string mới `sync.completedInviteVerified` / `Partial` / `VerifyFailed` cho vi + zh-CN.",
    ],
  },
  {
    version: "0.4.9",
    date: "2026-05-19",
    kind: "fix",
    summary: "Fix UI_ELEMENT_NOT_FOUND khi click 'Mời thành viên' sau toggle external invites",
    details: [
      "Bug: sau khi wrap external-invites BẬT toggle tại /admin/identity → navigate về /admin/members → gọi findInviteOpenButton() ngay, nhưng SPA render content sau navigation cần thêm vài trăm ms tới vài giây → button chưa tồn tại trong DOM → invite fail 'UI_ELEMENT_NOT_FOUND'.",
      "Fix 1 (invite.ts): findInviteOpenButton giờ chạy trong `waitFor()` poll loop tới 8s thay vì gọi 1 lần. Error message rõ hơn: list 3 điểm cần check.",
      "Fix 2 (external-invites.ts): wrap navigateTo predicate mạnh hơn — không chỉ chờ `location.pathname.includes('/admin/members')` mà còn chờ DOM có `<main>` + ≥2 button elements (= page content đã render xong). Timeout từ 5s → 10s.",
      "Symptom user thấy: extension xoay/hang ở trang /admin/members nhưng KHÔNG mở dialog Invite. Task FAILED với error_code=UI_ELEMENT_NOT_FOUND.",
    ],
  },
  {
    version: "0.4.8",
    date: "2026-05-19",
    kind: "feature",
    summary: "Invite flow trọn vẹn: bật toggle external invites → mời → MAP lời mời về dashboard → tắt toggle",
    details: [
      "Sau khi invite verify thành công, thêm bước MỚI: click tab 'Lời mời đang chờ xử lý' + scroll-and-scrape pending invites + return về background. Sau đó tab 'Người dùng' được click lại để extension idle ở trang quen thuộc.",
      "Background runner (runner.ts) detect INVITE_MEMBER COMPLETED có `data.pending_members` → chunked bulk-upsert với `scrapedStatuses=['pending']` → dashboard reconcile pending tab (NOT đụng tới `status='active'` của member khác).",
      "Mapping là BEST-EFFORT: nếu scrape pending fail (DOM lạ, locale mismatch, timeout 60s) → log warning + invite vẫn COMPLETED. KHÔNG bao giờ rollback invite chỉ vì mapping fail.",
      "External invites toggle wrap (external-invites.ts) không đổi: vẫn bật ON trước invite, restore (thường OFF) trong finally. Mapping chạy giữa 2 bước → toggle off chỉ sau khi mapping xong.",
      "Phase mới 'mapping' trong reportProgress → dashboard banner hiển thị 'Đang map lời mời mới về dashboard...' giữa invite success và task COMPLETED.",
      "Reusable export `scrapePendingInvitesAfterInvite(taskId)` trong sync.ts — caller bắt buộc đã ở /admin/members, hard cap 60s, không bao giờ throw.",
    ],
  },
  {
    version: "0.4.7",
    date: "2026-05-19",
    kind: "fix",
    summary: "Sync scraper lenient hơn (EMAIL_EXTRACT_RE fallback) + giảm 70% delay",
    details: [
      "Scraper sync.ts: thêm fallback EMAIL_EXTRACT_RE_G — extract email từ text node chứa email cùng tên/avatar (vd 'B b yaakovajax0054@outlook.com'). Trước v0.4.7 chỉ dùng EMAIL_FULL_RE (text node phải EXACT email) — miss khi ChatGPT 2026 concat avatar+name+email vào 1 text node.",
      "Diagnostic logging: scrape log tổng text nodes scanned + full-match count + extract-match count + final unique rows → debug dễ hơn khi sync trả 0 row.",
      "Delay -70% toàn bộ (human.ts DELAY_MULTIPLIER = 0.30): randomDelay default 1500-4000ms → 450-1200ms; microDelay 60-140ms → 18-42ms; per-char typing 40-120ms → 12-36ms. Theo yêu cầu user 'extension cứ xoay mãi' = chậm. Tradeoff: anti-detection nhẹ hơn nhưng vẫn realistic.",
      "⚠ Backend pair: sau khi update API code (vd thêm subscription_months column trong v0.4.4-0.4.6), MUST chạy `alembic upgrade head`. Auto-migration giờ chạy on startup (apps/api/app/main.py lifespan) — chỉ cần restart backend, không cần lệnh thủ công.",
    ],
  },
  {
    version: "0.4.6",
    date: "2026-05-19",
    kind: "fix",
    summary: "Sync: locale mismatch detection + anchor-click navigation cho /admin/members",
    details: [
      "SYNC_DATA action giờ nhận `expectedLocale` ('vi'|'en'|'zh') từ payload — dashboard truyền lang hiện tại (mapping: vi→vi, zh-CN→zh) để extension check ChatGPT đang dùng locale gì.",
      "Helper mới: `detectChatGPTLocale()` đọc `document.documentElement.lang` → normalize về 'vi'|'en'|'zh'. `checkLocaleMatch(expected)` compare + tạo hint message cho user nếu mismatch (instructions đổi ChatGPT settings → Locale).",
      "Khi sync trả 0 row VÀ locale mismatch → error_code mới 'LANGUAGE_MISMATCH' với error_message chứa hướng dẫn cụ thể. Dashboard TaskCompletionBanner show full message → user biết chính xác cần làm gì.",
      "sync.ts navigation cải tiến: ưu tiên click <a href> trong sidebar (Next.js router catches reliably) trước khi fallback pushState — khắc phục case admin tab đang ở /admin/billing và pushState không trigger re-render.",
      "Backend `POST /workspaces/{id}/sync` nhận query param `expected_locale` → ghi vào QueueItem payload. Dashboard syncMembers mutation gửi `expected_locale` mapped từ i18n state hiện tại.",
      "Log diagnostic cải tiến: phase 'discover' giờ kèm locale info trong console.",
    ],
  },
  {
    version: "0.4.5",
    date: "2026-05-19",
    kind: "fix",
    summary: "Invite progress chi tiết hơn (phase, current/total) để dashboard banner hiển thị tiến trình",
    details: [
      "Thêm `current` + `total` (= emails.length) vào mọi reportProgress call trong invite — banner Members hiển thị '1/4', '2/4', ... real-time.",
      "Phase 'add-row' mới: trước khi click 'Add more' cho email i, báo phase này → user thấy ngay extension đang ở bước nào.",
      "Phase 'opening-dialog' giờ kèm tổng số email trong message → debug dễ hơn khi banner hiển thị.",
      "Dashboard (apps/web) cập nhật banner invite — hiển thị per-task: email, status badge, phase, current/total, elapsed seconds, stale warning nếu > 90s không có phase. Banner FAILED riêng cho invite vừa fail (60s gần nhất) hiển thị error_code + error_message.",
    ],
  },
  {
    version: "0.4.4",
    date: "2026-05-19",
    kind: "fix",
    summary: "Multi-email invite: row-based UI 2026 (mỗi email 1 input riêng) + bổ sung text mapping",
    details: [
      "ChatGPT đổi dialog Invite sang layout 3-column (Email | Role | Seat type) với mỗi email là 1 ROW riêng có input riêng. UI cũ là 1 input + textarea expand sau khi click 'Add more'.",
      "Multi-email cũ: join các email bằng \\n vào 1 input duy nhất → 1 input không nhận newline → ChatGPT reject toàn bộ.",
      "Multi-email mới: type email[0] vào input đầu → loop 'Add more' → đợi row mới render (input count tăng) → type email[i] vào input rỗng cuối → repeat. Fallback dồn email vào 1 input nếu Add more fail.",
      "Helpers mới: countDialogEmailInputs(dialog) đếm input email-like, findLastEmptyEmailInput(dialog) lấy input rỗng cuối.",
      "Text mapping: thêm 'Send invites' (plural), 'Send invitations', 'Add another member', 'Add a member', 'Add row', 'Add many', 'Thêm thành viên', 'Thêm dòng', '添加成员', '添加一行'.",
      "Text mapping menu: thêm 'Change seat type', 'Edit seat type', 'Đổi loại ghế', '更改席位类型' (UI mới row menu chỉ còn Change seat type + Remove member).",
      "Progress mới: 'Đang nhập email i/N: {email}' — dashboard thấy tiến trình từng email.",
    ],
  },
  {
    version: "0.4.3",
    date: "2026-05-19",
    kind: "fix",
    summary: "Invite flow robust: multi-strategy label, sidebar-link nav, seat-limit error hints",
    details: [
      "findExternalInvitesToggle: thay row-only scope bằng multi-strategy label extraction — aria-labelledby → aria-label → label[for] → closest <label> → previous siblings → single-switch row. Switch nào không có ancestor 1-switch (DOM siblings flat) vẫn được label hoá đúng.",
      "console.table diagnostic mỗi lần scan switch — user mở DevTools thấy ngay label đọc được của từng toggle + pattern nào match/exclude.",
      "navigateTo: ưu tiên click <a href> trong sidebar (Next.js router catches) thay vì pushState. Selector mới quét tất cả <a[href]> match cả tuyệt đối lẫn tương đối. Quan trọng khi extension bị invoke từ tab /admin/billing — pushState từ billing đến identity thường không trigger re-render.",
      "INVITE_ERROR_HINTS thêm: seat limit (insufficient seats, không đủ ghế, 席位不足, …) + external domain (outside your organization, miền bên ngoài, 外部域). Dialog ChatGPT báo lỗi loại này sẽ được surface rõ ràng thay vì 'Dialog text: …'.",
      "Nav timeout log warning rõ ràng (đang ở X, target Y) thay vì im lặng.",
    ],
  },
  {
    version: "0.4.2",
    date: "2026-05-19",
    kind: "fix",
    summary: "Invite flow: chọn đúng toggle 'Allow External Domain Invites' (không nhầm 'Automatic Account Creation')",
    details: [
      "findExternalInvitesToggle() refactor: scope text match về 'row' (ancestor lớn nhất chỉ chứa 1 switch) thay vì walk-up 5 cấp — chặn false-match khi 2 toggle share ancestor.",
      "Thêm EXTERNAL_INVITE_EXCLUDE_PATTERNS — loại các row chứa 'Automatic Account Creation' / 'tự động tạo tài khoản' / '自动创建账户' khỏi candidate list.",
      "Patterns mới: 'Allow External Domain Invites' (English đầy đủ), 'cho phép lời mời từ miền bên ngoài' (VI), '允许外部域邀请' (ZH) — sắp xếp theo độ dài để chọn pattern đặc trưng nhất khi nhiều match.",
      "Best-match scoring: pattern dài nhất thắng → chọn switch có row label đặc trưng nhất.",
      "Áp dụng cùng heuristic cho harvest-labels.ts /admin/identity scraper — tránh ghi nhầm label 'Automatic Account Creation' vào DB.",
    ],
  },
  {
    version: "0.4.1",
    date: "2026-05-18",
    kind: "fix",
    summary: "Invite flow: luôn navigate về /admin/members sau khi tắt toggle",
    details: [
      "withExternalInvitesEnabled() trong finally: sau khi restore toggle external invites về OFF (nếu prev OFF), navigate về /admin/members thay vì kẹt ở /admin/identity.",
      "Áp dụng cho cả invite success và invite fail — UX nhất quán + task sau (SYNC_DATA, REMOVE_MEMBER...) khởi động ở đúng trang.",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-05-18",
    kind: "feature",
    summary: "HARVEST_LABELS: probe-invite mode (auto 100% locale coverage)",
    details: [
      "Khi tab 'Pending Invites' trống, harvest tự tạo invite probe (autogpt-probe-{ts}@example.com) → harvest menu Revoke + confirm Revoke → tự thu hồi probe để workspace sạch.",
      "Bỏ member_row_menu_button khỏi expected list (icon-only, không có text — CSS selector handle).",
      "Coverage giờ 14 control_key/page Members (thay vì 15) → 18 tổng → đạt 100% nếu probe-invite chạy được.",
    ],
  },
  {
    version: "0.3.2",
    date: "2026-05-18",
    kind: "fix",
    summary: "HARVEST_LABELS: progress lifecycle (background) + initial signal",
    details: [
      "Background runner báo progress sớm: 'queued' → 'opening_tab' → 'rate_limit' trước cả khi gửi tới content script. Trước đây dashboard im lặng 5-30s khi extension tự mở tab chatgpt.com/admin.",
      "Content script báo signal 'starting' ngay tại 0/18 trước locale check — dashboard có gì hiện ngay khi inject.",
      "Dashboard hiển thị status badge (PENDING/IN_PROGRESS), elapsed timer cục bộ ticking 1s, watchdog cảnh báo sau 20s nếu không thấy signal nào.",
      "Áp dụng cùng pattern progress lifecycle cho SYNC_DATA.",
    ],
  },
  {
    version: "0.3.1",
    date: "2026-05-18",
    kind: "fix",
    summary: "HARVEST_LABELS: progress real-time + nav verify + 3 phút timeout",
    details: [
      "Per-step progress (current/total/scanned/elapsed_sec) — dashboard hiện progress bar.",
      "navigateSpaVerified: kiểm tra location.pathname đổi thật sự sau pushState; skip page nếu nav fail thay vì hang.",
      "Global 3 phút timeout — harvest tự thoát nếu kẹt.",
      "Trả error 'không lấy được label nào' nếu total=0 sau crawl (thường do user chưa F5 hoặc selector lệch).",
      "JSON.parse hardening — backend 5xx không crash extension cache refresh nữa.",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-05-18",
    kind: "feature",
    summary: "HARVEST_LABELS — auto-crawl ChatGPT UI label",
    details: [
      "Action HARVEST_LABELS: extension tự navigate 4 page (/admin/members, /admin/billing, /admin/billing?tab=invoices, /admin/identity), mở invite dialog + click '...' menu + đọc confirm dialog rồi ESC để hủy → đọc 18 control_key cho 1 locale.",
      "Dashboard Settings → UI Labels: nút 'Harvest VI/EN/ZH' thay thế Console snippet thủ công.",
      "Endpoint mới POST /api/v1/ui-labels/harvest (X-API-KEY) cho extension bulk-upsert đa page.",
      "POST /api/v1/workspaces/{id}/harvest-labels (super-admin) tạo task qua SSE.",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-05-18",
    kind: "feature",
    summary: "UI Label calibration + self-heal stale labels",
    details: [
      "Fetch /api/v1/ui-labels/bundle định kỳ (15 phút) — cache label calibrate vào chrome.storage.",
      "Actions ưu tiên label đã harvest cho (locale × page) hiện tại; fallback hardcoded text patterns nếu DB rỗng.",
      "Tự động POST /report-mismatch khi tìm element fail dù DB có label → dashboard banner stale.",
      "Wire DB lookup: invite open/submit/add-more, tabs (active/pending/requests/billing-plan/billing-invoices), role options, menu remove/change-role, confirm remove/revoke, toggle external invites.",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-05-18",
    kind: "feature",
    summary: "Initial release",
    details: [
      "Cầu nối Dashboard nội bộ ↔ ChatGPT Business admin.",
      "Action: INVITE_MEMBER, REMOVE_MEMBER, CHANGE_ROLE, SYNC_DATA, SYNC_BILLING, REVOKE_INVITES.",
      "Auto-execute task qua SSE (real-time, không poll ChatGPT).",
      "Multi-language scraper (VI/EN/ZH).",
      "Port riêng: backend 18000, dashboard 17173, ext dev 17174.",
    ],
  },
];
