import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { AuthProvider } from "./hooks/useAuth";
import { I18nProvider } from "./i18n";
import { ToastProvider } from "./components/Toast";
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
    },
  },
});

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
