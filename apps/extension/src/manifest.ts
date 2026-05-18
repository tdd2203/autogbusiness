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
  ],
};
