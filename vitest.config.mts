import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * 使用 Cloudflare Workers 测试池而非 Node mock，使 D1 迁移、Web Crypto 与 Worker Request/Cookie 行为在接近生产的运行时验证。
 * 全局迁移设置文件在每个隔离测试 Worker 启动时执行，确保各测试均拥有相同表结构。
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    // 该配置只收集 Worker/D1 `.ts` 测试；DOM `.tsx` 测试必须由独立 jsdom 配置运行，避免把浏览器依赖错误装载为 Worker 模块。
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
