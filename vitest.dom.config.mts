import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * React DOM 测试独立于 Cloudflare Workers 测试池运行。
 * jsdom 的依赖不能被 Miniflare 当作 Worker 模块加载；分离配置仍让 DOM 交互测试进入本地质量门禁，而不削弱 D1/Worker 测试的生产相似性。
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.tsx"],
  },
});
