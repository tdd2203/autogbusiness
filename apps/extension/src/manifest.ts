import type { ManifestV3Export } from "@crxjs/vite-plugin";
import { VERSION } from "./version";

export const manifest: ManifestV3Export = {
  manifest_version: 3,
  name: "AutoGPT Admin Extension",
  description: "Cầu nối giữa Dashboard nội bộ và ChatGPT Business — thực thi invite/remove/role/sync.",
  version: VERSION,
  action: {
    default_popup: "src/popup/index.html",
    default_title: "AutoGPT Admin",
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["https://chatgpt.com/admin/*", "https://chat.openai.com/admin/*"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
    },
    {
      // Bridge cho dashboard: nhận postMessage "auto-trigger" sau khi user tạo task.
      // Dashboard chạy port riêng 17173 (xem apps/web/vite.config.ts).
      matches: ["http://localhost:17173/*", "http://127.0.0.1:17173/*"],
      js: ["src/content/dashboard-bridge.ts"],
      run_at: "document_start",
    },
    {
      // Stripe invoice page: tự click button "Link" sau khi PURCHASE_SEAT Phase 1
      // (chatgpt.com modal #1+#2) tạo invoice "Đến hạn" + Phase 2 (chatgpt.com
      // tab=invoices) mở URL invoice.stripe.com/i/<account>/<token>/...
      matches: ["https://invoice.stripe.com/*"],
      js: ["src/content/stripe-invoice.ts"],
      run_at: "document_idle",
    },
    {
      // Link checkout popup (cửa sổ riêng do invoice.stripe.com mở qua
      // window.open). Hiển thị thẻ đã lưu + nút "Thanh toán {amount}".
      // Content script verify amount + click confirm.
      matches: ["https://checkout.link.com/*"],
      js: ["src/content/link-checkout.ts"],
      run_at: "document_idle",
    },
  ],
  permissions: ["storage", "tabs", "scripting", "alarms"],
  host_permissions: [
    // Backend FastAPI: port riêng 18000.
    "http://localhost:18000/*",
    "http://127.0.0.1:18000/*",
    // Dashboard Vite: port riêng 17173.
    "http://localhost:17173/*",
    "http://127.0.0.1:17173/*",
    // CRXJS dev server cho extension watch: port 17174 (strictPort=true ở
    // vite.config.ts) — loaders fetch HMR module qua port này, không có
    // host_permissions thì Chrome chặn → ERR_BLOCKED_BY_CLIENT.
    "http://localhost:17174/*",
    "http://127.0.0.1:17174/*",
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
    // PURCHASE_SEAT payment chain — cần permission để inject content script
    // qua chrome.scripting.executeScript khi auto-injection chậm (fallback).
    "https://invoice.stripe.com/*",
    "https://checkout.link.com/*",
  ],
};
