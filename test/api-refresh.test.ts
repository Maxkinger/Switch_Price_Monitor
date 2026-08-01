import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { handleManualRefreshRoute } from "../src/routes/manual-refresh-routes";
import { PostgresManualRefreshRepository } from "../src/repositories/postgres/manual-refresh-repository";
import type { AppDatabase } from "../src/server/database/types";
import { ManualRefreshService } from "../src/services/manual-refresh-service";
import { createApiTestDatabase, createTestAuth, initializeAndLogin as initializeAdmin, resetApiTestData } from "./support/api-postgres";

/**
 * 测试替身只返回采集聚合数，不携带任天堂响应、商品 URL 或价格正文。
 * 这样可验证受认证路由的同步执行边界，同时避免单元测试向外部官方商店发起真实请求。
 */
interface ImmediateRefreshRunnerStub {
  run(now: string): Promise<{ attempted: number; collected: number; stale: number }>;
}

// 路由 helper 与计时器用例共享同一受守卫 PostgreSQL 连接池；外部采集始终由文件内 fake 截断。
let database: AppDatabase;

describe("manual refresh HTTP route", () => {
  beforeAll(async () => { database = await createApiTestDatabase(); });
  afterAll(async () => { await database.close(); });

  beforeEach(async () => {
    // 刷新时间与认证单例都跨请求持久化；清空一次性库证明两次同步执行完全由本用例请求触发。
    await resetApiTestData(database);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T01:00:00.000Z"));
  });

  afterEach(() => {
    // 恢复真实时钟，防止固定时间意外影响认证过期时间或其他用例对当前时间的业务断言。
    vi.useRealTimers();
  });

  it("runs every authenticated administrator refresh immediately while cooldown is temporarily disabled", async () => {
    // 临时验证阶段不依赖前端按钮状态或 429 限流；每个已认证请求都必须在响应前同步执行一次统一采集。
    const cookie = await initializeAndLogin();
    const runner: ImmediateRefreshRunnerStub = { run: vi.fn().mockResolvedValue({ attempted: 3, collected: 2, stale: 1 }) };
    const first = await call(cookie, runner);

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      status: "completed",
      executedAt: "2026-07-16T01:00:00.000Z",
      attempted: 3,
      collected: 2,
      stale: 1,
    });
    expect(runner.run).toHaveBeenCalledExactlyOnceWith("2026-07-16T01:00:00.000Z");

    vi.setSystemTime(new Date("2026-07-16T01:10:00.000Z"));
    const repeated = await call(cookie, runner);

    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toEqual({
      status: "completed",
      executedAt: "2026-07-16T01:10:00.000Z",
      attempted: 3,
      collected: 2,
      stale: 1,
    });
    expect(runner.run).toHaveBeenNthCalledWith(2, "2026-07-16T01:10:00.000Z");
  });

  it("returns a safe error when the immediate collection runner fails", async () => {
    // 来源或汇率异常不得把内部 URL、SQL 或堆栈回传到已登录浏览器；临时无冷却不改变认证和安全错误边界。
    const cookie = await initializeAndLogin();
    const runner: ImmediateRefreshRunnerStub = { run: vi.fn().mockRejectedValue(new Error("private upstream failure")) };

    const response = await call(cookie, runner);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "INTERNAL_ERROR",
      error: "刷新暂时无法完成，请稍后重试。",
    });
    expect(runner.run).toHaveBeenCalledExactlyOnceWith("2026-07-16T01:00:00.000Z");
  });
});

async function initializeAndLogin(): Promise<string> {
  // 真实 PostgreSQL 初始化与登录确保刷新端点继承管理员会话安全边界，而不是未受保护的写入路由。
  return (await initializeAdmin(database, { enabledRegions: ["US"], defaultSearchRegion: "US" })).cookie;
}

async function call(cookie: string, runner: ImmediateRefreshRunnerStub): Promise<Response> {
  // 直接注入无网络采集替身，验证路由在认证后每次等待同步采集完成；PostgreSQL 只记录服务端时间。
  const response = await handleManualRefreshRoute(
    new Request("http://127.0.0.1/api/refresh", { method: "POST", headers: { cookie } }),
    createTestAuth(database),
    new ManualRefreshService(new PostgresManualRefreshRepository(database), runner),
  );
  if (!response) throw new Error("手动刷新路由未处理 /api/refresh 请求。");
  return response;
}
