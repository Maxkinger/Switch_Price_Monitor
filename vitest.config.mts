import { defineConfig } from "vitest/config";

/**
 * 认证与管理 API 回归已经迁到 Node/PostgreSQL：这些文件共享一个受守卫的一次性 schema，
 * 因而必须从普通核心项目排除并按文件串行，避免 reset/TRUNCATE 交叉污染会话、价格或订阅断言。
 */
const nodePostgresApiTests = [
  "test/auth-routes.test.ts",
  "test/auth-guard.test.ts",
  "test/api-dashboard.test.ts",
  "test/api-history.test.ts",
  "test/api-product-discovery.test.ts",
  "test/api-product-preview.test.ts",
  "test/api-refresh.test.ts",
  "test/api-settings.test.ts",
  "test/api-subscription-detail.test.ts",
  "test/api-subscriptions.test.ts",
];

/**
 * Node 服务、平台中立核心、PostgreSQL 集成和本地浏览器生命周期使用四个互斥项目。
 * 明确排除顺序防止同一文件被重复执行；数据库和监听资源项目保持串行，纯核心测试则可安全并行。
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          environment: "node",
          // 核心项目接住原测试池的 37 个平台中立文件和新迁移的 4 个业务文件；排除清单与下方三个项目完全互斥。
          include: ["test/**/*.test.ts"],
          exclude: [
            ...nodePostgresApiTests,
            "test/postgres-*.test.ts",
            "test/server-*.test.ts",
            "test/playwright-*.test.ts",
            "test/japanese-upgrade-browser.test.ts",
            // 代理 Agent、回环夹具和 Chromium 探测依赖 Node TCP；不能落进普通核心项目伪造 Worker 兼容层。
            "test/proxy-*.test.ts",
            "test/outbound-network.test.ts",
          ],
        },
      },
      {
        test: {
          name: "node-postgres-api",
          environment: "node",
          // 每个文件会重建同一个一次性 PostgreSQL schema；禁止文件并行是数据库隔离而不是性能偏好。
          include: nodePostgresApiTests,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "postgres",
          environment: "node",
          // 数据库测试共享一个一次性 schema，禁止文件并行可避免 reset/migration 操作交叉污染而产生假阳性或偶发失败。
          include: ["test/postgres-*.test.ts"],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "server",
          environment: "node",
          // Node HTTP 与本地 Playwright 测试只使用临时目录、回环端口和注入生命周期；
          // 浏览器 smoke 不访问任天堂或公网，必须在真实 Node 环境运行，并与纯核心和数据库项目隔离。
          include: [
            "test/server-*.test.ts",
            "test/playwright-*.test.ts",
            "test/japanese-upgrade-browser.test.ts",
            "test/proxy-*.test.ts",
            "test/outbound-network.test.ts",
          ],
          // 生命周期用例共享本机监听资源或 Chromium 进程；串行文件可使关停断言稳定且不掩盖资源泄漏。
          fileParallelism: false,
        },
      },
    ],
  },
});
