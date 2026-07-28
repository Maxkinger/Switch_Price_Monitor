import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

/**
 * 迁移期间同时保留两套真实运行边界：既有用例继续在 Cloudflare Workers/D1 隔离池执行，
 * PostgreSQL 基础设施用例则在 Node 环境连接一次性容器。项目级 include 互斥，避免 PostgreSQL
 * 测试误装载 Worker setup、监听端口或访问 D1，也避免旧测试在尚未迁完时被错误切换到 Node mock。
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
          // 旧 `.ts` 测试仍由 D1 迁移 setup 初始化；显式排除 PostgreSQL 与 Node HTTP 用例可保护三种运行时边界，
          // 防止 Node 文件系统、监听端口或进程信号 API 被 Miniflare 误当作 Worker 模块加载。
          include: ["test/**/*.test.ts"],
          exclude: ["test/postgres-*.test.ts", "test/server-*.test.ts"],
          setupFiles: ["./test/apply-migrations.ts"],
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
          // Node HTTP 三批测试只使用临时目录、临时端口和注入生命周期，不连接 NAS、生产数据库或真实进程信号。
          include: ["test/server-*.test.ts"],
          // 生命周期用例共享本机监听资源；串行文件可使端口关停断言稳定且不掩盖连接泄漏。
          fileParallelism: false,
        },
      },
    ],
  },
});
