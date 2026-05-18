import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import { manifest } from "./src/manifest";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  server: {
    // Port riêng (không dùng 5174 default) để tránh đụng project khác.
    // strictPort=true: lock cứng 17174 để khớp với host_permissions trong
    // manifest. Nếu port bận → Vite sẽ fail thay vì fallback gây
    // ERR_BLOCKED_BY_CLIENT do thiếu host_permissions. Trước khi npm
    // run dev, kill process cũ trên 17174.
    host: "127.0.0.1",
    port: 17174,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
