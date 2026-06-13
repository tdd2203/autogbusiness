# Cài đặt Chrome Extension (dev mode)

## Yêu cầu

- Chrome / Edge / Brave (Chromium 110+)
- Node 20+
- Backend AutoGPT đang chạy (xem [setup.md](setup.md))
- Đã tạo ít nhất 1 workspace trong dashboard và copy được `Extension API Key`

## 1. Build / dev

```powershell
cd apps\extension
npm install
npm run dev
```

`npm run dev` chạy Vite ở port 5174 và sinh thư mục `dist/` (hot-reload). Lần đầu nó cần build xong mới load được.

Hoặc nếu chỉ muốn build production:

```powershell
npm run build
```

Output cuối cùng nằm trong `apps/extension/dist/`.

## 2. Load extension vào trình duyệt

1. Mở `chrome://extensions/`
2. Bật **Developer mode** (góc trên phải)
3. Bấm **Load unpacked**
4. Chọn thư mục `apps/extension/dist`
5. Extension "AutoGPT Admin Extension" xuất hiện trong danh sách

Khi code thay đổi và Vite rebuild, bấm nút reload (🔄) trên thẻ extension trong `chrome://extensions/`.

## 3. Kết nối với backend

1. Bấm icon extension trên thanh toolbar → popup mở
2. **Backend URL**: `http://localhost:8000` (mặc định)
3. **Extension API Key**: dán key bạn copy từ dashboard
   - Lấy bằng cách: dashboard → Workspaces → chọn workspace → tab **Extension** → bấm "Regenerate API Key" → copy key (chỉ hiển thị 1 lần)
4. Bấm **Lưu & Kết nối**
5. Popup hiển thị `✓ Kết nối: {tên workspace}` nếu thành công

## 4. Verify polling

- Sau khi kết nối, extension tự poll backend mỗi ~30 giây (`chrome.alarms`)
- Bấm nút **Poll** trong popup để poll thủ công (debug)
- Xem log: `chrome://extensions/` → bấm "service worker" trên thẻ extension → DevTools mở console của background worker

## 5. Test end-to-end (Tuần 4)

Hiện chỉ là skeleton. Khi có task trong queue, extension sẽ:
1. Pick task từ `/api/v1/queue/next`
2. Log task ra console
3. **Báo FAILED** với `error_code = "EXTENSION_NOT_IMPLEMENTED"` (Tuần 5 sẽ thực thi)

Cách verify:
1. Trong dashboard → workspace → trang Thành viên → mời 1 member
2. Vào tab **Queue** → thấy task `INVITE_MEMBER` status `PENDING`
3. Sau khi extension poll (≤30s), task chuyển `FAILED` với error_message giải thích.

## Troubleshooting

- **Popup hiện "API key sai hoặc đã bị thu hồi"**: regenerate trong dashboard, paste lại.
- **Service worker chết**: MV3 service worker sleep sau 30s idle, chrome.alarms tự đánh thức. Không cần action.
- **CORS lỗi**: backend đã có CORS cho `localhost:5173` (dashboard). Extension không bị CORS vì gọi qua `chrome.fetch` không thuộc origin nào. Nếu vẫn lỗi, check `manifest.json` `host_permissions`.
- **Content script không inject**: chỉ inject trên `chatgpt.com/admin/*` và `chat.openai.com/admin/*`. Trang khác không có.
