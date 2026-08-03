import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * 将既有 Worker/D1 测试与新增 PostgreSQL 集成测试分到各自真实运行时：
 * Worker 项目继续验证 D1、Web Crypto 与 Request/Cookie，PostgreSQL 项目则使用 Node 驱动访问明确指定的可丢弃测试库。
 * 两类测试不得共享 setupFiles，避免旧 D1 迁移误作用于 PostgreSQL，也防止数据库测试读取任何生产绑定或秘密配置。
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
          }),
        ],
        test: {
          name: "worker",
          // Worker 项目排除 PostgreSQL 文件；这些文件依赖 Node 的文件系统、加密和 TCP 能力，不能装载进 Miniflare。
          include: ["test/**/*.test.ts"],
          exclude: ["test/postgres-*.test.ts"],
          setupFiles: ["./test/apply-migrations.ts"],
        },
      },
      {
        test: {
          name: "postgres",
          environment: "node",
          // 数据库测试只连接 TEST_DATABASE_URL 指向的 disposable 实例；串行文件执行避免跨文件清理互相覆盖约束验证现场。
          include: ["test/postgres-*.test.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
});
