import type { ManifestV3Export } from "@crxjs/vite-plugin";

export const manifest: ManifestV3Export = {
  manifest_version: 3,
  name: "AutoGPT Admin Extension",
  description: "Cầu nối giữa Dashboard nội bộ và ChatGPT Business — thực thi invite/remove/role/sync.",
  version: "0.1.0",
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
  ],
  permissions: ["storage", "alarms", "tabs", "scripting"],
  host_permissions: [
    "http://localhost:8000/*",
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
  ],
};
