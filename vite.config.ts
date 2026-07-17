import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 同时构建 React 管理界面与 Cloudflare Worker。Cloudflare 插件读取 wrangler 配置，
 * 使本地开发、单元测试和生产构建共享同一绑定契约，避免 API 路径在不同环境失配。
 */
export default defineConfig({
  plugins: [react(), cloudflare()],
});
