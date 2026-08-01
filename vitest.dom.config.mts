import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * React DOM 测试与普通 Node、PostgreSQL 和本地浏览器项目分开运行。
 * jsdom 只为组件交互提供浏览器全局，不能渗入后端数据库或监听生命周期；独立配置仍让 DOM 用例进入本地质量门禁。
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.tsx"],
  },
});
