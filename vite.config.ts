import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite 只负责 React 前端静态产物；Node HTTP 服务由独立 SSR 配置构建，
 * 从构建链移除 Cloudflare 插件，避免 Worker/Static Assets 绑定重新成为 NAS 运行时依赖。
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
});
