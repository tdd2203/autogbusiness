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
    // emptyOutDir=false: KHÔNG xoá file build cũ. Lý do: mỗi lần build, hash
    // file đổi (vd index.ts-loader-<hash>.js). Nếu xoá file cũ trong khi Chrome
    // còn đang chạy bản trước (service worker tham chiếu hash cũ qua manifest),
    // executeScript inject sẽ "Could not load file" → CONTENT_NOT_INJECTED, mọi
    // task fail tới khi reload. Giữ file cũ → bản đang load vẫn chạy được tới khi
    // user reload lấy bản mới. Đánh đổi: dist tích tụ file cũ — thi thoảng xoá tay.
    emptyOutDir: false,
  },
});
