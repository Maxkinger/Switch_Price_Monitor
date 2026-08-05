import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * 迁移中的读路径测试保留原文件名，以便逐组对照旧 D1 断言并执行实施计划指定的 focused 命令。
 * 显式清单同时把这些文件排除出 Worker 项目并加入 Node/PostgreSQL 项目，避免同一 destructive 测试被两个运行时重复执行。
 */
const postgresReadTestFiles = [
  "test/collection-repository.test.ts",
  "test/exchange-rate-repository.test.ts",
  "test/manual-refresh-repository.test.ts",
  "test/notification-event-repository.test.ts",
  "test/price-repository.test.ts",
  "test/product-health-service.test.ts",
  "test/retention-repository.test.ts",
  "test/schema-and-repositories.test.ts",
  "test/settings-and-subscriptions.test.ts",
  "test/subscription-detail-repository.test.ts",
];

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
          // Node HTTP 运行时测试必须使用真实 fs、TCP 与 Node Request 适配器；若落入 Worker 项目会把运行时不兼容误报成业务失败。
          exclude: [
            "test/postgres-*.test.ts",
            "test/server-*.test.ts",
            "test/playwright-*.test.ts",
            // 日区升级 Browser Run 测试直接加载本地 Playwright 启动器；文件名不统一以 playwright- 开头，必须显式留在 Node 项目。
            "test/japanese-upgrade-browser.test.ts",
            "test/japanese-upgrade-relation-service.test.ts",
            "test/proxy-*.test.ts",
            "test/outbound-network.test.ts",
            ...postgresReadTestFiles,
          ],
          setupFiles: ["./test/apply-migrations.ts"],
        },
      },
      {
        test: {
          name: "postgres",
          environment: "node",
          // 数据库测试只连接 TEST_DATABASE_URL 指向的 disposable 实例；显式加入迁移清单，并串行执行以避免跨文件重建 schema 互相覆盖现场。
          include: ["test/postgres-*.test.ts", ...postgresReadTestFiles],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "server",
          environment: "node",
          // 服务器测试不加载 D1 迁移或 PostgreSQL destructive fixture；每项仅使用临时静态目录与显式注入的 API 依赖，绝不读取真实环境秘密。
          // 本地 Chromium 启动器依赖 Node 子进程与浏览器缓存，必须与 HTTP 服务器测试同属 Node 项目，不能装入 Miniflare。
          // 代理 Agent 依赖 Node TCP 与本机回环夹具；放入此项目可验证真实连接器，同时避免为 Worker 创建不受支持的代理兼容层。
          include: [
            "test/server-*.test.ts",
            "test/playwright-*.test.ts",
            "test/japanese-upgrade-browser.test.ts",
            "test/japanese-upgrade-relation-service.test.ts",
            "test/proxy-*.test.ts",
            "test/outbound-network.test.ts",
          ],
          // Node HTTP、Playwright 和回环代理夹具都会监听本机端口；串行文件执行避免多个浏览器/代理同时争抢 5 秒测试窗口。
          fileParallelism: false,
        },
      },
    ],
  },
});
