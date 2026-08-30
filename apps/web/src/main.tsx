import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { AuthProvider } from "./hooks/useAuth";
import { I18nProvider } from "./i18n";
import { ToastProvider } from "./components/Toast";
import { initUiScale } from "./lib/ui-scale";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      // Tự làm mới UI phía người dùng: khi quay lại tab (rời sang ChatGPT/extension
      // rồi trở về) hoặc khi mạng kết nối lại thì nạp dữ liệu mới, không cần F5 tay.
      // Dữ liệu bị scheduler nền/sync/extension/admin khác đổi sẽ tự cập nhật.
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      // Coi dữ liệu là cũ ngay -> refetch khi focus luôn lấy bản mới.
      staleTime: 0,
      // ĐỪNG NGÂM LƯỢT GỌI KHI TRÌNH DUYỆT TƯỞNG MÌNH MẤT MẠNG.
      //
      // Mặc định (`networkMode: "online"`) react-query không gọi khi `onlineManager`
      // báo offline: query nằm ở `fetchStatus: "paused"` — KHÔNG dữ liệu, KHÔNG lỗi,
      // không request nào đang bay. Mọi chỗ viết `isLoading ? "…"` sẽ đứng im vô
      // thời hạn, và nó chỉ tự gỡ khi có sự kiện `online` — sự kiện đó lỡ một nhịp
      // (VPN, đổi wifi, máy ngủ dậy) là treo tới lúc F5. Đúng triệu chứng "chờ load
      // mãi không hiện" (user 2026-08-30).
      //
      // Dashboard chỉ nói chuyện với đúng một server của mình, nên thà cứ gọi rồi
      // báo lỗi kèm nút thử lại (xem `components/LoadError.tsx`) còn hơn im lặng.
      //
      // LƯU Ý: cờ này KHÔNG gỡ được nhịp hoãn theo TAB ẨN — `canContinue()` của
      // retryer còn đòi `focusManager.isFocused()`, nên lượt gọi hỏng lúc tab đang
      // ẩn vẫn nằm chờ tới khi user quay lại tab. Chỗ đó tự gỡ theo
      // `visibilitychange` nên để nguyên.
      networkMode: "always",
    },
    mutations: {
      // Cùng lý do: lệnh mời/nạp bị ngâm im lặng thì user bấm lại lần nữa.
      networkMode: "always",
    },
  },
});

// Áp cỡ chữ đã chọn TRƯỚC khi React vẽ, nếu không màn hình nháy một nhịp cỡ
// 100% rồi mới nhảy sang cỡ của người dùng.
initUiScale();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ToastProvider>
          <BrowserRouter>
            <AuthProvider>
              <App />
            </AuthProvider>
          </BrowserRouter>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
