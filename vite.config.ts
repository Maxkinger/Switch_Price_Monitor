import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite 只构建 React 管理界面到 dist/client；Node 服务由独立 tsup 配置构建，
 * 避免前端产物打包 Node 服务端、PostgreSQL 适配器或任何部署期资源。开发代理保持浏览器请求同源语义，
 * 目标仅为本机 Node 默认端口，不代理数据库、Chromium 调试口或任何外部来源。
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/client",
    // 只清理前端子目录，不能删除同一次 build 后续或既有的 dist/server 服务端产物。
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // 开发模式固定由 Node 默认 3000 端口提供 API；生产静态文件和 API 均由同一 Node 进程直接提供。
      "/api": "http://127.0.0.1:3000",
    },
  },
});
