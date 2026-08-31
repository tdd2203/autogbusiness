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
      // NHÁNH CANVA: trang quản lý thành viên của team Canva. Kịch bản để riêng ở
      // `content/canva/` — không dùng chung với content script ChatGPT ở trên.
      matches: [
        "https://www.canva.com/settings/*",
        "https://canva.com/settings/*",
      ],
      js: ["src/content/canva/index.ts"],
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
      // Stripe invoice page: tự click button "Link" để thanh toán hoá đơn
      // "Đến hạn".
      //
      // ⚠️ Từ UI ChatGPT 2026-08-22, luồng mua suất CHÍNH không đi qua đây nữa:
      // modal "Xem lại giao dịch mua" trừ tiền thẳng qua thẻ đã lưu, không tạo
      // hoá đơn chờ. Chặng Stripe/Link chỉ còn phục vụ PURCHASE_SEAT
      // `skip_to_payment` — trả nốt hoá đơn "Đến hạn" tồn đọng từ các lần mua
      // theo UI cũ. Giữ lại cho tới khi dọn hết tồn đọng đó.
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
    // Backend production trên VPS (qua Cloudflare tunnel) — web nginx proxy
    // /api/ + /webhook/ về container api, extension chỉ cần 1 origin này.
    "https://gpt.lovevn.org/*",
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
    // Nhánh Canva — cần để mở/điều hướng tab và inject lại content script khi cần.
    "https://www.canva.com/*",
    "https://canva.com/*",
    // PURCHASE_SEAT payment chain — cần permission để inject content script
    // qua chrome.scripting.executeScript khi auto-injection chậm (fallback).
    // GIỮ LẠI dù luồng mua suất mới không dùng: chế độ `skip_to_payment` vẫn
    // cần để thanh toán hoá đơn "Đến hạn" tồn đọng (xem content_scripts trên).
    "https://invoice.stripe.com/*",
    "https://checkout.link.com/*",
  ],
};
