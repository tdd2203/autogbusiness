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
      matches: ["http://localhost:5173/*", "http://127.0.0.1:5173/*"],
      js: ["src/content/dashboard-bridge.ts"],
      run_at: "document_start",
    },
  ],
  permissions: ["storage", "tabs", "scripting", "alarms"],
  host_permissions: [
    "http://localhost:8000/*",
    "http://127.0.0.1:8000/*",
    "http://localhost:5173/*",
    "http://127.0.0.1:5173/*",
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
  ],
};
