import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: {
    // Port riêng (không dùng default 5173 của Vite) để tránh đụng project
    // khác trên cùng máy. Backend 18000, extension dev 17174.
    host: "127.0.0.1",
    port: 17173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:18000",
    },
  },
});
